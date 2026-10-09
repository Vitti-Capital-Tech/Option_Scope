-- Migration 059: paper-only "replace with a closer-to-ATM spread" toggle.
--
-- paper_trading_config.replace_closer_atm (default false). When ON for a PAPER account, a new
-- spread that is blocked only because the slots / allocated margin are full may REPLACE an
-- open pair (call or put — it must be the new spread's type only when the per-type cap is what
-- blocks) whose long strike is farther from spot, provided:
--   • the pair's cashflow is positive: short premium received − long premium paid − hedge
--     premium paid (on the legs' current quantities) > 0, and
--   • the account's TOTAL unrealized P&L (every open position, long at bid, short at ask,
--     hedge at bid) is positive and greater than that pair's cashflow.
-- The old pair is exited (exit_reason "Replaced (closer-to-ATM spread)") and the new one
-- entered in the same cycle; as many as qualify. Live accounts never do this, whatever the
-- flag says. Group sync copies the column like every other config column.
--
-- Additive and safe to re-run.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS replace_closer_atm BOOLEAN NOT NULL DEFAULT false;
