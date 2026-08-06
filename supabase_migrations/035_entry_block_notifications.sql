-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 035 — Entry-block notifications (cross-account entry governor)
-- ─────────────────────────────────────────────────────────────────────────────
-- When several accounts try to enter the SAME spread in one entry wave, their
-- combined contract size can exceed the real top-of-book depth on Delta. The engine's
-- cross-account entry governor (engine/lib/entryGovernor.js) fills accounts first-come
-- first-serve at FULL qty and BLOCKS the rest (all-or-nothing per spread). Each block
-- is recorded here so the dashboard can surface a persisted notification (a toast plus
-- a notifications panel) explaining WHY an account missed an entry.
--
-- Paper-trading facing (Phase 1): this is a WEBSITE notification, not a Telegram
-- alert. The engine INSERTs one row per blocked spread; the UI subscribes via Realtime
-- (scoped by account_id) and renders it.
--
-- One row per block event (append-only log). `details` carries the machine-readable
-- context (strikes, blocking leg, needed vs available qty) for the UI.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.entry_block_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    type        TEXT NOT NULL DEFAULT 'entry_blocked',
    message     TEXT NOT NULL,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb  -- { underlying, type, buy_strike, sell_strike, blocked_side, blocked_symbol, needed, available, long_qty, short_qty }
);

-- Newest-first reads per account (the panel query + Realtime backfill).
CREATE INDEX IF NOT EXISTS entry_block_notifications_account_created_idx
    ON public.entry_block_notifications (account_id, created_at DESC);

ALTER TABLE public.entry_block_notifications ENABLE ROW LEVEL SECURITY;

-- Read gated to authenticated users (same posture as live_exchange_state); the
-- account_id key already scopes what the UI queries.
CREATE POLICY "All authenticated users can read entry block notifications"
    ON public.entry_block_notifications FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Service role full access on entry_block_notifications"
    ON public.entry_block_notifications FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Realtime: the engine only INSERTs, so the UI needs INSERT events. Publication
-- membership is dashboard-managed and not guaranteed by any prior migration, so add
-- it here idempotently (mirrors migration 017).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'entry_block_notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.entry_block_notifications;
  END IF;
END $$;
