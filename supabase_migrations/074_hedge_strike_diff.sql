-- Migration 074: Min Hedge Strike Diff (hedge_strike_diff_min) on paper_trading_schedules
--
-- The hedge (3rd long) strike must be at least this many points beyond the SHORT strike
-- (default 0 = off). The farthest allowed hedge stays as before: spread width − one strike step.
-- PAPER accounts only — the engine ignores it for live accounts. Additive; the default keeps
-- every existing window's behaviour unchanged.

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS hedge_strike_diff_min NUMERIC NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_hedge_strike_diff_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_hedge_strike_diff_check
      CHECK (hedge_strike_diff_min >= 0);
  END IF;
END $$;
