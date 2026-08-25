-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 037 — per-window Min IV Edge + All Positions Same Type control
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. min_iv_diff: Shifts the Min IV Edge filter from the global control panel into
--    per-schedule-window controls, allowing individual IV diff thresholds per window.
-- 2. all_same_type: Checkbox/toggle to force all positions in a window to be of a single type.
-- 3. same_type: When all_same_type is true, determines whether all positions are 'call' or 'put'.
--    When active, max_combined_positions are all allocated to this type and combined_split_pct is bypassed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS min_iv_diff NUMERIC NOT NULL DEFAULT 5;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS all_same_type BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS same_type TEXT NOT NULL DEFAULT 'call';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_same_type_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_same_type_check
      CHECK (same_type IN ('call', 'put'));
  END IF;
END $$;
