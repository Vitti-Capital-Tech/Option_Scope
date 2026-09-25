-- Migration 041: simplified hedge leg (hedge_enabled + hedge_lot_pct) on paper_trading_schedules
--
-- The per-spread hedge leg (migration 023, strategy_version >= 2 / paper) used five per-window
-- fields: a strike type (none/call/put/both), a premium budget per type, and a qty % per type.
-- The engine bought the OTM strike whose ask was the highest within the budget.
--
-- It is now two fields:
--   • hedge_enabled — on/off for the window. When on, EVERY entered spread (call and put) gets
--                     a 3rd long.
--   • hedge_lot_pct — the 3rd long's qty as a % of the spread's own short qty (0–100).
-- The strike is no longer budget-driven: it sits one strike-width beyond the short
-- (call: short + (short − long), put: short − (long − short)), nearest listed strike.
--
-- The five migration-022 columns are no longer read or written by the app or the engine.
-- They are dropped by migration 042, which must run only AFTER the new code is deployed
-- (the old frontend still writes them when saving schedules).

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS hedge_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hedge_lot_pct NUMERIC NOT NULL DEFAULT 0;

-- Carry existing hedged windows over: any window that had a hedge type set keeps a hedge,
-- sized at the larger of its old call/put %. Runs only on rows still at the new defaults.
UPDATE public.paper_trading_schedules
   SET hedge_enabled = true,
       hedge_lot_pct = LEAST(100, GREATEST(COALESCE(hedge_call_pct, 0), COALESCE(hedge_put_pct, 0)))
 WHERE COALESCE(hedge_strike_type, 'none') <> 'none'
   AND hedge_enabled = false
   AND hedge_lot_pct = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_hedge_lot_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_hedge_lot_pct_check
      CHECK (hedge_lot_pct >= 0 AND hedge_lot_pct <= 100);
  END IF;
END $$;
