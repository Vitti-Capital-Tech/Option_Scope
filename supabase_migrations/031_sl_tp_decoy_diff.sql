-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 031 — SL/TP decoy diff (live only)
-- ─────────────────────────────────────────────────────────────────────────────
-- Delta appears to leak resting SL/TP levels to market makers. To hide the real
-- exit, the engine now places the exchange bracket/stop at a DECOY level and
-- triggers the REAL exit itself (its existing spot-cross catch-all market-closes
-- reduce-only at the true level). The exchange order stays as a genuine fallback.
--
--   • sl_tp_decoy_diff — points to shift the exchange (decoy) SL/TP AWAY from the
--                        real exit level, in the harder-to-trigger direction
--                        (call: real + diff, put: real − diff). So for an OTM 50
--                        exit with diff 50 the exchange shows ATM; a larger diff
--                        crosses past ATM into ITM. The engine's own trigger always
--                        fires first (at the real level), so the decoy is a later,
--                        worse-level fallback if the engine is down.
--
-- diff = 0 → decoy == real level == current behaviour (fully backward compatible,
-- no separate on/off flag). Per-window value on paper_trading_schedules is primary;
-- the paper_trading_config value is the account-level fallback. Live accounts only —
-- paper trading places no exchange orders, so the value is inert there.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS sl_tp_decoy_diff numeric NOT NULL DEFAULT 0;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS sl_tp_decoy_diff numeric NOT NULL DEFAULT 0;

-- Keep the diff non-negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_sl_tp_decoy_diff_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_sl_tp_decoy_diff_check
      CHECK (sl_tp_decoy_diff >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_sl_tp_decoy_diff_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_sl_tp_decoy_diff_check
      CHECK (sl_tp_decoy_diff >= 0);
  END IF;
END $$;
