-- ============================================================
-- OptionScope — ALL live-trading migrations, in order
-- Idempotent: safe to run on an existing DB. Run AFTER the one-time
-- Vault key:  select vault.create_secret(<long-random>, delta_cred_encryption_key);
-- ============================================================


-- ─── 001_delta_live_accounts.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001 — Delta Exchange LIVE account linking (Stage 1: credential storage)
-- ─────────────────────────────────────────────────────────────────────────────
-- Safe to run against an existing OptionScope database (all statements idempotent).
-- Adds a paper/live mode flag to accounts and a securely-encrypted credential store.
--
-- SECURITY MODEL
--   • The browser NEVER reads or stores the raw API secret. It writes credentials
--     through the SECURITY DEFINER RPC `upsert_delta_credentials`, which encrypts
--     the secret at rest with pgcrypto using a key held in Supabase Vault.
--   • Direct table access is denied to anon/authenticated by RLS; only service_role
--     (the headless engine) and the SECURITY DEFINER RPCs can touch the ciphertext.
--   • `get_delta_credentials_decrypted` is the ONLY decrypt path and is granted to
--     service_role ONLY — the engine uses it in Stage 2 to place live orders.
--
-- ONE-TIME PREREQUISITE (run once in the SQL editor, replace the passphrase):
--   select vault.create_secret(
--     'CHANGE-ME-to-a-long-random-string', 'delta_cred_encryption_key');
-- ─────────────────────────────────────────────────────────────────────────────

-- pgcrypto (Supabase installs it in the `extensions` schema). Vault ships enabled.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Account mode + kill-switch ------------------------------------------------
ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_accounts_mode_check'
  ) THEN
    ALTER TABLE public.paper_trading_accounts
      ADD CONSTRAINT paper_trading_accounts_mode_check CHECK (mode IN ('paper','live'));
  END IF;
END $$;

-- Kill-switch: live accounts do NOT send real orders until this is explicitly true.
ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS live_enabled BOOLEAN NOT NULL DEFAULT false;

-- 2. Encrypted credential store ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delta_credentials (
    account_id     UUID PRIMARY KEY REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    api_key        TEXT NOT NULL,           -- public identifier, sent in a header on every call
    api_secret_enc BYTEA NOT NULL,          -- pgp_sym_encrypt() ciphertext; never leaves the DB decrypted
    key_last4      TEXT,                    -- for display only
    status         TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (status IN ('unverified','verified','invalid')),
    verified_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_credentials ENABLE ROW LEVEL SECURITY;

-- Only the engine (service_role) may read/write the ciphertext directly.
-- No anon/authenticated policy exists, so RLS denies all direct client access;
-- clients must go through the SECURITY DEFINER RPCs below.
DROP POLICY IF EXISTS "Service role full access on delta_credentials" ON public.delta_credentials;
CREATE POLICY "Service role full access on delta_credentials"
    ON public.delta_credentials FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 3. Internal helpers ----------------------------------------------------------
-- Fetches the Vault-held encryption passphrase. SECURITY DEFINER + revoked from
-- clients so only the definer-owned RPCs below can reach it.
CREATE OR REPLACE FUNCTION public._delta_cred_key()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
   WHERE name = 'delta_cred_encryption_key' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._delta_cred_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;
REVOKE ALL ON FUNCTION public._is_admin() FROM PUBLIC, anon;

-- 4. Write RPC (owner-scoped, encrypts the secret) -----------------------------
CREATE OR REPLACE FUNCTION public.upsert_delta_credentials(
  p_account_id UUID,
  p_api_key    TEXT,
  p_api_secret TEXT,
  p_verified   BOOLEAN DEFAULT false
)
RETURNS TABLE (account_id UUID, key_last4 TEXT, status TEXT, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner UUID;
  v_key   TEXT;
BEGIN
  SELECT user_id INTO v_owner FROM public.paper_trading_accounts WHERE id = p_account_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  IF v_owner <> auth.uid() AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;
  IF p_api_key IS NULL OR length(p_api_key) < 4
     OR p_api_secret IS NULL OR length(p_api_secret) < 4 THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured (missing vault secret "delta_cred_encryption_key")';
  END IF;

  INSERT INTO public.delta_credentials AS dc
    (account_id, api_key, api_secret_enc, key_last4, status, verified_at, updated_at)
  VALUES (
    p_account_id,
    p_api_key,
    extensions.pgp_sym_encrypt(p_api_secret, v_key),
    right(p_api_key, 4),
    CASE WHEN p_verified THEN 'verified' ELSE 'unverified' END,
    CASE WHEN p_verified THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (account_id) DO UPDATE SET
    api_key        = EXCLUDED.api_key,
    api_secret_enc = EXCLUDED.api_secret_enc,
    key_last4      = EXCLUDED.key_last4,
    status         = EXCLUDED.status,
    verified_at    = EXCLUDED.verified_at,
    updated_at     = now();

  RETURN QUERY
    SELECT dc.account_id, dc.key_last4, dc.status, dc.verified_at
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- 5. Owner metadata read RPC (returns api_key + status, NEVER the secret) -------
CREATE OR REPLACE FUNCTION public.get_delta_credentials_meta(p_account_id UUID)
RETURNS TABLE (account_id UUID, api_key TEXT, key_last4 TEXT, status TEXT,
               verified_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_owner UUID;
BEGIN
  SELECT user_id INTO v_owner FROM public.paper_trading_accounts WHERE id = p_account_id;
  IF v_owner IS NULL OR (v_owner <> auth.uid() AND NOT public._is_admin()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN QUERY
    SELECT dc.account_id, dc.api_key, dc.key_last4, dc.status, dc.verified_at, dc.updated_at
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_credentials_meta(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_delta_credentials_meta(UUID) TO authenticated;

-- 6. Decrypt RPC — service_role ONLY (used by the engine in Stage 2) -----------
CREATE OR REPLACE FUNCTION public.get_delta_credentials_decrypted(p_account_id UUID)
RETURNS TABLE (api_key TEXT, api_secret TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_key TEXT;
BEGIN
  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured';
  END IF;
  RETURN QUERY
    SELECT dc.api_key, extensions.pgp_sym_decrypt(dc.api_secret_enc, v_key)
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_credentials_decrypted(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_delta_credentials_decrypted(UUID) TO service_role;


-- ─── 002_balance_allocation.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — Balance allocation for live position sizing
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a per-account "% of wallet balance to allocate" used ONLY by live accounts
-- to size positions (usable = balance × pct; part = usable / max positions; each
-- position uses up to 1 part of margin). Paper accounts get the column with the
-- default 90 but never use it, so paper trading is unaffected.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data is modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS balance_allocation_pct numeric NOT NULL DEFAULT 90;

-- Keep it sane (1–100%).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_balance_allocation_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_balance_allocation_pct_check
      CHECK (balance_allocation_pct > 0 AND balance_allocation_pct <= 100);
  END IF;
END $$;


-- ─── 003_pause_and_entry_offsets.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — Account pause + live entry price offsets
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. paper_trading_accounts.paused — when true the engine stops opening NEW
--    positions for the account but keeps managing open ones (and the resting
--    SL/TP orders stay on the exchange). Defaults false, so existing behaviour
--    (paper included) is unchanged.
-- 2. paper_trading_config.entry_buy_offset / entry_sell_offset — premium-dollar
--    offsets applied ONLY to LIVE entry order limit prices (buy at ask+offset,
--    sell at bid-offset) to make marketable entries fill. Paper ignores them.
--
-- Additive only. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_buy_offset numeric NOT NULL DEFAULT 10;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_sell_offset numeric NOT NULL DEFAULT 3;


-- ─── 004_engine_verify.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — Engine-mediated credential verification
-- ─────────────────────────────────────────────────────────────────────────────
-- The browser "Verify Connection" call cannot reach Delta from the whitelisted
-- server IP (it egresses from Vercel). Instead, the browser drops an encrypted
-- verification request here; the engine (running on the whitelisted AWS IP, with
-- the service_role key) picks it up, runs the balance check from that IP, and
-- writes the result back for the UI to poll. No public endpoint on the server.
--
-- Requires migration 001 (pgcrypto + _delta_cred_key + the Vault key).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delta_verify_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    api_key        TEXT NOT NULL,
    api_secret_enc BYTEA,                       -- encrypted; cleared after processing
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','verified','error')),
    error          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    processed_at   TIMESTAMPTZ
);

ALTER TABLE public.delta_verify_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own verify requests" ON public.delta_verify_requests;
CREATE POLICY "Users manage own verify requests"
    ON public.delta_verify_requests FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access on verify requests" ON public.delta_verify_requests;
CREATE POLICY "Service role full access on verify requests"
    ON public.delta_verify_requests FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_delta_verify_pending
    ON public.delta_verify_requests (status) WHERE status = 'pending';

-- Request verification (encrypts the secret with the Vault key). Owner-scoped.
CREATE OR REPLACE FUNCTION public.request_delta_verification(p_api_key TEXT, p_api_secret TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_key TEXT; v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_api_key IS NULL OR length(p_api_key) < 4
     OR p_api_secret IS NULL OR length(p_api_secret) < 4 THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;
  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured (missing vault secret "delta_cred_encryption_key")';
  END IF;
  INSERT INTO public.delta_verify_requests (user_id, api_key, api_secret_enc, status)
  VALUES (auth.uid(), p_api_key, extensions.pgp_sym_encrypt(p_api_secret, v_key), 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.request_delta_verification(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_delta_verification(TEXT, TEXT) TO authenticated;

-- Poll status (owner-scoped).
CREATE OR REPLACE FUNCTION public.get_delta_verification_status(p_id UUID)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
    SELECT r.status, r.error FROM public.delta_verify_requests r
     WHERE r.id = p_id AND r.user_id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_verification_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_delta_verification_status(UUID) TO authenticated;

-- Decrypt for the engine — service_role ONLY.
CREATE OR REPLACE FUNCTION public.get_delta_verify_request_decrypted(p_id UUID)
RETURNS TABLE (api_key TEXT, api_secret TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_key TEXT;
BEGIN
  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN RAISE EXCEPTION 'Encryption key not configured'; END IF;
  RETURN QUERY
    SELECT r.api_key, extensions.pgp_sym_decrypt(r.api_secret_enc, v_key)
      FROM public.delta_verify_requests r WHERE r.id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_verify_request_decrypted(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_delta_verify_request_decrypted(UUID) TO service_role;


-- ─── 005_verify_balance.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005 — Return wallet balance with the verification result
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds a balance column the engine fills on a successful verify (USDT wallet
-- balance), and surfaces it through the owner-facing status RPC so the UI can
-- display it. Additive; requires migration 004.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.delta_verify_requests
  ADD COLUMN IF NOT EXISTS balance numeric;

-- Return type changes, so drop + recreate the status RPC.
DROP FUNCTION IF EXISTS public.get_delta_verification_status(UUID);

CREATE FUNCTION public.get_delta_verification_status(p_id UUID)
RETURNS TABLE (status TEXT, error TEXT, balance numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
    SELECT r.status, r.error, r.balance FROM public.delta_verify_requests r
     WHERE r.id = p_id AND r.user_id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.get_delta_verification_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_delta_verification_status(UUID) TO authenticated;


-- ─── 006_fix_upsert_ambiguous.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006 — Fix "column reference account_id is ambiguous" on credential save
-- ─────────────────────────────────────────────────────────────────────────────
-- upsert_delta_credentials (migration 001) declares RETURNS TABLE (account_id ...),
-- which creates an output variable that shadows the delta_credentials.account_id
-- column. In `ON CONFLICT (account_id)` Postgres then can't tell variable from
-- column and raises "column reference account_id is ambiguous", so the credential
-- write fails (the account row saves via a separate call, but the key is not stored).
--
-- Fix: add `#variable_conflict use_column` so ambiguous identifiers resolve to the
-- table column. Signature is unchanged, so CREATE OR REPLACE is sufficient.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.upsert_delta_credentials(
  p_account_id UUID,
  p_api_key    TEXT,
  p_api_secret TEXT,
  p_verified   BOOLEAN DEFAULT false
)
RETURNS TABLE (account_id UUID, key_last4 TEXT, status TEXT, verified_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_owner UUID;
  v_key   TEXT;
BEGIN
  SELECT user_id INTO v_owner FROM public.paper_trading_accounts WHERE id = p_account_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
  IF v_owner <> auth.uid() AND NOT public._is_admin() THEN
    RAISE EXCEPTION 'Not authorized for this account';
  END IF;
  IF p_api_key IS NULL OR length(p_api_key) < 4
     OR p_api_secret IS NULL OR length(p_api_secret) < 4 THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  v_key := public._delta_cred_key();
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Encryption key not configured (missing vault secret "delta_cred_encryption_key")';
  END IF;

  INSERT INTO public.delta_credentials AS dc
    (account_id, api_key, api_secret_enc, key_last4, status, verified_at, updated_at)
  VALUES (
    p_account_id,
    p_api_key,
    extensions.pgp_sym_encrypt(p_api_secret, v_key),
    right(p_api_key, 4),
    CASE WHEN p_verified THEN 'verified' ELSE 'unverified' END,
    CASE WHEN p_verified THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (account_id) DO UPDATE SET
    api_key        = EXCLUDED.api_key,
    api_secret_enc = EXCLUDED.api_secret_enc,
    key_last4      = EXCLUDED.key_last4,
    status         = EXCLUDED.status,
    verified_at    = EXCLUDED.verified_at,
    updated_at     = now();

  RETURN QUERY
    SELECT dc.account_id, dc.key_last4, dc.status, dc.verified_at
      FROM public.delta_credentials dc WHERE dc.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_delta_credentials(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;


-- ─── 007_heartbeat_balance.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007 — Surface live wallet balance to the dashboard
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine polls the live USDT wallet balance for armed live accounts and writes
-- it to the heartbeat so the UI can show Wallet / Allocated / per-position figures.
-- Additive; null for paper accounts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS wallet_balance numeric;


-- ─── 008_heartbeat_dryrun.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008 — Surface engine execution mode (dry-run vs real) to the UI
-- ─────────────────────────────────────────────────────────────────────────────
-- The engine writes its DELTA_LIVE_DRYRUN state to the heartbeat so the dashboard
-- can show whether armed live accounts will place REAL orders or only simulate.
-- Additive; null when unknown/old engine.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS dry_run boolean;


-- ─── 009_live_exchange_state.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 009 — Live exchange state snapshot (real Delta orders/fills/positions)
-- ─────────────────────────────────────────────────────────────────────────────
-- For armed live accounts the engine periodically READS the account's real state
-- from Delta (positions, resting orders, stop orders, fills, wallet balances) and
-- upserts one row per account here. The UI reads this to populate the Positions /
-- Open Orders / Stop Orders / Fills / Risk & Margin tabs with exchange truth
-- instead of engine-internal bookkeeping.
--
-- READ-ONLY with respect to the exchange — publishing this snapshot places no
-- orders. Paper accounts never write here (row stays absent → UI falls back to the
-- engine-derived views). One row per account; blobs are JSONB and small.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_exchange_state (
    account_id   UUID PRIMARY KEY REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    positions    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- /v2/positions/margined
    orders       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- resting limit orders
    stop_orders  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- resting stop orders
    fills        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- recent executions
    balances     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- /v2/wallet/balances
    wallet       NUMERIC                              -- extracted usable balance
);

ALTER TABLE public.live_exchange_state ENABLE ROW LEVEL SECURITY;

-- Read gated to authenticated users (same posture as engine_heartbeat). Only the
-- account owner meaningfully cares, but the account_id key already scopes reads.
CREATE POLICY "All authenticated users can read live exchange state"
    ON public.live_exchange_state FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Service role full access on live_exchange_state"
    ON public.live_exchange_state FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);


-- ─── 010_heartbeat_maxpos.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010 — Publish engine's max-positions + allocation % to the heartbeat
-- ─────────────────────────────────────────────────────────────────────────────
-- The UI's "per-position" figure was computed from the account's creation-time
-- default_config and ignored schedule windows, so it didn't match the engine.
-- The engine now writes the SAME max-positions it uses for sizing (max of
-- calls+puts across base config AND all windows) plus the live allocation %, so
-- the KPI matches exactly. Additive; null for paper / disarmed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS max_positions integer;

ALTER TABLE public.engine_heartbeat
  ADD COLUMN IF NOT EXISTS allocation_pct numeric;


-- ─── 011_manual_exit.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011 — UI-initiated manual exit for live positions
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard sets exit_requested = true; the engine (not the browser) then
-- closes the real position on Delta, books a Manual Exit, and deletes the row.
-- Prevents the browser from deleting a live DB row while the exchange position
-- stays open. Additive; default false.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS exit_requested boolean NOT NULL DEFAULT false;


-- ─── 012_schedule_max_debit_exit_type.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012 — per-window Max Net Debit + Exit Type
-- ─────────────────────────────────────────────────────────────────────────────
-- Max Net Debit and Exit Type (+ Exit Points) move from the account-level Control
-- Panel to each time-schedule window, so different windows can run different entry
-- debit caps and exit rules. The account-level values remain as the fallback used
-- when no window is active (the uncovered-slot gap). Additive; safe defaults match
-- the previous account-level defaults.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS max_net_premium NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS exit_type TEXT NOT NULL DEFAULT 'ATM',
  ADD COLUMN IF NOT EXISTS exit_points INTEGER NOT NULL DEFAULT 0;


-- ─── 013_close_all.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013 — One-click "Close All" for live accounts
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard sets close_all_requested = true; the engine flattens the account
-- on Delta in one call (POST /v2/positions/close_all), cancels resting orders,
-- books Manual Exits, deletes the rows, then clears the flag. Falls back to
-- per-position reduce_only closes if the native call fails. Additive; default false.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS close_all_requested boolean NOT NULL DEFAULT false;


-- ─── 014_close_by_symbol.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014 — Close a single Delta position by symbol (per-row ✕)
-- ─────────────────────────────────────────────────────────────────────────────
-- Lets the dashboard close ANY open Delta leg from the Positions table — even
-- orphans the engine no longer tracks in active_positions. The UI inserts a row;
-- the engine places a reduce_only market close for that symbol and deletes the row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delta_close_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    product_symbol TEXT NOT NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_close_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage close requests of their own accounts" ON public.delta_close_requests;
CREATE POLICY "Users manage close requests of their own accounts"
    ON public.delta_close_requests FOR ALL
    USING (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()))
    WITH CHECK (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access on close requests" ON public.delta_close_requests;
CREATE POLICY "Service role full access on close requests"
    ON public.delta_close_requests FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ─── 015_cancel_order.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015 — Cancel a single Delta order from the Open Orders table (✕)
-- ─────────────────────────────────────────────────────────────────────────────
-- The dashboard inserts a row; the engine cancels that order on Delta (DELETE
-- /v2/orders with id + product_id) and removes the row.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.delta_cancel_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES public.paper_trading_accounts(id) ON DELETE CASCADE,
    order_id    BIGINT NOT NULL,
    product_id  BIGINT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.delta_cancel_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage cancel requests of their own accounts" ON public.delta_cancel_requests;
CREATE POLICY "Users manage cancel requests of their own accounts"
    ON public.delta_cancel_requests FOR ALL
    USING (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()))
    WITH CHECK (account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full access on cancel requests" ON public.delta_cancel_requests;
CREATE POLICY "Service role full access on cancel requests"
    ON public.delta_cancel_requests FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ─── 016_admin_manage_accounts.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016 — Let admins manage accounts they don't own
-- ─────────────────────────────────────────────────────────────────────────────
-- The credential RPCs already allow an admin (profiles.role = 'admin') to act on
-- ANY account, but the table RLS policies only allow the account OWNER
-- (user_id = auth.uid()). So an admin managing a client's account could NOT, from
-- the UI: close an orphan leg (delta_close_requests), cancel an order
-- (delta_cancel_requests), manually exit a position (active_positions), trigger
-- close-all / toggle live_enabled (paper_trading_accounts), or save config /
-- schedules — every such write failed RLS with:
--   "new row violates row-level security policy".
--
-- This migration extends each client-write policy with an admin bypass, using the
-- same inline admin check the existing "Admins can manage all profiles" policy
-- uses (no function-grant changes needed). Service-role policies are untouched.
-- Idempotent: every policy is DROP-then-CREATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- Accounts ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage their own accounts" ON public.paper_trading_accounts;
CREATE POLICY "Users can manage their own accounts"
    ON public.paper_trading_accounts FOR ALL
    USING (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        auth.uid() = user_id
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Config ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage config of their own accounts" ON public.paper_trading_config;
CREATE POLICY "Users can manage config of their own accounts"
    ON public.paper_trading_config FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Schedules ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own schedules" ON public.paper_trading_schedules;
CREATE POLICY "Users manage own schedules"
    ON public.paper_trading_schedules FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Active positions (manual exit) ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage active positions of their own accounts" ON public.active_positions;
CREATE POLICY "Users can manage active positions of their own accounts"
    ON public.active_positions FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Trade history ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can manage trade history of their own accounts" ON public.trade_history;
CREATE POLICY "Users can manage trade history of their own accounts"
    ON public.trade_history FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Close requests (per-leg ✕, incl. orphans) ──────────────────────────────────
DROP POLICY IF EXISTS "Users manage close requests of their own accounts" ON public.delta_close_requests;
CREATE POLICY "Users manage close requests of their own accounts"
    ON public.delta_close_requests FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );

-- Cancel requests (per-order ✕) ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage cancel requests of their own accounts" ON public.delta_cancel_requests;
CREATE POLICY "Users manage cancel requests of their own accounts"
    ON public.delta_cancel_requests FOR ALL
    USING (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    )
    WITH CHECK (
        account_id IN (SELECT a.id FROM public.paper_trading_accounts a WHERE a.user_id = auth.uid())
        OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
    );


-- ─── 017_live_order_history.sql ───
-- Adds order_history JSONB to live_exchange_state so the UI's Order History tab
-- can mirror Delta's real order-history feed for armed live accounts. Additive.
ALTER TABLE public.live_exchange_state
    ADD COLUMN IF NOT EXISTS order_history JSONB NOT NULL DEFAULT '[]'::jsonb;


-- ─── 018_strategy_version.sql ───
-- Per-account strategy_version: lets experimental strategy logic (new filters,
-- changed entry/exit rules) run on a PAPER account (version 2) while LIVE accounts
-- stay on the stable version 1. Engine and UI both branch on this value. Defaults
-- to 1 so existing accounts are unchanged. Additive.
ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS strategy_version INTEGER NOT NULL DEFAULT 1;


-- ─── 019_schedule_days_to_expiry.sql ───
-- Per-window Min Days to Expiry: days_to_expiry moves from account-level config into
-- each schedule window for experimental paper accounts (strategy_version >= 2). Live
-- accounts (v1) keep the account-level field. Expiry auto-selection uses the PEAK
-- days_to_expiry across active windows; each window guards its own entries. Defaults
-- to 0 (unchanged behaviour). Additive.
ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS days_to_expiry NUMERIC NOT NULL DEFAULT 0;


-- ─── 021_trade_days.sql ───
-- Per-account Trading Days: the weekdays an account may OPEN new positions on (JSONB
-- array, JS getDay() 0=Sun..6=Sat), aligned to the 17:30 IST trading-day boundary.
-- Entry-only gate; experimental paper (strategy_version >= 2) only. Default all seven
-- (trade every day) so existing accounts are unchanged. Additive.
ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS trade_days JSONB NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb;


-- ─── 022_hedge_overlay.sql ───
-- Per-window long-only Hedge Overlay (paper strategy_version >= 2). A window can buy an
-- OTM long of a type sized as (sum of active short qty of type) × pct, at the strike whose
-- ask is nearest a target premium; it drains proportionally as the main book exits.
-- Marked buy_leg.isHedge; exempt from normal caps/exit. Defaults leave windows unchanged.
ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS hedge_strike_type TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS hedge_call_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_call_pct NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_put_price NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hedge_put_pct NUMERIC NOT NULL DEFAULT 0;


-- ─── 023_per_spread_hedge_leg.sql ───
-- Per-spread Hedge Leg (paper strategy_version >= 2): replaces the standalone hedge
-- overlay (022) with a 3rd LONG-ONLY leg baked into each ratio spread (long/short/long
-- triplet). The 5 config fields from 022 are reused; the leg is stored in a new nullable
-- hedge_leg JSONB column on both tables. Sized as (this spread's own short qty) × pct,
-- gated into entry by the combined 3-leg net debit, and exited on the main long's
-- ATM/ITM/OTM cross or expiry. NULL hedge_leg = plain 2-leg spread. Additive.
ALTER TABLE public.active_positions
  ADD COLUMN IF NOT EXISTS hedge_leg JSONB DEFAULT NULL;
ALTER TABLE public.trade_history
  ADD COLUMN IF NOT EXISTS hedge_leg JSONB DEFAULT NULL;


-- ─── 024_heartbeat_unlogged.sql ───
-- engine_heartbeat is a tiny table re-upserted every ~30s per engine (liveness). Its
-- last_heartbeat always changes, so it churns dead tuples and autovacuums ~every 1.5min
-- all day — the dominant WAL/autovacuum disk-IO consumer. The data is ephemeral (engine
-- rewrites within 30s of restart; UI marks offline after 120s), so make it UNLOGGED to
-- drop its WAL + vacuum IO. Read by the UI via polling, not Realtime — drop from the
-- publication first (unlogged tables can't be logically replicated). fillfactor 70 keeps
-- repeated updates HOT. Reversible via ALTER TABLE ... SET LOGGED.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'engine_heartbeat'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.engine_heartbeat';
  END IF;
END $$;
ALTER TABLE public.engine_heartbeat SET UNLOGGED;
ALTER TABLE public.engine_heartbeat SET (fillfactor = 70);


-- ─── 025_expiry_in_strike_unique.sql ───
-- The same buy/sell strike on DIFFERENT expiries (e.g. 67000 on the 16th vs 67000 on the
-- 17th during an expiry roll) are genuinely different positions. The old unique indexes
-- keyed only on (account_id, underlying, type, strike), so the second insert collided with
-- the first and Postgres rejected it with 23505 (unique_violation) — the
-- "DB Guard: Duplicate strike entry blocked for X/Y" false positive. Re-key both indexes
-- to include expiry so cross-expiry same-strike positions coexist; same-expiry duplicates
-- are still blocked.
DROP INDEX IF EXISTS public.idx_active_positions_buy_strike_unique;
DROP INDEX IF EXISTS public.idx_active_positions_sell_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike);


-- ─── 026_sell_strike_unique_partial.sql ───
-- Root cause of the 65500/67000 incident that 025 did NOT fix: the DB still carried the
-- original no-expiry unique CONSTRAINTS unique_buy_strike_per_type / unique_sell_strike_per_type.
-- 025 only DROP INDEX'd the new idx_* names and never dropped these constraints (a
-- constraint-backed index can't be dropped with DROP INDEX — needs ALTER TABLE DROP
-- CONSTRAINT), so the stricter no-expiry sell constraint kept rejecting cross-expiry same
-- strikes. Drop both legacy constraints, then (re)create the expiry-aware indexes: buy-strike
-- non-partial, sell-strike PARTIAL on sell_qty > 0 so long-only remnants don't reserve a
-- strike and the index matches the pre-order guard (closing the orphan window). Two active
-- shorts at the same strike/expiry still both carry sell_qty > 0 and stay blocked.
ALTER TABLE public.active_positions DROP CONSTRAINT IF EXISTS unique_buy_strike_per_type;
ALTER TABLE public.active_positions DROP CONSTRAINT IF EXISTS unique_sell_strike_per_type;
DROP INDEX IF EXISTS public.unique_buy_strike_per_type;
DROP INDEX IF EXISTS public.unique_sell_strike_per_type;
DROP INDEX IF EXISTS public.idx_active_positions_buy_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_buy_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, buy_strike);
DROP INDEX IF EXISTS public.idx_active_positions_sell_strike_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_positions_sell_strike_unique
    ON public.active_positions(account_id, underlying, type, expiry, sell_strike)
    WHERE sell_qty > 0;


-- ─── 027_paper_balance_combined.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027 — Paper initial balance + combined-position sizing
-- ─────────────────────────────────────────────────────────────────────────────
-- Brings a real funded-account model to PAPER trading (paper only — live is
-- unchanged and keeps its wallet-balance sizing + number_of_calls/number_of_puts).
--
--   • initial_balance          — the paper account's starting equity. Live equity =
--                                initial_balance + cumulative realized P&L. The
--                                tradeable margin pool = equity × balance_allocation_pct;
--                                the remainder stays as an untouched buffer.
--   • max_combined_positions   — per-window cap on TOTAL open full spreads (calls+puts).
--   • combined_split_pct       — per-window %. Derived per-type cap (paper) =
--                                ceil(combined_split_pct/100 × max_combined_positions),
--                                applied to BOTH calls and puts; the combined total is
--                                still hard-capped at max_combined_positions.
--
-- balance_allocation_pct already exists (migration 002) and is reused for paper.
-- Per-position margin = allocated pool ÷ the ACTIVE window's max_combined_positions.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No data modified or removed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS initial_balance numeric NOT NULL DEFAULT 3000;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS max_combined_positions integer NOT NULL DEFAULT 4;

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS combined_split_pct numeric NOT NULL DEFAULT 70;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS max_combined_positions integer NOT NULL DEFAULT 4;

ALTER TABLE public.paper_trading_schedules
  ADD COLUMN IF NOT EXISTS combined_split_pct numeric NOT NULL DEFAULT 70;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_initial_balance_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_initial_balance_check
      CHECK (initial_balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_max_combined_positions_check
      CHECK (max_combined_positions >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_config_combined_split_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_config
      ADD CONSTRAINT paper_trading_config_combined_split_pct_check
      CHECK (combined_split_pct > 0 AND combined_split_pct <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_max_combined_positions_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_max_combined_positions_check
      CHECK (max_combined_positions >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_trading_schedules_combined_split_pct_check'
  ) THEN
    ALTER TABLE public.paper_trading_schedules
      ADD CONSTRAINT paper_trading_schedules_combined_split_pct_check
      CHECK (combined_split_pct > 0 AND combined_split_pct <= 100);
  END IF;
END $$;


-- ─── 028_account_telegram_chat.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028 — Per-account Telegram chat id (independent live logs)
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds an optional per-account Telegram destination so each LIVE account can send
-- its trade/failure alerts to its own chat instead of the single shared group.
-- NULL → fall back to the global TELEGRAM_CHAT_ID env (unchanged). One shared bot
-- token (TELEGRAM_BOT_TOKEN) still serves every chat. Additive only.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_chat_id text;


-- ─── 029_account_telegram_link.sql ───
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 029 — Telegram /start deep-link auto-capture code
-- ─────────────────────────────────────────────────────────────────────────────
-- Companion to 028. Single-use linking token so a live account captures its Telegram
-- chat id via a t.me/<bot>?start=<code> deep link (no manual numeric-id entry): UI
-- writes telegram_link_code, the engine's bot listener matches an incoming /start
-- <code>, stores telegram_chat_id and clears the code. Additive only.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_accounts
  ADD COLUMN IF NOT EXISTS telegram_link_code text;

CREATE INDEX IF NOT EXISTS idx_accounts_telegram_link_code
  ON public.paper_trading_accounts (telegram_link_code)
  WHERE telegram_link_code IS NOT NULL;
