-- Migration 044: Shared Long Strikes (paper v2) — one long strike may carry TWO spreads.
--
-- New per-window setting `shared_long_strikes` (0 = off, the default). When N > 0 on a paper
-- account with strategy_version >= 2, the N long strikes nearest ATM (calls and puts
-- together) may each be used by up to two spreads that share the same long but have
-- different shorts — the two valid shorts nearest ATM. Each spread is its own position
-- (own cap slot, own margin). Live accounts and v1 ignore the setting.
--
-- The one-long-per-strike rule is also enforced by idx_active_positions_buy_strike_unique
-- (migration 026). That index gains `long_share_slot` (0 or 1): every existing and every
-- non-shared position is slot 0, so uniqueness is exactly as before for them; a second
-- spread on a shared long takes slot 1. At most two positions can therefore ever hold the
-- same long strike, and live (always slot 0) keeps strict one-long-per-strike.
-- Short-strike uniqueness (partial, sell_qty > 0) is unchanged: the two spreads always use
-- different shorts.
--
-- Additive and safe to run before the new engine/frontend are deployed.

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS shared_long_strikes INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_shared_long_strikes_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_shared_long_strikes_check
      CHECK (shared_long_strikes >= 0);
  END IF;
END $$;

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS long_share_slot SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'active_positions_long_share_slot_check'
  ) THEN
    ALTER TABLE public.active_positions
      ADD CONSTRAINT active_positions_long_share_slot_check
      CHECK (long_share_slot IN (0, 1));
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_active_positions_buy_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike, long_share_slot);
