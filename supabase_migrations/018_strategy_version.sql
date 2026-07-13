-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 018 — per-account strategy_version (paper→live logic gate)
-- ─────────────────────────────────────────────────────────────────────────────
-- paper_trading_config.strategy_version — the "which strategy logic runs" flag for
-- an account. It lets experimental logic (new filters, changed entry/exit rules) be
-- tested on a PAPER account without touching LIVE accounts:
--
--   • Live accounts stay on version 1 (stable, validated logic).
--   • An experimental paper account is bumped to 2 to run the new logic.
--   • Both the engine (behavior) and the UI (which controls are shown) branch on the
--     SAME value: engine reads config.strategyVersion, the UI reads it off the loaded
--     config. So a v2-only filter neither runs nor appears on a v1 (live) account.
--   • Promotion = flip the live account's strategy_version to 2 (a single DB change,
--     no redeploy). Once every account is on the new version, delete the old branch.
--
-- Defaults to 1, so every EXISTING account (paper included) keeps its current
-- behaviour — additive and safe. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS strategy_version INTEGER NOT NULL DEFAULT 1;
