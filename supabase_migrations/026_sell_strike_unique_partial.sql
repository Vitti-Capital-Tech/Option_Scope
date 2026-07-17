-- 026: Make the sell-strike uniqueness index PARTIAL (WHERE sell_qty > 0).
--
-- When a spread's short leg is bought back (SL fill / resting exit), the position becomes
-- long-only: the row stays in active_positions with sell_qty = 0, but its sell_strike column
-- is left populated (only sell_qty/sell_leg are updated — see paperTradingEngine.js short-SL
-- path). Under the non-partial index (migration 025), that dead remnant kept "reserving" its
-- sell_strike, so a new spread that shorts the SAME strike on the SAME expiry — even paired
-- with a DIFFERENT buy strike — was rejected with 23505, even though no active short existed
-- at that strike. That both blocked a legitimate re-entry AND, because the pre-order guard
-- filters sell_qty > 0 while the index did not, opened the fail-open → orphan window (guard
-- passes, orders go live, insert then rejected).
--
-- Scope the index to sell_qty > 0 so only positions with an ACTIVE short reserve a sell
-- strike. Long-only remnants no longer block re-entry, and the guard (which already filters
-- sell_qty > 0) now matches the index exactly — no post-order 23505 from a remnant. A genuine
-- duplicate (two active shorts, same strike/expiry) still has sell_qty > 0 on both rows, so it
-- remains blocked. The buy-strike index stays non-partial: a long-only remnant still holds a
-- real long at its buy strike, so duplicate longs there must still be blocked.

DROP INDEX IF EXISTS public.idx_active_positions_sell_strike_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike)
    WHERE sell_qty > 0;
