-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008 — Surface engine execution mode (dry-run vs real) to the UI
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine writes its DELTA_LIVE_DRYRUN state to the heartbeat so the dashboard
-- can show whether armed live accounts will place REAL orders or only simulate.
-- Additive; null when unknown/old engine.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS dry_run boolean;
