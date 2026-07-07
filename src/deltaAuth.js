// Delta credential verification — engine-mediated.
//
// The browser cannot reach Delta from the whitelisted server IP (its request
// egresses from Vercel). So instead of signing/calling Delta here, we drop an
// encrypted verification request into Supabase; the engine — running on the
// whitelisted server with the service_role key — runs the balance check from
// that IP and writes the result back. We poll for the outcome.
//
// The raw secret is encrypted at rest by the RPC and never returned to the
// browser; it is cleared once the engine processes the request.

import { supabase } from './supabase';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify an API key/secret pair via the engine. Returns { ok, error }.
 * Requires the engine to be running (it does the actual Delta call).
 */
export async function verifyDeltaCredentials(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) {
    return { ok: false, error: 'API key and secret are required.' };
  }
  try {
    const { data: id, error } = await supabase.rpc('request_delta_verification', {
      p_api_key: apiKey.trim(),
      p_api_secret: apiSecret.trim(),
    });
    if (error) return { ok: false, error: error.message };

    // Poll for the engine's result (~30s max).
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const { data, error: sErr } = await supabase.rpc('get_delta_verification_status', { p_id: id });
      if (sErr) return { ok: false, error: sErr.message };
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.status === 'verified') return { ok: true };
      if (row?.status === 'error') return { ok: false, error: row.error || 'Verification failed.' };
    }
    return { ok: false, error: 'Timed out waiting for the engine — is it running?' };
  } catch (e) {
    return { ok: false, error: e?.message || 'Verification error.' };
  }
}
