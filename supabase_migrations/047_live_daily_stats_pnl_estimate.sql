-- Migration 047: pnl_is_estimate on live_daily_stats (migrations 045/046).
--
-- realized_gross_pnl normally holds Delta's own realized P&L (order history meta_data.pnl).
-- For days before Delta's order history reaches (backfill), or before the live tracker's
-- first successful Delta read, it falls back to trade_history's engine-side P&L, which can
-- differ a lot from Delta for live accounts. Those rows are flagged so the Daily Report
-- tags realized / net / return as "est.". Defaults to false.
--
-- Run BEFORE deploying the engine/backfill code that writes this column.

ALTER TABLE public.live_daily_stats
  ADD COLUMN IF NOT EXISTS pnl_is_estimate BOOLEAN NOT NULL DEFAULT false;
