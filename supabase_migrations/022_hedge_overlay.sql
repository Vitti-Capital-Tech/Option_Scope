-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 022 — per-window Hedge Overlay (long-only, paper strategy_version >= 2)
-- ─────────────────────────────────────────────────────────────────────────────
-- A schedule window can open an extra LONG-ONLY "hedge overlay" position, sized as a
-- share of the account's active short exposure of that type:
--
--   • hedge_strike_type — 'none' | 'call' | 'put' | 'both'. Which type(s) to hedge.
--   • hedge_call_price / hedge_put_price — TARGET PREMIUM ($). The engine buys the OTM
--     strike of that type whose ask is nearest to this price.
--   • hedge_call_pct / hedge_put_pct — buy qty = (sum of active short qty of that type,
--     this underlying) × pct/100.
--
-- The overlay is entered ONCE while the window is active (and short exposure exists),
-- and it DRAINS proportionally as the main book exits: with N = that type's open long
-- positions at overlay entry, each subsequent full exit of such a position sells 1/N of
-- the overlay (target lot = buyQty × openLongs/N), so it is fully closed once all have
-- exited. Marked with buy_leg.isHedge = true; exempt from the normal caps and exit rules.
--
-- Experimental (strategy_version >= 2 / paper) only; v1 (live) ignores it and the UI is
-- hidden. Defaults ('none' / 0) leave existing windows unchanged. Additive.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS hedge_strike_type TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS hedge_call_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_call_pct NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_put_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_put_pct NUMERIC NOT NULL DEFAULT 0;
