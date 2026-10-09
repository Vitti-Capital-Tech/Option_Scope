-- Migration 060: cumulative realized P&L per account as ONE number from the database.
--
-- The engine's paper equity = initial balance + realized P&L. It used to compute the realized
-- part by downloading EVERY trade_history row of the account every 45s and summing it — but
-- the API returns at most 1,000 rows per request, so accounts with more trades got a partial
-- sum (e.g. 3,300 trades, $6,571 realized, engine saw ~$1,900) and paper positions were sized
-- off a too-small equity. 22 accounts doing that every 45s was also heavy egress and a large
-- share of the database load behind the statement timeouts.
--
-- get_account_realized_pnl(account) sums it in the database and returns a single number
-- (always a fresh, exact total — nothing to keep in sync). The covering index lets Postgres
-- answer it from the index alone (index-only scan) instead of reading the trade rows.
--
-- Additive and safe to re-run. Building the index briefly locks writes to trade_history
-- (a few seconds on a few-thousand-row table) — run it at a quiet time.

CREATE INDEX IF NOT EXISTS idx_trade_history_account_pnl
    ON public.trade_history (account_id) INCLUDE (realized_net_pnl);

CREATE OR REPLACE FUNCTION public.get_account_realized_pnl(p_account UUID)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(SUM(realized_net_pnl), 0) FROM public.trade_history WHERE account_id = p_account;
$$;

REVOKE ALL ON FUNCTION public.get_account_realized_pnl(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_account_realized_pnl(UUID) TO service_role;
