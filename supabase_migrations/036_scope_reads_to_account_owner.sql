-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 036 — Scope the remaining broad READ policies to the account owner
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016 put every client-facing WRITE behind "owner OR admin". Three READ
-- policies were left wide open, so per-account isolation held only in the UI (which
-- filters `user_id` for role='client') and NOT at the API. Any logged-in client could
-- open the browser console and read EVERY account's rows directly:
--
--   • paper_trading_schedules       — USING (true): readable even by ANON. Leaks every
--                                     account's strategy config and schedule windows.
--   • live_exchange_state           — USING (auth.role() = 'authenticated'): leaks
--                                     positions, orders, stop_orders, fills, balances
--                                     and wallet for EVERY live account. Real money data.
--   • entry_block_notifications     — USING (auth.role() = 'authenticated'): leaks every
--                                     account's blocked-entry log.
--
-- This matters the moment a second person is given access to one account: granting a
-- client ownership of a single live account is only meaningful if the other accounts
-- are actually unreadable. This migration closes all three using the SAME inline admin
-- check migration 016 uses (no function grants needed).
--
-- NOT changed:
--   • delta_credentials — already service_role + SECURITY DEFINER RPCs only. Correct.
--   • engine_heartbeat  — process-wide, not per-account; nothing account-scoped to leak.
--   • Every "Service role full access …" policy — the headless engine must keep writing.
--
-- Realtime: Supabase applies RLS to `postgres_changes`, so the owner/admin keep
-- receiving their own rows; only other accounts' rows stop being delivered.
--
-- Idempotent: DROP IF EXISTS then CREATE throughout.
-- ─────────────────────────────────────────────────────────────────────────────

-- Schedules ───────────────────────────────────────────────────────────────────
-- Drop the anon-readable SELECT policy outright. No replacement is needed: migration
-- 016's "Users manage own schedules" is FOR ALL with an owner-or-admin USING clause,
-- so it already grants SELECT to exactly the right people. Verified readers are the
-- authenticated dashboard and the engine (service_role) — no anon consumer exists.
DROP POLICY IF EXISTS "Allow public read on schedules" ON public.paper_trading_schedules;

-- Live exchange state ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "All authenticated users can read live exchange state" ON public.live_exchange_state;
CREATE POLICY "Account owners can read live exchange state"
    ON public.live_exchange_state FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Entry-block notifications ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "All authenticated users can read entry block notifications" ON public.entry_block_notifications;
CREATE POLICY "Account owners can read entry block notifications"
    ON public.entry_block_notifications FOR SELECT
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );
