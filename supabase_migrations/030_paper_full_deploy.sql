-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 030 — Paper full-deployment time (paper only)
-- ─────────────────────────────────────────────────────────────────────────────
-- Makes the "go all out / use all the remaining margin" fill configurable per
-- paper account, replacing the hard-coded 04:30 IST behaviour in the engine.
--
--   • full_deploy_enabled — when true, once per IST day, on the entry-eligible
--                           cycle that crosses full_deploy_time, the engine
--                           concentrates the WHOLE remaining allocated pool across
--                           the spreads it can actually open now (instead of
--                           reserving budget per free slot). When false, the fill
--                           never fires and sizing stays even across free slots.
--   • full_deploy_time    — IST 'HH:MM' at which the fill fires (default '04:30').
--
-- Paper accounts only — live accounts ignore both (they size on the real wallet
-- balance). Additive only: ADD COLUMN IF NOT EXISTS, no data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS full_deploy_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS full_deploy_time text NOT NULL DEFAULT '04:30';

-- Keep the time a well-formed 24h 'HH:MM'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_full_deploy_time_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_full_deploy_time_check
      CHECK (full_deploy_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
END $$;
