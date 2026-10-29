-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 068 — Live hedge entry offset
-- ─────────────────────────────────────────────────────────────────────────────
-- paper_trading_config.entry_hedge_offset — premium-dollar offset for the LIVE hedge
-- (3rd long) entry order: limit = hedge ask + this, and the entry chase never re-prices
-- above it. Before this the hedge used entry_buy_offset (sized for a $100+ long), so a
-- ~$5 hedge was sent at $10–$15 and filled up to that (2026-10-27 23:04, P-BTC-78600).
-- Editable per account next to Buy / Sell Offset. Copied by group sync with the other
-- config columns. Paper ignores it.
--
-- Additive only. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_hedge_offset numeric NOT NULL DEFAULT 2;
