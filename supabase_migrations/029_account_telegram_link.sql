-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 029 — Telegram /start deep-link auto-capture code
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to migration 028 (telegram_chat_id). Adds a single-use linking token so
-- a live account can capture its Telegram chat id WITHOUT the user pasting a numeric
-- id: the UI writes a random `telegram_link_code`, builds a `t.me/<bot>?start=<code>`
-- deep link, and when the user presses Start the engine's bot listener matches the
-- code, stores `telegram_chat_id`, and clears the code (single use).
--
--   • telegram_link_code — random token pending a /start bind. NULL when unset/consumed.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_link_code text;

-- Fast lookup for the bot listener resolving an incoming /start <code>.
CREATE INDEX IF NOT EXISTS idx_accounts_telegram_link_code
  ON public.paper_trading_accounts (telegram_link_code)
  WHERE telegram_link_code IS NOT NULL;
