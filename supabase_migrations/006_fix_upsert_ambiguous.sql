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
