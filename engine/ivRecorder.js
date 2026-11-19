/**
 * ATM IV recorder — its own PM2 process (`optionscope-iv-recorder`), separate from the trading
 * engine: public Delta market data only, no orders, no accounts. A crash or restart here never
 * touches trading.
 *
 * Every minute, for BTC and ETH and the two nearest unsettled expiries, it saves one row to
 * public.iv_history (migration 073): spot, the strike nearest spot (ATM), and Delta's mark IV of
 * that strike's call and put — the same numbers the IV Analysis chart rebuilds from mark-price
 * candles. Those candles vanish when an option expires, so this is what lets 2–3 weeks of ATM IV
 * be analysed later.
 *
 * Cost: 2 public ticker calls a minute (+ a products refresh hourly) on the box's shared public
 * Delta budget — negligible next to the engine.
 *
 * Run: pm2 start ecosystem.config.cjs --only optionscope-iv-recorder
 * Off: pm2 stop optionscope-iv-recorder   (or IV_RECORDER_UNDERLYINGS= to record nothing)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const BASE_URL = 'https://api.india.delta.exchange';
const UNDERLYINGS = String(process.env.IV_RECORDER_UNDERLYINGS ?? 'BTC,ETH').split(',').map(s => s.trim()).filter(Boolean);
const EXPIRIES_PER_UNDERLYING = Math.max(1, Number(process.env.IV_RECORDER_EXPIRIES ?? 2));
const PRODUCTS_REFRESH_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10000;
const SECOND_OF_MINUTE = 5; // record a few seconds into each minute

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${stamp()}] [iv-recorder] ${m}`);
const warn = (m) => console.warn(`[${stamp()}] [iv-recorder] ⚠ ${m}`);
const r4 = (v) => (v == null ? null : Number(v.toFixed(4)));
const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

async function apiGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(json?.error?.code || json?.error?.message || `HTTP ${res.status} on ${path}`);
  return json.result;
}

// symbol → settlement time (ISO), per underlying; refreshed hourly (new expiries list daily).
const settleBySymbol = new Map();
let productsAt = 0;
async function refreshProducts() {
  if (Date.now() - productsAt < PRODUCTS_REFRESH_MS && settleBySymbol.size) return;
  const next = new Map();
  for (const u of UNDERLYINGS) {
    for (const ct of ['call_options', 'put_options']) {
      const list = await apiGet('/v2/products', { contract_types: ct, states: 'live', underlying_asset_symbols: u });
      for (const p of list || []) if (p.symbol && p.settlement_time) next.set(p.symbol, p.settlement_time);
    }
  }
  if (next.size) { settleBySymbol.clear(); for (const [k, v] of next) settleBySymbol.set(k, v); productsAt = Date.now(); }
}

async function recordUnderlying(u, minuteIso) {
  const tickers = await apiGet('/v2/tickers', { contract_types: 'call_options,put_options', underlying_asset_symbols: u });
  const now = Date.now();
  // expiry → strike → { call, put } tickers
  const byExpiry = new Map();
  let spot = null;
  for (const t of tickers || []) {
    const exp = settleBySymbol.get(t.symbol);
    if (!exp || new Date(exp).getTime() <= now + 60_000) continue; // unknown or settling now
    spot = spot ?? num(t.spot_price);
    const k = num(t.strike_price);
    if (k == null) continue;
    if (!byExpiry.has(exp)) byExpiry.set(exp, new Map());
    const strikes = byExpiry.get(exp);
    if (!strikes.has(k)) strikes.set(k, {});
    strikes.get(k)[t.contract_type === 'call_options' ? 'call' : 'put'] = t;
  }
  if (spot == null) throw new Error('no spot in tickers');
  const expiries = [...byExpiry.keys()].sort((a, b) => new Date(a) - new Date(b)).slice(0, EXPIRIES_PER_UNDERLYING);
  const ivOf = (t) => {
    const v = num(t?.quotes?.mark_iv ?? t?.mark_vol);
    return v != null && v > 0 ? v * 100 : null;
  };
  const rows = [];
  expiries.forEach((exp, rank) => {
    const strikes = byExpiry.get(exp);
    // Nearest strike to spot that has a usable mark IV on at least one side.
    const ranked = [...strikes.keys()].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    const k = ranked.find(s => ivOf(strikes.get(s).call) != null || ivOf(strikes.get(s).put) != null);
    if (k == null) return;
    const { call, put } = strikes.get(k);
    const callIv = ivOf(call), putIv = ivOf(put);
    const ivs = [callIv, putIv].filter(v => v != null);
    rows.push({
      ts: minuteIso, underlying: u, expiry: exp, expiry_rank: rank,
      spot, atm_strike: k,
      call_iv: r4(callIv), put_iv: r4(putIv), atm_iv: r4(ivs.reduce((a, b) => a + b, 0) / ivs.length),
      call_mark: num(call?.mark_price), put_mark: num(put?.mark_price),
      hours_to_expiry: Number(((new Date(exp).getTime() - now) / 3_600_000).toFixed(3)),
    });
  });
  if (!rows.length) return 0;
  if (process.env.IV_RECORDER_DRY === '1') { console.log(JSON.stringify(rows)); return rows.length; }
  const { error } = await supabase.from('iv_history').upsert(rows, { onConflict: 'underlying,expiry,ts', ignoreDuplicates: true });
  if (error) throw new Error(`insert: ${error.message}`);
  return rows.length;
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  const minuteIso = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  try {
    await refreshProducts();
    const parts = [];
    for (const u of UNDERLYINGS) {
      try { parts.push(`${u} ${await recordUnderlying(u, minuteIso)}`); }
      catch (e) { warn(`${u} ${minuteIso}: ${e.message}`); }
    }
    // One line every 15 minutes is enough to show it is alive.
    if (new Date(minuteIso).getUTCMinutes() % 15 === 0) log(`recorded ${minuteIso}: ${parts.join(', ')} row(s)`);
  } catch (e) {
    warn(`products refresh failed: ${e.message}`);
  } finally {
    busy = false;
  }
}

function scheduleNext() {
  const now = Date.now();
  const next = Math.floor(now / 60000) * 60000 + 60000 + SECOND_OF_MINUTE * 1000;
  setTimeout(async () => { await tick(); scheduleNext(); }, next - now);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[iv-recorder] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in engine/.env');
  process.exit(1);
}
log(`started — ${UNDERLYINGS.join(', ') || '(none)'}, ${EXPIRIES_PER_UNDERLYING} nearest expiries, one row per minute.`);
tick().finally(scheduleNext);
process.on('SIGTERM', () => { log('stopping'); process.exit(0); });
