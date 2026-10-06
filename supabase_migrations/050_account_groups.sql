-- Migration 050: Account groups — several accounts share ONE set of settings.
--
-- A group is a named set of accounts of the same owner, the same mode (paper / live) and the
-- same strategy_version. Settings are still stored per account (paper_trading_config +
-- paper_trading_schedules), so the engine is unchanged and every account keeps trading and
-- being monitored on its own. "Shared" means: whenever a member's settings are saved from the
-- UI, `sync_account_group(source)` copies them to every other member, atomically.
--
-- Shared (copied): every paper_trading_config column EXCEPT id, account_id, initial_balance,
-- strategy_version, created_at, updated_at — i.e. all filters, exits, ATM scaling, trade days,
-- full deploy, excluded strikes, allocation %, entry offsets, combined caps — plus ALL schedule
-- windows, and the allocation / entry-offset keys of paper_trading_accounts.default_config.
-- New config columns added by later migrations are shared automatically (column list is read
-- from information_schema). Per account (never copied): balance, credentials, armed / paused,
-- Telegram, positions and history.
--
-- Additive and safe to run before the new frontend is deployed.

-- 1. Groups ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.account_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own account groups" ON public.account_groups;
CREATE POLICY "Users manage own account groups"
    ON public.account_groups FOR ALL
    USING (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

DROP POLICY IF EXISTS "Service role full access on account groups" ON public.account_groups;
CREATE POLICY "Service role full access on account groups"
    ON public.account_groups FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_account_groups_user_id ON public.account_groups(user_id);

-- 2. Membership: one group per account; deleting a group just ungroups its accounts -------
ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.account_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_group_id ON public.paper_trading_accounts(group_id);

-- 3. Membership rules (any write path): same owner, same mode, same strategy_version -------
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
  IF g.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'Account "%" belongs to a different user than group "%"', NEW.name, g.name;
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

DROP TRIGGER IF EXISTS trg_check_account_group ON public.paper_trading_accounts;
CREATE TRIGGER trg_check_account_group
  BEFORE INSERT OR UPDATE OF group_id, mode, user_id ON public.paper_trading_accounts
  FOR EACH ROW EXECUTE FUNCTION public._check_account_group();

-- 4. Copy one member's settings to the rest of its group ----------------------------------
-- p_what: 'config' (paper_trading_config + default_config keys), 'schedules', or 'all'.
-- Returns the number of other members updated. One transaction: members never see a
-- half-copied state, and schedules are replaced (delete + insert) atomically.
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
BEGIN
  IF p_what NOT IN ('config', 'schedules', 'all') THEN
    RAISE EXCEPTION 'sync_account_group: p_what must be config, schedules or all';
  END IF;
  SELECT group_id, user_id INTO v_group, v_owner FROM public.paper_trading_accounts WHERE id = p_source;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Account % not found', p_source; END IF;
  IF auth.role() <> 'service_role' AND v_owner <> auth.uid() AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF v_group IS NULL THEN RETURN 0; END IF;

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
