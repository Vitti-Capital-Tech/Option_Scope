-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 023 — per-spread Hedge Leg (long/short/long triplet, paper strategy_version >= 2)
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaces the standalone "Hedge Overlay" model (migration 022) with a 3rd LONG-ONLY leg
-- baked INTO each ratio spread, so an entered call/put spread becomes a long/short/long
-- triplet. The 5 per-window config fields from migration 022 are REUSED as-is to drive it:
--
--   • hedge_strike_type — 'none' | 'call' | 'put' | 'both'. Which spread type(s) get a 3rd leg.
--   • hedge_call_price / hedge_put_price — PREMIUM BUDGET ($). The engine buys the OTM strike
--     of that type whose ask is the highest ≤ this budget (most protective still in budget).
--   • hedge_call_pct / hedge_put_pct — 3rd-long qty = (THIS spread's own short qty) × pct/100.
--
-- The 3rd long is attached to its parent spread (new `hedge_leg` JSONB column below), gated
-- into entry by the COMBINED (3-leg) net-debit vs maxNetPremium, and exits ONLY on the main
-- long's ATM/ITM/OTM spot-cross or expiry (never short-bought-back / laddered / drained). If
-- the short buys back and the main long fully ladders out first, the hedge is HELD (row stays
-- alive, hedge-only) until ATM/ITM/OTM or expiry.
--
-- A NULL `hedge_leg` means a plain 2-leg spread (all existing rows unaffected). Experimental
-- (strategy_version >= 2 / paper) only; v1 (live) ignores it. Additive.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS hedge_leg JSONB DEFAULT NULL;

ALTER TABLE public.trade_history
  ADD COLUMN IF NOT EXISTS hedge_leg JSONB DEFAULT NULL;
