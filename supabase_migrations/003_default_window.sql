-- ─────────────────────────────────────────────────────────────────────────────
-- 003_default_window.sql
-- Makes the schedule "windows" the single source of truth for the 8 shared
-- strategy fields (calls/puts, spread width, spot distance, ATM scaling + call/put
-- %, re-entry spot step). Every account now owns a permanent "Default" window
-- (is_default = true) that acts as the 24/7 fallback whenever no time-bound
-- window is active — replacing the old base-config fallback role.
--
-- Also fixes schema drift: the app has been reading/writing atm_ratio_scaling,
-- atm_ratio_distance_call/put and spot_diff on paper_trading_schedules, but those
-- columns were never declared in supabase_schema.sql. Added here defensively.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the previously-undeclared window columns + the is_default flag.
ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS atm_ratio_scaling       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS atm_ratio_distance_call NUMERIC NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS atm_ratio_distance_put  NUMERIC NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS spot_diff               NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS is_default              BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill: create a Default 24/7 window for every account that lacks one,
--    seeded from that account's current paper_trading_config values so existing
--    behaviour is preserved after the cutover.
INSERT INTO public.paper_trading_schedules
  (account_id, label, is_default, start_time, end_time,
   number_of_calls, number_of_puts, min_long_dist, min_strike_diff,
   atm_ratio_scaling, atm_ratio_distance_call, atm_ratio_distance_put, spot_diff,
   is_active, sort_order)
SELECT
   c.account_id, 'Default', true, '00:00', '00:00',
   c.number_of_calls, c.number_of_puts, c.min_long_dist, c.min_strike_diff,
   c.atm_ratio_scaling, c.atm_ratio_distance_call, c.atm_ratio_distance_put, c.spot_diff,
   true, 0
FROM public.paper_trading_config c
WHERE NOT EXISTS (
  SELECT 1 FROM public.paper_trading_schedules s
  WHERE s.account_id = c.account_id AND s.is_default = true
);

-- 3. Enforce one default window per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_one_default_per_account
  ON public.paper_trading_schedules (account_id)
  WHERE is_default = true;
