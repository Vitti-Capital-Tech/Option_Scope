-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 073 — Saved ATM IV history (IV Analysis)
-- ─────────────────────────────────────────────────────────────────────────────
-- The IV Analysis tab computes ATM IV in the browser from Delta's candles and keeps nothing,
-- and an expired option's candles are gone with it — so weeks of IV can't be looked back at.
-- engine/ivRecorder.js (its own PM2 process, public market data only, no trading) writes one
-- row per minute per underlying (BTC, ETH) for the two nearest unsettled expiries:
--   expiry_rank 0 = nearest expiry, 1 = the next one (a continuous "front expiry" series is
--   expiry_rank = 0 across days).
--   atm_strike = listed strike of that expiry nearest the spot; call_iv / put_iv = Delta's mark
--   IV of that strike's call / put in percent (what the IV Analysis chart reproduces from mark
--   prices); atm_iv = their average.
-- ~5,800 rows/day; 3 weeks ≈ 120k rows.
--
-- Read by signed-in users (export in IV Analysis); written only by the service role.
-- Additive and safe to re-run. Run before starting the recorder.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.iv_history (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMP WITH TIME ZONE NOT NULL,          -- the minute (UTC, seconds = 0)
    underlying TEXT NOT NULL,
    expiry TIMESTAMP WITH TIME ZONE NOT NULL,      -- settlement time
    expiry_rank SMALLINT NOT NULL,                 -- 0 = nearest expiry, 1 = next
    spot NUMERIC NOT NULL,
    atm_strike NUMERIC NOT NULL,
    call_iv NUMERIC,                               -- percent
    put_iv NUMERIC,                                -- percent
    atm_iv NUMERIC,                                -- percent, avg of call/put
    call_mark NUMERIC,
    put_mark NUMERIC,
    hours_to_expiry NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (underlying, expiry, ts)
);

CREATE INDEX IF NOT EXISTS iv_history_lookup ON public.iv_history (underlying, expiry_rank, ts);

ALTER TABLE public.iv_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Signed-in users read IV history" ON public.iv_history;
CREATE POLICY "Signed-in users read IV history"
    ON public.iv_history FOR SELECT
    USING (auth.role() = 'authenticated');
