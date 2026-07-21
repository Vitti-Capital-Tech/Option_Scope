-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027 — Paper initial balance + combined-position sizing
-- ─────────────────────────────────────────────────────────────────────────────
-- Brings a real funded-account model to PAPER trading (paper only — live is
-- unchanged and keeps its wallet-balance sizing + number_of_calls/number_of_puts).
--
--   • initial_balance          — the paper account's starting equity. Live equity =
--                                initial_balance + cumulative realized P&L. The
--                                tradeable margin pool = equity × balance_allocation_pct;
--                                the remainder stays as an untouched buffer.
--   • max_combined_positions   — per-window cap on TOTAL open full spreads (calls+puts).
--   • combined_split_pct       — per-window %. Derived per-type cap (paper) =
--                                ceil(combined_split_pct/100 × max_combined_positions),
--                                applied to BOTH calls and puts; the combined total is
--                                still hard-capped at max_combined_positions.
--
-- balance_allocation_pct already exists (migration 002) and is reused for paper.
-- Per-position margin = allocated pool ÷ the ACTIVE window's max_combined_positions.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed. The config
-- columns are account-level fallbacks used when a window predates this migration or
-- when there are no active windows; the schedule columns are the primary per-window
-- values the engine sizes on.
-- ─────────────────────────────────────────────────────────────────────────────

-- Account-level (fallback) config
ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS initial_balance numeric NOT NULL DEFAULT 3000;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS max_combined_positions integer NOT NULL DEFAULT 4;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS combined_split_pct numeric NOT NULL DEFAULT 70;

-- Per-window (primary) schedule values
ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS max_combined_positions integer NOT NULL DEFAULT 4;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS combined_split_pct numeric NOT NULL DEFAULT 70;

-- Keep the values sane.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_initial_balance_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_initial_balance_check
      CHECK (initial_balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_max_combined_positions_check
      CHECK (max_combined_positions >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_combined_split_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_combined_split_pct_check
      CHECK (combined_split_pct > 0 AND combined_split_pct <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_max_combined_positions_check
      CHECK (max_combined_positions >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_combined_split_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_combined_split_pct_check
      CHECK (combined_split_pct > 0 AND combined_split_pct <= 100);
  END IF;
END $$;
