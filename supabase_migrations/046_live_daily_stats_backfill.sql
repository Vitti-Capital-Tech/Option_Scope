-- Migration 046: flags for backfilled days in live_daily_stats (migration 045).
--
-- engine/backfillDailyStats.js fills trading days from before the live tracker existed:
--   • is_backfilled       — the row was created/filled by the backfill script, not recorded live.
--   • margin_is_estimate  — max_margin_used is an ESTIMATE from trade_history (peak sum of
--                           concurrent full-spread margins), not Delta's blocked margin.
-- Both default to false, so rows written by the live tracker are unaffected.

ALTER TABLE public.live_daily_stats
  ADD COLUMN IF NOT EXISTS is_backfilled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS margin_is_estimate BOOLEAN NOT NULL DEFAULT false;
