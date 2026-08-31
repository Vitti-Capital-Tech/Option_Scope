/**
 * Delta user-identity check — READ ONLY, places no orders.
 *
 * WHY: Delta throttles authenticated requests **per user id** (10,000 units / 5 min).
 * If every live account is its own Delta user, each carries its own quota and the fleet
 * scales freely. If several accounts are SUB-ACCOUNTS of one user, they SHARE a single
 * 10,000 — at ~2,000 units per account per window that ceiling is reached around five
 * accounts, and everything past it starts getting 429s. This is the single fact the whole
 * scaling plan rests on, so measure it rather than assume.
 *
 * Usage (on the server, from the engine directory):
 *     node checkDeltaUsers.js
 *
 * Reads the same credentials the engine uses (service_role RPC) and reports the Delta
 * user id behind each live account, plus whether Delta itself reports any sub-accounts.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import crypto from 'node:crypto';
import { supabase, hasServiceRole } from './lib/supabase.js';

const BASE = 'https://api.india.delta.exchange';

async function signedGet(creds, path, query = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', creds.apiSecret)
    .update('GET' + ts + path + query).digest('hex');
  const res = await fetch(BASE + path + query, {
    headers: {
      'api-key': creds.apiKey, signature: sig, timestamp: ts,
      'Content-Type': 'application/json', 'User-Agent': 'optionscope-engine',
    },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error?.code || json?.error?.message || `HTTP ${res.status} on ${path}`);
  }
  return json?.result;
}

// Delta does not document a single "profile" endpoint, but `user_id` rides along on
// several authenticated payloads. Try them in order of cost (weights 3, 3, 10) and stop
// at the first that carries one, so an account with no open positions still resolves.
async function resolveUserId(creds) {
  const probes = [
    ['/v2/positions/margined', '', (r) => (Array.isArray(r) ? r : [])[0]?.user_id],
    ['/v2/wallet/balances', '', (r) => (Array.isArray(r) ? r : [])[0]?.user_id],
    ['/v2/orders', '?states=open,pending&page_size=1', (r) => (Array.isArray(r) ? r : [])[0]?.user_id],
    ['/v2/fills', '?page_size=1', (r) => (Array.isArray(r) ? r : [])[0]?.user_id],
  ];
  for (const [path, query, pick] of probes) {
    try {
      const id = pick(await signedGet(creds, path, query));
      if (id != null) return { userId: String(id), via: path };
    } catch { /* try the next probe */ }
  }
  return { userId: null, via: null };
}

async function subAccountCount(creds) {
  try {
    const r = await signedGet(creds, '/v2/sub_accounts', '?page_size=50');
    return Array.isArray(r) ? r.length : null;
  } catch { return null; }   // endpoint absent / not permitted for this key
}

(async () => {
  if (!hasServiceRole) {
    console.error('SUPABASE_SERVICE_ROLE_KEY missing — cannot decrypt credentials. Run this on the server.');
    process.exit(1);
  }
  const { data: accounts, error } = await supabase
    .from('paper_trading_accounts')
    .select('id, name, mode, live_enabled, is_active')
    .eq('mode', 'live').eq('is_active', true);
  if (error) { console.error('Account fetch failed:', error.message); process.exit(1); }
  if (!accounts?.length) { console.log('No active live accounts.'); process.exit(0); }

  console.log(`Checking ${accounts.length} active live account(s)...\n`);
  const rows = [];
  for (const a of accounts) {
    const { data, error: e } = await supabase.rpc('get_delta_credentials_decrypted', { p_account_id: a.id });
    const c = data?.[0];
    if (e || !c?.api_key || !c?.api_secret) {
      rows.push({ name: a.name, userId: null, note: e ? `creds error: ${e.message}` : 'no stored credentials' });
      continue;
    }
    const creds = { apiKey: c.api_key, apiSecret: c.api_secret };
    const { userId, via } = await resolveUserId(creds);
    const subs = await subAccountCount(creds);
    rows.push({
      name: a.name, userId,
      note: userId ? `via ${via}${subs != null ? ` | sub_accounts: ${subs}` : ''}` : 'could not resolve (no positions/orders/fills yet?)',
    });
  }

  console.log('account'.padEnd(24) + 'delta user_id'.padEnd(16) + 'source');
  console.log('-'.repeat(78));
  for (const r of rows) console.log(r.name.padEnd(24) + String(r.userId ?? '—').padEnd(16) + r.note);

  const ids = rows.map(r => r.userId).filter(Boolean);
  const uniq = new Set(ids);
  console.log('\n' + '='.repeat(78));
  if (!ids.length) {
    console.log('VERDICT: could not resolve any user id — see notes above.');
  } else if (uniq.size === ids.length) {
    console.log(`VERDICT: ${uniq.size} distinct Delta user(s) across ${ids.length} account(s) — SEPARATE QUOTAS.`);
    console.log('Each account gets its own 10,000 units / 5 min. Fleet scales on this axis.');
  } else {
    console.log(`VERDICT: ${ids.length} account(s) map to only ${uniq.size} Delta user(s) — QUOTA IS SHARED.`);
    console.log('Accounts sharing a user id share ONE 10,000-unit budget. At ~2,000 units per');
    console.log('account per window that ceiling arrives around five accounts; past it, 429s.');
    const byId = new Map();
    for (const r of rows) if (r.userId) byId.set(r.userId, [...(byId.get(r.userId) || []), r.name]);
    for (const [id, names] of byId) if (names.length > 1) console.log(`   user ${id}: ${names.join(', ')}`);
  }
  process.exit(0);
})();
