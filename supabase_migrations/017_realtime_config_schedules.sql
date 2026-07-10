-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017 — enable Realtime for config + schedules
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine subscribes to `paper_trading_config` and `paper_trading_schedules`
-- changes (subscribeConfigChanges) to apply filter/exit/schedule edits to LIVE
-- trading within ~1-3s. But a Realtime subscription only receives events for tables
-- that are members of the `supabase_realtime` publication. If these two tables were
-- never added (publication membership is dashboard-managed and not in any prior
-- migration), the engine never gets the change events and only reloads config on its
-- 5-minute fallback sync — so filter changes appear to "reflect after some time".
--
-- This adds both tables to the publication (idempotent — skips if already a member)
-- so edits propagate to the running engine in near real-time. No egress cost; the
-- engine's handler just refetches the row on each event.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'paper_trading_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_trading_config;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'paper_trading_schedules'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_trading_schedules;
  END IF;
END $$;
