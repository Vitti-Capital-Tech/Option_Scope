-- Migration 053: grouped accounts don't all exit at the same level. When a group's schedule
-- windows are copied (sync_account_group), every OTHER member's window gets
-- exit_points = source's points ± a random whole number in [10, 50] (only + when − would go
-- below 0), drawn per member per window. The account the settings were saved from keeps
-- exactly what was typed.
--
-- exit_points_jitter remembers the random part on each window, so the group's "base" points
-- are always exit_points − exit_points_jitter. That way saving from ANY member (not just the
-- one first edited) copies base + jitter, and the points never drift upward across saves.
-- A trigger resets a window's jitter to 0 whenever its exit_points are edited directly
-- (UI save, scanner "send to window", SQL), so a typed value becomes the new base.
--
-- A member keeps its random part across saves while that window's base points stay the same;
-- a new number is drawn only when the base changes (or the window is new). group_window_key
-- ties the copies of one window together across members (sync re-creates member rows with
-- new ids), so each member's previous jitter can be found again.
--
-- Additive and safe to re-run. No frontend change needed: the UI never writes the new columns.

-- 1. Random part of a window's exit points (0 = the value was set directly) + window link ---
ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS exit_points_jitter INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS group_window_key UUID;

-- 2. A direct edit of exit_points makes the typed value the base ----------------------------
CREATE OR REPLACE FUNCTION public._reset_exit_points_jitter()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  -- sync_account_group changes both columns together; anything else changing only the points
  -- is a direct edit.
  IF NEW.exit_points IS DISTINCT FROM OLD.exit_points
     AND NEW.exit_points_jitter IS NOT DISTINCT FROM OLD.exit_points_jitter THEN
    NEW.exit_points_jitter := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_exit_points_jitter ON public.paper_trading_schedules;
CREATE TRIGGER trg_reset_exit_points_jitter
  BEFORE UPDATE ON public.paper_trading_schedules
  FOR EACH ROW EXECUTE FUNCTION public._reset_exit_points_jitter();

-- 3. sync_account_group (migration 052) + per-member exit-points jitter ---------------------
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

      -- The copies carry the source's points and jitter: swap in the member's own jitter,
      -- keeping the base (points − jitter) the same. A member keeps its previous random part
      -- while the window's base is unchanged; otherwise it gets a fresh one of ±[10, 50]. The
      -- minus side is skipped when it would take the points below 0 (the engine reads |points|).
      UPDATE public.paper_trading_schedules t
         SET exit_points = t.exit_points - t.exit_points_jitter + r.j,
             exit_points_jitter = r.j
        FROM (SELECT x.id,
                     CASE WHEN (x.prev ->> 0)::numeric = x.base AND abs((x.prev ->> 1)::int) BETWEEN 10 AND 50
                          THEN (x.prev ->> 1)::int
                          WHEN x.neg AND x.base >= x.mag THEN -x.mag
                          ELSE x.mag
                     END AS j
                FROM (SELECT s.id,
                             s.exit_points - s.exit_points_jitter AS base,
                             v_old_jitter -> (s.account_id::text || ':' || s.group_window_key::text) AS prev,
                             10 + floor(random() * 41)::int AS mag,
                             random() < 0.5 AS neg
                        FROM public.paper_trading_schedules s
                       WHERE s.account_id = ANY(v_members)) x) r
       WHERE t.id = r.id;
    END IF;
  END IF;

  RETURN array_length(v_members, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_account_group(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_account_group(UUID, TEXT) TO authenticated, service_role;
