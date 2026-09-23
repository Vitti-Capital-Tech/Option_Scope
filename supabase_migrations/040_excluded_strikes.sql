-- Migration 040: excluded strikes (excluded_strikes) on paper_trading_config
--
-- A global, account-level blacklist of strike prices the user does not want to trade.
-- The engine removes these strikes from the entry scan pool for BOTH calls and puts, so
-- neither the long nor the short leg of a new spread (nor a v2 hedge leg) can land on
-- one. Open positions already on an excluded strike are not touched — the list gates
-- NEW entries only. The ATM strike and intrinsic pricing still read the full chain.
--
-- PAPER accounts only (same scope as migration 039's ATM edge floors); live accounts
-- ignore the column. Stored as a JSON array of numbers, like trade_days. Default [] =
-- nothing excluded = today's behaviour.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS excluded_strikes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_excluded_strikes_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_excluded_strikes_check
      CHECK (jsonb_typeof(excluded_strikes) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN public.paper_trading_config.excluded_strikes IS
  'Paper only. JSON array of strike prices no new entry leg (long, short or hedge) may use, for calls and puts alike. Open positions are unaffected. Live accounts ignore this.';
