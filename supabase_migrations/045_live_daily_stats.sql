-- Migration 045: live_daily_stats — one row per LIVE account per trading day.
--
-- Feeds the Daily Report tab (P&L, % return, fees, max margin used; CSV / Excel export).
-- The trading day runs 17:30 → 17:30 IST (= 12:00 → 12:00 UTC), the boundary the rest of
-- the app uses, and is named for the date it ENDS on: trade_date = (ts + 12 hours)::date.
--
-- Written only by the engine (service_role). Sources:
--   • max_margin_used / _at / _pct, closing_balance, unrealized_pnl — sampled from Delta on
--     every live snapshot (~10s): margin used = wallet balance − available_balance (what
--     Delta blocks for positions and orders). The running max is saved as it rises, so a
--     restart doesn't lose the day's peak.
--   • opening_balance — the first wallet balance seen in the day.
--   • fees_actual / fills_count — Delta's own commission, summed over that day's fills.
--   • realized_gross_pnl / fees_estimated / trades_closed — the day's trade_history rows.
--   • net_pnl = realized_gross_pnl − fees (actual if known, else estimated);
--     return_pct = net_pnl ÷ opening_balance × 100.
-- is_final flips to true once the day has ended and its totals were recomputed.

CREATE TABLE IF NOT EXISTS public.live_daily_stats (
    account_id         UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    trade_date         DATE NOT NULL,
    opening_balance    NUMERIC,
    closing_balance    NUMERIC,
    realized_gross_pnl NUMERIC NOT NULL DEFAULT 0,
    fees_actual        NUMERIC,
    fees_estimated     NUMERIC NOT NULL DEFAULT 0,
    net_pnl            NUMERIC NOT NULL DEFAULT 0,
    return_pct         NUMERIC,
    unrealized_pnl     NUMERIC,
    max_margin_used    NUMERIC,
    max_margin_at      TIMESTAMP WITH TIME ZONE,
    max_margin_pct     NUMERIC,
    trades_closed      INTEGER NOT NULL DEFAULT 0,
    fills_count        INTEGER NOT NULL DEFAULT 0,
    is_final           BOOLEAN NOT NULL DEFAULT false,
    updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_live_daily_stats_date ON public.live_daily_stats (trade_date DESC);

ALTER TABLE public.live_daily_stats ENABLE ROW LEVEL SECURITY;

-- Read: the account owner, or an admin (same rule as every other per-account table).
DROP POLICY IF EXISTS "Account owners can read live daily stats" ON public.live_daily_stats;
CREATE POLICY "Account owners can read live daily stats"
    ON public.live_daily_stats FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Write: the engine only.
DROP POLICY IF EXISTS "Service role full access on live daily stats" ON public.live_daily_stats;
CREATE POLICY "Service role full access on live daily stats"
    ON public.live_daily_stats FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
