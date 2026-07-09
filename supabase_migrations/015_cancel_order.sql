-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015 — Cancel a single Delta order from the Open Orders table (✕)
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard inserts a row; the engine cancels that order on Delta (DELETE
-- /v2/orders with id + product_id) and removes the row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delta_cancel_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    order_id    BIGINT NOT NULL,
    product_id  BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_cancel_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage cancel requests of their own accounts" ON public.delta_cancel_requests;
CREATE POLICY "Users manage cancel requests of their own accounts"
    ON public.delta_cancel_requests FOR ALL
    USING (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()))
    WITH CHECK (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access on cancel requests" ON public.delta_cancel_requests;
CREATE POLICY "Service role full access on cancel requests"
    ON public.delta_cancel_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
