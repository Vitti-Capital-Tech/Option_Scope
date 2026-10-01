-- Migration 048: net_deposits on live_daily_stats (migrations 045–047).
--
-- Deposits, withdrawals and transfers move the wallet balance without being P&L. They come
-- from the Delta wallet ledger (transaction_type deposit / withdrawal / transfer…), summed
-- with their sign: + money in, − money out. NULL = unknown (ledger not read).
--
-- Return % now uses the capital actually available that day as its base:
--     return_pct = net_pnl ÷ (opening_balance + max(0, net_deposits)) × 100
-- and the Daily Report's range total uses: first day's opening + Σ net_deposits.
--
-- Run BEFORE deploying the engine/backfill code that writes this column.

ALTER TABLE public.live_daily_stats
  ADD COLUMN IF NOT EXISTS net_deposits NUMERIC;
