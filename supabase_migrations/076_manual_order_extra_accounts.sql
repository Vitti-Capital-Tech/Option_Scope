-- Migration 076: Trade tab — punch a manual order on extra live accounts too (not only the
-- account's own group).
--
-- place_manual_order() gains p_extra_accounts UUID[]: every listed account gets its own copy of
-- the order in delta_order_requests (055), sharing one group_request_id with the rest, exactly
-- like a whole-group order (056). Each account's engine places its copy independently, so one
-- rejection never blocks the others.
--
-- Who may: each extra account must be LIVE and owned by the caller, or the caller is an admin
-- (same rule as the account itself). The whole-group fan-out keeps its 056 rule (group owner
-- or admin). Duplicates (an extra that is already a group member / the account itself) are
-- ignored. Engine unchanged.
--
-- The 8-argument version is dropped first so PostgREST never sees two overloads (an RPC call
-- with named args would be ambiguous). Re-runnable.

BEGIN;

DROP FUNCTION IF EXISTS public.place_manual_order(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION public.place_manual_order(
  p_account UUID,
  p_symbol TEXT,
  p_side TEXT,
  p_order_type TEXT,
  p_size INTEGER,
  p_limit_price NUMERIC,
  p_reduce_only BOOLEAN DEFAULT false,
  p_whole_group BOOLEAN DEFAULT false,
  p_extra_accounts UUID[] DEFAULT NULL
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
  v_extra UUID;
  v_x_owner UUID;
  v_x_mode TEXT;
  v_x_name TEXT;
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
  END IF;

  -- Extra accounts (any group or none): live, and the caller owns each one or is an admin.
  IF p_extra_accounts IS NOT NULL THEN
    FOREACH v_extra IN ARRAY p_extra_accounts LOOP
      CONTINUE WHEN v_extra IS NULL OR v_extra = ANY(v_targets);
      SELECT user_id, mode, name INTO v_x_owner, v_x_mode, v_x_name
        FROM public.paper_trading_accounts WHERE id = v_extra;
      IF v_x_owner IS NULL THEN RAISE EXCEPTION 'Account % not found', v_extra; END IF;
      IF v_x_mode IS DISTINCT FROM 'live' THEN
        RAISE EXCEPTION 'Account "%" is not a live account', v_x_name;
      END IF;
      IF auth.uid() IS DISTINCT FROM v_x_owner AND NOT public._is_admin() THEN
        RAISE EXCEPTION 'Not allowed to place orders on account "%"', v_x_name;
      END IF;
      v_targets := v_targets || v_extra;
    END LOOP;
  END IF;

  IF array_length(v_targets, 1) > 1 THEN v_group_request := gen_random_uuid(); END IF;

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

REVOKE ALL ON FUNCTION public.place_manual_order(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_manual_order(UUID, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN, UUID[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
