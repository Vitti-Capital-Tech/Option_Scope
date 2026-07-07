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
