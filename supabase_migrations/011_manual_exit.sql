-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011 — UI-initiated manual exit for live positions
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard sets exit_requested = true; the engine (not the browser) then
-- closes the real position on Delta, books a Manual Exit, and deletes the row.
-- Prevents the browser from deleting a live DB row while the exchange position
-- stays open. Additive; default false.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS exit_requested boolean NOT NULL DEFAULT false;
