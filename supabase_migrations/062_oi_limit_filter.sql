-- Migration 062: Open Interest (OI) limit filter — paper and live accounts (global / Control Panel).
--
-- Delta Exchange applies a contract-level, market-wide OI limit on options from 14 Oct 2026:
-- once a strike's total open interest (all participants) reaches the cap, the strike goes
-- REDUCE-ONLY — no new positions, closing still allowed. Caps: BTC 15M, ETH 10M, XAUT 5M.
-- The API exposes it per ticker as `oi_reduce_only_mode` (and `oi_value_usd` = the strike's
-- OI in USD).
--
-- paper_trading_config.oi_filter_enabled (default false): when ON (paper or live), the
-- engine skips every strike whose OI (USD) is at/over the cap or that Delta has locked
-- (reduce-only) — for the long, the short and the hedge leg. New entries only.
-- paper_trading_config.oi_max_cap_m: the cap in millions of USD; NULL = the underlying's
-- default (BTC 15, ETH 10, XAUT 5).
--
-- Group sync (sync_account_group) copies every config column dynamically, so both columns
-- sync to the group's members with no RPC change. Promoted to live on 2026-10-14.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS oi_filter_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oi_max_cap_m NUMERIC NULL CHECK (oi_max_cap_m IS NULL OR oi_max_cap_m > 0);
