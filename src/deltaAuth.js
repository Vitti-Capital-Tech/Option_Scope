// Browser-side Delta Exchange authenticated request helper.
//
// Used ONLY to verify a freshly-entered API key/secret pair before we hand it to
// the encrypted store. The secret lives in memory for the duration of the Verify
// call and is never persisted client-side. Real order placement happens in the
// headless engine (service_role), never here.
//
// Requests go through a proxy so the signature is computed over the exact path
// Delta receives. By default this is the same-origin `/api` rewrite (Vite dev
// proxy / Vercel rewrite -> https://api.india.delta.exchange).
//
// Because Vercel's egress IP is dynamic, an IP-whitelisted key will reject the
// Vercel-proxied Verify call. Set VITE_DELTA_PROXY_URL to a proxy running on the
// server whose IP IS whitelisted (see engine/proxyServer.js) to route Verify
// through that host instead. It must NOT include a path prefix — the real Delta
// path (e.g. /v2/wallet/balances) is appended directly.
const PROXY = import.meta.env.VITE_DELTA_PROXY_URL || '/api';

// HMAC-SHA256(message) with `secret`, hex-encoded, via Web Crypto.
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Perform a signed Delta request. `path` is the real Delta path (no `/api`
 * prefix) exactly as it appears in the signature, e.g. '/v2/wallet/balances'.
 * Delta rejects signatures older than 5s, so we sign immediately before sending.
 */
export async function signedDeltaRequest(method, path, { apiKey, apiSecret, query = '', body = '' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = method + timestamp + path + query + body;
  const signature = await hmacSha256Hex(apiSecret, signaturePayload);

  const res = await fetch(PROXY + path + query, {
    method,
    headers: {
      'api-key': apiKey,
      timestamp,
      signature,
      'Content-Type': 'application/json',
      // Delta expects a User-Agent identifying the client library.
      'User-Agent': 'optionscope-web',
    },
    ...(body ? { body } : {}),
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok && json?.success !== false, status: res.status, json };
}

/**
 * Verify an API key/secret pair by hitting a lightweight authenticated endpoint.
 * Returns { ok, error }. A 401/invalid_api_key means bad credentials; a network
 * failure surfaces as ok:false with a message.
 */
export async function verifyDeltaCredentials(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) {
    return { ok: false, error: 'API key and secret are required.' };
  }
  try {
    const { ok, status, json } = await signedDeltaRequest('GET', '/v2/wallet/balances', {
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
    });
    if (ok) return { ok: true };
    const msg =
      json?.error?.code ||
      json?.error?.message ||
      (status === 401 ? 'Unauthorized — check the key/secret and IP allowlist.' : `HTTP ${status}`);
    return { ok: false, error: String(msg) };
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error contacting Delta Exchange.' };
  }
}
