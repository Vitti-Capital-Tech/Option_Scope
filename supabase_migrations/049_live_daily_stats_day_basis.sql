-- Migration 049: day_basis on live_daily_stats.
--
-- The Daily Report's day moved from the app's 17:30 IST trading day to Delta's own day
-- (00:00 → 24:00 UTC = 05:30 → 05:30 IST) so per-day realized P&L and fees match Delta.
-- Rows say which cut they were built on:
--   'ist1730' — the old cut (every existing row, and any row an engine still running the
--               old code keeps writing — it doesn't send this column, so it gets the default)
--   'utc'     — Delta's day (written by the new engine and backfill)
-- The new live tracker ignores an 'ist1730' row's measured values and rebuilds the day, and
-- the backfill rewrites (or removes) 'ist1730' rows — so the switch needs no engine downtime.

ALTER TABLE public.live_daily_stats
  ADD COLUMN IF NOT EXISTS day_basis TEXT NOT NULL DEFAULT 'ist1730';
