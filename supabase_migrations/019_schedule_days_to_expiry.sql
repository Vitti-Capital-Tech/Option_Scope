-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 019 — per-window Min Days to Expiry (paper strategy_version >= 2)
-- ─────────────────────────────────────────────────────────────────────────────
-- days_to_expiry moves from the account-level Control Panel into each time-schedule
-- window, so an experimental PAPER account (strategy_version >= 2) can set a
-- different min-days-to-expiry per window. LIVE accounts (version 1) keep the
-- account-level config field and ignore this column.
--
-- Because the engine trades ONE expiry at a time, expiry auto-selection uses the
-- PEAK (largest) days_to_expiry across active windows (so the selected expiry is
-- valid for every window); each window then guards its own entries with its own
-- value. See the STRATEGY VERSIONING + refreshProducts notes in paperTradingEngine.js.
--
-- Defaults to 0 (same as the previous account-level default), so existing windows
-- are unchanged. Additive; no data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS days_to_expiry NUMERIC NOT NULL DEFAULT 0;
