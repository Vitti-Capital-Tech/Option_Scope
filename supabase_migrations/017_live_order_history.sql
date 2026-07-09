-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 017 — Live order-history blob on the exchange snapshot
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds an `order_history` JSONB column to live_exchange_state so the UI's Order
-- History tab can mirror Delta's real order-history feed (filled + cancelled
-- orders with execution price, cashflow, realized pnl, commission, reduce-only,
-- time) for armed live accounts — the same pattern as positions/orders/fills.
--
-- Additive and idempotent. Existing rows default to an empty array; paper
-- accounts never write here (UI keeps the engine trade-ledger for them).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.live_exchange_state
    ADD COLUMN IF NOT EXISTS order_history JSONB NOT NULL DEFAULT '[]'::jsonb;
