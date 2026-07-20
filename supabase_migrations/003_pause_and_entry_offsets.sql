-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — Account pause + live entry price offsets
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. paper_trading_accounts.paused — when true the engine stops opening NEW
--    positions for the account but keeps managing open ones (and the resting
--    SL/TP orders stay on the exchange). Defaults false, so existing behaviour
--    (paper included) is unchanged.
-- 2. paper_trading_config.entry_buy_offset / entry_sell_offset — premium-dollar
--    offsets applied ONLY to LIVE entry order limit prices (buy at ask+offset,
--    sell at bid-offset) to make marketable entries fill. Paper ignores them.
--
-- Additive only. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_buy_offset numeric NOT NULL DEFAULT 10;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_sell_offset numeric NOT NULL DEFAULT 3;
