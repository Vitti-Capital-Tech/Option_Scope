-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 033 — per-window short-exit price + variable-slice controls
-- ─────────────────────────────────────────────────────────────────────────────
-- Moves three exit controls from account-level ONLY to per-schedule-window, so the
-- currently-active window governs them (active-window-governs, same as exitType/
-- exitPoints). The account-level columns on paper_trading_config stay as the gap
-- fallback (used when no window is active), and are still set at account creation.
--
--   • short_exit_price     — the short leg's live-ask threshold to buy back the short
--                            and hold the long. On live it also prices the resting
--                            reduce-only buy-back order (re-synced on a window flip).
--   • variable_exit_slices — toggle for the long-only ladder's Variable mode.
--   • long_exit_slices     — the Variable-mode slice count (coupled to the toggle).
--
-- Both paper AND live. Additive only: ADD COLUMN IF NOT EXISTS, defaults match the
-- existing account-level defaults. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS short_exit_price numeric NOT NULL DEFAULT 1.1;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS variable_exit_slices boolean NOT NULL DEFAULT false;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS long_exit_slices integer NOT NULL DEFAULT 10;
