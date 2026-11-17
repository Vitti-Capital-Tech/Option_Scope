-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 072 — Per-account exchange (Cosmic Trade paper accounts)
-- ─────────────────────────────────────────────────────────────────────────────
-- paper_trading_accounts.exchange — which exchange's market data the account trades on:
--   'delta'  (default) — every existing account; unchanged behaviour.
--   'cosmic' — Cosmic Trade (cosmic.trade). The engine loads Cosmic's BTC option chain and
--              live feed (engine/lib/cosmicApi.js) instead of Delta's. Shown only on the
--              dashboard's "Cosmic Paper" tab; the Paper Trading tab shows Delta accounts only.
-- Cosmic accounts are PAPER ONLY for now — enforced here so no Cosmic account can ever be
-- switched to live (the engine also refuses to start one).
--
-- Additive and safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS exchange text NOT NULL DEFAULT 'delta';

ALTER TABLE public.paper_trading_accounts
  DROP CONSTRAINT IF EXISTS paper_trading_accounts_exchange_check;
ALTER TABLE public.paper_trading_accounts
  ADD CONSTRAINT paper_trading_accounts_exchange_check
  CHECK (exchange IN ('delta', 'cosmic') AND NOT (exchange = 'cosmic' AND mode = 'live'));
