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
