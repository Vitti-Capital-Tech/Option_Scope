-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010 — Publish engine's max-positions + allocation % to the heartbeat
-- ─────────────────────────────────────────────────────────────────────────────
-- The UI's "per-position" figure was computed from the account's creation-time
-- default_config and ignored schedule windows, so it didn't match the engine.
-- The engine now writes the SAME max-positions it uses for sizing (max of
-- calls+puts across base config AND all windows) plus the live allocation %, so
-- the KPI matches exactly. Additive; null for paper / disarmed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS max_positions integer;

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS allocation_pct numeric;
