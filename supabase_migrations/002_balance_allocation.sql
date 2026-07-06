-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — Balance allocation for live position sizing
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a per-account "% of wallet balance to allocate" used ONLY by live accounts
-- to size positions (usable = balance × pct; part = usable / max positions; each
-- position uses up to 1 part of margin). Paper accounts get the column with the
-- default 90 but never use it, so paper trading is unaffected.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data is modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS balance_allocation_pct numeric NOT NULL DEFAULT 90;

-- Keep it sane (1–100%).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_balance_allocation_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_balance_allocation_pct_check
      CHECK (balance_allocation_pct > 0 AND balance_allocation_pct <= 100);
  END IF;
END $$;
