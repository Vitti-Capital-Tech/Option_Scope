-- Migration 052: account groups may hold accounts of DIFFERENT users (an admin's group of
-- client accounts). Drops the same-owner rule from _check_account_group, so an admin can give
-- an individual grouped account any user_id. In its place: only the group's owner or an admin
-- may put an account into a group, and only they may copy settings across it
-- (sync_account_group). Same mode / same strategy_version rules are unchanged. Safe to re-run.

CREATE OR REPLACE FUNCTION public._check_account_group()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  g public.account_groups%ROWTYPE;
  v_mode TEXT := CASE WHEN NEW.mode = 'live' THEN 'live' ELSE 'paper' END;
  v_ver INTEGER;
  v_other_ver INTEGER;
BEGIN
  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM public.account_groups WHERE id = NEW.group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account group % not found', NEW.group_id; END IF;
  -- Joining (or moving to) a group: only the group's owner or an admin may do it, so a client
  -- can't attach an account to someone else's group. Changing an account's user_id while it
  -- stays in its group is fine — members may belong to different users.
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM g.user_id AND NOT public._is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Only the owner of group "%" or an admin can add accounts to it', g.name;
    ELSIF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
      RAISE EXCEPTION 'Only the owner of group "%" or an admin can add accounts to it', g.name;
    END IF;
  END IF;
  IF g.mode <> v_mode THEN
    RAISE EXCEPTION 'Account "%" is %, but group "%" is for % accounts', NEW.name, v_mode, g.name, g.mode;
  END IF;
  SELECT strategy_version INTO v_ver FROM public.paper_trading_config WHERE account_id = NEW.id;
  SELECT c.strategy_version INTO v_other_ver
    FROM public.paper_trading_accounts a
    JOIN public.paper_trading_config c ON c.account_id = a.id
   WHERE a.group_id = NEW.group_id AND a.id <> NEW.id
   LIMIT 1;
  IF v_ver IS NOT NULL AND v_other_ver IS NOT NULL AND v_ver <> v_other_ver THEN
    RAISE EXCEPTION 'Account "%" runs strategy v%, but group "%" runs v%', NEW.name, v_ver, g.name, v_other_ver;
  END IF;
  RETURN NEW;
END;
$$;

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
      DELETE FROM public.paper_trading_schedules WHERE account_id = ANY(v_members);
      EXECUTE format(
        'INSERT INTO public.paper_trading_schedules (account_id, %1$s) SELECT m, %1$s FROM public.paper_trading_schedules s CROSS JOIN unnest($2) AS m WHERE s.account_id = $1',
        v_sched_cols
      ) USING p_source, v_members;
    END IF;
  END IF;

  RETURN array_length(v_members, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_account_group(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_account_group(UUID, TEXT) TO authenticated, service_role;
