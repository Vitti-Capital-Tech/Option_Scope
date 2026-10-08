-- Migration 055: manual orders from the dashboard's Trade tab (live accounts).
--
-- The UI inserts a row; the engine (which alone holds the decrypted Delta keys) claims it,
-- places the order on Delta (POST /v2/orders, client_order_id `MAN-<request id prefix>`) and
-- writes the outcome back to the same row: placed / dry_run / failed / expired, plus the
-- exchange order id or the rejection message. Same queue pattern as delta_close_requests (014)
-- and delta_cancel_requests (015), but rows are kept (and updated) so the UI can show status.
--
-- Account owner and admins may insert and read; only the engine (service_role) updates.
-- Additive and safe to re-run.

CREATE TABLE IF NOT EXISTS public.delta_order_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    product_symbol    TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    order_type        TEXT NOT NULL CHECK (order_type IN ('limit', 'market')),
    size              INTEGER NOT NULL CHECK (size >= 1),
    limit_price       NUMERIC CHECK (limit_price IS NULL OR limit_price > 0),
    reduce_only       BOOLEAN NOT NULL DEFAULT false,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'placed', 'dry_run', 'failed', 'expired')),
    error             TEXT,
    exchange_order_id BIGINT,
    order_state       TEXT,
    requested_by      UUID DEFAULT auth.uid(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at      TIMESTAMPTZ,
    CONSTRAINT delta_order_requests_limit_price CHECK (order_type = 'market' OR limit_price IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_delta_order_requests_account_created
    ON public.delta_order_requests(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delta_order_requests_pending
    ON public.delta_order_requests(account_id) WHERE status = 'pending';

ALTER TABLE public.delta_order_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read order requests of their own accounts" ON public.delta_order_requests;
CREATE POLICY "Users read order requests of their own accounts"
    ON public.delta_order_requests FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- New requests only: always 'pending', no outcome fields, on a live account.
DROP POLICY IF EXISTS "Users place order requests on their own live accounts" ON public.delta_order_requests;
CREATE POLICY "Users place order requests on their own live accounts"
    ON public.delta_order_requests FOR INSERT
    WITH CHECK (
        status = 'pending' AND error IS NULL AND exchange_order_id IS NULL AND processed_at IS NULL
        AND account_id IN (
            SELECT a.id FROM public.paper_trading_accounts a
             WHERE a.mode = 'live'
               AND (a.user_id = auth.uid()
                    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
        )
    );

DROP POLICY IF EXISTS "Service role full access on order requests" ON public.delta_order_requests;
CREATE POLICY "Service role full access on order requests"
    ON public.delta_order_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Realtime: the Trade tab follows each request's status as the engine updates it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'delta_order_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.delta_order_requests;
  END IF;
END $$;
