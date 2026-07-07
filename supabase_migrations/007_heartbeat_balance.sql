-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007 — Surface live wallet balance to the dashboard
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine polls the live USDT wallet balance for armed live accounts and writes
-- it to the heartbeat so the UI can show Wallet / Allocated / per-position figures.
-- Additive; null for paper accounts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS wallet_balance numeric;
