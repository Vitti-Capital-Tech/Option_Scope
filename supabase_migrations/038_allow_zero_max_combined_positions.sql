-- Migration 038: Allow 0 for max_combined_positions in paper_trading_config and paper_trading_schedules
-- Allows users to disable new entries in specific schedule windows or globally by setting maxCombinedPositions = 0.

DO $$
BEGIN
  -- 1. paper_trading_config
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      DROP CONSTRAINT paper_trading_config_max_combined_positions_check;
  END IF;

  ALTER TABLE public.paper_trading_config
    ADD CONSTRAINT paper_trading_config_max_combined_positions_check
    CHECK (max_combined_positions >= 0);

  -- 2. paper_trading_schedules
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      DROP CONSTRAINT paper_trading_schedules_max_combined_positions_check;
  END IF;

  ALTER TABLE public.paper_trading_schedules
    ADD CONSTRAINT paper_trading_schedules_max_combined_positions_check
    CHECK (max_combined_positions >= 0);
END $$;
