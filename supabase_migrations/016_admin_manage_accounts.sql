-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016 — Let admins manage accounts they don't own
-- ─────────────────────────────────────────────────────────────────────────────
-- The credential RPCs already allow an admin (profiles.role = 'admin') to act on
-- ANY account, but the table RLS policies only allow the account OWNER
-- (user_id = auth.uid()). So an admin managing a client's account could NOT, from
-- the UI: close an orphan leg (delta_close_requests), cancel an order
-- (delta_cancel_requests), manually exit a position (active_positions), trigger
-- close-all / toggle live_enabled (paper_trading_accounts), or save config /
-- schedules — every such write failed RLS with:
--   "new row violates row-level security policy".
--
-- This migration extends each client-write policy with an admin bypass, using the
-- same inline admin check the existing "Admins can manage all profiles" policy
-- uses (no function-grant changes needed). Service-role policies are untouched.
-- Idempotent: every policy is DROP-then-CREATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- Accounts ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their own accounts" ON public.paper_trading_accounts;
CREATE POLICY "Users can manage their own accounts"
    ON public.paper_trading_accounts FOR ALL
    USING (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Config ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage config of their own accounts" ON public.paper_trading_config;
CREATE POLICY "Users can manage config of their own accounts"
    ON public.paper_trading_config FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Schedules ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own schedules" ON public.paper_trading_schedules;
CREATE POLICY "Users manage own schedules"
    ON public.paper_trading_schedules FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Active positions (manual exit) ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage active positions of their own accounts" ON public.active_positions;
CREATE POLICY "Users can manage active positions of their own accounts"
    ON public.active_positions FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Trade history ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage trade history of their own accounts" ON public.trade_history;
CREATE POLICY "Users can manage trade history of their own accounts"
    ON public.trade_history FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Close requests (per-leg ✕, incl. orphans) ──────────────────────────────────
DROP POLICY IF EXISTS "Users manage close requests of their own accounts" ON public.delta_close_requests;
CREATE POLICY "Users manage close requests of their own accounts"
    ON public.delta_close_requests FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Cancel requests (per-order ✕) ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage cancel requests of their own accounts" ON public.delta_cancel_requests;
CREATE POLICY "Users manage cancel requests of their own accounts"
    ON public.delta_cancel_requests FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );
