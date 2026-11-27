-- Migration 077: Ratio Spread Scanner "Send" — enter a scanner row on PAPER accounts in one click
-- (paper first; live is promoted later by changing the account-mode check below + the engine).
--
-- The scanner calls request_scanner_entry() with the row (underlying, expiry, type, long / short
-- strike, hedge strike + Hedge Lot %, ATM scaling) and the paper accounts picked in the scanner.
-- One row per account goes into scanner_entry_requests (sharing group_request_id). Each
-- account's engine claims its row (pending → processing), enters that spread through its
-- NORMAL entry path — engine sizing (allocation ÷ free slots), the shared depth governor, the
-- window's exits (and on live, later: entry offsets, fill / abort, Delta brackets) — and writes
-- the outcome back:
--   entered (position_id) / skipped (reason) / failed (reason) / expired (> 60s old).
-- Skipped for these entries: the window's scan filters, ATM P&L floor, Max Net Debit, time
-- window and min days to expiry. Kept: max positions, not paused, allocation, strike already
-- held, fresh quotes, depth, OI cap, expiry buffer.
--
-- Who may: each account must be a PAPER account (not live, for now) owned by the caller, or the
-- caller is an admin.
-- A second click on the same spread for the same account within 10 s is ignored (double click).
-- get_pending_engine_requests (061) gains the 'scannerEntry' kind so the engine's 1.5 s poll
-- picks the rows up. Additive and re-runnable.

BEGIN;

CREATE TABLE IF NOT EXISTS public.scanner_entry_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_request_id    UUID NOT NULL,
    account_id          UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    underlying          TEXT NOT NULL,
    expiry              TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('call', 'put')),
    buy_strike          NUMERIC NOT NULL,
    sell_strike         NUMERIC NOT NULL,
    hedge_strike        NUMERIC,
    hedge_lot_pct       NUMERIC,
    atm_ratio_scaling   BOOLEAN NOT NULL DEFAULT false,
    atm_ratio_pct_call  NUMERIC,
    atm_ratio_pct_put   NUMERIC,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'entered', 'skipped', 'failed', 'expired')),
    message             TEXT,
    position_id         TEXT,
    requested_by        UUID DEFAULT auth.uid(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scanner_entry_requests_pending
    ON public.scanner_entry_requests(account_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scanner_entry_requests_group
    ON public.scanner_entry_requests(group_request_id);

ALTER TABLE public.scanner_entry_requests ENABLE ROW LEVEL SECURITY;

-- Read: own accounts, or admin. Writes only through the RPC (SECURITY DEFINER) and the engine.
DROP POLICY IF EXISTS "Users read scanner entry requests of their own accounts" ON public.scanner_entry_requests;
CREATE POLICY "Users read scanner entry requests of their own accounts"
    ON public.scanner_entry_requests FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

CREATE OR REPLACE FUNCTION public.request_scanner_entry(
  p_accounts UUID[],
  p_underlying TEXT,
  p_expiry TEXT,
  p_type TEXT,
  p_buy_strike NUMERIC,
  p_sell_strike NUMERIC,
  p_hedge_strike NUMERIC DEFAULT NULL,
  p_hedge_lot_pct NUMERIC DEFAULT NULL,
  p_atm_ratio_scaling BOOLEAN DEFAULT false,
  p_atm_ratio_pct_call NUMERIC DEFAULT NULL,
  p_atm_ratio_pct_put NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_group UUID := gen_random_uuid();
  v_acc UUID;
  v_owner UUID;
  v_mode TEXT;
  v_name TEXT;
  v_added INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF p_accounts IS NULL OR cardinality(p_accounts) = 0 THEN RAISE EXCEPTION 'No accounts selected'; END IF;
  IF lower(p_type) NOT IN ('call', 'put') THEN RAISE EXCEPTION 'Type must be call or put'; END IF;
  IF p_buy_strike IS NULL OR p_sell_strike IS NULL OR p_buy_strike = p_sell_strike THEN
    RAISE EXCEPTION 'Invalid strikes';
  END IF;
  IF p_hedge_strike IS NOT NULL AND (p_hedge_lot_pct IS NULL OR p_hedge_lot_pct <= 0) THEN
    RAISE EXCEPTION 'Hedge Lot %% must be above 0 when a hedge strike is sent';
  END IF;

  FOREACH v_acc IN ARRAY p_accounts LOOP
    CONTINUE WHEN v_acc IS NULL;
    SELECT user_id, mode, name INTO v_owner, v_mode, v_name
      FROM public.paper_trading_accounts WHERE id = v_acc;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'Account % not found', v_acc; END IF;
    -- Paper only for now; live is promoted later (change this check and the engine's).
    IF v_mode = 'live' THEN RAISE EXCEPTION 'Account "%" is a live account — scanner orders are paper-only for now', v_name; END IF;
    IF auth.uid() IS DISTINCT FROM v_owner AND NOT public._is_admin() THEN
      RAISE EXCEPTION 'Not allowed to place orders on account "%"', v_name;
    END IF;
    -- Double click: the same spread for the same account within 10 s is ignored.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.scanner_entry_requests r
       WHERE r.account_id = v_acc AND r.type = lower(p_type)
         AND r.buy_strike = p_buy_strike AND r.sell_strike = p_sell_strike
         AND r.created_at > NOW() - INTERVAL '10 seconds');
    INSERT INTO public.scanner_entry_requests (
      group_request_id, account_id, underlying, expiry, type, buy_strike, sell_strike,
      hedge_strike, hedge_lot_pct, atm_ratio_scaling, atm_ratio_pct_call, atm_ratio_pct_put, requested_by)
    VALUES (
      v_group, v_acc, upper(p_underlying), p_expiry, lower(p_type), p_buy_strike, p_sell_strike,
      p_hedge_strike, CASE WHEN p_hedge_strike IS NULL THEN NULL ELSE p_hedge_lot_pct END,
      COALESCE(p_atm_ratio_scaling, false), p_atm_ratio_pct_call, p_atm_ratio_pct_put, auth.uid());
    v_added := v_added + 1;
  END LOOP;

  IF v_added = 0 THEN RAISE EXCEPTION 'Already sent — wait a few seconds before sending the same spread again'; END IF;
  RETURN v_group;
END;
$$;

REVOKE ALL ON FUNCTION public.request_scanner_entry(UUID[], TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_scanner_entry(UUID[], TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, NUMERIC, NUMERIC) TO authenticated;

-- Engine poll (061) + the new kind.
CREATE OR REPLACE FUNCTION public.get_pending_engine_requests(p_ids UUID[], p_live_ids UUID[])
RETURNS TABLE (account_id UUID, kind TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT a.id, 'closeAll' FROM public.paper_trading_accounts a
   WHERE a.close_all_requested AND a.id = ANY(p_ids)
  UNION
  SELECT r.account_id, 'closeReq' FROM public.delta_close_requests r WHERE r.account_id = ANY(p_live_ids)
  UNION
  SELECT r.account_id, 'cancelReq' FROM public.delta_cancel_requests r WHERE r.account_id = ANY(p_live_ids)
  UNION
  SELECT p.account_id, 'manualEx' FROM public.active_positions p
   WHERE p.exit_requested AND p.account_id = ANY(p_ids)
  UNION
  SELECT r.account_id, 'orderReq' FROM public.delta_order_requests r
   WHERE r.status = 'pending' AND r.account_id = ANY(p_ids)
  UNION
  SELECT r.account_id, 'editReq' FROM public.delta_edit_requests r
   WHERE r.status = 'pending' AND r.account_id = ANY(p_ids)
  UNION
  SELECT r.account_id, 'scannerEntry' FROM public.scanner_entry_requests r
   WHERE r.status = 'pending' AND r.account_id = ANY(p_ids);
$$;

REVOKE ALL ON FUNCTION public.get_pending_engine_requests(UUID[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_engine_requests(UUID[], UUID[]) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
