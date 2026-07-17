-- 025: Include expiry in the strike-uniqueness indexes.
--
-- The same buy/sell strike on DIFFERENT expiries (e.g. 67000 on the 16th vs 67000 on the
-- 17th during an expiry roll) are genuinely different positions. The old unique indexes
-- keyed only on (account_id, underlying, type, strike), so the second insert collided with
-- the first and Postgres rejected it with 23505 (unique_violation) — surfacing as the
-- "DB Guard: Duplicate strike entry blocked for X/Y" false positive even though no real
-- duplicate existed. Re-key both indexes to include expiry so cross-expiry same-strike
-- positions coexist, while same-expiry duplicates are still blocked.

DROP INDEX IF EXISTS public.idx_active_positions_buy_strike_unique;
DROP INDEX IF EXISTS public.idx_active_positions_sell_strike_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike);
