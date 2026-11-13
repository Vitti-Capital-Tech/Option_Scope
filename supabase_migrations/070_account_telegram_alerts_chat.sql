-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 070 — Per-account Telegram ALERTS chat (separate from trade logs)
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to 028 / 029. An account can now link TWO Telegram chats:
--   • telegram_chat_id        (028) — entries / exits (trade logs)
--   • telegram_alert_chat_id  (new) — error alerts, in a user-friendly format.
--                                     NULL → alerts go to telegram_chat_id instead.
-- The admin / common group (TELEGRAM_ERROR_CHAT_ID, else TELEGRAM_CHAT_ID env) keeps
-- receiving every error in the technical format.
--
--   • telegram_alert_link_code — single-use /start token for linking the alerts chat
--                                (same flow as telegram_link_code). NULL when unset/consumed.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_alert_chat_id text;

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_alert_link_code text;

CREATE INDEX IF NOT EXISTS idx_accounts_telegram_alert_link_code
  ON public.paper_trading_accounts (telegram_alert_link_code)
  WHERE telegram_alert_link_code IS NOT NULL;
