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
