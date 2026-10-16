-- Migration 063: Partial scale-down controls — paper accounts (global / Control Panel).
--
-- The ATM-ratio partial scale-down (engine applyAtmRatioScaling) sells part of a full
-- spread's LONG when the live ATM ratio has risen and gross P&L clears a threshold. Its three
-- numbers were fixed at 10% / 10% / 50%. Paper accounts can now set them; LIVE accounts keep
-- the fixed values (these columns are ignored for live).
--
--   partial_scale_enabled       (default true)  — off = no partial scale-down for this account.
--   partial_scale_lot_pct       (default 10)    — each step sells this % of the initial long.
--   partial_scale_threshold_pct (default 10)    — the next step needs gross P&L to rise by this
--                                                 % of the checkpoint ATM P&L.
--   partial_scale_max_pct       (default 50)    — never scale the long down by more than this %
--                                                 of the initial long (50 = keep at least half).
--
-- Group sync (sync_account_group) copies every config column dynamically — no RPC change.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS partial_scale_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS partial_scale_lot_pct NUMERIC NOT NULL DEFAULT 10
    CHECK (partial_scale_lot_pct > 0 AND partial_scale_lot_pct <= 100),
  ADD COLUMN IF NOT EXISTS partial_scale_threshold_pct NUMERIC NOT NULL DEFAULT 10
    CHECK (partial_scale_threshold_pct >= 0 AND partial_scale_threshold_pct <= 1000),
  ADD COLUMN IF NOT EXISTS partial_scale_max_pct NUMERIC NOT NULL DEFAULT 50
    CHECK (partial_scale_max_pct > 0 AND partial_scale_max_pct < 100);
