-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 021 — per-account Trading Days (day-of-week entry filter, paper v2)
-- ─────────────────────────────────────────────────────────────────────────────
-- paper_trading_config.trade_days — the set of weekdays on which the account is
-- allowed to OPEN new positions. A JSONB array of weekday numbers matching JS
-- getDay(): 0 = Sunday … 6 = Saturday. Default is all seven, so existing accounts
-- trade every day exactly as before.
--
-- A "trading day" is aligned to the schedule timeline's 17:30 IST boundary (the same
-- boundary the Schedule Panel uses): the trading day named for weekday W runs from
-- (W-1) 17:30 IST to W 17:30 IST. So at/after 17:30 IST the active trading day is
-- TOMORROW's weekday. e.g. Friday enabled ⇒ tradeable Thu 17:30 → Fri 17:30 IST;
-- Sunday disabled ⇒ blocked Sat 17:30 → Sun 17:30 IST.
--
-- Entry-only gate: a disabled day blocks NEW entries but never exits/position
-- management (like `paused`). Experimental (strategy_version >= 2 / paper) only — v1
-- (live) accounts ignore it and the control is hidden from their UI. Additive.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS trade_days JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb;
