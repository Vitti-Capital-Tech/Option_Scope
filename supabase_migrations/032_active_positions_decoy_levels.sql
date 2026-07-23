-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 032 — active_positions real/decoy exit levels (paper observability)
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to migration 031 (sl_tp_decoy_diff). Stores, per OPEN position, the
-- two index (spot) levels the decoy feature reasons about:
--
--   • real_exit_level  — the engine's TRUE exit trigger (computeIndexTriggerLevel:
--                        ATM = buy strike, ITM/OTM = ± exitPoints). This is the
--                        level the engine actually exits on, unchanged by the decoy.
--   • decoy_exit_level — real_exit_level shifted sl_tp_decoy_diff points in the
--                        HARDER-to-trigger direction (call: real + diff,
--                        put: real − diff). On live this is where the exchange
--                        bracket would sit (a later, worse-level fallback); here it
--                        is recorded so the geometry can be VALIDATED in paper first.
--
-- PAPER accounts populate both (observational only — paper places no exchange
-- orders, so nothing acts on the decoy; the real exit is untouched). LIVE rows are
-- left NULL by this engine (the live decoy is enforced on the exchange, not stored).
-- diff = 0 → decoy_exit_level == real_exit_level.
--
-- Stamped at entry and re-synced only when the active window's exitType/exitPoints
-- drift (a rare update, not per-cycle). Additive only: ADD COLUMN IF NOT EXISTS.
-- No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS real_exit_level numeric DEFAULT NULL;

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS decoy_exit_level numeric DEFAULT NULL;
