-- Migration 058: per-group choice between a RANDOM and a FIXED exit-points difference.
--
-- account_groups gets these settings (Groups modal → each group):
--   • exit_points_mode  'fixed' (DEFAULT — also for every existing group, via the column
--                       default) or 'random' (the 053/054 behaviour: each other member gets the
--                       source's points ± a random number in its range, unique per window).
--   • exit_points_random_min / exit_points_random_max — the RANDOM range in points (default
--                       10 and 50; 0 <= min <= max <= 1000).
--   • exit_points_step  the FIXED step in points (default 25, >= 0). The source account keeps
--                       its typed points (offset 0) and the other members take an arithmetic
--                       progression around it, e.g. 5 accounts at step 25 → −50, −25, 0, +25, +50
--                       (members in account creation order get the offsets in ascending order).
--                       A minus step that would take a window's points below 0 is skipped and the
--                       next plus step is used. Step 0 = every member on the source's points.
-- Only schedule windows' exit points are affected (as in 053/054). Changing the setting in the
-- UI re-syncs the group's schedules so it applies immediately.
--
-- Additive and safe to re-run: new columns with defaults, sync_account_group replaced (same
-- signature and permissions as 054).

ALTER TABLE public.account_groups
  ADD COLUMN IF NOT EXISTS exit_points_mode TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS exit_points_step INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS exit_points_random_min INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS exit_points_random_max INTEGER NOT NULL DEFAULT 50;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_groups_exit_points_mode_check') THEN
    ALTER TABLE public.account_groups
      ADD CONSTRAINT account_groups_exit_points_mode_check CHECK (exit_points_mode IN ('random', 'fixed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_groups_exit_points_step_check') THEN
    ALTER TABLE public.account_groups
      ADD CONSTRAINT account_groups_exit_points_step_check CHECK (exit_points_step BETWEEN 0 AND 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_groups_exit_points_random_range_check') THEN
    ALTER TABLE public.account_groups
      ADD CONSTRAINT account_groups_exit_points_random_range_check
      CHECK (exit_points_random_min >= 0 AND exit_points_random_max <= 1000 AND exit_points_random_min <= exit_points_random_max);
  END IF;
END $$;

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
  v_diff_mode TEXT;
  v_step INTEGER;
  w RECORD;
  v_base NUMERIC;
  v_n INTEGER;
  v_offsets INTEGER[];
  v_src_j INTEGER;
  v_rmin INTEGER;
  v_rmax INTEGER;
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
  SELECT user_id, COALESCE(exit_points_mode, 'fixed'), COALESCE(exit_points_step, 25),
         COALESCE(exit_points_random_min, 10), COALESCE(exit_points_random_max, 50)
    INTO v_group_owner, v_diff_mode, v_step, v_rmin, v_rmax
    FROM public.account_groups WHERE id = v_group;
  IF v_rmax < v_rmin THEN v_rmax := v_rmin; END IF;
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

      IF v_diff_mode = 'fixed' THEN
        -- FIXED difference (migration 058): slots of an arithmetic progression around the
        -- window's base — 0, +s, −s, +2s, −2s, … (a minus step is skipped where it would take
        -- the points below 0; the engine reads |points|). The source keeps its own points (slot 0
        -- when it was typed there; its own offset if it is itself a member that was offset), and
        -- the other members take the nearest remaining slots, sorted ascending and handed out in
        -- account creation order, so each keeps the same place on every save. E.g. 5 accounts,
        -- step 25, saved from the typed account: source 0, others −50 / −25 / +25 / +50.
        -- Deterministic (no randomness); unique while the step is > 0.
        FOR w IN
          SELECT s.group_window_key AS key, min(s.exit_points - s.exit_points_jitter) AS base, count(*)::int AS n
            FROM public.paper_trading_schedules s
           WHERE s.account_id = ANY(v_members)
           GROUP BY s.group_window_key
        LOOP
          v_base := w.base;
          v_n := w.n;
          SELECT COALESCE(max(exit_points_jitter), 0) INTO v_src_j
            FROM public.paper_trading_schedules
           WHERE account_id = p_source AND group_window_key IS NOT DISTINCT FROM w.key;
          SELECT array_agg(o ORDER BY o) INTO v_offsets
            FROM (SELECT c.o
                    FROM (SELECT 0 AS o, 0 AS idx, 0 AS neg
                          UNION ALL
                          SELECT g * v_step, g, 0 FROM generate_series(1, v_n + 1) g
                          UNION ALL
                          SELECT -g * v_step, g, 1 FROM generate_series(1, v_n + 1) g) c
                   WHERE v_base + c.o >= 0 AND c.o <> v_src_j
                   ORDER BY c.idx, c.neg
                   LIMIT v_n) t;
          WITH ordered AS (
            SELECT s.id, row_number() OVER (ORDER BY a.created_at, a.id) AS rn
              FROM public.paper_trading_schedules s
              JOIN public.paper_trading_accounts a ON a.id = s.account_id
             WHERE s.account_id = ANY(v_members) AND s.group_window_key IS NOT DISTINCT FROM w.key
          )
          UPDATE public.paper_trading_schedules t
             SET exit_points = v_base + COALESCE(v_offsets[o.rn], 0),
                 exit_points_jitter = COALESCE(v_offsets[o.rn], 0)
            FROM ordered o
           WHERE t.id = o.id;
        END LOOP;
      ELSE
        -- RANDOM difference (053/054), within the group's range [v_rmin, v_rmax] (default 10–50).
        -- The copies carry the source's points and jitter: swap in each member's own jitter,
        -- keeping the base (points − jitter) the same. Within one window no two accounts of the
        -- group (source included) end up on the same exit points:
        --   • a member keeps its previous random part while the base is unchanged and that value
        --     is still free;
        --   • otherwise it draws a free ±[min, max] (minus only when the points stay >= 0 — the
        --     engine reads |points|);
        --   • only if every value in the range is taken may it repeat one.
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
          IF (r.prev ->> 0)::numeric = r.base AND abs((r.prev ->> 1)::int) BETWEEN v_rmin AND v_rmax
             AND NOT (r.base + (r.prev ->> 1)::int = ANY(v_used)) THEN
            v_j := (r.prev ->> 1)::int;
          END IF;
          IF v_j IS NULL THEN
            SELECT g.c INTO v_j
              FROM (SELECT generate_series(-v_rmax, -v_rmin) AS c UNION ALL SELECT generate_series(v_rmin, v_rmax)) g
             WHERE r.base + g.c >= 0 AND NOT (r.base + g.c = ANY(v_used))
             ORDER BY random() LIMIT 1;
          END IF;
          IF v_j IS NULL THEN
            v_j := v_rmin + floor(random() * (v_rmax - v_rmin + 1))::int;
          END IF;

          UPDATE public.paper_trading_schedules
             SET exit_points = r.base + v_j, exit_points_jitter = v_j
           WHERE id = r.id;
          v_done := v_done || r.id;
        END LOOP;
        END IF;
    END IF;
  END IF;

  RETURN array_length(v_members, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_account_group(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_account_group(UUID, TEXT) TO authenticated, service_role;
