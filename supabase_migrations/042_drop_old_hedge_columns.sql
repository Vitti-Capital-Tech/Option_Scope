-- Migration 042: drop the unused migration-022 hedge columns from paper_trading_schedules
--
-- Migration 041 replaced them with hedge_enabled + hedge_lot_pct and copied existing hedged
-- windows over. Nothing in the app or engine reads or writes these five columns any more.
--
-- RUN ORDER: 041 → deploy the new frontend + engine → 042. The old frontend still writes
-- these columns when saving schedules, so dropping them while it is live would make every
-- schedule save fail.
--
-- Destructive: the old per-type budgets and percentages are discarded.

ALTER TABLE public.paper_trading_schedules
  DROP COLUMN IF EXISTS hedge_strike_type,
  DROP COLUMN IF EXISTS hedge_call_price,
  DROP COLUMN IF EXISTS hedge_call_pct,
  DROP COLUMN IF EXISTS hedge_put_price,
  DROP COLUMN IF EXISTS hedge_put_pct;
