-- Migration 039: ATM edge floors (min_atm_pnl / min_atm_roi) on paper_trading_config
--
-- The entry gate's ATM P&L floor was the hardcoded constant 50 (discounted by the ATM-ratio
-- scaling percentage when scaling is on). That constant is calibrated for BTC, where the
-- $195,000 short-notional cap binds and scales the candidate up to a ~$1,000-margin unit.
-- It cannot bind on ETH: reaching $195,000 at a ~$2,400 spot needs a sell ratio of ~81,
-- against a maxSellQty of 10 — so an ETH candidate is always measured on its unscaled
-- 1-unit basis, and a genuinely good spread reads as single-digit dollars. Observed
-- 2026-09-03 on the JD Eth account: CALL 2800/2900 at **35.38% ROI** was rejected for an
-- ATM P&L of $9.50 against a $25.00 floor.
--
-- These two columns make the floor explicit and add the ROI floor the scanner UI already
-- has (its "ATM Edge Floors"), so an account can be gated on the dimension that actually
-- travels across underlyings. GLOBAL (account-level), not per schedule window, and applied
-- to PAPER accounts only — live keeps the historical constant.
--
-- Defaults preserve today's behaviour for BTC paper accounts: 50 is the same constant the
-- code used, and the 2% ROI floor is below what any candidate that clears a $50 ATM P&L
-- at a ~$1,000 margin already achieves.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS min_atm_pnl NUMERIC NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS min_atm_roi NUMERIC NOT NULL DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_min_atm_pnl_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_min_atm_pnl_check CHECK (min_atm_pnl >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_min_atm_roi_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_min_atm_roi_check CHECK (min_atm_roi >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.paper_trading_config.min_atm_pnl IS
  'Paper only. Minimum ATM P&L ($) an entry candidate must clear. Still discounted by the ATM-ratio scaling pct when atm_ratio_scaling is on, exactly as the old hardcoded 50 was. Live accounts ignore this and keep the 50 constant.';
COMMENT ON COLUMN public.paper_trading_config.min_atm_roi IS
  'Paper only. Minimum ATM ROI (%) an entry candidate must clear, applied flat (no scaling discount) to match the scanner UI. Live accounts ignore this.';
