-- Migration 061: query optimisations (database load / egress on the Micro instance).
--
-- 1. get_pending_engine_requests(ids, live_ids) — the engine's 1.5s manual-action poll asked
--    six tables in six requests (~345k requests/day even when idle). One RPC now returns the
--    (account_id, kind) pairs that have pending work. Small partial / account indexes keep
--    each part an index lookup.
-- 2. live_exchange_state.snapshot_version — bumped only when the engine writes a FULL snapshot.
--    When nothing changed the engine's 60s keepalive now only touches updated_at (no rewrite of
--    the large JSON row); the dashboard sees the same version and just refreshes the timestamp
--    instead of re-reading the whole row. A full snapshot is still written at least every 5 min.
-- 3. idx_trade_history_stats — covers get_trade_stats (account_id + underlying, the summed P&L
--    columns and exit_time) so the dashboard KPIs no longer read every trade row.
-- 4. get_trade_day_totals(account, from, to) — the Daily Report's per-day sums (gross P&L, fees,
--    trade count) in the database; the old row download was capped at 1,000 rows by the API.
--
-- Additive and safe to re-run. Building the trade_history index briefly locks writes to it
-- (seconds) — run at a quiet time. Needs migrations 055 and 057 (request tables) first.

-- ── 1. Pending manual-action requests ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_delta_close_requests_account ON public.delta_close_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_delta_cancel_requests_account ON public.delta_cancel_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_active_positions_exit_requested
    ON public.active_positions(account_id) WHERE exit_requested;
CREATE INDEX IF NOT EXISTS idx_accounts_close_all_requested
    ON public.paper_trading_accounts(id) WHERE close_all_requested;
CREATE INDEX IF NOT EXISTS idx_delta_verify_requests_created ON public.delta_verify_requests(created_at);

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
   WHERE r.status = 'pending' AND r.account_id = ANY(p_ids);
$$;

REVOKE ALL ON FUNCTION public.get_pending_engine_requests(UUID[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_engine_requests(UUID[], UUID[]) TO service_role;

-- ── 2. Live snapshot version ────────────────────────────────────────────────
ALTER TABLE public.live_exchange_state
  ADD COLUMN IF NOT EXISTS snapshot_version BIGINT NOT NULL DEFAULT 0;

-- ── 3. Dashboard KPI aggregate (get_trade_stats) ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trade_history_stats
    ON public.trade_history(account_id, underlying)
    INCLUDE (realized_gross_pnl, realized_net_pnl, exit_time);

-- ── 4. Daily Report per-day totals ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_trade_day_totals(p_account UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (realized_gross NUMERIC, fees NUMERIC, trades BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(SUM(realized_gross_pnl), 0), COALESCE(SUM(total_fees), 0), COUNT(*)
    FROM public.trade_history
   WHERE account_id = p_account AND exit_time >= p_from AND exit_time < p_to;
$$;

REVOKE ALL ON FUNCTION public.get_trade_day_totals(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_day_totals(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
