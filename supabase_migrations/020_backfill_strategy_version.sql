-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020 — set all PAPER accounts to strategy_version 2, LIVE to 1 + backfill
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE-TIME DATA migration (run once — not part of ALL_MIGRATIONS, as it UPDATEs data
-- rather than schema). Makes paper accounts the experimental testbed (v2) while live
-- accounts stay on the stable version (1). Also backfills each paper account's
-- per-window days_to_expiry (migration 019) from its old account-level value, so the
-- move to per-window DTE preserves the exact behaviour the account had at v1.
--
-- Prerequisite: migrations 018 (strategy_version) and 019 (schedule days_to_expiry)
-- must already be applied.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Paper accounts → v2 (experimental). Live → 1 (stable) — set explicitly for both
--    so the state is deterministic regardless of prior values.
UPDATE public.paper_trading_config c
SET strategy_version = CASE WHEN a.mode = 'live' THEN 1 ELSE 2 END
FROM public.paper_trading_accounts a
WHERE c.account_id = a.id;

-- 2) Backfill: copy each PAPER account's account-level days_to_expiry into its schedule
--    windows so v2's per-window guard starts from the same value it used at v1. Only
--    touches windows still at the 0 default (won't clobber any value already set), and
--    only when the account-level value is non-zero (0 → 0 is a no-op).
UPDATE public.paper_trading_schedules s
SET days_to_expiry = c.days_to_expiry
FROM public.paper_trading_config c
JOIN public.paper_trading_accounts a ON a.id = c.account_id
WHERE s.account_id = c.account_id
  AND a.mode <> 'live'
  AND s.days_to_expiry = 0
  AND c.days_to_expiry > 0;
