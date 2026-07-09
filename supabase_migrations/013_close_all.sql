-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013 — One-click "Close All" for live accounts
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard sets close_all_requested = true; the engine flattens the account
-- on Delta in one call (POST /v2/positions/close_all), cancels resting orders,
-- books Manual Exits, deletes the rows, then clears the flag. Falls back to
-- per-position reduce_only closes if the native call fails. Additive; default false.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS close_all_requested boolean NOT NULL DEFAULT false;
