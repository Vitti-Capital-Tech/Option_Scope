-- 026: Drop the legacy no-expiry strike CONSTRAINTS and make sell-strike uniqueness partial.
--
-- ── Root cause of the 65500/67000 incident (why migration 025 didn't fix it) ──
-- The database still carries two ORIGINAL unique CONSTRAINTS created out-of-band, keyed
-- WITHOUT expiry:
--     unique_buy_strike_per_type  (account_id, underlying, type, buy_strike)
--     unique_sell_strike_per_type (account_id, underlying, type, sell_strike)
-- Migration 025 tried to re-key uniqueness to include expiry, but it only ran
-- `DROP INDEX IF EXISTS idx_active_positions_*` — the NEW index names. It never touched the
-- legacy constraints, and a constraint-backed index cannot be dropped with DROP INDEX at all
-- (Postgres requires ALTER TABLE ... DROP CONSTRAINT). So `unique_sell_strike_per_type`
-- survived, and being the stricter (no-expiry) enforcer it is what actually rejected the
-- 17th-July 67000 insert as a duplicate of the 16th-July 67000 — the 23505 that orphaned the
-- spread. 025's expiry-aware index was live but redundant behind the still-present constraint.
--
-- ── Fix ──
-- 1. Drop both legacy no-expiry constraints (and any same-named plain indexes, defensively).
-- 2. Recreate the buy-strike index WITH expiry, non-partial (a long-only remnant still holds a
--    real long at its buy strike, so duplicate longs there must stay blocked).
-- 3. Recreate the sell-strike index WITH expiry and PARTIAL (WHERE sell_qty > 0): a long-only
--    remnant (short bought back, sell_qty = 0) keeps its sell_strike populated but holds no
--    active short, so it must NOT reserve that strike — a new spread may short it again,
--    possibly paired with a different buy strike. This also matches the pre-order guard
--    (which filters sell_qty > 0), closing the fail-open -> orphan window. Two genuine active
--    shorts at the same strike/expiry both carry sell_qty > 0 and remain blocked.

-- 1. Remove the legacy no-expiry enforcers (constraint form, then defensively index form).
ALTER TABLE public.active_positions DROP CONSTRAINT IF EXISTS unique_buy_strike_per_type;
ALTER TABLE public.active_positions DROP CONSTRAINT IF EXISTS unique_sell_strike_per_type;
DROP INDEX IF EXISTS public.unique_buy_strike_per_type;
DROP INDEX IF EXISTS public.unique_sell_strike_per_type;

-- 2. Buy-strike uniqueness: expiry-aware, non-partial.
DROP INDEX IF EXISTS public.idx_active_positions_buy_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);

-- 3. Sell-strike uniqueness: expiry-aware, partial on active shorts only.
DROP INDEX IF EXISTS public.idx_active_positions_sell_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike)
    WHERE sell_qty > 0;
