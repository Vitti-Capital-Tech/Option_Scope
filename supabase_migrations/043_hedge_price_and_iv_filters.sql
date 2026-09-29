-- Migration 043: hedge strike filters (hedge_max_price, hedge_iv_diff_min/max) on paper_trading_schedules
--
-- The hedge leg's strike is no longer placed one strike-width beyond the short. It is now the
-- strike beyond the short (call: above, put: below), nearest the short, that passes both:
--   • hedge_max_price    — its price (ask) must be BELOW this (default 10)
--   • hedge_iv_diff_min / hedge_iv_diff_max — |hedge IV − short IV| must lie in this range
--                          (inclusive, default [0, 2])
-- Paper accounts with strategy_version >= 2 only (live never hedges). Additive; the defaults
-- apply to every existing window.

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS hedge_max_price NUMERIC NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS hedge_iv_diff_min NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_iv_diff_max NUMERIC NOT NULL DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_hedge_filters_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_hedge_filters_check
      CHECK (hedge_max_price >= 0 AND hedge_iv_diff_min >= 0 AND hedge_iv_diff_max >= hedge_iv_diff_min);
  END IF;
END $$;
