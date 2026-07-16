-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 023 — backfill LIVE accounts' per-window days_to_expiry
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE-TIME DATA migration (run once — not part of ALL_MIGRATIONS, as it UPDATEs data
-- rather than schema). Per-window Min Days to Expiry (migration 019) is now used by ALL
-- accounts, not just experimental paper (v2). Previously live (v1) accounts kept a single
-- account-level days_to_expiry and their schedule windows sat at the 0 default; migration
-- 020 backfilled paper accounts only (a.mode <> 'live'), explicitly skipping live.
--
-- This copies each LIVE account's account-level days_to_expiry into its schedule windows
-- so the switch to per-window DTE preserves the exact expiry behaviour the account had
-- before — a live account with account-level DTE 1 keeps DTE 1 on every window instead of
-- silently dropping to 0.
--
-- Mirrors migration 020 step 2 but for a.mode = 'live'. Only touches windows still at the
-- 0 default (won't clobber a value already set) and only when the account-level value is
-- non-zero (0 → 0 is a no-op).
--
-- Prerequisite: migrations 018 (strategy_version), 019 (schedule days_to_expiry), and 020
-- (backfill) must already be applied.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.paper_trading_schedules s
SET days_to_expiry = c.days_to_expiry
FROM public.paper_trading_config c
JOIN public.paper_trading_accounts a ON a.id = c.account_id
WHERE s.account_id = c.account_id
  AND a.mode = 'live'
  AND s.days_to_expiry = 0
  AND c.days_to_expiry > 0;
