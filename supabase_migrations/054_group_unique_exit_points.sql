-- Migration 054: within a group, no two accounts share the same exit points on a window.
-- Builds on migration 053 (per-member ±[10, 50] exit-points jitter): sync_account_group now
-- draws each member's random part from the values still free on that window — not equal to
-- the source account's points or any other member's. A member still keeps its previous value
-- while the window's base points are unchanged, unless that value is now taken.
-- Same function signature and permissions as 053; no table changes. Safe to re-run.

CREATE OR REPLACE FUNCTION public.sync_account_group(p_source UUID, p_what TEXT DEFAULT 'all')
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_group UUID;
  v_owner UUID;
  v_members UUID[];
  v_cols TEXT;
  v_sched_cols TEXT;
  v_group_owner UUID;
  v_old_jitter JSONB;
  r RECORD;
  v_j INTEGER;
  v_used NUMERIC[];
  v_done UUID[] := '{}';
BEGIN
  IF p_what NOT IN ('config', 'schedules', 'all') THEN
    RAISE EXCEPTION 'sync_account_group: p_what must be config, schedules or all';
  END IF;
  SELECT group_id, user_id INTO v_group, v_owner FROM public.paper_trading_accounts WHERE id = p_source;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Account % not found', p_source; END IF;
  IF v_group IS NULL THEN RETURN 0; END IF;
  -- Members may belong to different users (an admin's group of client accounts), so only the
  -- GROUP's owner or an admin may copy settings across it — never a member's own client.
  -- No JWT user (service_role / SQL editor) is allowed.
  SELECT user_id INTO v_group_owner FROM public.account_groups WHERE id = v_group;
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM v_group_owner AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Only the group owner or an admin can copy group settings';
  END IF;

  SELECT array_agg(id) INTO v_members
    FROM public.paper_trading_accounts
   WHERE group_id = v_group AND id <> p_source;
  IF v_members IS NULL THEN RETURN 0; END IF;

  IF p_what IN ('config', 'all') THEN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'paper_trading_config'
       AND column_name NOT IN ('id', 'account_id', 'initial_balance', 'strategy_version', 'created_at', 'updated_at');
    EXECUTE format(
      'UPDATE public.paper_trading_config t SET (%1$s) = (SELECT %1$s FROM public.paper_trading_config s WHERE s.account_id = $1), updated_at = NOW() WHERE t.account_id = ANY($2)',
      v_cols
    ) USING p_source, v_members;

    UPDATE public.paper_trading_accounts t
       SET default_config = COALESCE(t.default_config, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
             'balanceAllocationPct', s.default_config -> 'balanceAllocationPct',
             'entryBuyOffset', s.default_config -> 'entryBuyOffset',
             'entrySellOffset', s.default_config -> 'entrySellOffset'))
      FROM public.paper_trading_accounts s
     WHERE s.id = p_source AND t.id = ANY(v_members);
  END IF;

  IF p_what IN ('schedules', 'all') THEN
    -- Never leave a member with zero windows: skip if the source has none.
    IF EXISTS (SELECT 1 FROM public.paper_trading_schedules WHERE account_id = p_source) THEN
      SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_sched_cols
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'paper_trading_schedules'
         AND column_name NOT IN ('id', 'account_id', 'created_at', 'updated_at');

      -- Give the source's new windows a group-wide key (copies inherit it), then remember each
      -- member's current base + jitter per window before its rows are replaced.
      UPDATE public.paper_trading_schedules SET group_window_key = id
       WHERE account_id = p_source AND group_window_key IS NULL;
      SELECT jsonb_object_agg(account_id::text || ':' || group_window_key::text,
                              jsonb_build_array(exit_points - exit_points_jitter, exit_points_jitter))
        INTO v_old_jitter
        FROM public.paper_trading_schedules
       WHERE account_id = ANY(v_members) AND group_window_key IS NOT NULL;

      DELETE FROM public.paper_trading_schedules WHERE account_id = ANY(v_members);
      EXECUTE format(
        'INSERT INTO public.paper_trading_schedules (account_id, %1$s) SELECT m, %1$s FROM public.paper_trading_schedules s CROSS JOIN unnest($2) AS m WHERE s.account_id = $1',
        v_sched_cols
      ) USING p_source, v_members;

      -- The copies carry the source's points and jitter: swap in each member's own jitter,
      -- keeping the base (points − jitter) the same. Within one window no two accounts of the
      -- group (source included) end up on the same exit points:
      --   • a member keeps its previous random part while the base is unchanged and that value
      --     is still free;
      --   • otherwise it draws a free ±[10, 50] (minus only when the points stay >= 0 — the
      --     engine reads |points|);
      --   • only if every value is taken (more than ~80 members) may it repeat one.
      -- Members that can keep their value are placed first, so a new member never takes it.
      FOR r IN
        SELECT s.id, s.group_window_key AS k, s.exit_points - s.exit_points_jitter AS base,
               v_old_jitter -> (s.account_id::text || ':' || s.group_window_key::text) AS prev
          FROM public.paper_trading_schedules s
         WHERE s.account_id = ANY(v_members)
         ORDER BY s.group_window_key,
                  COALESCE(v_old_jitter ? (s.account_id::text || ':' || s.group_window_key::text), false) DESC,
                  s.account_id
      LOOP
        SELECT COALESCE(array_agg(exit_points::numeric), '{}') INTO v_used
          FROM public.paper_trading_schedules
         WHERE group_window_key = r.k AND (account_id = p_source OR id = ANY(v_done));

        v_j := NULL;
        IF (r.prev ->> 0)::numeric = r.base AND abs((r.prev ->> 1)::int) BETWEEN 10 AND 50
           AND NOT (r.base + (r.prev ->> 1)::int = ANY(v_used)) THEN
          v_j := (r.prev ->> 1)::int;
        END IF;
        IF v_j IS NULL THEN
          SELECT g.c INTO v_j
            FROM (SELECT generate_series(-50, -10) AS c UNION ALL SELECT generate_series(10, 50)) g
           WHERE r.base + g.c >= 0 AND NOT (r.base + g.c = ANY(v_used))
           ORDER BY random() LIMIT 1;
        END IF;
        IF v_j IS NULL THEN
          v_j := 10 + floor(random() * 41)::int;
        END IF;

        UPDATE public.paper_trading_schedules
           SET exit_points = r.base + v_j, exit_points_jitter = v_j
         WHERE id = r.id;
        v_done := v_done || r.id;
      END LOOP;
    END IF;
  END IF;

  RETURN array_length(v_members, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_account_group(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_account_group(UUID, TEXT) TO authenticated, service_role;
