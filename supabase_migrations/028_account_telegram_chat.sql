-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028 — Per-account Telegram chat id (independent live logs)
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds an optional per-account Telegram destination so each LIVE account can send
-- its trade/failure alerts to its own chat instead of the single shared group.
--
--   • telegram_chat_id — the Telegram chat/channel/group id this account's live
--                        alerts go to. NULL → fall back to the global
--                        TELEGRAM_CHAT_ID env (unchanged behaviour). One shared bot
--                        token (TELEGRAM_BOT_TOKEN) still serves every chat.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed. Paper
-- accounts get the column too but never notify (alerts are armed-live-only).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_chat_id text;
