-- Migration 066: Account max SL — PAPER ONLY.
--
-- paper_trading_config.max_sl_pct: % of the paper account's balance (initial balance +
-- realized P&L). When the account's total unrealized P&L reaches −(balance × max_sl_pct%)
-- or below, the engine closes EVERY open position of the account (booked as 'Max SL Exit').
-- The account is not paused — entries carry on as usual afterwards.
-- e.g. balance $2,000 at 20% → all positions closed at −$400 unrealized.
-- Default 20; 0 = off. Live accounts ignore it.
--
-- Group sync (sync_account_group) copies every config column dynamically — no RPC change.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS max_sl_pct NUMERIC NOT NULL DEFAULT 20
    CHECK (max_sl_pct >= 0 AND max_sl_pct <= 100);
