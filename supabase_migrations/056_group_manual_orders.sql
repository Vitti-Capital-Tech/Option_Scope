-- Migration 056: a manual order on a grouped account can be punched on the WHOLE group.
--
-- place_manual_order() queues the same order (symbol, side, type, size, price, reduce-only)
-- in delta_order_requests (055) for the chosen account and, when p_whole_group is true, for
-- every other live account in its group. The rows share one group_request_id. Each account's
-- engine places its own copy independently, so one member's rejection (not armed, no
-- position for reduce-only, margin…) never blocks the others.
--
-- Who may: the account's owner or an admin for the account itself; fanning out to the group
-- follows sync_account_group (052) — only the GROUP's owner or an admin, since members may
-- belong to different users. Additive and safe to re-run.

ALTER TABLE public.delta_order_requests
  ADD COLUMN IF NOT EXISTS group_request_id UUID;

CREATE INDEX IF NOT EXISTS idx_delta_order_requests_group_request
    ON public.delta_order_requests(group_request_id) WHERE group_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.place_manual_order(
  p_account UUID,
  p_symbol TEXT,
  p_side TEXT,
  p_order_type TEXT,
  p_size INTEGER,
  p_limit_price NUMERIC,
  p_reduce_only BOOLEAN DEFAULT false,
  p_whole_group BOOLEAN DEFAULT false
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner UUID;
  v_mode TEXT;
  v_group UUID;
  v_group_owner UUID;
  v_targets UUID[];
  v_group_request UUID;
BEGIN
  SELECT user_id, mode, group_id INTO v_owner, v_mode, v_group
    FROM public.paper_trading_accounts WHERE id = p_account;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Account % not found', p_account; END IF;
  IF auth.uid() IS DISTINCT FROM v_owner AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF v_mode IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION 'Manual orders are only for live accounts';
  END IF;

  v_targets := ARRAY[p_account];
  IF p_whole_group AND v_group IS NOT NULL THEN
    SELECT user_id INTO v_group_owner FROM public.account_groups WHERE id = v_group;
    IF auth.uid() IS DISTINCT FROM v_group_owner AND NOT public._is_admin() THEN
      RAISE EXCEPTION 'Only the group owner or an admin can place an order on the whole group';
    END IF;
    SELECT v_targets || COALESCE(array_agg(id ORDER BY created_at), '{}') INTO v_targets
      FROM public.paper_trading_accounts
     WHERE group_id = v_group AND id <> p_account AND mode = 'live';
    IF array_length(v_targets, 1) > 1 THEN v_group_request := gen_random_uuid(); END IF;
  END IF;

  -- Column CHECKs (side, type, size >= 1, limit price) validate the order itself.
  INSERT INTO public.delta_order_requests
    (account_id, product_symbol, side, order_type, size, limit_price, reduce_only, requested_by, group_request_id)
  SELECT t, p_symbol, p_side, p_order_type, p_size,
         CASE WHEN p_order_type = 'limit' THEN p_limit_price END,
         COALESCE(p_reduce_only, false), auth.uid(), v_group_request
    FROM unnest(v_targets) AS t;

  RETURN array_length(v_targets, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.place_manual_order(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_manual_order(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN) TO authenticated, service_role;
