-- Migration 075: Partial scale-down Ratio Gap (partial_scale_ratio_gap) on paper_trading_config
--
-- The ATM-ratio partial scale-down (engine applyAtmRatioScaling) sells a slice of the long only
-- while the live ATM ratio is at least the ratio after that slice PLUS a gap:
--     liveAtmRatio >= recalculatedRatio + gap
-- The gap was fixed at 1. It is now a Control Panel field (Partial Scale-Down → Ratio Gap),
-- default 1 = unchanged behaviour. Paper AND live, like the other 063 controls; synced across
-- groups (sync_account_group copies every config column dynamically — no RPC change).
-- Additive and safe to re-run.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS partial_scale_ratio_gap NUMERIC NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_partial_scale_ratio_gap_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_partial_scale_ratio_gap_check
      CHECK (partial_scale_ratio_gap >= 0 AND partial_scale_ratio_gap <= 100);
  END IF;
END $$;
