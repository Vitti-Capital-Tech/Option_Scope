-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012 — per-window Max Net Debit + Exit Type
-- ─────────────────────────────────────────────────────────────────────────────
-- Max Net Debit and Exit Type (+ Exit Points) move from the account-level Control
-- Panel to each time-schedule window, so different windows can run different entry
-- debit caps and exit rules. The account-level values remain as the fallback used
-- when no window is active (the uncovered-slot gap). Additive; safe defaults match
-- the previous account-level defaults.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS max_net_premium NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS exit_type TEXT NOT NULL DEFAULT 'ATM',
  ADD COLUMN IF NOT EXISTS exit_points INTEGER NOT NULL DEFAULT 0;
