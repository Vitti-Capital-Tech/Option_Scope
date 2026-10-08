-- Migration 057: edit a resting order's quantity / limit price from the Open Orders tab (✎).
--
-- Same queue pattern as delta_cancel_requests (015): the UI inserts a row, the engine (which
-- alone holds the Delta keys) claims it and edits the order in place on Delta (PUT /v2/orders
-- — keeps the order id and its bracket), then writes the outcome back (done / dry_run /
-- failed / expired) so the UI can report a rejection. `size` is the order's new TOTAL size
-- (filled + unfilled), as Delta expects.
--
-- Account owner and admins may insert and read; only the engine (service_role) updates.
-- Additive and safe to re-run.

CREATE TABLE IF NOT EXISTS public.delta_edit_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    order_id        BIGINT NOT NULL,
    product_id      BIGINT,
    product_symbol  TEXT NOT NULL,
    size            INTEGER NOT NULL CHECK (size >= 1),
    limit_price     NUMERIC NOT NULL CHECK (limit_price > 0),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'dry_run', 'failed', 'expired')),
    error           TEXT,
    requested_by    UUID DEFAULT auth.uid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delta_edit_requests_pending
    ON public.delta_edit_requests(account_id) WHERE status = 'pending';

ALTER TABLE public.delta_edit_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read edit requests of their own accounts" ON public.delta_edit_requests;
CREATE POLICY "Users read edit requests of their own accounts"
    ON public.delta_edit_requests FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

DROP POLICY IF EXISTS "Users request edits on their own live accounts" ON public.delta_edit_requests;
CREATE POLICY "Users request edits on their own live accounts"
    ON public.delta_edit_requests FOR INSERT
    WITH CHECK (
        status = 'pending' AND error IS NULL AND processed_at IS NULL
        AND account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
             WHERE a.mode = 'live'
               AND (a.user_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
        )
    );

DROP POLICY IF EXISTS "Service role full access on edit requests" ON public.delta_edit_requests;
CREATE POLICY "Service role full access on edit requests"
    ON public.delta_edit_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
