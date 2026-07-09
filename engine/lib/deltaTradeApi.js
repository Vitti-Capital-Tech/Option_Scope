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
    let msg = json?.error?.code || json?.error?.message || `Delta API ${res.status} on ${path}`;
    // Surface the IP Delta actually saw — tells you exactly what to whitelist.
    const clientIp = json?.error?.context?.client_ip;
    if (clientIp) msg += ` (client_ip: ${clientIp})`;
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

/**
 * Edit an existing (open) order in place — price and/or size. Keeps the order id
 * (and queue priority) rather than cancel+replace. `order` fields:
 *   id, product_id | product_symbol, limit_price (string), size (int)
 */
export async function editOrder(creds, order) {
  return signedRequest(creds, 'PUT', '/v2/orders', { body: order });
}

/**
 * Edit the bracket (attached SL/TP) on a position/order in place. Fields:
 *   product_id | product_symbol, bracket_stop_loss_price, bracket_take_profit_price,
 *   bracket_stop_trigger_method ('spot_price' | 'mark_price' | 'last_traded_price'),
 *   optional id.
 */
export async function editBracket(creds, bracket) {
  return signedRequest(creds, 'PUT', '/v2/orders/bracket', { body: bracket });
}

/** All open margined positions for the account. */
export async function getLivePositions(creds) {
  return signedRequest(creds, 'GET', '/v2/positions/margined');
}

/**
 * Flatten ALL open positions on the account in one call. Closes both cross
 * (portfolio) and isolated positions. Note: this closes every position on the
 * account, not just the engine's — only use on a dedicated trading account.
 */
export async function closeAllPositions(creds) {
  return signedRequest(creds, 'POST', '/v2/positions/close_all', {
    body: { close_all_portfolio: true, close_all_isolated: true },
  });
}

/** Wallet balances — cheapest authenticated read, used for connectivity checks. */
export async function getBalance(creds) {
  return signedRequest(creds, 'GET', '/v2/wallet/balances');
}

/**
 * Live (resting) orders for the account. Delta returns limit AND stop orders here;
 * the caller separates them by `stop_order_type`. `states` filters by order state
 * (comma-joined), defaulting to still-working orders.
 */
export async function getLiveOrders(creds, { states = 'open,pending', pageSize = 100 } = {}) {
  // Delta paginates /v2/orders (small default page) — request a large page so we
  // get ALL working orders, otherwise later brackets (e.g. TP legs) get truncated.
  const params = new URLSearchParams();
  if (states) params.set('states', states);
  params.set('page_size', String(pageSize));
  return signedRequest(creds, 'GET', '/v2/orders', { query: `?${params.toString()}` });
}

/** Recent fills (individual leg executions), newest first, capped at `pageSize`. */
export async function getFills(creds, { pageSize = 50 } = {}) {
  const query = `?page_size=${encodeURIComponent(pageSize)}`;
  return signedRequest(creds, 'GET', '/v2/fills', { query });
}

/**
 * Order history — every past order for the account (filled + cancelled), newest
 * first. This is Delta's Order History feed: each record carries execution price,
 * cashflow, realized pnl, commission, reduce-only, etc. Used to mirror Delta's
 * Order History tab in the UI (read-only). `pageSize` caps the page.
 */
export async function getOrderHistory(creds, { pageSize = 100 } = {}) {
  const query = `?page_size=${encodeURIComponent(pageSize)}`;
  return signedRequest(creds, 'GET', '/v2/orders/history', { query });
}
