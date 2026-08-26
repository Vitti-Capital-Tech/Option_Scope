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

// ── Request timeouts ────────────────────────────────────────────────────────
// `fetch` has no default request timeout, so a half-open socket to Delta used to hang
// a call indefinitely. Every one of these runs inside the engine's single evaluation
// lock, so ONE stalled read froze that account's exits AND its next entry scan until
// the OS TCP timeout eventually tripped — minutes later.
//
// Reads are bounded tightly: a stale answer is worthless and the caller retries on the
// next ~1s tick anyway. WRITES get a much longer leash on purpose — aborting the client
// side of an order that Delta already accepted creates an orphan on the exchange, so we
// only give up when the request is beyond plausible. (Orphans that do slip through are
// still caught by reconcileOrphans / protectOrphanExchangePositions.)
const READ_TIMEOUT_MS = Math.max(1000, Number(process.env.DELTA_READ_TIMEOUT_MS ?? 6000));
const WRITE_TIMEOUT_MS = Math.max(2000, Number(process.env.DELTA_WRITE_TIMEOUT_MS ?? 15000));

function timeoutFor(method) {
  return method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

/**
 * Run a fetch under an abort deadline, re-labelling the abort so callers log the real
 * cause ("timed out after 6000ms") instead of a bare, opaque `AbortError`.
 */
async function fetchWithTimeout(url, init, method, path) {
  const ms = timeoutFor(method);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`Delta API ${method} ${path} timed out after ${ms}ms`);
    }
    throw e;
  }
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

  const res = await fetchWithTimeout(BASE_URL + path + query, {
    method,
    headers: {
      'api-key': creds.apiKey,
      signature,
      timestamp,
      'Content-Type': 'application/json',
      'User-Agent': 'optionscope-engine',
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  }, method, path);

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
 * Like signedRequest but returns the FULL response envelope ({ result, meta }) so
 * callers can page through cursor-paginated endpoints (meta.after / meta.before).
 */
async function signedRequestFull(creds, method, path, { query = '', body = null } = {}) {
  if (!creds?.apiKey || !creds?.apiSecret) throw new Error('Missing Delta credentials');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = method + timestamp + path + query + bodyStr;
  const signature = signPayload(creds.apiSecret, message);
  const res = await fetchWithTimeout(BASE_URL + path + query, {
    method,
    headers: {
      'api-key': creds.apiKey, signature, timestamp,
      'Content-Type': 'application/json', 'User-Agent': 'optionscope-engine',
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  }, method, path);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || json?.success === false) {
    let msg = json?.error?.code || json?.error?.message || `Delta API ${res.status} on ${path}`;
    const clientIp = json?.error?.context?.client_ip;
    if (clientIp) msg += ` (client_ip: ${clientIp})`;
    throw new Error(String(msg));
  }
  return { result: json?.result, meta: json?.meta };
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

/**
 * Place (or replace) a bracket — attached SL/TP — on an OPEN POSITION.
 * `POST /v2/orders/bracket`. For an already-FILLED position this is the correct call:
 * the `PUT /v2/orders/bracket` variant only edits brackets that still rest as unfilled
 * order legs. Delta allows a single bracket per open position, so re-posting UPDATES it.
 * Body:
 *   product_id (required) + product_symbol,
 *   stop_loss_order / take_profit_order — nested { order_type, stop_price, limit_price? },
 *   bracket_stop_trigger_method ('spot_price' | 'mark_price' | 'last_traded_price').
 * `size` is not sent — a bracket closes the whole position.
 */
export async function placeBracketOrder(creds, bracket) {
  return signedRequest(creds, 'POST', '/v2/orders/bracket', { body: bracket });
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
 * first. This is Delta's Order History feed. Delta paginates this endpoint with a
 * cursor (meta.after), so a single page only returns the most recent slice — we
 * walk the cursor and concatenate up to `maxPages` pages so the UI shows the FULL
 * history, not just the latest page. Read-only.
 */
export async function getOrderHistory(creds, { pageSize = 100, maxPages = 20 } = {}) {
  const all = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const params = new URLSearchParams();
    params.set('page_size', String(pageSize));
    if (after) params.set('after', after);
    const { result, meta } = await signedRequestFull(
      creds, 'GET', '/v2/orders/history', { query: `?${params.toString()}` },
    );
    if (Array.isArray(result) && result.length) all.push(...result);
    after = meta?.after || null;
    // Stop when there's no next cursor or the page came back short (last page).
    if (!after || !Array.isArray(result) || result.length < pageSize) break;
  }
  return all;
}
