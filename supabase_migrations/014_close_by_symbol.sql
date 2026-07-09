-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014 — Close a single Delta position by symbol (per-row ✕)
-- ─────────────────────────────────────────────────────────────────────────────
-- Lets the dashboard close ANY open Delta leg from the Positions table — even
-- orphans the engine no longer tracks in active_positions. The UI inserts a row;
-- the engine places a reduce_only market close for that symbol and deletes the row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delta_close_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    product_symbol TEXT NOT NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_close_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage close requests of their own accounts" ON public.delta_close_requests;
CREATE POLICY "Users manage close requests of their own accounts"
    ON public.delta_close_requests FOR ALL
    USING (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()))
    WITH CHECK (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access on close requests" ON public.delta_close_requests;
CREATE POLICY "Service role full access on close requests"
    ON public.delta_close_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
