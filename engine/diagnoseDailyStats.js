/**
 * READ-ONLY check of where a live account's daily P&L and fees come from on Delta.
 * Places no orders and writes nothing.
 *
 * Usage (on the server, from the engine directory — Delta only answers the whitelisted IP):
 *     node diagnoseDailyStats.js --account "Dg" --date 2026-09-28
 *
 * For that trading day (17:30 → 17:30 IST, named for the end date) it prints, side by side:
 *   1. Order history — Σ meta_data.pnl and every commission-like field, plus which fields exist.
 *   2. Fills        — Σ commission per fill.
 *   3. Wallet ledger — Σ amount per transaction_type, and the balance at the start and end.
 *   4. A reconciliation: balance change vs pnl − fees vs pnl alone, to show whether Delta's
 *      realized P&L already includes fees, and which source has the fees.
 * And what live_daily_stats currently holds for the day.
 */
import 'dotenv/config';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { supabase, hasServiceRole } from './lib/supabase.js';
import { getOrderHistorySinceFull, getWalletTransactionsSince, orderTimeMs, fillTimeMs } from './lib/deltaTradeApi.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ACCOUNT = argVal('--account');
const DATE = argVal('--date');
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const f2 = (v) => (v == null ? '—' : v.toFixed(2));

async function getFillsSince(creds, sinceMs) {
  // Same cursor walk as the order history, over /v2/fills (kept local: diagnostic only).
  const { createHmac } = await import('node:crypto');
  const out = []; let after = null;
  for (let i = 0; i < 200; i++) {
    const q = `?page_size=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', creds.apiSecret).update('GET' + ts + '/v2/fills' + q).digest('hex');
    const res = await fetch('https://api.india.delta.exchange/v2/fills' + q, { headers: { 'api-key': creds.apiKey, signature: sig, timestamp: ts, 'User-Agent': 'optionscope-engine' } });
    const json = await res.json();
    if (!res.ok || json.success === false) throw new Error(json?.error?.code || `HTTP ${res.status}`);
    const page = json.result || [];
    out.push(...page);
    after = json.meta?.after;
    const oldest = page.length ? fillTimeMs(page[page.length - 1]) : null;
    if (!after || !page.length || (oldest != null && oldest < sinceMs)) break;
  }
  return out;
}

async function main() {
  if (!ACCOUNT || !/^\d{4}-\d{2}-\d{2}$/.test(DATE || '')) {
    console.log('Usage: node diagnoseDailyStats.js --account "<name or id>" --date YYYY-MM-DD');
    process.exit(1);
  }
  if (!hasServiceRole) { console.log('SUPABASE_SERVICE_ROLE_KEY is required.'); process.exit(1); }
  const { data: accts } = await supabase.from('paper_trading_accounts').select('id, name, mode').eq('mode', 'live');
  const acct = (accts || []).find(a => a.id === ACCOUNT || a.name === ACCOUNT);
  if (!acct) { console.log(`No live account "${ACCOUNT}". Live accounts: ${(accts || []).map(a => a.name).join(', ')}`); process.exit(1); }
  const { data: cr } = await supabase.rpc('get_delta_credentials_decrypted', { p_account_id: acct.id });
  if (!cr?.[0]?.api_key) { console.log('No Delta credentials for this account.'); process.exit(1); }
  const creds = { apiKey: cr[0].api_key, apiSecret: cr[0].api_secret };

  const end = Date.parse(`${DATE}T12:00:00.000Z`);
  const start = end - DAY_MS;
  const inDay = (t) => t != null && t >= start && t < end;
  console.log(`${acct.name} — trading day ${DATE} (${new Date(start).toISOString()} → ${new Date(end).toISOString()})\n`);

  // 1. Order history
  const { items: orders } = await getOrderHistorySinceFull(creds, start - 2 * DAY_MS, { maxPages: 200 });
  const dayOrders = orders.filter(o => inDay(orderTimeMs(o)));
  const feeKeys = new Set();
  const sums = {};
  let pnl = 0; let withPnl = 0;
  for (const o of dayOrders) {
    const p = num(o.meta_data?.pnl);
    if (p != null) { pnl += p; withPnl++; }
    const scan = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj || {})) {
        if (/commission|fee/i.test(k) && num(v) != null) { feeKeys.add(prefix + k); sums[prefix + k] = (sums[prefix + k] || 0) + num(v); }
      }
    };
    scan(o, ''); scan(o.meta_data, 'meta_data.');
  }
  const states = {};
  for (const o of dayOrders) states[o.state] = (states[o.state] || 0) + 1;
  console.log('1) ORDER HISTORY');
  console.log(`   orders in day: ${dayOrders.length}  (states: ${JSON.stringify(states)})`);
  console.log(`   Σ meta_data.pnl: ${f2(pnl)}  (on ${withPnl} orders)`);
  console.log(`   commission/fee fields: ${[...feeKeys].map(k => `${k} Σ ${f2(sums[k])}`).join(' | ') || 'none'}`);
  const sample = dayOrders.find(o => num(o.meta_data?.pnl) != null) || dayOrders[0];
  if (sample) {
    console.log(`   sample order keys: ${Object.keys(sample).join(', ')}`);
    console.log(`   sample meta_data keys: ${Object.keys(sample.meta_data || {}).join(', ')}`);
  }

  // 2. Fills
  console.log('\n2) FILLS');
  try {
    const fills = (await getFillsSince(creds, start)).filter(f => inDay(fillTimeMs(f)));
    const fillFee = fills.reduce((s, f) => s + (num(f.commission) ?? 0), 0);
    console.log(`   fills in day: ${fills.length}   Σ commission: ${f2(fillFee)}`);
    if (fills[0]) console.log(`   sample fill keys: ${Object.keys(fills[0]).join(', ')}`);
  } catch (e) { console.log(`   fetch failed: ${e.message}`); }

  // 3. Wallet ledger
  console.log('\n3) WALLET TRANSACTIONS');
  let ledger = null;
  try {
    const { items } = await getWalletTransactionsSince(creds, start - 30 * DAY_MS, { maxPages: 300 });
    const sorted = items.filter(t => fillTimeMs(t) != null).sort((a, b) => fillTimeMs(a) - fillTimeMs(b));
    const before = sorted.filter(t => fillTimeMs(t) < start).pop();
    const day = sorted.filter(t => inDay(fillTimeMs(t)));
    const byType = {};
    for (const t of day) { const k = t.transaction_type || '?'; byType[k] = (byType[k] || 0) + (num(t.amount) ?? 0); }
    const startBal = num(before?.balance);
    const endBal = num((day.length ? day[day.length - 1] : before)?.balance);
    ledger = { byType, startBal, endBal };
    console.log(`   transactions in day: ${day.length}`);
    for (const [k, v] of Object.entries(byType)) console.log(`     ${k.padEnd(28)} ${f2(v)}`);
    console.log(`   balance: start ${f2(startBal)} → end ${f2(endBal)}  (change ${startBal != null && endBal != null ? f2(endBal - startBal) : '—'})`);
    if (day[0]) console.log(`   sample transaction keys: ${Object.keys(day[0]).join(', ')}`);
  } catch (e) { console.log(`   fetch failed: ${e.message}`); }

  // 4. Reconciliation
  console.log('\n4) RECONCILE');
  const fee = sums.paid_commission ?? sums.commission ?? 0;
  console.log(`   order-history pnl            ${f2(pnl)}`);
  console.log(`   order-history pnl − fees     ${f2(pnl - fee)}   (fees = ${f2(fee)})`);
  if (ledger?.startBal != null && ledger?.endBal != null) {
    const dep = Object.entries(ledger.byType).filter(([k]) => /deposit|withdraw|transfer/i.test(k)).reduce((s, [, v]) => s + v, 0);
    console.log(`   balance change               ${f2(ledger.endBal - ledger.startBal)}   (of which deposits/withdrawals/transfers ${f2(dep)})`);
    console.log(`   balance change excl. deposits ${f2(ledger.endBal - ledger.startBal - dep)}`);
  }
  console.log('   → if "pnl − fees" matches the balance change (excl. deposits), pnl EXCLUDES fees;');
  console.log('     if "pnl" alone matches, pnl already INCLUDES them. Open positions at day end also move the balance (premium paid/received).');

  const { data: row } = await supabase.from('live_daily_stats').select('*').eq('account_id', acct.id).eq('trade_date', DATE).maybeSingle();
  console.log('\n5) live_daily_stats row now:');
  console.log(row ? `   realized ${row.realized_gross_pnl} | fees_actual ${row.fees_actual} | fees_est ${row.fees_estimated} | net ${row.net_pnl} | open ${row.opening_balance} → close ${row.closing_balance}` : '   (none)');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
