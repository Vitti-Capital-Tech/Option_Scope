/**
 * Server-side AUTHENTICATED Delta Exchange client (live trading).
 *
 * Separate from deltaApi.js (which is public/market-data only). Every call here
 * is HMAC-SHA256 signed with a live account's api key/secret. Used exclusively by
 * the live-execution layer for accounts flagged `mode='live'` with the
 * `live_enabled` kill-switch on.
 *
 * Delta signature scheme:
 *   signature = HMAC_SHA256(secret, method + timestamp + path + queryString + body)
 * where timestamp is Unix seconds and queryString includes the leading '?'.
 * Delta rejects signatures older than 5s, so we sign immediately before sending.
 */
import crypto from 'node:crypto';

const BASE_URL = 'https://api.india.delta.exchange';

function signPayload(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Perform a signed request. `creds` = { apiKey, apiSecret }.
 * `query` (optional) must include the leading '?' and match exactly what is sent.
 */
async function signedRequest(creds, method, path, { query = '', body = null } = {}) {
  if (!creds?.apiKey || !creds?.apiSecret) {
    throw new Error('Missing Delta credentials');
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = method + timestamp + path + query + bodyStr;
  const signature = signPayload(creds.apiSecret, message);

  const res = await fetch(BASE_URL + path + query, {
    method,
    headers: {
      'api-key': creds.apiKey,
      signature,
      timestamp,
      'Content-Type': 'application/json',
      'User-Agent': 'optionscope-engine',
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || json?.success === false) {
    const msg = json?.error?.code || json?.error?.message || `Delta API ${res.status} on ${path}`;
    throw new Error(String(msg));
  }
  return json?.result;
}

/**
 * Place an order. `order` fields:
 *   product_symbol | product_id, size (int contracts), side ('buy'|'sell'),
 *   order_type ('limit_order'|'market_order'), limit_price (string),
 *   time_in_force ('gtc'|'ioc'), reduce_only (bool), client_order_id (string)
 */
export async function placeOrder(creds, order) {
  return signedRequest(creds, 'POST', '/v2/orders', { body: order });
}

/** Cancel an order by id (product_id required by Delta). */
export async function cancelOrder(creds, { id, product_id }) {
  return signedRequest(creds, 'DELETE', '/v2/orders', { body: { id, product_id } });
}

/** All open margined positions for the account. */
export async function getLivePositions(creds) {
  return signedRequest(creds, 'GET', '/v2/positions/margined');
}

/** Wallet balances — cheapest authenticated read, used for connectivity checks. */
export async function getBalance(creds) {
  return signedRequest(creds, 'GET', '/v2/wallet/balances');
}
