-- Supabase Database Schema for OptionScope Paper Trading
-- Paste this file directly into the Supabase SQL Editor.

-- Enable UUID extension if not already active
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PROFILES TABLE (Syncs with Supabase Auth)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "Users can view their own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Admins can manage all profiles"
    ON public.profiles FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE public.profiles.id = auth.uid() AND public.profiles.role = 'admin'
        )
    );

-- Trigger to automatically create a profile when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, role)
    VALUES (new.id, new.email, 'client');
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PAPER TRADING ACCOUNTS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_trading_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    default_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.paper_trading_accounts ENABLE ROW LEVEL SECURITY;

-- Policies for accounts
CREATE POLICY "Users can manage their own accounts"
    ON public.paper_trading_accounts FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access on accounts"
    ON public.paper_trading_accounts FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON public.paper_trading_accounts(user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PAPER TRADING CONFIG TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_trading_config (
    id UUID PRIMARY KEY REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    underlying TEXT NOT NULL DEFAULT 'BTC',
    expiry TEXT NOT NULL DEFAULT '',
    min_strike_diff INTEGER NOT NULL DEFAULT 800,
    min_iv_diff NUMERIC NOT NULL DEFAULT 5,
    max_ratio_deviation NUMERIC NOT NULL DEFAULT 0.25,
    min_sell_premium NUMERIC NOT NULL DEFAULT 10,
    max_net_premium NUMERIC NOT NULL DEFAULT 20,
    min_long_dist INTEGER NOT NULL DEFAULT 500,
    max_sell_qty NUMERIC NOT NULL DEFAULT 10,
    atm_ratio_scaling BOOLEAN NOT NULL DEFAULT true,
    atm_ratio_distance_call NUMERIC NOT NULL DEFAULT 50,
    atm_ratio_distance_put NUMERIC NOT NULL DEFAULT 25,
    days_to_expiry NUMERIC NOT NULL DEFAULT 0,
    number_of_calls INTEGER NOT NULL DEFAULT 3,
    number_of_puts INTEGER NOT NULL DEFAULT 3,
    exit_type TEXT NOT NULL DEFAULT 'ATM',
    exit_points NUMERIC NOT NULL DEFAULT 0,
    short_exit_price NUMERIC NOT NULL DEFAULT 1.1,
    long_exit_slices INTEGER NOT NULL DEFAULT 10,
    variable_exit_slices BOOLEAN NOT NULL DEFAULT false,
    -- Which strategy logic this account runs: live accounts stay on 1 (stable),
    -- an experimental paper account is bumped to 2 to test new logic. Engine and
    -- UI both branch on this value. See migration 018.
    strategy_version INTEGER NOT NULL DEFAULT 1,
    -- Weekdays the account may OPEN new positions on (JS getDay(): 0=Sun..6=Sat),
    -- aligned to the 17:30 IST trading-day boundary. Entry-only gate, v2/paper only.
    -- See migration 021.
    trade_days JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.paper_trading_config ENABLE ROW LEVEL SECURITY;

-- Policies for configuration
CREATE POLICY "Users can manage config of their own accounts"
    ON public.paper_trading_config FOR ALL
    USING (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access on config"
    ON public.paper_trading_config FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Index for fast lookup by account ID
CREATE INDEX IF NOT EXISTS idx_config_account_id ON public.paper_trading_config(account_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PAPER TRADING SCHEDULES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_trading_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'Window',
    start_time TIME NOT NULL, -- IST time e.g. '17:30'
    end_time TIME NOT NULL,   -- IST time e.g. '22:29'
    number_of_calls INTEGER NOT NULL DEFAULT 3,
    number_of_puts INTEGER NOT NULL DEFAULT 3,
    min_long_dist INTEGER NOT NULL DEFAULT 500,
    min_strike_diff INTEGER NOT NULL DEFAULT 800,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.paper_trading_schedules ENABLE ROW LEVEL SECURITY;

-- Policies for schedules
CREATE POLICY "Users manage own schedules"
    ON public.paper_trading_schedules FOR ALL
    USING (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access on schedules"
    ON public.paper_trading_schedules FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow public read on schedules"
    ON public.paper_trading_schedules FOR SELECT
    USING (true);

-- Indexes for performance and sorting
CREATE INDEX IF NOT EXISTS idx_schedules_account_id 
    ON public.paper_trading_schedules (account_id, is_active, sort_order);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ACTIVE POSITIONS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.active_positions (
    id TEXT PRIMARY KEY, -- Formatted custom ID (e.g. 'T...')
    account_id UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    underlying TEXT NOT NULL,
    expiry TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'put')),
    buy_leg JSONB NOT NULL,
    sell_leg JSONB NOT NULL,
    hedge_leg JSONB DEFAULT NULL, -- migration 023: optional 3rd long-only leg (long/short/long triplet); NULL = plain 2-leg spread
    sell_qty NUMERIC NOT NULL,
    strike_diff INTEGER NOT NULL,
    entry_time TIMESTAMP WITH TIME ZONE NOT NULL,
    entry_buy_price NUMERIC NOT NULL,
    entry_sell_price NUMERIC NOT NULL,
    entry_spot_price NUMERIC NOT NULL,
    stages_exited INTEGER NOT NULL DEFAULT 0,
    margin NUMERIC NOT NULL DEFAULT 0,
    entry_fee NUMERIC NOT NULL DEFAULT 0,
    accumulated_sell_pnl NUMERIC NOT NULL DEFAULT 0,
    buy_strike NUMERIC NOT NULL,
    sell_strike NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.active_positions ENABLE ROW LEVEL SECURITY;

-- Policies for active positions
CREATE POLICY "Users can manage active positions of their own accounts"
    ON public.active_positions FOR ALL
    USING (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access on active positions"
    ON public.active_positions FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_active_positions_account ON public.active_positions(account_id);
CREATE INDEX IF NOT EXISTS idx_active_positions_type ON public.active_positions(account_id, type);

-- Unique constraints to prevent duplicate buy/sell strikes per account/underlying/type/expiry.
-- expiry MUST be part of the key: the same strike on two different expiries (e.g. 67000 on the
-- 16th vs 67000 on the 17th during an expiry roll) are genuinely DIFFERENT positions. Keying
-- without expiry made the second insert collide with 23505 — the "DB Guard: Duplicate strike
-- entry blocked" false positive. (See migration 025.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike);

-- Account-scoped Realtime subscriptions (filter: account_id=eq.X) must also receive
-- DELETE events. Under default replica identity the old row carries only the primary
-- key, so a filter on account_id can't match a delete and the event is dropped.
-- Instead of REPLICA IDENTITY FULL (which would put the entire old row — including the
-- heavy buy_leg/sell_leg JSON — into every UPDATE/DELETE payload), use a tiny unique
-- index carrying just (id, account_id): enough for the filter to match on account_id
-- and for delete handlers to read payload.old.id, with minimal Realtime egress.
-- Both the UI (PaperTrading.jsx) and the engine (paperTradingEngine.js) rely on this
-- to learn about closed positions in real time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_id_account
    ON public.active_positions (id, account_id);
-- REPLICA IDENTITY USING INDEX requires every index column to be NOT NULL. account_id is
-- declared NOT NULL above, but enforce it explicitly here so the migration also works on
-- existing databases where the column may have drifted to nullable.
ALTER TABLE public.active_positions ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE public.active_positions REPLICA IDENTITY USING INDEX idx_active_positions_id_account;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. TRADE HISTORY TABLE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id TEXT NOT NULL UNIQUE, -- Custom ID matching active_positions or PE/LS actions
    account_id UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    underlying TEXT NOT NULL,
    expiry TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('call', 'put')),
    buy_leg JSONB NOT NULL,
    sell_leg JSONB NOT NULL,
    hedge_leg JSONB DEFAULT NULL, -- migration 023: 3rd long-only leg snapshot when this row books a triplet's hedge exit
    sell_qty NUMERIC NOT NULL,
    strike_diff INTEGER NOT NULL,
    entry_time TIMESTAMP WITH TIME ZONE NOT NULL,
    entry_buy_price NUMERIC NOT NULL,
    entry_sell_price NUMERIC NOT NULL,
    entry_spot_price NUMERIC NOT NULL,
    margin NUMERIC NOT NULL DEFAULT 0,
    exit_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    exit_buy_price NUMERIC,
    exit_sell_price NUMERIC,
    exit_spot_price NUMERIC,
    realized_gross_pnl NUMERIC,
    realized_net_pnl NUMERIC,
    exit_fee NUMERIC,
    total_fees NUMERIC,
    exit_reason TEXT,
    is_partial BOOLEAN NOT NULL DEFAULT false,
    zombie_exit_time TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    lot_size NUMERIC DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.trade_history ENABLE ROW LEVEL SECURITY;

-- Policies for trade history
CREATE POLICY "Users can manage trade history of their own accounts"
    ON public.trade_history FOR ALL
    USING (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    )
    WITH CHECK (
        account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
            WHERE a.user_id = auth.uid()
        )
    );

CREATE POLICY "Service role full access on trade history"
    ON public.trade_history FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trade_history_account ON public.trade_history(account_id);
CREATE INDEX IF NOT EXISTS idx_trade_history_exit_time ON public.trade_history(account_id, exit_time DESC);

-- Server-side aggregation for the cumulative KPIs (total/today PnL, win counts).
-- The UI calls this instead of downloading the whole trade_history table on every
-- stats refresh, so egress stays O(1) row regardless of how large the history grows.
-- "today" uses the same UTC+12 day bucket as the client. SECURITY INVOKER (default)
-- so existing RLS on trade_history still gates access.
CREATE OR REPLACE FUNCTION public.get_trade_stats(p_account_id uuid, p_underlying text)
RETURNS TABLE (
  total_gross numeric,
  total_net   numeric,
  total_count bigint,
  win_gross   bigint,
  win_net     bigint,
  today_gross numeric,
  today_net   numeric
)
LANGUAGE sql STABLE
AS $$
  SELECT
    COALESCE(SUM(realized_gross_pnl), 0),
    COALESCE(SUM(realized_net_pnl),   0),
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(realized_gross_pnl, 0) > 0),
    COUNT(*) FILTER (WHERE COALESCE(realized_net_pnl,   0) > 0),
    COALESCE(SUM(realized_gross_pnl) FILTER (
      WHERE (exit_time + interval '12 hours')::date = (now() + interval '12 hours')::date), 0),
    COALESCE(SUM(realized_net_pnl) FILTER (
      WHERE (exit_time + interval '12 hours')::date = (now() + interval '12 hours')::date), 0)
  FROM public.trade_history
  WHERE account_id = p_account_id AND underlying = p_underlying;
$$;

GRANT EXECUTE ON FUNCTION public.get_trade_stats(uuid, text) TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ENGINE HEARTBEAT TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- UNLOGGED: ephemeral liveness state re-upserted every ~30s per engine. Making it
-- unlogged removes its WAL + autovacuum disk IO (migration 024); a crash just loses the
-- row until the engine rewrites it. fillfactor 70 keeps repeated updates HOT (in-page).
-- Read by the UI via polling (.select()), NOT Realtime — so it is not (and cannot be, as
-- an unlogged table) part of the supabase_realtime publication.
CREATE UNLOGGED TABLE IF NOT EXISTS public.engine_heartbeat (
    id TEXT PRIMARY KEY, -- e.g. 'paper_trading_<account_id>'
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'starting',
    underlying TEXT,
    expiry TEXT,
    active_positions INTEGER NOT NULL DEFAULT 0,
    ws_status TEXT,
    spot_price NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
) WITH (fillfactor = 70);

-- Enable RLS
ALTER TABLE public.engine_heartbeat ENABLE ROW LEVEL SECURITY;

-- Policies for engine heartbeat
CREATE POLICY "All authenticated users can read engine heartbeat"
    ON public.engine_heartbeat FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Service role full access on heartbeat"
    ON public.engine_heartbeat FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. DELTA EXCHANGE LIVE ACCOUNT LINKING (mode flag + encrypted credentials)
-- ─────────────────────────────────────────────────────────────────────────────
-- Lets a paper_trading_accounts row be flagged 'live' and linked to a real Delta
-- Exchange account. The API secret is encrypted at rest with pgcrypto using a key
-- held in Supabase Vault; the browser writes credentials through a SECURITY DEFINER
-- RPC and can never read the raw secret back. Only the headless engine
-- (service_role) can decrypt, via get_delta_credentials_decrypted (Stage 2).
--
-- ONE-TIME PREREQUISITE (run once, replace the passphrase with a long random string):
--   select vault.create_secret('CHANGE-ME-long-random', 'delta_cred_encryption_key');
--
-- The statements below are identical to supabase_migrations/001_delta_live_accounts.sql
-- and are idempotent, so running the master schema stays safe.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_accounts_mode_check'
  ) THEN
    ALTER TABLE public.paper_trading_accounts
      ADD CONSTRAINT paper_trading_accounts_mode_check CHECK (mode IN ('paper','live'));
  END IF;
END $$;

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS live_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.delta_credentials (
    account_id     UUID PRIMARY KEY REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    api_key        TEXT NOT NULL,
    api_secret_enc BYTEA NOT NULL,
    key_last4      TEXT,
    status         TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (status IN ('unverified','verified','invalid')),
    verified_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on delta_credentials" ON public.delta_credentials;
CREATE POLICY "Service role full access on delta_credentials"
    ON public.delta_credentials FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE OR REPLACE FUNCTION public._delta_cred_key()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
   WHERE name = 'delta_cred_encryption_key' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._delta_cred_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;
REVOKE ALL ON FUNCTION public._is_admin() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.upsert_delta_credentials(
  p_account_id UUID,
  p_api_key    TEXT,
  p_api_secret TEXT,
  p_verified   BOOLEAN DEFAULT false
)
RETURNS TABLE (account_id UUID, key_last4 TEXT, status TEXT, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner UUID;
  v_key   TEXT;
BEGIN
  SELECT user_id INTO v_owner FROM public.paper_trading_accounts WHERE id = p_account_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  IF v_owner <> auth.uid() AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;
  IF p_api_key IS NULL OR length(p_api_key) < 4
     OR p_api_secret IS NULL OR length(p_api_secret) < 4 THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured (missing vault secret "delta_cred_encryption_key")';
  END IF;

  INSERT INTO public.delta_credentials AS dc
    (account_id, api_key, api_secret_enc, key_last4, status, verified_at, updated_at)
  VALUES (
    p_account_id,
    p_api_key,
    extensions.pgp_sym_encrypt(p_api_secret, v_key),
    right(p_api_key, 4),
    CASE WHEN p_verified THEN 'verified' ELSE 'unverified' END,
    CASE WHEN p_verified THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (account_id) DO UPDATE SET
    api_key        = EXCLUDED.api_key,
    api_secret_enc = EXCLUDED.api_secret_enc,
    key_last4      = EXCLUDED.key_last4,
    status         = EXCLUDED.status,
    verified_at    = EXCLUDED.verified_at,
    updated_at     = now();

  RETURN QUERY
    SELECT dc.account_id, dc.key_last4, dc.status, dc.verified_at
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_delta_credentials_meta(p_account_id UUID)
RETURNS TABLE (account_id UUID, api_key TEXT, key_last4 TEXT, status TEXT,
               verified_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_owner UUID;
BEGIN
  SELECT user_id INTO v_owner FROM public.paper_trading_accounts WHERE id = p_account_id;
  IF v_owner IS NULL OR (v_owner <> auth.uid() AND NOT public._is_admin()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
    SELECT dc.account_id, dc.api_key, dc.key_last4, dc.status, dc.verified_at, dc.updated_at
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_credentials_meta(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_delta_credentials_meta(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_delta_credentials_decrypted(p_account_id UUID)
RETURNS TABLE (api_key TEXT, api_secret TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_key TEXT;
BEGIN
  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured';
  END IF;
  RETURN QUERY
    SELECT dc.api_key, extensions.pgp_sym_decrypt(dc.api_secret_enc, v_key)
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_credentials_decrypted(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_delta_credentials_decrypted(UUID) TO service_role;
