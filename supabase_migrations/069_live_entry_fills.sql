-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 069 — live_entry_fills(): entry orders for the Slippage tab
-- ─────────────────────────────────────────────────────────────────────────────
-- The Slippage tab compares each live entry's quote (what the engine saw when it decided:
-- long at the ask, short at the bid, hedge at the ask — active_positions / trade_history
-- entry prices) with Delta's actual average fill. The fills live in
-- live_exchange_state.order_history (up to ~2000 recent orders per account, several MB for
-- many accounts). This returns only the ENTRY orders (client_order_id `<position id>-EB` /
-- `-ES` / `-HB`) since a time, so the browser doesn't download whole histories.
--
-- SECURITY INVOKER: the caller's RLS on live_exchange_state applies (owner or admin,
-- migration 036) — it can never return another user's orders.
--
-- Additive only. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.live_entry_fills(p_account_ids uuid[], p_since timestamptz)
RETURNS TABLE (
  account_id         uuid,
  client_order_id    text,
  product_symbol     text,
  side               text,
  size               numeric,
  unfilled_size      numeric,
  limit_price        numeric,
  average_fill_price numeric,
  contract_value     numeric,
  created_at         timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT s.account_id,
         o->>'client_order_id',
         o->>'product_symbol',
         o->>'side',
         NULLIF(o->>'size', '')::numeric,
         NULLIF(o->>'unfilled_size', '')::numeric,
         NULLIF(o->>'limit_price', '')::numeric,
         NULLIF(o->>'average_fill_price', '')::numeric,
         NULLIF(o->'product'->>'contract_value', '')::numeric,
         (o->>'created_at')::timestamptz
    FROM public.live_exchange_state s
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.order_history, '[]'::jsonb)) o
   WHERE s.account_id = ANY(p_account_ids)
     AND (o->>'client_order_id' LIKE '%-EB'
       OR o->>'client_order_id' LIKE '%-ES'
       OR o->>'client_order_id' LIKE '%-HB')
     AND (o->>'created_at')::timestamptz >= p_since;
$$;

GRANT EXECUTE ON FUNCTION public.live_entry_fills(uuid[], timestamptz) TO authenticated;
