-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009 — Live exchange state snapshot (real Delta orders/fills/positions)
-- ─────────────────────────────────────────────────────────────────────────────
-- For armed live accounts the engine periodically READS the account's real state
-- from Delta (positions, resting orders, stop orders, fills, wallet balances) and
-- upserts one row per account here. The UI reads this to populate the Positions /
-- Open Orders / Stop Orders / Fills / Risk & Margin tabs with exchange truth
-- instead of engine-internal bookkeeping.
--
-- READ-ONLY with respect to the exchange — publishing this snapshot places no
-- orders. Paper accounts never write here (row stays absent → UI falls back to the
-- engine-derived views). One row per account; blobs are JSONB and small.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_exchange_state (
    account_id   UUID PRIMARY KEY REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    positions    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- /v2/positions/margined
    orders       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- resting limit orders
    stop_orders  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- resting stop orders
    fills        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- recent executions
    balances     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- /v2/wallet/balances
    wallet       NUMERIC                              -- extracted usable balance
);

ALTER TABLE public.live_exchange_state ENABLE ROW LEVEL SECURITY;

-- Read gated to authenticated users (same posture as engine_heartbeat). Only the
-- account owner meaningfully cares, but the account_id key already scopes reads.
CREATE POLICY "All authenticated users can read live exchange state"
    ON public.live_exchange_state FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Service role full access on live_exchange_state"
    ON public.live_exchange_state FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
