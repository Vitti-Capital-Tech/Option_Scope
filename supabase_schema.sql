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
    spot_diff NUMERIC NOT NULL DEFAULT 0.5,
    exit_type TEXT NOT NULL DEFAULT 'ATM',
    exit_points NUMERIC NOT NULL DEFAULT 0,
    leg_swap_premium NUMERIC NOT NULL DEFAULT 0,
    short_exit_price NUMERIC NOT NULL DEFAULT 1.1,
    long_exit_slices INTEGER NOT NULL DEFAULT 10,
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

-- Unique constraints to prevent duplicate buy/sell strikes per account/underlying/type
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique 
    ON public.active_positions(account_id, underlying, type, buy_strike);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, sell_strike);

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
CREATE TABLE IF NOT EXISTS public.engine_heartbeat (
    id TEXT PRIMARY KEY, -- e.g. 'paper_trading_<account_id>'
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'starting',
    underlying TEXT,
    expiry TEXT,
    active_positions INTEGER NOT NULL DEFAULT 0,
    ws_status TEXT,
    spot_price NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
