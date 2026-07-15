/**
 * Paper Trading Engine — Server-Side
 *
 * Headless Node.js version of PaperTrading.jsx's evaluateStrategy Phase 2.
 * Runs as a persistent process: connects to Delta Exchange WS, evaluates
 * strategy every minute, and writes all state to Supabase.
 *
 * Features preserved from browser version:
 * - Rotation with worst-first, 1-for-1 reservation
 * - 0.5% spot scaling guard
 * - DB-level count/strike guards
 * - Spot staleness guard
 * - Expiry settlement (2 min early)
 * - Product refresh every 5 minutes
 */
import { supabase, hasServiceRole } from './lib/supabase.js';
import { createHeartbeat } from './lib/heartbeat.js';
import { createLiveExecutor, isLiveDryRun, longContracts, shortContracts, extractBalance } from './lib/liveExecution.js';
import { notifyLiveFailure, notifyLiveTrade } from './lib/telegram.js';
import { getBalance } from './lib/deltaTradeApi.js';
import {
  loadProducts, getExpiries, getSpotPrice,
  createTickerStream, buildSymbolMeta, processTickerMessage,
  backfillTickers, getOptionHigh
} from './lib/deltaApi.js';
import {
  safeParseLeg, calculateFee, calcMargin, scanTickers,
  computeEntryAtmRatio, computeScaledSellQty,
  pickTopUniqueStrikes, log, logWarn, logError
} from './lib/utils.js';

// Entry chase-fill tuning (armed-real only): re-price each entry leg toward the
// market up to `attempts` times, waiting `pollMs` between checks, escalating the
// cross by `bump` (premium $) each attempt so a widening quote still fills. If a
// leg still can't fully fill, openSpread unwinds and aborts the entry. Env-overridable.
const ENTRY_CHASE = {
  attempts: Math.max(0, Number(process.env.ENTRY_CHASE_ATTEMPTS ?? 3)),
  pollMs: Math.max(200, Number(process.env.ENTRY_CHASE_POLL_MS ?? 5000)),
  bump: Math.max(0, Number(process.env.ENTRY_CHASE_BUMP ?? 1)),
};

/**
 * ── STRATEGY VERSIONING ──────────────────────────────────────────────────────
 * `config.strategyVersion` (per-account, from paper_trading_config.strategy_version)
 * gates experimental strategy logic so it can be tested on a PAPER account without
 * affecting LIVE accounts. Live accounts stay on version 1; bump an experimental
 * paper account to 2 to run new logic.
 *
 * Add a branch ONLY where behaviour actually changes — everything else stays shared:
 *
 *     if (config.strategyVersion >= 2) {
 *       // new experimental logic
 *     } else {
 *       // stable logic — live accounts run this
 *     }
 *
 * `config` is threaded into scanTickers()/schedule windows too, so `config.strategyVersion`
 * is available there as well. The frontend reads the same value to show/hide any v2-only
 * UI controls, so a v2 filter neither runs nor appears on a v1 (live) account.
 *
 * Promotion: once validated on paper, set the live account's strategy_version to 2 in
 * the DB (no redeploy). Once ALL accounts are on the new version, DELETE the old branch
 * so versions don't pile up — keep at most stable (live) + experimental (paper) alive.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Build `count` equidistant exit price levels (sorted ascending) spanning the
 * long option's current bid up to `upperBound` (= max(entry, last 1-2hr high)).
 * Used to scale a held long-only leg out as its bid recovers. Levels are evenly
 * spaced: the first sits one step above the current bid and the last lands on
 * the upper bound, so each slice needs a distinct price move (no clustering).
 * If the range is degenerate (current already >= upperBound), every level
 * collapses to the upper bound so the whole long exits as soon as it's evaluated.
 */
function buildLongExitLevels(currentBid, upperBound, count = 10) {
  const lo = currentBid ?? 0;
  const hi = Math.max(lo, upperBound);
  if (count <= 1) {
    return [Number(hi.toFixed(2))];
  }
  if (!(hi > lo)) {
    return Array(count).fill(Number(hi.toFixed(2)));
  }
  const step = (hi - lo) / (count - 1);
  const levels = [];
  for (let i = 0; i < count; i++) {
    levels.push(Number((lo + i * step).toFixed(2)));
  }
  return levels;
}

async function getOrBuildLongExitLevels(longBid, pos, config) {
  if (config.variableExitSlices) {
    let upper = pos.entryBuyPrice;
    try {
      const pastHigh = await getOptionHigh(pos.buyLeg.symbol, 4);
      if (pastHigh != null) {
        upper = pastHigh;
      }
    } catch (e) {
      logWarn(`Failed to fetch 4h high for ${pos.buyLeg.symbol}: ${e.message}`);
    }
    return buildLongExitLevels(longBid, upper, config.longExitSlices ?? 10);
  } else {
    if (longBid < 25) {
      return [10, 20, 30, 40, 50];
    } else {
      return [25, 50, 75, 100, 125];
    }
  }
}

/**
 * Index price level that triggers the live SL (short) / TP (long), derived from
 * the account's exitType/exitPoints relative to the buy strike — the same
 * geometry as the paper ATM/ITM/OTM full-exit rule, but enforced on the exchange
 * as a spot-triggered stop. TP and SL share this one level.
 */
function computeIndexTriggerLevel(type, buyStrike, cfg) {
  const exitType = cfg.exitType || 'ATM';
  const pts = Math.abs(cfg.exitPoints || 0);
  const isCall = type === 'call';
  // NOTE: ITM/OTM direction is intentionally reversed from the textbook definition,
  // per the account's exit convention: ITM = buyStrike − pts (call) / + pts (put),
  // OTM = buyStrike + pts (call) / − pts (put).
  if (exitType === 'ITM') return isCall ? buyStrike - pts : buyStrike + pts;
  if (exitType === 'OTM') return isCall ? buyStrike + pts : buyStrike - pts;
  return buyStrike; // ATM
}

/** True once the index (spot) has reached the trigger level for this option type. */
function isIndexTriggerMet(type, level, spot) {
  if (level == null || spot == null) return false;
  return type === 'call' ? spot >= level : spot <= level;
}

/** Greatest common divisor — reduces a ratio to minimal integer lots. */
function gcdInt(a, b) {
  a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

async function startSingleAccountEngine(account) {
  let accountState = account;
  const ENGINE_ID = 'paper_trading_' + accountState.id;
  const heartbeat = createHeartbeat(ENGINE_ID);
  let configDbId = null;

  // ── Mutable engine state ──────────────────────────────────────────────
  let config = {
    underlying: 'BTC', expiry: '',
    minStrikeDiff: 800, minIvDiff: 5, maxRatioDeviation: 0.25,
    minSellPremium: 10, maxNetPremium: 20, minLongDist: 500, maxSellQty: 10,
    atmRatioScaling: true,
    atmRatioPctCall: 50,
    atmRatioPctPut: 25,
    daysToExpiry: 0,
    numberOfCalls: 3,
    numberOfPuts: 3,
    exitType: 'ATM',
    exitPoints: 0,
    shortExitPrice: 1.1,
    longExitSlices: 10,
    balanceAllocationPct: 90,
    entryBuyOffset: 5,
    entrySellOffset: 2,
    // Which strategy logic to run. 1 = stable (live accounts); an experimental
    // paper account is set to 2+ to test new logic. Branch on it wherever the
    // behaviour diverges — see the STRATEGY VERSIONING note below.
    strategyVersion: 1,
    // Weekdays new entries are allowed on (0=Sun..6=Sat), aligned to the 17:30 IST
    // trading-day boundary. All seven = trade every day. v2/paper entry-gate only.
    tradeDays: [0, 1, 2, 3, 4, 5, 6]
  };
  let products = [];
  let expiries = [];
  let spotPrice = null;
  let lastSpotUpdate = 0;
  let positions = []; // Active positions (in-memory mirror of Supabase)
  let tickerData = {}; // Live ticker data from WS
  let wsHandle = null;
  let symbolMeta = {};
  let lastEvaluated = 0;
  let isEvaluating = false;
  let evaluationStart = 0;
  let lastWsReconnectTime = 0;
  let lastDbWrite = 0;
  let schedules = []; // Time-based schedule windows

  // ── Live trading (Delta Exchange) ─────────────────────────────────────
  let liveCreds = null; // { apiKey, apiSecret } for mode==='live', else null
  const live = createLiveExecutor(() => ({
    accountName: accountState.name,
    mode: accountState.mode,
    liveEnabled: accountState.live_enabled,
    creds: liveCreds,
  }));

  // Push a live trade event (entry/exit) to Telegram. Gated on armed REAL live
  // (mode live + armed + NOT dry-run) so paper and dry-run validation never notify.
  // Fire-and-forget — telegram.js swallows all errors.
  function notifyTrade({ title, detail = '', pnl = null }) {
    if (!(accountState.mode === 'live' && accountState.live_enabled && !live.dryRun)) return;
    notifyLiveTrade({ account: accountState.name, title, detail, pnl });
  }

  // Load + decrypt Delta credentials for live accounts. Requires the engine to
  // run with the service_role key; otherwise live trading stays disabled.
  async function loadCredentials() {
    if (accountState.mode !== 'live') { liveCreds = null; return; }
    if (!hasServiceRole) {
      liveCreds = null;
      logWarn(`[${accountState.name}] Live account but engine lacks service_role key — live trading disabled.`);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('get_delta_credentials_decrypted', {
        p_account_id: accountState.id,
      });
      if (error) {
        liveCreds = null;
        logError(`[${accountState.name}] Failed to load Delta credentials:`, error.message);
        return;
      }
      if (data && data[0] && data[0].api_key && data[0].api_secret) {
        liveCreds = { apiKey: data[0].api_key, apiSecret: data[0].api_secret };
        log(`[${accountState.name}] Delta credentials loaded. Armed: ${accountState.live_enabled ? 'YES' : 'no (kill-switch off)'} | Dry-run: ${isLiveDryRun() ? 'ON' : 'OFF'}`);
      } else {
        liveCreds = null;
        logWarn(`[${accountState.name}] Live mode but no stored credentials found.`);
      }
    } catch (e) {
      liveCreds = null;
      logError(`[${accountState.name}] Credential load exception:`, e);
    }
  }

  // ── Supabase data fetchers ────────────────────────────────────────────

  async function fetchConfig() {
    let retries = 10;
    let data = null;
    let error = null;

    while (retries > 0) {
      try {
        const res = await supabase
          .from('paper_trading_config')
          .select('*')
          .eq('account_id', accountState.id)
          .single();
        data = res.data;
        error = res.error;

        if (data && !error) {
          break;
        }
      } catch (e) {
        error = e;
      }

      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    try {
      if (error && error.code === 'PGRST116') {
        // Row not found, let's create a default one
        logWarn(`[${accountState.name}] No config row found after retries for account_id = ${accountState.id}. Creating default...`);
        const defaultRow = {
          id: accountState.id,
          account_id: accountState.id,
          underlying: 'BTC',
          min_strike_diff: 800,
          min_iv_diff: 5,
          max_ratio_deviation: 0.25,
          min_sell_premium: 10,
          max_net_premium: 20,
          min_long_dist: 500,
          max_sell_qty: 10,
          atm_ratio_scaling: true,
          atm_ratio_distance_call: 50,
          atm_ratio_distance_put: 25,
          days_to_expiry: 0,
          number_of_calls: 3,
          number_of_puts: 3,
          exit_type: 'ATM',
          exit_points: 0,
          short_exit_price: 1.1,
          long_exit_slices: 10,
          variable_exit_slices: false,
          balance_allocation_pct: 90,
          entry_buy_offset: 5,
          entry_sell_offset: 2,
          // Paper = experimental testbed (v2), live = stable (v1).
          strategy_version: accountState.mode === 'live' ? 1 : 2,
          trade_days: [0, 1, 2, 3, 4, 5, 6],
          updated_at: new Date().toISOString()
        };
        const { data: inserted, error: insertErr } = await supabase
          .from('paper_trading_config')
          .insert([defaultRow])
          .select('*')
          .single();
        if (inserted && !insertErr) {
          data = inserted;
          error = null;
        } else {
          logError(`[${accountState.name}] Failed to auto-create config row:`, insertErr?.message);
        }
      }

      if (data && !error) {
        config = {
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10,
          atmRatioScaling: data.atm_ratio_scaling ?? true,
          atmRatioPctCall: data.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: data.atm_ratio_distance_put ?? 25,
          daysToExpiry: data.days_to_expiry ?? 0,
          numberOfCalls: data.number_of_calls ?? 3,
          numberOfPuts: data.number_of_puts ?? 3,
          exitType: data.exit_type ?? 'ATM',
          exitPoints: data.exit_points ?? 0,
          shortExitPrice: data.short_exit_price ?? 1.1,
          longExitSlices: data.long_exit_slices ?? 10,
          variableExitSlices: data.variable_exit_slices ?? false,
          balanceAllocationPct: data.balance_allocation_pct ?? 90,
          entryBuyOffset: data.entry_buy_offset ?? 5,
          entrySellOffset: data.entry_sell_offset ?? 2,
          strategyVersion: data.strategy_version ?? 1,
          tradeDays: Array.isArray(data.trade_days) ? data.trade_days : [0, 1, 2, 3, 4, 5, 6]
        };
        configDbId = data.id;
        // log(`[${accountState.name}] Config loaded: ${config.underlying} | Expiry: ${config.expiry || 'auto'}`);
      }
    } catch (e) { logError(`[${accountState.name}] Config fetch error`, e); }
  }

  // ── Schedule fetcher ────────────────────────────────────────────────────

  async function fetchSchedules() {
    try {
      const { data, error } = await supabase
        .from('paper_trading_schedules')
        .select('*')
        .eq('account_id', accountState.id)
        .order('sort_order', { ascending: true });
      if (error) {
        logError(`[${accountState.name}] Fetch schedules error`, error);
        return;
      }
      if (data) {
        schedules = data.map(s => ({
          id: s.id,
          label: s.label || 'Window',
          startTime: s.start_time,  // 'HH:MM' IST
          endTime: s.end_time,      // 'HH:MM' IST
          numberOfCalls: s.number_of_calls ?? 3,
          numberOfPuts: s.number_of_puts ?? 3,
          minLongDist: s.min_long_dist ?? 500,
          minStrikeDiff: s.min_strike_diff ?? 800,
          atmRatioScaling: s.atm_ratio_scaling ?? true,
          atmRatioPctCall: s.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: s.atm_ratio_distance_put ?? 25,
          maxNetPremium: s.max_net_premium ?? config.maxNetPremium ?? 20,
          exitType: s.exit_type ?? config.exitType ?? 'ATM',
          exitPoints: s.exit_points ?? config.exitPoints ?? 0,
          // Per-window min-days-to-expiry (strategy_version >= 2 only). Falls back to
          // the account-level config value for rows that predate migration 019.
          daysToExpiry: s.days_to_expiry ?? config.daysToExpiry ?? 0,
          // Per-window hedge overlay (strategy_version >= 2 only, migration 022).
          hedgeStrikeType: s.hedge_strike_type ?? 'none',
          hedgeCallPrice: s.hedge_call_price ?? 0,
          hedgeCallPct: s.hedge_call_pct ?? 0,
          hedgePutPrice: s.hedge_put_price ?? 0,
          hedgePutPct: s.hedge_put_pct ?? 0,
          isActive: s.is_active ?? true,
        }));
      }
    } catch (e) { logError(`[${accountState.name}] Schedule fetch error`, e); }
  }

  async function fetchActivePositions() {
    try {
      if (Date.now() - lastDbWrite < 3000) return;
      const { data, error } = await supabase
        .from('active_positions').select('*')
        .eq('account_id', accountState.id)
        .order('entry_time', { ascending: true });

      if (error) { logError('Fetch positions error', error); return; }

      if (data && data.length > 0) {
        positions = data.map(p => {
          const buyLeg = safeParseLeg(p.buy_leg);
          const sellLeg = safeParseLeg(p.sell_leg);
          return {
            id: p.id, underlying: p.underlying, expiry: p.expiry, type: p.type,
            buyLeg, sellLeg,
            sellQty: p.sell_qty, strikeDiff: p.strike_diff,
            entryTime: new Date(p.entry_time),
            entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
            entrySpotPrice: p.entry_spot_price,
            stagesExited: p.stages_exited || 0,
            margin: p.margin || 0, entryFee: p.entry_fee || 0,
            accumulatedSellPnl: p.accumulated_sell_pnl || 0,
          };
        }).filter(p => p.buyLeg && p.sellLeg);
      } else if (data) {
        positions = [];
      }
    } catch (e) { logError('Fetch positions exception', e); }
  }

  // ── Product + expiry management ───────────────────────────────────────

  // Min days-to-expiry that drives account-global expiry auto-selection. For
  // strategy_version >= 2 (per-window DTE, migration 019) the engine still trades ONE
  // expiry, so it rolls to the NEAREST expiry that satisfies the SMALLEST (min)
  // days_to_expiry across active windows — so the global expiry advances as soon as the
  // nearest-eligible window allows (e.g. windows 1:DTE 1, 2:DTE 2 → expiry follows DTE 1,
  // NOT the farther DTE 2). Each window then guards its OWN entries with its own value
  // (a window whose DTE the current expiry doesn't meet simply doesn't enter). v1 (live)
  // uses the single account-level config value, unchanged.
  function expirySelectionMinDte() {
    if (config.strategyVersion >= 2) {
      const active = schedules.filter(s => s.isActive);
      if (active.length > 0) {
        return Math.max(0, Math.min(...active.map(s => s.daysToExpiry ?? 0)));
      }
    }
    return config.daysToExpiry || 0;
  }

  async function refreshProducts() {
    try {
      const prods = await loadProducts(config.underlying);
      products = prods;
      expiries = getExpiries(prods);

      const minDte = expirySelectionMinDte();
      const currentDaysRemaining = config.expiry ? (new Date(config.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000) : 0;
      const isExpiryStale = config.expiry && currentDaysRemaining < minDte;

      if (expiries.length && (!config.expiry || !expiries.includes(config.expiry) || isExpiryStale)) {
        let selectedExpiry = null;
        for (const exp of expiries) {
          const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining >= minDte) {
            selectedExpiry = exp;
            break;
          }
        }
        if (!selectedExpiry) {
          selectedExpiry = expiries[0];
        }
        if (selectedExpiry !== config.expiry) {
          config.expiry = selectedExpiry;
          log(`[${accountState.name}] Expiry auto-selected: ${config.expiry}`);
          // Persist the auto-selected expiry back to Supabase
          if (configDbId) {
            await supabase.from('paper_trading_config').upsert({
              id: configDbId,
              expiry: config.expiry,
              updated_at: new Date().toISOString()
            });
          }
        }
      }
    } catch (e) { logError('Product refresh error', e); }
  }

  // ── Spot price polling ────────────────────────────────────────────────

  async function fetchSpot() {
    try {
      const sp = await getSpotPrice(config.underlying);
      if (sp) {
        spotPrice = sp;
        lastSpotUpdate = Date.now();
      }
    } catch (e) { /* ignore */ }
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────

  function startWebSocket() {
    if (!config.expiry || !products.length) return;

    symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
    const perpSymbol = `${config.underlying}USD`;
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.includes(perpSymbol)) {
      allSymbols.push(perpSymbol);
    }
    if (allSymbols.length < 2) {
      logWarn('Not enough symbols to subscribe — skipping WS start');
      return;
    }

    // Close existing WS if any
    if (wsHandle) {
      try { wsHandle.close(); } catch (e) { }
      wsHandle = null;
    }

    log(`Starting WS: ${allSymbols.length} symbols for ${config.underlying} / ${config.expiry}`);

    wsHandle = createTickerStream(
      allSymbols,
      (msg) => {
        if (msg.symbol === perpSymbol) {
          const sp = parseFloat(msg.spot_price || msg.mark_price || msg.close || msg.last_price);
          if (sp && !isNaN(sp)) {
            spotPrice = sp;
            lastSpotUpdate = Date.now();
          }
          return;
        }
        const processed = processTickerMessage(msg, symbolMeta, tickerData);
        if (processed) {
          tickerData[processed.symbol] = processed;
        }
      },
      (status) => {
        const mappedWsStatus = status === 'live' ? 'live' : 'reconnecting';
        heartbeat.update({ ws_status: mappedWsStatus });
        if (status === 'live') {
          log('WebSocket connected');
        } else if (status === 'disconnected') {
          logWarn('WebSocket disconnected — auto-reconnecting in 3s...');
        }
      }
    );

    heartbeat.update({ ws_status: 'live' });
  }

  // ── Core strategy evaluation (Phase 2) ────────────────────────────────

  // Day-of-week ENTRY gate (strategy_version >= 2 / paper only). A "trading day" is
  // aligned to the schedule timeline's 17:30 IST boundary: the day named for weekday W
  // runs (W-1) 17:30 → W 17:30 IST, so at/after 17:30 IST the active trading day is
  // TOMORROW's weekday. Returns true (entries allowed) for v1 accounts, or when the
  // current trading-day weekday (0=Sun..6=Sat) is enabled in config.tradeDays. This
  // only blocks NEW entries — exits and position management are never gated (like `paused`).
  function isTradingDayEnabled() {
    if (config.strategyVersion < 2) return true;
    const days = Array.isArray(config.tradeDays) ? config.tradeDays : null;
    if (!days) return true; // missing/misconfigured → don't block
    const ist = new Date(Date.now() + 330 * 60000); // shift UTC → IST wall clock
    const istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const tradingWeekday = istMin >= 1050 ? (ist.getUTCDay() + 1) % 7 : ist.getUTCDay(); // 1050 = 17:30 IST
    return days.includes(tradingWeekday);
  }

  // Returns active schedule window for current IST time (UTC + 5:30), or null if none match
  function getActiveSchedule() {
    const now = new Date();
    // Convert current UTC time to IST (UTC + 5:30)
    const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;

    // Track the most-recently-ended active window so an UNCOVERED gap (e.g. the ~1-min
    // slot left by the default full-day Window 1 at 17:29–17:30) carries the PREVIOUS
    // window's config forward instead of dropping to the account base config.
    let mostRecent = null;
    let minSinceEnd = Infinity;
    for (const s of schedules) {
      if (!s.isActive) continue;
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      // Handle overnight windows (e.g. 22:00 -> 06:00)
      const inWin = startMin > endMin
        ? (istMin >= startMin || istMin < endMin)
        : (istMin >= startMin && istMin < endMin);
      if (inWin) return s; // a window that actually covers `now` always wins
      const sinceEnd = (istMin - endMin + 1440) % 1440; // minutes since this window ended (wraps)
      if (sinceEnd < minSinceEnd) { minSinceEnd = sinceEnd; mostRecent = s; }
    }
    // No window covers `now`: fall back to the previous window's config in the gap.
    // (null only when there are no active windows at all → caller uses base config.)
    return mostRecent;
  }

  // Position slots = the PEAK (calls + puts) across ALL active schedule windows —
  // falls back to base config when there are no windows. Used to divide the
  // allocated balance into equal "parts" (1 part of margin per position). Sizing on
  // the busiest window (largest calls+puts sum) means a position is funded so it
  // never over-allocates regardless of which window opens it; smaller windows just
  // leave part of the budget unused.
  function computeMaxPositions() {
    const activeWindows = schedules.filter(s => s.isActive);
    if (activeWindows.length > 0) {
      return Math.max(1, ...activeWindows.map(s => (s.numberOfCalls || 0) + (s.numberOfPuts || 0)));
    }
    return Math.max(1, (config.numberOfCalls || 0) + (config.numberOfPuts || 0));
  }

  // Margin of a LONG-ONLY position (short already exited). It MUST use the same basis as
  // the position was sized on, else the live remaining-budget math is skewed: a live
  // position is sized on the real per-contract underlying amount (`buyLeg.contractValue`,
  // e.g. 0.001 BTC), NOT the paper `lotSize`. Using lotSize here mis-states a live
  // long-only margin (inflated when lotSize ≠ contract value), which bloats `usedMargin`,
  // starves `remainingBudget`, and forces new entries down to the minimum 1 unit. Falls
  // back to lotSize for paper-sized positions (contractValue == null) — unchanged there.
  function longOnlyMargin(pos) {
    const cv = pos.buyLeg?.contractValue;
    const lot = cv != null ? cv * longContracts(pos.buyLeg) : (pos.buyLeg?.lotSize || 0);
    return calcMargin(pos.entryBuyPrice, lot, spotPrice, 0, 1);
  }

  // Correct-basis margin for a full/partial spread. A LIVE position is sized on the real
  // per-contract underlying amount at entry (buyLeg.contractValue, e.g. 0.001 BTC), so its
  // carried margin MUST use that basis: the paper lotSize basis over-states a live margin
  // ~100× (short term = spot × sellQty × 1 vs × contractValue), which bloats `usedMargin`
  // and starves the live entry budget. `longCV` is the long leg's contract value — pass
  // null for a paper-sized position to get the unchanged notional basis. Mirrors the entry
  // formula (calcMargin with longCV × contracts for the long, shortCV for the short).
  function contractBasisMargin(pos, longCV) {
    if (longCV == null) {
      return calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, spotPrice, pos.sellQty, pos.sellLeg.lotSize || 1);
    }
    const longLot = longCV * longContracts(pos.buyLeg);
    const shortCV = pos.sellQty > 0 ? (symbolMeta[pos.sellLeg?.symbol]?.contractValue ?? longCV) : 1;
    return calcMargin(pos.entryBuyPrice, longLot, spotPrice, pos.sellQty, shortCV);
  }

  // One-time PnL-basis normalisation for a LIVE position that was opened on the PAPER
  // basis (originalLotSize=1, lotSize in whole contracts, contractValue null) and later
  // carried into an armed-live account. Its $ PnL books ~1/contractValue TOO BIG because
  // the PnL formula (premium × lot) uses the paper lot (contracts) instead of the real
  // contract-value-scaled lot (contracts × e.g. 0.001 BTC). Rescale the LOT dimension by
  // contractValue so the position matches a natively live-sized one — WITHOUT changing the
  // real contract counts: longContracts/shortContracts are round(lot/base) and both legs
  // scale by the same factor, so the on-exchange order sizes are unchanged. Detected by
  // contractValue == null (only paper-basis positions have it null after live entry sets
  // it); sets it, so the conversion runs exactly once and is restart-safe (persisted).
  // Hedge overlays keep their own (paper) basis and are skipped.
  async function normalizeLiveBasis(pos) {
    if (!(accountState.mode === 'live' && accountState.live_enabled)) return false;
    if (pos.buyLeg?.isHedge) return false;
    if (pos.buyLeg?.contractValue != null) return false; // already live-basis / converted
    const longCV = symbolMeta[pos.buyLeg?.symbol]?.contractValue ?? null;
    if (longCV == null) return false; // no contract-value basis available — leave as-is
    const shortCV = symbolMeta[pos.sellLeg?.symbol]?.contractValue ?? longCV;
    pos.buyLeg = {
      ...pos.buyLeg,
      lotSize: Number(((pos.buyLeg.lotSize || 0) * longCV).toFixed(8)),
      originalLotSize: Number(((pos.buyLeg.originalLotSize || 1) * longCV).toFixed(8)),
      contractValue: longCV,
    };
    pos.sellLeg = {
      ...pos.sellLeg,
      lotSize: Number(((pos.sellLeg.lotSize || 0) * shortCV).toFixed(8)),
      contractValue: shortCV,
    };
    // Fees scale with the lot basis (≈ contract-value per side); the residual is negligible
    // versus the now-corrected gross, so this only keeps `net` from being fee-dominated.
    pos.entryFee = Number(((pos.entryFee || 0) * longCV * longCV).toFixed(8));
    pos.margin = contractBasisMargin(pos, longCV);
    try {
      await supabase.from('active_positions').update({
        buy_leg: JSON.stringify(pos.buyLeg),
        sell_leg: JSON.stringify(pos.sellLeg),
        entry_fee: pos.entryFee,
        margin: pos.margin,
      }).eq('id', pos.id);
      log(`[${accountState.name}] 🔧 Live PnL basis normalised ${pos.id}: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} → contract-value basis (cv ${longCV}) · ${longContracts(pos.buyLeg)} long contract(s) · lot ${pos.buyLeg.lotSize}`);
    } catch (e) { logError(`[${accountState.name}] normalizeLiveBasis persist failed for ${pos.id}:`, e); }
    return true;
  }

  // ── Live exit handling (armed live accounts only) ────────────────────────
  // Replaces the paper simulated exits. Exits are driven by the shared index
  // trigger level (exitType/exitPoints vs buy strike): SHORT closes first (SL),
  // then the LONG (TP) at the same level. In dry-run the index crossing itself is
  // the fill signal; when armed, the resting exchange orders fill and we detect it
  // via the exchange position size dropping to 0. Books trade_history directly and
  // pushes surviving (long-only) positions back into `remaining`.
  async function handleLiveExit(pos, remaining, sizeBySymbol) {
    const tickerBuy = tickerData[pos.buyLeg.symbol];
    const tickerSell = tickerData[pos.sellLeg.symbol];
    const longBid = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
    const shortAsk = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

    const triggerLevel = pos.sellLeg?.slTriggerLevel != null
      ? pos.sellLeg.slTriggerLevel
      : computeIndexTriggerLevel(pos.type, pos.buyLeg.strike, config);

    // Expiry settlement — exchange cash-settles; just close the books, no orders.
    const expiryTs = new Date(pos.expiry).getTime();
    const atExpiry = Date.now() >= expiryTs - 120000;

    const triggerMet = isIndexTriggerMet(pos.type, triggerLevel, spotPrice);
    let shortFilled, longFilled;
    if (live.dryRun) {
      shortFilled = pos.sellQty > 0 && triggerMet;
      longFilled = pos.sellQty === 0 && triggerMet;
    } else {
      // Fill-by-absence: a leg missing from the exchange = filled. But "absent"
      // ALSO describes a leg that never opened, or one whose symbol we can't match
      // in the positions response. Only trust absence as a fill for a leg we have
      // actually SEEN open (size≠0) on the exchange first — otherwise we'd phantom-
      // exit a position that is really still open (leaving a naked leg on Delta).
      const shortRaw = sizeBySymbol[pos.sellLeg.symbol];
      const longRaw = sizeBySymbol[pos.buyLeg.symbol];
      const shortSize = Math.abs(shortRaw ?? 0);
      const longSize = Math.abs(longRaw ?? 0);
      shortFilled = pos.sellQty > 0 && pos._shortConfirmedOpen === true && shortSize === 0;
      longFilled = pos.sellQty === 0 && pos._longConfirmedOpen === true && longSize === 0;

      // Diagnostic: log whenever a fill is inferred OR a held leg is unexpectedly
      // absent-but-never-confirmed (the phantom-exit signature). Tells (B1) symbol
      // mismatch / unlisted leg (ABSENT, never confirmed) apart from (B2) a real
      // close (was confirmed open, size dropped to 0).
      const suspicious = (pos.sellQty > 0 && shortSize === 0 && !pos._shortConfirmedOpen)
        || (pos.sellQty === 0 && longSize === 0 && !pos._longConfirmedOpen);
      if (shortFilled || longFilled || suspicious) {
        log(`[${accountState.name}] 🔎 Live fill-check ${pos.id} (${pos.type} ${pos.buyLeg.strike}/${pos.sellLeg.strike}): ` +
          `short ${pos.sellLeg.symbol}=${shortRaw ?? 'ABSENT'}${pos._shortConfirmedOpen ? '' : ' (never-confirmed)'} · ` +
          `long ${pos.buyLeg.symbol}=${longRaw ?? 'ABSENT'}${pos._longConfirmedOpen ? '' : ' (never-confirmed)'} · ` +
          `exchange returned ${Object.keys(sizeBySymbol).length} leg(s) → ` +
          `${shortFilled ? 'SHORT-FILL' : longFilled ? 'LONG-FILL' : 'HELD (phantom avoided)'}`);
      }
    }

    // ── Short SL filled → book short exit, convert to long-only, arm long TP ──
    if (shortFilled && !atExpiry) {
      const shortLot = pos.sellLeg.lotSize || 1;
      const exitShortPrice = shortAsk;
      if (exitShortPrice == null) { remaining.push(pos); return; }
      lastDbWrite = Date.now();
      const gross = (pos.entrySellPrice - exitShortPrice) * pos.sellQty * shortLot;
      const entryFee = Math.min(pos.entryFee || 0, calculateFee(pos.entrySellPrice, pos.entrySpotPrice, pos.sellQty, shortLot));
      const exitFee = calculateFee(exitShortPrice, spotPrice, pos.sellQty, shortLot);
      const net = gross - (entryFee + exitFee);
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: `${pos.id}-LSL`,
          underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: 0 }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, exitIv: tickerSell?.askIv ?? tickerSell?.iv ?? null }),
          sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: longBid, exit_sell_price: exitShortPrice, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: `Live Short SL @ index ${triggerLevel}`, is_partial: true, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
      } catch (e) { logError(`[${accountState.name}] Live short SL booking failed for ${pos.id}:`, e); }

      pos.entryFee = Math.max(0, (pos.entryFee || 0) - entryFee);
      pos.sellLeg = { ...pos.sellLeg, lotSize: 0 };
      pos.sellQty = 0;

      const tpRes = await live.placeStop({
        symbol: pos.buyLeg.symbol, side: 'sell',
        contracts: longContracts(pos.buyLeg), stopPrice: triggerLevel, tag: `${pos.id}-TP`,
      });
      pos.buyLeg = { ...pos.buyLeg, tpOrderId: tpRes?.order?.id ?? pos.buyLeg.tpOrderId ?? null, longExitBaseLot: pos.buyLeg.lotSize };
      pos.margin = longOnlyMargin(pos);
      try {
        await supabase.from('active_positions').update({
          buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          sell_qty: 0, entry_fee: pos.entryFee, margin: pos.margin,
        }).eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Live short SL update failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] ✂️ LIVE SHORT SL: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}/${pos.sellLeg.strike} @ index ${triggerLevel} | PnL $${net.toFixed(2)} → long TP armed`);
      remaining.push(pos);
      return;
    }

    // ── Long TP filled (or expiry) → book long exit, delete position ──
    if (longFilled || atExpiry) {
      const exitLong = longBid;
      // If we have no quote and it isn't an expiry settlement, wait for one.
      if (exitLong == null && !atExpiry) { remaining.push(pos); return; }
      lastDbWrite = Date.now();
      const lot = pos.buyLeg.lotSize || 0;
      const px = exitLong ?? pos.entryBuyPrice;
      const gross = (px - pos.entryBuyPrice) * lot;
      const entryFee = pos.entryFee || 0;
      const exitFee = calculateFee(px, spotPrice, lot, pos.buyLeg.originalLotSize || 1);
      const net = gross - (entryFee + exitFee);
      const reason = atExpiry ? 'Live Expiry Settlement' : `Live Long TP @ index ${triggerLevel}`;
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: `${pos.id}-LTP`,
          underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
          sell_qty: 0, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: px, exit_sell_price: null, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: reason, is_partial: false, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
        await supabase.from('active_positions').delete().eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Live long TP booking failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] 🎯 LIVE ${atExpiry ? 'EXPIRY' : 'LONG TP'}: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} @ index ${triggerLevel} | PnL $${net.toFixed(2)}`);
      return; // closed — not pushed to remaining
    }

    // No fill yet — hold.
    remaining.push(pos);
  }

  // ── Live RESTING-order exit model (armed + REAL orders only) ─────────────
  // Exits execute as resting exchange orders instead of engine-driven market
  // closes. At entry a reduce-only limit BUY rests on the short leg @ shortExitPrice.
  // When it fills (its order id shows up in recent fills), the short is booked and a
  // FIXED-ladder of reduce-only limit SELLs is placed on the long — split
  // [1,1,1,1,S-4] across the 5 fixed levels, remainder on the highest level. Each
  // ladder slice fills on its own at its level. Spot-cross (ATM/ITM/OTM) and expiry
  // remain engine-driven catch-alls: they cancel any still-resting orders and
  // market-close the remainder. Fills are detected by order id (restart-safe).
  const fixedLadderLevels = (bid) => ((bid ?? 0) < 25 ? [10, 20, 30, 40, 50] : [25, 50, 75, 100, 125]);
  // Split `total` long contracts EVENLY across `n` ladder levels (≈ total/n each) so a
  // properly-scaled long laddering out into real slices, not [1,1,1,1,bulk]. Fewer
  // contracts than levels → 1 each (fewer, but real, slices). Any remainder goes on the
  // HIGHEST levels (better price = less loss).
  const splitContracts = (total, n) => {
    if (total <= 0) return [];
    if (total <= n) return Array(total).fill(1);
    const base = Math.floor(total / n);
    const rem = total - base * n; // 0..n-1 — added to the top `rem` levels
    return Array.from({ length: n }, (_, i) => base + (i >= n - rem ? 1 : 0));
  };
  async function cancelRestingOrders(pos) {
    const toCancel = [];
    if (pos.sellLeg?.exitOrderId) toCancel.push({ id: pos.sellLeg.exitOrderId, productId: pos.sellLeg.exitProductId });
    for (const lo of (pos.buyLeg?.ladderOrders || [])) {
      if (lo.orderId && !lo.filled) toCancel.push({ id: lo.orderId, productId: lo.productId });
    }
    for (const o of toCancel) await live.cancelStop(o);
  }
  // NOTE: the long-TP / short-SL brackets are attached to the exchange positions;
  // Delta auto-cancels a bracket when its position closes, so they need no manual
  // cancellation here — closing a leg (resting fill or market close) clears it.

  // Orphan reconcile (armed real): a position the engine still holds but Delta no
  // longer reports as open was closed exchange-side — a TP/SL bracket fired, or a
  // manual/external close. Book a full exit at current mark + delete so the books,
  // KPI, and Positions view converge with Delta. Two guards prevent phantom cleanup:
  //   • the positions fetch must SUCCEED (null = API hiccup → skip), and
  //   • the leg must have been CONFIRMED open on Delta here at least once
  //     (`_everOpenOnDelta`) — so a symbol we can't match / a never-opened row is
  //     never mistaken for a close. In-memory latch resets on restart (conservative).
  async function reconcileOrphans() {
    if (!(accountState.mode === 'live' && accountState.live_enabled && !live.dryRun)) return;
    const livePos = await live.positions();
    if (livePos == null) return; // fetch failed → don't infer any closes this pass
    const liveOrders = await live.orders();
    const sizeBySymbol = {};
    for (const p of livePos) sizeBySymbol[p.product_symbol] = Number(p.size) || 0;

    const hasOrderForSymbol = {};
    if (Array.isArray(liveOrders)) {
      for (const o of liveOrders) {
        if (o.product_symbol) hasOrderForSymbol[o.product_symbol] = true;
      }
    }

    // Systemic-mismatch guard: if Delta reports open positions but NONE of them
    // match any tracked leg symbol, that's a symbol-format problem — NOT real
    // closes. Deleting here would wipe live positions the engine still owns
    // (leaving them unmanaged on Delta). Skip the whole pass in that case.
    const liveOpenSymbols = new Set(livePos.filter(p => Number(p.size) !== 0).map(p => p.product_symbol));
    const tracked = positions.filter(p => p.underlying === config.underlying);
    if (liveOpenSymbols.size > 0 && tracked.length > 0) {
      const anyMatch = tracked.some(p => liveOpenSymbols.has(p.buyLeg?.symbol) || liveOpenSymbols.has(p.sellLeg?.symbol));
      if (!anyMatch) {
        logWarn(`[${accountState.name}] reconcile: Delta has ${liveOpenSymbols.size} open leg(s) but none match tracked symbols — skipping (possible symbol mismatch, not wiping positions).`);
        return;
      }
    }

    const now = Date.now();
    for (const pos of [...positions]) {
      if (pos.underlying !== config.underlying) continue;
      const shortSize = Math.abs(sizeBySymbol[pos.sellLeg?.symbol] ?? 0);
      const longSize = Math.abs(sizeBySymbol[pos.buyLeg?.symbol] ?? 0);
      if (shortSize > 0 || longSize > 0) { pos._everOpenOnDelta = true; continue; } // still open
      
      const hasLongOrder = hasOrderForSymbol[pos.buyLeg?.symbol] || false;
      const hasShortOrder = hasOrderForSymbol[pos.sellLeg?.symbol] || false;
      
      // If the orders are not resting and the position is not open, it was cancelled/closed.
      // If it was cancelled before ever opening, we can clean it up immediately (isDeadEntry).
      const isDeadEntry = !pos._everOpenOnDelta && !hasLongOrder && (!pos.sellQty || !hasShortOrder);

      const ageMs = now - new Date(pos.entryTime).getTime();
      if (!isDeadEntry) {
        // If never confirmed open on Delta (e.g. engine restarted after exits), clean up after 5 min
        if (!pos._everOpenOnDelta && ageMs < 300000) continue;
        // If confirmed open before, wait 90s before treating an absent position as
        // closed — conservative, so a transient fetch/symbol blip can't wrongly wipe
        // a live position (the systemic-mismatch guard above is the primary defence).
        if (ageMs < 90000) continue;
      }

      // Orphan — the exchange closed it. Book a full exit at current mark + delete
      // (Realtime removes it from the in-memory `positions` and the UI).
      const tBuy = tickerData[pos.buyLeg.symbol];
      const tSell = tickerData[pos.sellLeg.symbol];
      const exitLong = tBuy?.markPrice ?? tBuy?.bid ?? tBuy?.lastPrice ?? pos.entryBuyPrice;
      const exitShort = tSell?.markPrice ?? tSell?.ask ?? tSell?.lastPrice ?? pos.entrySellPrice;
      const longLot = pos.buyLeg.lotSize || 0;
      const shortLot = pos.sellLeg.lotSize || 1;
      const gross = (exitLong - pos.entryBuyPrice) * longLot
        + (pos.sellQty > 0 ? (pos.entrySellPrice - exitShort) * pos.sellQty * shortLot : 0);
      const entryFee = pos.entryFee || 0;
      const exitFee = calculateFee(exitLong, spotPrice, longLot, pos.buyLeg.originalLotSize || 1)
        + (pos.sellQty > 0 ? calculateFee(exitShort, spotPrice, pos.sellQty, shortLot) : 0);
      const net = gross - (entryFee + exitFee);
      try {
        await cancelRestingOrders(pos);
        if (pos._everOpenOnDelta) {
          const isTp = pos.sellQty === 0;
          const label = isTp ? '🎯 TAKE PROFIT (long TP)' : '🚨 STOP LOSS (short SL)';
          await supabase.from('trade_history').upsert([{
            trade_id: pos.id, underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
            buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
            sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
            entry_time: pos.entryTime.toISOString(),
            entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
            margin: pos.margin, exit_time: new Date().toISOString(),
            exit_buy_price: exitLong, exit_sell_price: pos.sellQty > 0 ? exitShort : null, exit_spot_price: spotPrice,
            realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
            exit_reason: `Reconciled: ${label}`, is_partial: false, account_id: accountState.id,
          }], { onConflict: 'trade_id', ignoreDuplicates: true });
        }
        await supabase.from('active_positions').delete().eq('id', pos.id);
        log(`[${accountState.name}] ♻️ RECONCILE-CLEAN: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''} absent from Delta → ${pos._everOpenOnDelta ? 'booked + removed' : 'silently removed (never filled)'}`);
        if (pos._everOpenOnDelta) {
          const isTp = pos.sellQty === 0;
          const title = isTp ? '🎯 TAKE PROFIT (long TP)' : '🚨 STOP LOSS (short SL)';
          notifyTrade({ title, detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''} · closed on Delta`, pnl: net + (pos.accumulatedSellPnl || 0) });
        }
      } catch (e) {
        logError(`[${accountState.name}] reconcileOrphans failed for ${pos.id}:`, e);
        notifyLiveFailure({ account: accountState.name, context: `Orphan reconcile FAILED (${pos.id}) — exchange/engine state may be out of sync`, error: e });
      }
    }
  }

  // ── Manual exit (UI-initiated) ───────────────────────────────────────────
  // The dashboard sets active_positions.exit_requested = true. The engine (not the
  // browser) then closes the real position on Delta — cancel resting orders +
  // market-close the legs (no-op for paper / dry-run / disarmed) — books a Manual
  // Exit and deletes the row. This prevents the browser from deleting a live DB row
  // while the real Delta position stays open.
  async function manualExitPosition(pos, opts = {}) {
    // skipExchangeClose: the account was already flattened by a native close_all,
    // so the legs are gone — just cancel resting orders, book, and delete.
    const { skipExchangeClose = false } = opts;
    lastDbWrite = Date.now();
    const tBuy = tickerData[pos.buyLeg.symbol];
    const tSell = tickerData[pos.sellLeg.symbol];
    const exitLong = tBuy?.bid ?? tBuy?.markPrice ?? tBuy?.lastPrice ?? pos.entryBuyPrice;
    const exitShort = tSell?.ask ?? tSell?.markPrice ?? tSell?.lastPrice ?? pos.entrySellPrice;
    try { await cancelRestingOrders(pos); } catch (e) { /* best-effort */ }
    if (!skipExchangeClose) {
      if (pos.sellQty > 0) {
        await live.closeLeg({ symbol: pos.sellLeg.symbol, side: 'buy', contracts: shortContracts(pos.sellQty), price: exitShort, tag: `${pos.id}-MXS` });
      }
      if ((pos.buyLeg.lotSize || 0) > 0) {
        await live.closeLeg({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: longContracts(pos.buyLeg), price: exitLong, tag: `${pos.id}-MXB` });
      }
    }
    const longLot = pos.buyLeg.lotSize || 0;
    const shortLot = pos.sellLeg.lotSize || 1;
    const gross = (exitLong - pos.entryBuyPrice) * longLot
      + (pos.sellQty > 0 ? (pos.entrySellPrice - exitShort) * pos.sellQty * shortLot : 0);
    const entryFee = pos.entryFee || 0;
    const exitFee = calculateFee(exitLong, spotPrice, longLot, pos.buyLeg.originalLotSize || 1)
      + (pos.sellQty > 0 ? calculateFee(exitShort, spotPrice, pos.sellQty, shortLot) : 0);
    const net = gross - (entryFee + exitFee);
    try {
      await supabase.from('trade_history').upsert([{
        trade_id: pos.id, underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
        buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
        sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
        entry_time: pos.entryTime.toISOString(),
        entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
        margin: pos.margin, exit_time: new Date().toISOString(),
        exit_buy_price: exitLong, exit_sell_price: pos.sellQty > 0 ? exitShort : null, exit_spot_price: spotPrice,
        realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
        exit_reason: 'Manual Exit', is_partial: false, account_id: accountState.id,
      }], { onConflict: 'trade_id', ignoreDuplicates: true });
      await supabase.from('active_positions').delete().eq('id', pos.id);
    } catch (e) { logError(`[${accountState.name}] Manual exit booking failed for ${pos.id}:`, e); }
    positions = positions.filter(p => p.id !== pos.id);
    heartbeat.update({ active_positions: positions.length });
    const cumulativeNet = net + (pos.accumulatedSellPnl || 0);
    log(`[${accountState.name}] 🙋 MANUAL EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''} | PnL $${cumulativeNet.toFixed(2)} (cumulative)`);
    notifyTrade({ title: '🙋 MANUAL EXIT', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''}`, pnl: cumulativeNet });
  }

  // Poll for UI-requested exits and process them promptly.
  async function processManualExits() {
    try {
      const { data, error } = await supabase
        .from('active_positions').select('id')
        .eq('account_id', accountState.id).eq('exit_requested', true);
      if (error || !data || !data.length) return;
      const ids = new Set(data.map(r => r.id));
      let exited = false;
      for (const pos of [...positions]) {
        if (ids.has(pos.id)) { await manualExitPosition(pos); exited = true; }
      }
      // Republish immediately so the closed position clears from the UI within ~1s.
      if (exited) await publishLiveSnapshot(true).catch(() => {});
    } catch (e) { /* non-fatal */ }
  }

  // Record a single manually-closed leg to trade_history (partial).
  async function bookLegClose(pos, legSide, exitPx, gross, sym) {
    try {
      await supabase.from('trade_history').upsert([{
        trade_id: `${pos.id}-MLC-${legSide}-${Date.now().toString(36).toUpperCase()}`,
        underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
        buy_leg: JSON.stringify(legSide === 'long' ? pos.buyLeg : { ...pos.buyLeg, lotSize: 0 }),
        sell_leg: JSON.stringify(legSide === 'short' ? pos.sellLeg : { ...pos.sellLeg, lotSize: 0 }),
        sell_qty: legSide === 'short' ? pos.sellQty : 0,
        strike_diff: pos.strikeDiff,
        entry_time: pos.entryTime.toISOString(),
        entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
        margin: pos.margin, exit_time: new Date().toISOString(),
        exit_buy_price: legSide === 'long' ? exitPx : null,
        exit_sell_price: legSide === 'short' ? exitPx : null,
        exit_spot_price: spotPrice,
        realized_gross_pnl: gross, realized_net_pnl: gross, exit_fee: 0, total_fees: 0,
        exit_reason: `Manual Leg Close (${sym})`, is_partial: true, account_id: accountState.id,
      }], { onConflict: 'trade_id', ignoreDuplicates: true });
      notifyTrade({ title: '🙋 MANUAL LEG CLOSE', detail: `${pos.type.toUpperCase()} ${legSide} leg · ${sym}`, pnl: gross });
    } catch (e) { logError(`[${accountState.name}] bookLegClose failed for ${pos.id}:`, e); }
  }

  // Per-symbol close (UI ✕ on a Delta position row, incl. orphans not tracked by
  // the engine). Reduce_only market close of exactly that leg on Delta.
  async function processCloseRequests() {
    if (!(accountState.mode === 'live' && accountState.live_enabled)) return;
    try {
      const { data, error } = await supabase
        .from('delta_close_requests').select('id, product_symbol, created_at')
        .eq('account_id', accountState.id);
      if (error || !data || !data.length) return;
      // Discard stale requests (e.g. a backlog that piled up while the engine was
      // down) without acting — so a restart never bulk-closes old clicks.
      const fresh = [];
      for (const r of data) {
        if (Date.now() - new Date(r.created_at).getTime() > 90000) {
          await supabase.from('delta_close_requests').delete().eq('id', r.id);
        } else { fresh.push(r); }
      }
      if (!fresh.length) return;
      const livePos = await live.positions();
      const sizeBySymbol = {};
      for (const p of (livePos || [])) sizeBySymbol[p.product_symbol] = Number(p.size) || 0;
      for (const r of fresh) {
        const sym = r.product_symbol;
        const sz = sizeBySymbol[sym] || 0;
        if (sz !== 0) {
          const side = sz > 0 ? 'sell' : 'buy'; // close only this leg
          await live.closeSymbol({ symbol: sym, side, contracts: Math.abs(sz), tag: `${sym}-CX` });
        } else {
          log(`[${accountState.name}] Close request for ${sym}: no open size on Delta (already flat).`);
        }
        lastDbWrite = Date.now();
        // Per-leg bookkeeping: zero ONLY the closed leg on the matching spread
        // (do NOT close the other leg). Delete the row only if both legs are gone.
        for (const pos of [...positions]) {
          const tBuy = tickerData[pos.buyLeg?.symbol];
          const tSell = tickerData[pos.sellLeg?.symbol];
          let changed = false;
          if (pos.buyLeg?.symbol === sym && (pos.buyLeg.lotSize || 0) > 0) {
            const px = tBuy?.bid ?? tBuy?.markPrice ?? tBuy?.lastPrice ?? pos.entryBuyPrice;
            const gross = (px - pos.entryBuyPrice) * (pos.buyLeg.lotSize || 0);
            await bookLegClose(pos, 'long', px, gross, sym);
            pos.buyLeg = { ...pos.buyLeg, lotSize: 0 };
            changed = true;
          }
          if (pos.sellLeg?.symbol === sym && (pos.sellQty || 0) > 0) {
            const px = tSell?.ask ?? tSell?.markPrice ?? tSell?.lastPrice ?? pos.entrySellPrice;
            const gross = (pos.entrySellPrice - px) * pos.sellQty * (pos.sellLeg.lotSize || 1);
            await bookLegClose(pos, 'short', px, gross, sym);
            pos.sellLeg = { ...pos.sellLeg, lotSize: 0 };
            pos.sellQty = 0;
            changed = true;
          }
          if (changed) {
            const fullyClosed = (pos.buyLeg.lotSize || 0) <= 0 && (pos.sellQty || 0) <= 0;
            try {
              if (fullyClosed) {
                await supabase.from('active_positions').delete().eq('id', pos.id);
                positions = positions.filter(p => p.id !== pos.id);
              } else {
                await supabase.from('active_positions').update({
                  buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg), sell_qty: pos.sellQty,
                }).eq('id', pos.id);
              }
            } catch (e) { logError(`[${accountState.name}] leg-close persist failed for ${pos.id}:`, e); }
          }
        }
        await supabase.from('delta_close_requests').delete().eq('id', r.id);
      }
      // Republish the snapshot immediately so the UI reflects the close within ~1s
      // instead of waiting up to the 20s snapshot tick (which made a closed leg
      // reappear on the UI's 5s refetch until then — the "glitch").
      await publishLiveSnapshot(true).catch(() => {});
    } catch (e) { logError(`[${accountState.name}] processCloseRequests error:`, e); }
  }

  // Per-order cancel (UI ✕ on an Open Orders row). Cancels that order on Delta.
  async function processCancelRequests() {
    if (!(accountState.mode === 'live' && accountState.live_enabled)) return;
    try {
      const { data, error } = await supabase
        .from('delta_cancel_requests').select('id, order_id, product_id, created_at')
        .eq('account_id', accountState.id);
      if (error || !data || !data.length) return;
      let cancelled = false;
      for (const r of data) {
        // Skip stale cancel requests (backlog from a down engine) — just remove them.
        if (Date.now() - new Date(r.created_at).getTime() > 90000) {
          await supabase.from('delta_cancel_requests').delete().eq('id', r.id);
          continue;
        }
        await live.cancelStop({ id: r.order_id, productId: r.product_id });
        await supabase.from('delta_cancel_requests').delete().eq('id', r.id);
        cancelled = true;
      }
      // Republish immediately so the cancelled order clears from the UI within ~1s.
      if (cancelled) await publishLiveSnapshot(true).catch(() => {});
    } catch (e) { logError(`[${accountState.name}] processCancelRequests error:`, e); }
  }

  // "Close All" — the dashboard sets paper_trading_accounts.close_all_requested.
  // Armed real: flatten the account in ONE Delta call (close_all); if that fails,
  // fall back to per-position closes. Then cancel resting orders, book, delete all.
  async function processCloseAll() {
    // Read the flag straight from the DB rather than relying on in-memory
    // accountState.close_all_requested. Realtime is the only path that sets that
    // field (the 30s fallback sync selects a subset that omits it, and replaces
    // accountState with a partial row that drops it), so a missed Realtime event
    // would silently swallow a Close All. Polling here — like processCloseRequests
    // — makes it reliable regardless of Realtime delivery.
    let requested = false;
    try {
      const { data, error } = await supabase
        .from('paper_trading_accounts')
        .select('close_all_requested')
        .eq('id', accountState.id).single();
      if (error) return;
      requested = !!data?.close_all_requested;
    } catch { return; }
    if (!requested) return;
    // Clear the flag first so we process it exactly once.
    try {
      await supabase.from('paper_trading_accounts').update({ close_all_requested: false }).eq('id', accountState.id);
    } catch (e) { /* will retry next tick if this failed */ }
    accountState.close_all_requested = false;

    const open = [...positions];
    log(`[${accountState.name}] 🧨 CLOSE ALL requested — ${open.length} tracked position(s)`);

    // Flatten the whole Delta account FIRST (even if the engine tracks nothing —
    // this also clears any orphaned positions the engine lost track of). One call.
    let flattened = false;
    if (accountState.mode === 'live' && accountState.live_enabled) {
      const r = await live.closeAll();          // one-shot flatten (dry-run logs only)
      flattened = !!(r.ok && r.res);            // real success → legs already gone
    }
    // Book + delete every tracked position (cancels resting orders). Skip the
    // per-leg close only when the native flatten actually executed.
    for (const pos of open) {
      await manualExitPosition(pos, { skipExchangeClose: flattened });
    }
    // Republish immediately so the flattened account shows empty on the UI within
    // ~1s rather than lingering until the next 20s snapshot tick.
    await publishLiveSnapshot(true).catch(() => {});
  }

  async function handleLiveRestingExit(pos, remaining, fillIds, sizeBySymbol, eff = config, applyAtmRatioScaling = null) {
    const tickerBuy = tickerData[pos.buyLeg.symbol];
    const tickerSell = tickerData[pos.sellLeg.symbol];
    const longBid = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
    const shortAsk = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

    // Active-window exit rule governs the engine's spot-cross catch-all. The exchange
    // SL/TP bracket placed at entry is NOT moved here (see note at the call site).
    const triggerLevel = computeIndexTriggerLevel(pos.type, pos.buyLeg.strike, eff);
    const spotCross = isIndexTriggerMet(pos.type, triggerLevel, spotPrice);
    const expiryTs = new Date(pos.expiry).getTime();
    const atExpiry = Date.now() >= expiryTs - 120000;

    // ── Catch-all: spot crossed the strike (SL), or expiry → cancel resting +
    //    market-close the remainder + book a single full exit.
    if (spotCross || atExpiry) {
      await cancelRestingOrders(pos);
      lastDbWrite = Date.now();
      const longLot = pos.buyLeg.lotSize || 0;
      const shortLot = pos.sellLeg.lotSize || 1;
      const exitLong = longBid ?? pos.entryBuyPrice;
      const exitShort = shortAsk ?? pos.entrySellPrice;
      // Market-close remaining legs unless expiry (Delta cash-settles expired options).
      if (!atExpiry) {
        // CAXS/CAXB tags (vs the strategy exit's XS/XB) so the Order History UI shows "Close All".
        if (pos.sellQty > 0) {
          await live.closeLeg({ symbol: pos.sellLeg.symbol, side: 'buy', contracts: shortContracts(pos.sellQty), price: exitShort, tag: `${pos.id}-CAXS` });
        }
        if (longLot > 0) {
          await live.closeLeg({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: longContracts(pos.buyLeg), price: exitLong, tag: `${pos.id}-CAXB` });
        }
      }
      const grossLong = (exitLong - pos.entryBuyPrice) * longLot;
      const grossShort = pos.sellQty > 0 ? (pos.entrySellPrice - exitShort) * pos.sellQty * shortLot : 0;
      const gross = grossLong + grossShort;
      const entryFee = pos.entryFee || 0;
      const exitFee = calculateFee(exitLong, spotPrice, longLot, pos.buyLeg.originalLotSize || 1)
        + (pos.sellQty > 0 ? calculateFee(exitShort, spotPrice, pos.sellQty, shortLot) : 0);
      const net = gross - (entryFee + exitFee);
      const reason = atExpiry ? 'Expiry Reached (2min Early)' : `Full Exit (${eff.exitType || 'ATM'} spot ${Math.round(spotPrice)})`;
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: pos.id, underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: pos.zombieExitTime || new Date().toISOString(),
          exit_buy_price: exitLong, exit_sell_price: pos.sellQty > 0 ? exitShort : null, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: reason, is_partial: false, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
        await supabase.from('active_positions').delete().eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Resting full-exit booking failed for ${pos.id}:`, e); }
      const cumulativeNet = net + (pos.accumulatedSellPnl || 0);
      log(`[${accountState.name}] 📤 LIVE ${atExpiry ? 'EXPIRY' : 'FULL EXIT'}: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''} | ${reason} | PnL $${cumulativeNet.toFixed(2)} (cumulative)`);
      notifyTrade({ title: atExpiry ? '📤 EXPIRY EXIT' : '📤 FULL EXIT', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''} · ${reason}`, pnl: cumulativeNet });
      return; // closed
    }

    // ── Full spread: waiting for the resting short-@shortExitPrice BUY to fill ──
    if (pos.sellQty > 0) {
      // Dynamic ATM-ratio scale-down on the LONG leg — same engine-driven partial as
      // the active model, run every cycle while the spread is still full. The trigger
      // is dynamic (live ATM ratio + PnL threshold), so it can't rest on the exchange;
      // it actively fires a reduce_only SELL at the bid and books the partial slice(s).
      // Safe alongside the resting short buy-back: it only touches the long leg, which
      // has no resting orders yet (the long ladder is placed only AFTER the short exits),
      // and it leaves pos.sellQty untouched so the short-fill logic below is unaffected.
      if (typeof applyAtmRatioScaling === 'function' && longBid != null && shortAsk != null) {
        await applyAtmRatioScaling(pos, { liveExitBuy: longBid, liveExitSell: shortAsk, tickerBuy });
      }

      // The exit order id appears in `fillIds` on the FIRST partial fill, not only a
      // full one. Booking the short exit + placing the long ladder on a partial fill
      // would drop long exit slices while the sell position is still partly open — the
      // "lot qty not full but exit slices appear" bug. Sequence:
      //   1) no fill yet → hold (no size fetch needed);
      //   2) fill started → confirm the short is FULLY flat on the exchange (size 0)
      //      before converting to long-only. `sizeBySymbol` is only fetched while a
      //      buy-back is filling; if it's null (fetch failed / not fetched), hold and
      //      re-check next cycle rather than infer a close.
      // A confirmed fill (order id in `fillIds`) means the reduce-only buy-back actually
      // traded, so size 0 is a genuine close — a never-opened phantom short can't fill.
      const orderFilled = pos.sellLeg.exitOrderId != null && fillIds.has(String(pos.sellLeg.exitOrderId));
      if (!orderFilled) { remaining.push(pos); return; }
      if (sizeBySymbol == null) { remaining.push(pos); return; }
      const shortSize = Math.abs(sizeBySymbol[pos.sellLeg.symbol] ?? 0);
      if (shortSize > 0) { remaining.push(pos); return; } // partial fill — wait for the rest

      lastDbWrite = Date.now();
      const exitPx = pos.sellLeg.exitOrderPx ?? (config.shortExitPrice ?? 1.1);
      const shortLot = pos.sellLeg.lotSize || 1;
      const gross = (pos.entrySellPrice - exitPx) * pos.sellQty * shortLot;
      const entryFee = Math.min(pos.entryFee || 0, calculateFee(pos.entrySellPrice, pos.entrySpotPrice, pos.sellQty, shortLot));
      const exitFee = calculateFee(exitPx, spotPrice, pos.sellQty, shortLot);
      const net = gross - (entryFee + exitFee);
      try {
        await supabase.from('trade_history').upsert([{
          trade_id: `${pos.id}-SE`, underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: 0 }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, exitIv: tickerSell?.askIv ?? tickerSell?.iv ?? null }),
          sell_qty: pos.sellQty, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: longBid, exit_sell_price: exitPx, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: `Short Leg Exit @ $${exitPx} (resting, holding long ${pos.buyLeg.strike})`,
          is_partial: true, account_id: accountState.id,
        }], { onConflict: 'trade_id', ignoreDuplicates: true });
      } catch (e) { logError(`[${accountState.name}] Resting short-exit booking failed for ${pos.id}:`, e); }

      // Convert to long-only and place the fixed ladder of resting SELL orders.
      // (The short's SL bracket auto-cancels on the exchange now that the short is flat.)
      pos.entryFee = Math.max(0, (pos.entryFee || 0) - entryFee);
      pos.sellLeg = { ...pos.sellLeg, lotSize: 0, exitOrderId: null };
      pos.sellQty = 0;
      pos.accumulatedSellPnl = (pos.accumulatedSellPnl || 0) + net;
      const baseLot = pos.buyLeg.lotSize || 0;
      const S = longContracts(pos.buyLeg);
      const levels = fixedLadderLevels(longBid);
      const alloc = splitContracts(S, levels.length);
      const ladderOrders = [];
      for (let i = 0; i < alloc.length; i++) {
        const res = await live.closeLeg({
          symbol: pos.buyLeg.symbol, side: 'sell', contracts: alloc[i], price: levels[i], tag: `${pos.id}-LE-${i}`,
        });
        ladderOrders.push({
          stage: i, level: levels[i], contracts: alloc[i],
          lot: S > 0 ? Number((baseLot * alloc[i] / S).toFixed(4)) : baseLot,
          orderId: res?.order?.id ?? null, productId: res?.order?.product_id ?? null, filled: false,
        });
      }
      pos.buyLeg = { ...pos.buyLeg, longExitBaseLot: baseLot, ladderOrders };
      pos.margin = longOnlyMargin(pos);
      try {
        await supabase.from('active_positions').update({
          buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          sell_qty: 0, entry_fee: pos.entryFee, margin: pos.margin,
          accumulated_sell_pnl: pos.accumulatedSellPnl,
        }).eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Resting short-exit persist failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] ✂️ RESTING SHORT EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} @ $${exitPx} | ladder ${alloc.join('/')} contracts @ [${levels.join(',')}] | PnL $${net.toFixed(2)}`);
      notifyTrade({ title: '✂️ SHORT EXIT', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike} · short bought back @ $${exitPx} · long ladder placed`, pnl: net });
      remaining.push(pos);
      return;
    }

    // ── Long-only: book any ladder slices that have filled ──
    const ladder = pos.buyLeg.ladderOrders || [];
    const newlyFilled = ladder.filter(lo => !lo.filled && lo.orderId != null && fillIds.has(String(lo.orderId)));
    if (newlyFilled.length > 0) {
      lastDbWrite = Date.now();
      const rows = [];
      let cycleNet = 0; // sum of this cycle's slice net PnL (for the Telegram notify)
      for (const lo of newlyFilled) {
        const px = lo.level;
        const gross = (px - pos.entryBuyPrice) * lo.lot;
        const entryFee = Math.min(pos.entryFee || 0, calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, lo.lot, pos.buyLeg.originalLotSize || 1));
        const exitFee = calculateFee(px, spotPrice, lo.lot, pos.buyLeg.originalLotSize || 1);
        const net = gross - (entryFee + exitFee);
        cycleNet += net;
        rows.push({
          trade_id: `${pos.id}-LE-${lo.stage}`, underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
          buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: lo.lot, ladderOrders: undefined, exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null }),
          sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
          sell_qty: 0, strike_diff: pos.strikeDiff,
          entry_time: pos.entryTime.toISOString(),
          entry_buy_price: pos.entryBuyPrice, entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice,
          margin: pos.margin, exit_time: new Date().toISOString(),
          exit_buy_price: px, exit_sell_price: null, exit_spot_price: spotPrice,
          realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFee + exitFee,
          exit_reason: `Long Leg Exit @ level $${lo.level} (resting)`, is_partial: true, account_id: accountState.id,
        });
        lo.filled = true;
        pos.entryFee = Math.max(0, (pos.entryFee || 0) - entryFee);
        pos.buyLeg.lotSize = Number((pos.buyLeg.lotSize - lo.lot).toFixed(4));
        pos.accumulatedSellPnl = (pos.accumulatedSellPnl || 0) + net;
      }
      try {
        await supabase.from('trade_history').upsert(rows, { onConflict: 'trade_id', ignoreDuplicates: true });
      } catch (e) { logError(`[${accountState.name}] Resting ladder booking failed for ${pos.id}:`, e); }

      const allFilled = ladder.length > 0 && ladder.every(lo => lo.filled);
      if (allFilled || pos.buyLeg.lotSize <= 0.0001) {
        try { await supabase.from('active_positions').delete().eq('id', pos.id); }
        catch (e) { logError(`[${accountState.name}] Resting ladder final delete failed for ${pos.id}:`, e); }
        log(`[${accountState.name}] 🪜 LONG FULLY EXITED (resting ladder): ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${newlyFilled.length} slice(s) this cycle`);
        notifyTrade({ title: '🪜 LONG FULLY EXITED', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike} · ${newlyFilled.length} slice(s) this cycle · position closed`, pnl: pos.accumulatedSellPnl });
        return;
      }
      pos.margin = longOnlyMargin(pos);
      try {
        await supabase.from('active_positions').update({
          buy_leg: JSON.stringify(pos.buyLeg), entry_fee: pos.entryFee, margin: pos.margin,
          accumulated_sell_pnl: pos.accumulatedSellPnl,
        }).eq('id', pos.id);
      } catch (e) { logError(`[${accountState.name}] Resting ladder persist failed for ${pos.id}:`, e); }
      log(`[${accountState.name}] 🪜 LONG SLICE EXIT (resting): ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${newlyFilled.length} slice(s) | remaining lot ${pos.buyLeg.lotSize}`);
      notifyTrade({ title: '🪜 LONG SLICE EXIT', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike} · ${newlyFilled.length} slice(s) · remaining lot ${pos.buyLeg.lotSize}`, pnl: pos.accumulatedSellPnl });
    }
    remaining.push(pos);
  }

  async function evaluateStrategy(onlyExits = false) {
    if (isEvaluating) {
      const evalDuration = Date.now() - evaluationStart;
      if (evaluationStart > 0 && evalDuration > 60000) {
        logError(`[${accountState.name}] Strategy evaluation has been hung for ${Math.round(evalDuration / 1000)}s. Crashing process for PM2 recovery.`);
        process.exit(1);
      }
      return;
    }
    if (!spotPrice) return;

    // Spot staleness guard
    const spotAge = Date.now() - lastSpotUpdate;
    if (lastSpotUpdate > 0 && spotAge > 120000) {
      logWarn(`[${accountState.name}] Spot stale (${Math.round(spotAge / 1000)}s). Skipping evaluation.`);

      const now = Date.now();
      if (now - lastWsReconnectTime > 60000) {
        logWarn(`[${accountState.name}] Forcing WebSocket reconnect due to stale spot...`);
        lastWsReconnectTime = now;
        try {
          startWebSocket();
        } catch (e) {
          logError(`[${accountState.name}] Failed to force WS reconnect:`, e);
        }
      }
      return;
    }

    isEvaluating = true;
    evaluationStart = Date.now();
    try {
      const allTickers = Object.values(tickerData);
      if (allTickers.length === 0) {
        if (!onlyExits) {
          logWarn('No tickers in cache — skipping entry scan.');
        }
        return;
      }

      // ── Apply active time-schedule overrides ──────────────────────────
      const activeSchedule = getActiveSchedule();
      const effectiveConfig = activeSchedule
        ? {
          ...config,
          numberOfCalls: activeSchedule.numberOfCalls,
          numberOfPuts: activeSchedule.numberOfPuts,
          minLongDist: activeSchedule.minLongDist,
          minStrikeDiff: activeSchedule.minStrikeDiff,
          atmRatioScaling: activeSchedule.atmRatioScaling,
          atmRatioPctCall: activeSchedule.atmRatioPctCall,
          atmRatioPctPut: activeSchedule.atmRatioPctPut,
          // Per-window entry debit cap + exit rule (fall back to account config if
          // the schedule row predates migration 012).
          maxNetPremium: activeSchedule.maxNetPremium ?? config.maxNetPremium,
          exitType: activeSchedule.exitType ?? config.exitType,
          exitPoints: activeSchedule.exitPoints ?? config.exitPoints,
          // Per-window min-days-to-expiry only for strategy_version >= 2 (migration 019);
          // v1 keeps the account-level value spread from config above.
          ...(config.strategyVersion >= 2
            ? {
              daysToExpiry: activeSchedule.daysToExpiry ?? config.daysToExpiry,
              // Hedge overlay (migration 022) — active window's settings, v2 only.
              hedgeStrikeType: activeSchedule.hedgeStrikeType ?? 'none',
              hedgeCallPrice: activeSchedule.hedgeCallPrice ?? 0,
              hedgeCallPct: activeSchedule.hedgeCallPct ?? 0,
              hedgePutPrice: activeSchedule.hedgePutPrice ?? 0,
              hedgePutPct: activeSchedule.hedgePutPct ?? 0,
            }
            : {}),
        }
        : { ...config };

      // if (activeSchedule) {
      //   log(`[${accountState.name}] Schedule active: "${activeSchedule.label}" — Calls: ${activeSchedule.numberOfCalls}, Puts: ${activeSchedule.numberOfPuts}, LongDist: ${activeSchedule.minLongDist}, StrikeDiff: ${activeSchedule.minStrikeDiff}`);
      // }

      const underlying = effectiveConfig.underlying;

      // Identify ATM strike
      let atmStrike = null;
      let minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      // A. Local Scan: top candidates per type
      const callTickers = allTickers.filter(t => t.type === 'call' && t.expiry === config.expiry && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && t.expiry === config.expiry && (atmStrike === null || t.strike <= atmStrike));

      if (!onlyExits) {
        const now = Date.now();
        const staleCallCount = callTickers.filter(t => !((t.askUpdatedAt || 0) > 0 && (now - t.askUpdatedAt) < 120000)).length;
        const stalePutCount = putTickers.filter(t => !((t.bidUpdatedAt || 0) > 0 && (now - t.bidUpdatedAt) < 120000)).length;
        const totalTickers = allTickers.length;
        const expiryMatchCount = callTickers.length + putTickers.length;
        if (expiryMatchCount === 0) {
          logWarn(`[${accountState.name}] Ticker pool: ${totalTickers} total, 0 match expiry ${config.expiry} — WS may not have started yet.`);
        } else if (staleCallCount + stalePutCount > 0) {
          logWarn(`[${accountState.name}] Ticker pool: ${expiryMatchCount} matching expiry (${callTickers.length} calls, ${putTickers.length} puts), but ${staleCallCount + stalePutCount} have stale quotes (>120s) — waiting for fresh WS data.`);
        }
      }

      const { pairs: localTopCalls, rejected: callRej } = scanTickers(callTickers, effectiveConfig, spotPrice, atmStrike, getTickerPrice);
      const { pairs: localTopPuts, rejected: putRej } = scanTickers(putTickers, effectiveConfig, spotPrice, atmStrike, getTickerPrice);
      const topSpreads = [...localTopCalls, ...localTopPuts];

      // Merge rejection counts from calls + puts
      const totalRejected = {};
      for (const k of Object.keys(callRej)) totalRejected[k] = (callRej[k] || 0) + (putRej[k] || 0);

      function getTickerPrice(strike, optType, priceField, expiry) {
        const lowerType = optType.toLowerCase();
        const allTickersOfType = allTickers.filter(t => t.type === lowerType && (!expiry || t.expiry === expiry));
        if (!allTickersOfType.length) return null;

        // Exact match first
        const exact = allTickersOfType.find(t => t.strike === strike);
        if (exact) {
          const val = exact[priceField] ?? exact.lastPrice ?? exact.markPrice;
          return (val != null && val > 0) ? val : null;
        }

        // Nearest strike fallback - tight tolerance
        const maxTolerance = config.underlying === 'ETH' ? 50 : 500;
        let nearest = null;
        let minDist = Infinity;
        for (const t of allTickersOfType) {
          const dist = Math.abs(t.strike - strike);
          if (dist < minDist && dist <= maxTolerance) {
            minDist = dist;
            nearest = t;
          }
        }
        if (!nearest) return null;
        const val = nearest[priceField] ?? nearest.lastPrice ?? nearest.markPrice;
        return (val != null && val > 0) ? val : null;
      }

      function calculateAtmPnlAndRoi(spread) {
        const buyIntrinsic = getTickerPrice(atmStrike, spread.buyLeg.type, 'bid', config.expiry);
        const targetSellStrike = spread.buyLeg.type === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
        const sellIntrinsic = getTickerPrice(targetSellStrike, spread.buyLeg.type, 'ask', config.expiry);
        const lotSize = spread.buyLeg.lotSize || 1;

        if (buyIntrinsic == null || sellIntrinsic == null) {
          return { atmPnl: null, roi: null };
        }

        const entryAtmRatio = computeEntryAtmRatio(buyIntrinsic, sellIntrinsic);
        const ratioToUse = computeScaledSellQty(spread.sellQty, entryAtmRatio, spread.buyLeg.type, effectiveConfig);

        const sellLotSize = spread.sellLeg.lotSize || lotSize;
        let shortValue = spotPrice * ratioToUse * sellLotSize;

        let adjustedLotSize = lotSize;
        let adjustedSellQty = ratioToUse;
        let scale = 1;

        if (shortValue >= 195000) {
          scale = 195000 / shortValue;
          adjustedLotSize = Number((lotSize * scale).toFixed(2));
          adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
          shortValue = 195000;
        }

        const atmPnl = ((buyIntrinsic - spread.buyPrice) + (spread.sellPrice - sellIntrinsic) * ratioToUse) * adjustedLotSize;
        const margin = calcMargin(spread.buyPrice, adjustedLotSize, spotPrice, adjustedSellQty, sellLotSize);
        const roi = margin > 0 ? (atmPnl / margin) * 100 : 0;

        return { atmPnl, roi };
      }

      // Compute ATM P&L and ROI for each spread in topSpreads, and filter by ATM P&L >= 50
      const processedSpreads = [];
      if (!onlyExits) {
        log(`[${accountState.name}] Evaluating ${topSpreads.length} candidate spreads for entry (Spot: ${spotPrice}, ATM Strike: ${atmStrike})`);
        if (topSpreads.length === 0) {
          // Log top rejection reason to diagnose why 0 candidates
          const topFilter = Object.entries(totalRejected)
            .filter(([, v]) => v > 0)
            .sort(([, a], [, b]) => b - a)[0];
          if (topFilter) {
            const filterNames = {
              strikeDiff: 'minStrikeDiff', noPrice: 'no ask/bid price',
              staleQuote: 'stale WS quote (>120s)', noIv: 'missing IV',
              ivDiff: 'minIvDiff', longDist: 'minLongDist',
              sellPremium: 'minSellPremium', noDelta: 'missing delta',
              ratioDev: 'maxRatioDeviation', maxSellQty: 'maxSellQty', netPrem: 'maxNetPremium'
            };
            logWarn(`[${accountState.name}] 0 candidates — top filter: ${filterNames[topFilter[0]] || topFilter[0]} rejected ${topFilter[1]} pairs (pool: ${callTickers.length} calls, ${putTickers.length} puts)`);
          }
        }
      }
      for (const spread of topSpreads) {
        const { atmPnl, roi } = calculateAtmPnlAndRoi(spread);

        let minAtmPnl = 50;
        if (effectiveConfig.atmRatioScaling) {
          const pct = spread.buyLeg.type === 'call' ? effectiveConfig.atmRatioPctCall : effectiveConfig.atmRatioPctPut;
          minAtmPnl = 50 * (1 - (pct || 0) / 100);
        }

        const passed = (atmPnl != null && atmPnl >= minAtmPnl);
        if (!onlyExits) {
          log(`[${accountState.name}] Candidate ${spread.buyLeg.type.toUpperCase()} ${spread.buyLeg.strike}/${spread.sellLeg.strike}: ATM P&L = $${atmPnl != null ? atmPnl.toFixed(2) : 'null'} (Min required: $${minAtmPnl.toFixed(2)}), ROI = ${roi != null ? roi.toFixed(2) : 0}%, Passed = ${passed}`);
        }
        if (passed) {
          processedSpreads.push({ ...spread, atmPnl, roi });
        }
      }

      // Group by buy strike and select the one with highest ROI for each unique strike
      const callGroups = {};
      const putGroups = {};

      for (const spread of processedSpreads) {
        const key = spread.buyLeg.strike;
        if (spread.buyLeg.type === 'call') {
          if (!callGroups[key]) callGroups[key] = [];
          callGroups[key].push(spread);
        } else {
          if (!putGroups[key]) putGroups[key] = [];
          putGroups[key].push(spread);
        }
      }

      const hasConflictWithOtherActivePositions = (spread, activePositions) => {
        const bStrike = Number(spread.buyLeg.strike);
        const sStrike = Number(spread.sellLeg.strike);
        const type = spread.buyLeg.type;

        return activePositions.some(p => {
          if (Number(p.buyLeg.strike) === bStrike && Number(p.sellLeg.strike) === sStrike) {
            return false;
          }
          return p.underlying === underlying &&
            p.type === type &&
            (Number(p.buyLeg.strike) === bStrike || Number(p.sellLeg.strike) === sStrike);
        });
      };

      const uniqueCalls = [];
      for (const group of Object.values(callGroups)) {
        group.sort((a, b) => b.roi - a.roi);
        const primary = group[0];
        uniqueCalls.push(primary);
        if (hasConflictWithOtherActivePositions(primary, positions)) {
          const fallback = group.slice(1).find(s => !hasConflictWithOtherActivePositions(s, positions));
          if (fallback) uniqueCalls.push(fallback);
        }
      }

      const uniquePuts = [];
      for (const group of Object.values(putGroups)) {
        group.sort((a, b) => b.roi - a.roi);
        const primary = group[0];
        uniquePuts.push(primary);
        if (hasConflictWithOtherActivePositions(primary, positions)) {
          const fallback = group.slice(1).find(s => !hasConflictWithOtherActivePositions(s, positions));
          if (fallback) uniquePuts.push(fallback);
        }
      }

      // Sort candidate lists by distance to ATM (closest to ATM first)
      uniqueCalls.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));
      uniquePuts.sort((a, b) => Math.abs(a.buyLeg.strike - spotPrice) - Math.abs(b.buyLeg.strike - spotPrice));

      const maxCallCandidates = Math.max(10, effectiveConfig.numberOfCalls || 3);
      const maxPutCandidates = Math.max(10, effectiveConfig.numberOfPuts || 3);

      const uniqueTopSpreads = [
        ...uniqueCalls.slice(0, maxCallCandidates),
        ...uniquePuts.slice(0, maxPutCandidates)
      ];

      if (!onlyExits && uniqueTopSpreads.length > 0) {
        const topDesc = uniqueTopSpreads.map(s => `${s.buyLeg.type.toUpperCase()} ${s.buyLeg.strike}/${s.sellLeg.strike} (ROI: ${s.roi.toFixed(1)}%, ATM P&L: $${s.atmPnl.toFixed(1)})`).join(', ');
        log(`Selected top unique spreads: ${topDesc}`);
      }

      // Count active positions
      const remaining = [];
      const exited = [];

      // Exit model selection:
      //  • Paper accounts & dry-run live → engine-ACTIVE model below (premium short
      //    buy-back, laddered long, ATM partials, ATM/ITM/OTM, expiry). Each branch
      //    also fires reduce_only closes to Delta when armed.
      //  • Armed REAL live → RESTING-order model (handleLiveRestingExit): the short
      //    buy-back @1.1 and the fixed long ladder rest in the exchange order book
      //    and fill on their own; the engine books fills (detected by order id) and
      //    keeps spot-cross / expiry as engine-driven catch-alls. Fetch recent fill
      //    order ids once per cycle; a failed fetch (null) → hold everything (no
      //    fill inference) to avoid mis-booking.
      const liveResting = accountState.mode === 'live' && !!accountState.live_enabled && !live.dryRun;
      let liveFillIds = null;
      let liveSizeBySymbol = null;
      // Only the resting-order model consumes fills, and only when this account actually
      // holds a position for the current underlying. With no open positions the exit loop
      // below is a no-op anyway, so an idle account no longer polls Delta fills every ~1s
      // for nothing. When positions DO exist we still fetch every cycle — the spot-cross /
      // expiry catch-all and resting-fill detection depend on it.
      if (liveResting && positions.some(p => p.underlying === underlying)) {
        liveFillIds = await live.recentFillOrderIds();
        // Per-symbol position sizes are needed ONLY to confirm a short buy-back has FULLY
        // closed — i.e. when a full-spread's resting exit order has already begun filling.
        // This exit loop runs ~once/second, so fetch the positions snapshot only in that
        // narrow window (not every cycle) to keep Delta API egress low: the common cases
        // (no open short, short not yet filling, or long-only laddering) never touch it.
        const needSizes = liveFillIds != null && positions.some(p =>
          p.underlying === underlying && p.sellQty > 0 && p.sellLeg?.exitOrderId != null
          && liveFillIds.has(String(p.sellLeg.exitOrderId)));
        if (needSizes) {
          // null = fetch failed → leave liveSizeBySymbol null so the short branch holds
          // rather than inferring a full close from a missing snapshot.
          const livePos = await live.positions();
          if (livePos != null) {
            liveSizeBySymbol = {};
            for (const p of livePos) liveSizeBySymbol[p.product_symbol] = Number(p.size) || 0;
          }
        }
      }

      // Shared ATM-ratio scale-down. Used by BOTH the engine-active model (paper /
      // dry-run) and the armed-REAL resting model, so the live path scales identically
      // to paper. Reduces the long (buy) leg in 10% steps when the live ATM ratio has
      // risen and gross PnL clears the checkpoint threshold; books each slice as a
      // partial trade_history row and fires a reduce_only SELL to Delta when armed.
      // Full spreads only. Closes over atmStrike / getTickerPrice / spotPrice.
      async function applyAtmRatioScaling(pos, { liveExitBuy, liveExitSell, tickerBuy }) {
        // Dynamic ATM ratio-based scaling (full spreads only — skipped once long-only)
        if (atmStrike !== null && pos.sellQty > 0) {
          // Initialize missing fields for older positions
          if (pos.buyLeg && (pos.buyLeg.originalLotSize === undefined || pos.buyLeg.originalSellQty === undefined || pos.buyLeg.initialScaledLotSize === undefined)) {
            pos.buyLeg.originalLotSize = pos.buyLeg.originalLotSize ?? (pos.buyLeg.lotSize || 1);
            pos.buyLeg.originalSellQty = pos.buyLeg.originalSellQty ?? (pos.sellQty || 0);
            if (pos.buyLeg.initialScaledLotSize === undefined) {
              const origLot = pos.buyLeg.originalLotSize;
              const origSell = pos.buyLeg.originalSellQty;
              if (origSell > 0 && pos.sellQty > 0) {
                pos.buyLeg.initialScaledLotSize = Number((pos.sellQty * (origLot / origSell)).toFixed(2));
              } else {
                pos.buyLeg.initialScaledLotSize = pos.buyLeg.lotSize || origLot;
              }
            }
            try {
              await supabase.from('active_positions').update({
                buy_leg: JSON.stringify(pos.buyLeg)
              }).eq('id', pos.id);
            } catch (e) {
              logError(`Failed to initialize originalLotSize/originalSellQty/initialScaledLotSize for position ${pos.id}:`, e);
            }
          }

          const buyIntrinsic = getTickerPrice(atmStrike, pos.type, 'bid', pos.expiry);
          const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, pos.type, 'ask', pos.expiry);

          if (pos.buyLeg && pos.buyLeg.originalLotSize !== undefined && buyIntrinsic != null && sellIntrinsic != null && sellIntrinsic > 0) {
            const liveAtmRatio = parseFloat((Math.round((buyIntrinsic / sellIntrinsic) / 0.25) * 0.25).toFixed(2));
            const originalLotSize = pos.buyLeg.originalLotSize || pos.buyLeg.lotSize || 1;
            const initialScaledLotSize = pos.buyLeg.initialScaledLotSize !== undefined
              ? pos.buyLeg.initialScaledLotSize
              : (pos.buyLeg.originalSellQty && pos.buyLeg.originalSellQty > 0
                ? Number((pos.sellQty * (originalLotSize / pos.buyLeg.originalSellQty)).toFixed(2))
                : originalLotSize);
            const deltaBuyQty = Number((initialScaledLotSize * 0.10).toFixed(2));
            const floorLimit = Number((initialScaledLotSize * 0.5).toFixed(2));
            let currentLotSize = pos.buyLeg.lotSize;
            let hypotheticalLotSize = Number((currentLotSize - deltaBuyQty).toFixed(2));
            const shortCV = pos.sellLeg?.contractValue ?? pos.buyLeg?.contractValue ?? null;
            const shortExposure = shortCV != null ? (pos.sellQty * shortCV) : pos.sellQty;
            let recalculatedRatio = hypotheticalLotSize > 0
              ? Number((shortExposure / hypotheticalLotSize).toFixed(2))
              : Infinity;
            let entryFee = pos.entryFee || 0;
            let hasScaled = false;
            let partialExitsToRecord = [];

            const buyPriceDiff = (liveExitBuy != null && pos.entryBuyPrice != null) ? (liveExitBuy - pos.entryBuyPrice) : 0;
            const sellPriceDiff = (liveExitSell != null && pos.entrySellPrice != null) ? (pos.entrySellPrice - liveExitSell) : 0;

            // NOTE: DB column is "accumulated_sell_pnl" but it actually tracks accumulated BUY leg partial exit PnL
            let accumulatedPartialBuyPnl = pos.accumulatedSellPnl || 0;

            let currentGrossPnl = (buyPriceDiff * currentLotSize)
              + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
              + accumulatedPartialBuyPnl;

            // ATM PnL: buy side scales with lotSize, sell side is fixed (sellQty unchanged in partial exits)
            const atmBuyPnlPerLot = buyIntrinsic - pos.entryBuyPrice;
            const atmSellPnlTotal = (pos.entrySellPrice - sellIntrinsic) * pos.sellQty * (pos.sellLeg.lotSize || 1);

            let checkpointPnl = pos.buyLeg.lastCheckpointPnl !== undefined
              ? pos.buyLeg.lastCheckpointPnl
              : (pos.entrySellPrice * pos.sellQty * (pos.sellLeg.lotSize || 1))
              - (pos.entryBuyPrice * currentLotSize);

            let checkpointAtmPnl = pos.buyLeg.lastCheckpointAtmPnl !== undefined
              ? pos.buyLeg.lastCheckpointAtmPnl
              : (atmBuyPnlPerLot * currentLotSize) + atmSellPnlTotal;

            let threshold = (checkpointAtmPnl * 0.10) + checkpointPnl;

            while (
              currentGrossPnl >= threshold &&
              hypotheticalLotSize >= floorLimit &&
              liveAtmRatio >= recalculatedRatio + 1
            ) {
              log(`[${accountState.name}]: ⚖️ SCALING: Position ${pos.id} (${pos.type.toUpperCase()}) - PnL: $${currentGrossPnl.toFixed(2)} >= Threshold: $${threshold.toFixed(2)}. ATM ratio (1:x) increased: Recalculated Ratio ${recalculatedRatio.toFixed(2)} <= Live ${liveAtmRatio} - 1. Reducing buy lot size from ${currentLotSize} to ${hypotheticalLotSize}.`);

              const partialGrossPnl = buyPriceDiff * deltaBuyQty;

              // Exact entry fee of the buy leg portion being exited
              const partialEntryFee = Math.min(entryFee, calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1));
              const partialExitFee = calculateFee(liveExitBuy, spotPrice, deltaBuyQty, pos.buyLeg.originalLotSize || 1);
              const partialTotalFees = partialEntryFee + partialExitFee;
              const partialNetPnl = partialGrossPnl - partialTotalFees;

              accumulatedPartialBuyPnl += partialGrossPnl;

              // Deterministic, lifetime-unique key: lots-remaining after this step
              // strictly decreases across the position's life, so it never collides
              // across cycles AND is identical if two evaluators race the same step —
              // letting the trade_id UNIQUE constraint reject the duplicate.
              const partialTradeId = `${pos.id}-PE-${hypotheticalLotSize.toFixed(2)}`;

              const historyBuyLeg = {
                ...pos.buyLeg,
                lotSize: deltaBuyQty,
                exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null,
                exitBuyAtmPrice: buyIntrinsic,
                exitSellAtmPrice: sellIntrinsic,
                exitAtmRatio: liveAtmRatio
              };

              // FIX B5: remainingGrossPnl double count fix
              const remainingGrossPnl = (buyPriceDiff * hypotheticalLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + (accumulatedPartialBuyPnl - partialGrossPnl);

              const remainingExitFee = calculateFee(liveExitBuy, spotPrice, hypotheticalLotSize, pos.buyLeg.originalLotSize || 1)
                + calculateFee(liveExitSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize || 1);
              const remainingEntryFee = Math.max(0, entryFee - partialEntryFee);
              const remainingNetPnl = remainingGrossPnl - (remainingEntryFee + remainingExitFee);

              const originalSellQty = pos.buyLeg.originalSellQty || pos.sellQty || 0;
              const entryNetPremium = (pos.entrySellPrice * originalSellQty * (pos.sellLeg.lotSize || 1))
                - (pos.entryBuyPrice * originalLotSize);
              const entryPremiumType = entryNetPremium >= 0 ? 'Credit' : 'Debit';
              const entryPremiumVal = Math.abs(entryNetPremium);

              // Compute next threshold using post-update values (after lot size reduction)
              const postAtmPnl = (atmBuyPnlPerLot * hypotheticalLotSize) + atmSellPnlTotal;
              const postGrossPnl = (buyPriceDiff * hypotheticalLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + accumulatedPartialBuyPnl;
              const nextThreshold = (postAtmPnl * 0.10) + postGrossPnl;
              const partialExitReason = [
                `Partial Exit`,
                `Current Gross PnL: $${currentGrossPnl.toFixed(2)}`,
                `Threshold Met: $${threshold.toFixed(2)}`,
                `Checkpoint PnL: $${checkpointPnl.toFixed(2)}`,
                `Checkpoint ATM PnL: $${checkpointAtmPnl.toFixed(2)}`,
                `ATM step (10%): $${(checkpointAtmPnl * 0.10).toFixed(2)}`,
                `Next threshold: $${nextThreshold.toFixed(2)}`,
                `Live ATM Ratio: ${liveAtmRatio.toFixed(2)}`,
                `Recalculated Ratio: ${recalculatedRatio.toFixed(2)}`,
                `Lots remaining: ${hypotheticalLotSize.toFixed(2)}`,
                `Net ${entryPremiumType} at Entry: $${entryPremiumVal.toFixed(2)}`
              ].join(' | ');

              partialExitsToRecord.push({
                trade_id: partialTradeId,
                underlying: pos.underlying,
                expiry: pos.expiry,
                type: pos.type,
                buy_leg: JSON.stringify(historyBuyLeg),
                sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
                sell_qty: 0,
                strike_diff: pos.strikeDiff,
                entry_time: pos.entryTime.toISOString(),
                entry_buy_price: pos.entryBuyPrice,
                entry_sell_price: pos.entrySellPrice,
                entry_spot_price: pos.entrySpotPrice,
                margin: pos.margin,
                exit_time: new Date().toISOString(),
                exit_buy_price: liveExitBuy,
                exit_sell_price: liveExitSell,
                exit_spot_price: spotPrice,
                realized_gross_pnl: partialGrossPnl,
                realized_net_pnl: partialNetPnl,
                exit_fee: partialExitFee,
                total_fees: partialTotalFees,
                exit_reason: partialExitReason,
                is_partial: true,
                account_id: accountState.id
              });

              entryFee = Math.max(0, entryFee - partialEntryFee);

              // FIX B3: save checkpoint AFTER lot size reduction
              currentLotSize = hypotheticalLotSize;

              currentGrossPnl = (buyPriceDiff * currentLotSize)
                + (sellPriceDiff * pos.sellQty * (pos.sellLeg.lotSize || 1))
                + accumulatedPartialBuyPnl;

              checkpointPnl = currentGrossPnl;
              pos.buyLeg.lastCheckpointPnl = checkpointPnl;

              // Recalculate ATM PnL: buy scales with reduced lot size, sell stays fixed
              checkpointAtmPnl = (atmBuyPnlPerLot * currentLotSize) + atmSellPnlTotal;
              pos.buyLeg.lastCheckpointAtmPnl = checkpointAtmPnl;

              threshold = (checkpointAtmPnl * 0.10) + checkpointPnl;

              pos.buyLeg.maxAtmRatio = recalculatedRatio;

              hasScaled = true;

              hypotheticalLotSize = Number((currentLotSize - deltaBuyQty).toFixed(2));
              recalculatedRatio = hypotheticalLotSize > 0
                ? Number((shortExposure / hypotheticalLotSize).toFixed(2))
                : Infinity;
            }

            if (hasScaled) {
              pos.entryFee = entryFee;
              pos.buyLeg.lotSize = currentLotSize;
              pos.accumulatedSellPnl = accumulatedPartialBuyPnl; // DB column name is misleading; tracks buy leg partial PnL

              // Correct-basis margin: live positions (buyLeg.contractValue set) use the
              // contract-value basis like entry; paper positions (contractValue null) keep
              // the notional lotSize basis unchanged. Gated on the position's OWN stored
              // contractValue — NOT symbolMeta — so paper accounts are byte-for-byte the same.
              pos.margin = contractBasisMargin(pos, pos.buyLeg.contractValue ?? null);

              // LIVE: sell the reduced buy-leg lot (reduce_only) at the current bid.
              // Delta trades WHOLE contracts, so size the order by the change in the
              // ROUNDED contract count — round(lotBefore) − round(lotAfter) — NOT by
              // independently rounding this cycle's fractional 10% chunk. Independent
              // rounding forced a minimum of 1 contract every cycle, which over-closed
              // small positions (a 10% step on a 3-contract position sold a whole
              // contract = 33%) and drifted the engine out of sync with the exchange.
              // Tracking the rounded count keeps the exchange position exactly equal to
              // round(lotSize / base): sub-contract 10% steps accumulate over cycles
              // (the fractional bookkeeping above advances like paper) and a whole
              // contract is sold only when the rounded count actually drops. When it
              // doesn't drop this cycle, no order is sent. (No-op for paper — unarmed.)
              const totalReducedLot = partialExitsToRecord.length * deltaBuyQty;
              const exitBase = pos.buyLeg.originalLotSize || pos.buyLeg.lotSize || 1;
              const lotBefore = pos.buyLeg.lotSize + totalReducedLot; // pre-reduction lot this cycle
              const contractsToSell = Math.max(0,
                Math.round(lotBefore / exitBase) - Math.round(pos.buyLeg.lotSize / exitBase));
              if (contractsToSell >= 1) {
                await live.closeLeg({
                  symbol: pos.buyLeg.symbol, side: 'sell',
                  contracts: contractsToSell,
                  price: liveExitBuy, tag: `${pos.id}-PEX-${pos.buyLeg.lotSize}`,
                });
                const batchNet = partialExitsToRecord.reduce((s, r) => s + (r.realized_net_pnl || 0), 0);
                notifyTrade({ title: '🔻 PARTIAL SCALE-DOWN', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike} · sold ${contractsToSell} contract(s) · remaining lot ${pos.buyLeg.lotSize}`, pnl: batchNet });
              }

              // FIX B6: batched insert
              try {
                await supabase.from('trade_history').upsert(partialExitsToRecord, { onConflict: 'trade_id', ignoreDuplicates: true });
                log(`📤 PARTIAL EXITS RECORDED: ${pos.id} | ${partialExitsToRecord.length} exits | Total reduced: ${partialExitsToRecord.length * deltaBuyQty} lots`);
              } catch (e) {
                logError(`Failed to insert partial exit history for position ${pos.id}:`, e);
              }

              try {
                await supabase.from('active_positions').update({
                  buy_leg: JSON.stringify(pos.buyLeg),
                  entry_fee: pos.entryFee,
                  margin: pos.margin,
                  accumulated_sell_pnl: pos.accumulatedSellPnl
                }).eq('id', pos.id);
              } catch (e) {
                logError(`Failed to update scaled position ${pos.id} in DB:`, e);
              }
            }
          }
        }
      }

      // Normalise any legacy PAPER-basis live positions to the contract-value basis
      // BEFORE exits are evaluated, so THIS cycle books PnL on the correct basis (not
      // ~1/contractValue inflated). One-time per position (idempotent via contractValue),
      // so it's a cheap no-op once converted; runs every cycle incl. onlyExits.
      if (accountState.mode === 'live' && accountState.live_enabled) {
        for (const pos of positions) {
          if (pos.underlying === underlying) await normalizeLiveBasis(pos);
        }
      }

      // Sort worst-first (farthest from ATM)
      const sortedPositions = [...positions].sort((a, b) => {
        const distA = Math.abs(a.buyLeg.strike - spotPrice);
        const distB = Math.abs(b.buyLeg.strike - spotPrice);
        return distB - distA;
      });

      // ── 1. Exit evaluation ──────────────────────────────────────────────
      for (const pos of sortedPositions) {
        if (pos.underlying !== underlying) {
          remaining.push(pos);
          continue;
        }

        // Hedge overlays (long-only) have their OWN exit — they drain proportionally as
        // the main book exits (processHedgeOverlays below), so the normal short-buyback /
        // ladder / ATM-ITM-OTM / expiry rules don't apply. Keep them in `remaining` here.
        if (pos.buyLeg?.isHedge) { remaining.push(pos); continue; }

        // Armed REAL live → resting-order exit model (isolated from the active model).
        if (liveResting) {
          if (liveFillIds == null) { remaining.push(pos); continue; } // fills fetch failed → hold
          // liveSizeBySymbol may be null when no size check was needed this cycle; the
          // handler's short branch only consults it once a buy-back has begun filling.
          // applyAtmRatioScaling is passed in so the resting model can scale the long
          // leg identically to the active model (it closes over atmStrike/getTickerPrice).
          await handleLiveRestingExit(pos, remaining, liveFillIds, liveSizeBySymbol, effectiveConfig, applyAtmRatioScaling);
          continue;
        }

        // Data gap guard
        const tickerBuy = tickerData[pos.buyLeg.symbol];
        const tickerSell = tickerData[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice;

        // Long-only positions (short already exited) only need the long's price.
        if (liveExitBuy == null || (pos.sellQty > 0 && liveExitSell == null)) {
          remaining.push(pos);
          continue;
        }

        // ── Short-leg-only exit ────────────────────────────────────────────
        // When the short leg's live ASK reaches less than the configured shortExitPrice (default 1.1),
        // buy it back (close the short at the ask) and keep holding the long leg. The long leg is
        // then closed later by the normal expiry / ATM-ITM-OTM exit rules.
        // the short leg will not be closed that cycle.
        const shortLiveAsk = tickerSell?.ask ?? null;
        const targetShortExitPrice = config.shortExitPrice ?? 1.1;
        if (pos.sellQty > 0 && shortLiveAsk <= targetShortExitPrice) {
          const shortLotSize = pos.sellLeg.lotSize || 1;
          const exitShortPrice = liveExitSell; // ask (<= targetShortExitPrice)

          const shortGrossPnl = (pos.entrySellPrice - exitShortPrice) * pos.sellQty * shortLotSize;
          const shortEntryFee = Math.min(
            pos.entryFee || 0,
            calculateFee(pos.entrySellPrice, pos.entrySpotPrice, pos.sellQty, shortLotSize)
          );
          const shortExitFee = calculateFee(exitShortPrice, spotPrice, pos.sellQty, shortLotSize);
          const shortTotalFees = shortEntryFee + shortExitFee;
          const shortNetPnl = shortGrossPnl - shortTotalFees;

          const shortExitReason = `Short Leg Exit @ Ask $${exitShortPrice.toFixed(2)} (holding long ${pos.buyLeg.strike})`;
          const shortTradeId = `${pos.id}-SE`;

          // Record the short-leg close as a partial trade_history row. Deterministic
          // trade_id + idempotent upsert so a duplicate evaluator can't double-book.
          try {
            await supabase.from('trade_history').upsert([{
              trade_id: shortTradeId,
              underlying: pos.underlying,
              expiry: pos.expiry,
              type: pos.type,
              buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: 0 }),
              sell_leg: JSON.stringify({ ...pos.sellLeg, exitIv: tickerSell?.askIv ?? tickerSell?.iv ?? null }),
              sell_qty: pos.sellQty,
              strike_diff: pos.strikeDiff,
              entry_time: pos.entryTime.toISOString(),
              entry_buy_price: pos.entryBuyPrice,
              entry_sell_price: pos.entrySellPrice,
              entry_spot_price: pos.entrySpotPrice,
              margin: pos.margin,
              exit_time: new Date().toISOString(),
              exit_buy_price: liveExitBuy,
              exit_sell_price: exitShortPrice,
              exit_spot_price: spotPrice,
              realized_gross_pnl: shortGrossPnl,
              realized_net_pnl: shortNetPnl,
              exit_fee: shortExitFee,
              total_fees: shortTotalFees,
              exit_reason: shortExitReason,
              is_partial: true,
              account_id: accountState.id,
            }], { onConflict: 'trade_id', ignoreDuplicates: true });
          } catch (e) {
            logError(`Failed to record short-leg exit for position ${pos.id}:`, e);
          }

          // LIVE: buy back the short leg to close it (reduce_only).
          await live.closeLeg({
            symbol: pos.sellLeg.symbol, side: 'buy',
            contracts: shortContracts(pos.sellQty),
            price: exitShortPrice, tag: `${pos.id}-SEX`,
          });

          // Convert the position to long-only: drop the short leg, recompute margin.
          // Snapshot the long lot (base for the 10-slice laddered exit) and build 10
          // equidistant exit levels spanning the long's current bid up to its entry price.
          const longBidAtExit = liveExitBuy; // long leg's live bid (the realistic sell price)
          const generatedLevels = await getOrBuildLongExitLevels(longBidAtExit, pos, config);

          pos.entryFee = Math.max(0, (pos.entryFee || 0) - shortEntryFee);
          pos.sellLeg = { ...pos.sellLeg, lotSize: 0 };
          pos.sellQty = 0;
          pos.buyLeg = {
            ...pos.buyLeg,
            longExitBaseLot: pos.buyLeg.lotSize,
            longExitStage: 0,
            longExitLevels: generatedLevels,
          };
          pos.margin = longOnlyMargin(pos);
          log(`[${accountState.name}] 🎚️ Long ladder set: ${pos.buyLeg.strike} | bid at exit: ${longBidAtExit} | config variable: ${config.variableExitSlices} | levels ${JSON.stringify(pos.buyLeg.longExitLevels)}`);

          try {
            await supabase.from('active_positions').update({
              buy_leg: JSON.stringify(pos.buyLeg),
              sell_leg: JSON.stringify(pos.sellLeg),
              sell_qty: 0,
              entry_fee: pos.entryFee,
              margin: pos.margin,
            }).eq('id', pos.id);
          } catch (e) {
            logError(`Failed to persist short-leg exit for position ${pos.id}:`, e);
          }

          log(`[${accountState.name}] ✂️ SHORT EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike}/${pos.sellLeg.strike} | Short bought back @ $${exitShortPrice} | PnL: $${shortNetPnl.toFixed(2)} | Holding long ${pos.buyLeg.strike}`);

          remaining.push(pos);
          continue;
        }

        // ── Long-only laddered profit exit ──────────────────────────────────
        // Once the short leg is gone, scale the held long out in slices as its
        // own BID recovers toward entry. At short-exit we placed equidistant
        // exit levels spanning [current bid, entry price]; each crossed level exits
        // a slice of the base lot. Trigger and exit price are both the live bid.
        if (pos.sellQty === 0) {
          const longBid = liveExitBuy; // long leg's live bid (the price we can sell at)

          // Base lot + equidistant exit levels are set at short-exit; fall back for older rows.
          if (pos.buyLeg.longExitBaseLot === undefined) {
            pos.buyLeg.longExitBaseLot = pos.buyLeg.lotSize || 0;
            pos.buyLeg.longExitStage = pos.buyLeg.longExitStage || 0;
          }
          if (!Array.isArray(pos.buyLeg.longExitLevels) || pos.buyLeg.longExitLevels.length === 0) {
            pos.buyLeg.longExitLevels = await getOrBuildLongExitLevels(longBid, pos, config);
          }
          const exitLevels = pos.buyLeg.longExitLevels;
          const baseLot = pos.buyLeg.longExitBaseLot || 0;
          const sliceLot = Number((baseLot / exitLevels.length).toFixed(2));
          let stage = pos.buyLeg.longExitStage || 0;

          if (longBid != null && baseLot > 0 && sliceLot > 0 && pos.entryBuyPrice > 0) {
            const longExitSlices = [];
            let cycleExitLot = 0; // total long lot closed this cycle (for the live order)
            const exitPrice = liveExitBuy; // close long by selling at the bid

            // Exit one slice per newly-crossed level (bid may cross several at once).
            while (stage < exitLevels.length && longBid >= exitLevels[stage]) {
              const isLast = (stage === exitLevels.length - 1);
              // Final checkpoint clears any rounding remainder.
              const exitLot = isLast
                ? Number(pos.buyLeg.lotSize.toFixed(2))
                : Math.min(sliceLot, Number(pos.buyLeg.lotSize.toFixed(2)));
              if (exitLot <= 0) { stage++; continue; }

              const sliceGrossPnl = (exitPrice - pos.entryBuyPrice) * exitLot;
              const sliceEntryFee = Math.min(
                pos.entryFee || 0,
                calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, exitLot, pos.buyLeg.originalLotSize || 1)
              );
              const sliceExitFee = calculateFee(exitPrice, spotPrice, exitLot, pos.buyLeg.originalLotSize || 1);
              const sliceTotalFees = sliceEntryFee + sliceExitFee;
              const sliceNetPnl = sliceGrossPnl - sliceTotalFees;

              longExitSlices.push({
                trade_id: `${pos.id}-LE-${stage}`,
                underlying: pos.underlying,
                expiry: pos.expiry,
                type: pos.type,
                buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: exitLot, exitIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? null }),
                sell_leg: JSON.stringify({ ...pos.sellLeg, lotSize: 0 }),
                sell_qty: 0,
                strike_diff: pos.strikeDiff,
                entry_time: pos.entryTime.toISOString(),
                entry_buy_price: pos.entryBuyPrice,
                entry_sell_price: pos.entrySellPrice,
                entry_spot_price: pos.entrySpotPrice,
                margin: pos.margin,
                exit_time: new Date().toISOString(),
                exit_buy_price: exitPrice,
                exit_sell_price: null,
                exit_spot_price: spotPrice,
                realized_gross_pnl: sliceGrossPnl,
                realized_net_pnl: sliceNetPnl,
                exit_fee: sliceExitFee,
                total_fees: sliceTotalFees,
                exit_reason: `Long Leg Exit @ level $${exitLevels[stage]} (Bid $${longBid})`,
                is_partial: true,
                account_id: accountState.id,
              });

              pos.entryFee = Math.max(0, (pos.entryFee || 0) - sliceEntryFee);
              pos.buyLeg.lotSize = Number((pos.buyLeg.lotSize - exitLot).toFixed(2));
              cycleExitLot += exitLot;
              stage++;
            }

            if (longExitSlices.length > 0) {
              pos.buyLeg.longExitStage = stage;

              // LIVE: sell the closed long lot (reduce_only) at the bid. Delta trades WHOLE
              // contracts, so size by the change in the ROUNDED contract count this cycle —
              // round(lotBefore/base) − round(lotAfter/base) — NOT by rounding this cycle's
              // fractional slice(s) independently. `longContracts(cycleExitLot)` has a
              // Math.max(1,…) floor that sold a whole contract for every sub-contract slice
              // (e.g. a 10-slice ladder on a 5-contract position = 0.5 contract/slice → 1
              // contract each → 10 sold vs 5 held → over-close + `no_position_for_reduce_only`
              // on the drift). Same rounded-count basis the partial scale-down uses; the
              // fractional book advances every cycle and a contract is sent only when the
              // rounded count actually drops (no order when it doesn't). No-op for paper.
              const exitBase = pos.buyLeg.originalLotSize || pos.buyLeg.lotSize || 1;
              const lotBefore = Number((pos.buyLeg.lotSize + cycleExitLot).toFixed(4));
              const contractsToSell = Math.max(0,
                Math.round(lotBefore / exitBase) - Math.round(pos.buyLeg.lotSize / exitBase));
              if (contractsToSell >= 1) {
                await live.closeLeg({
                  symbol: pos.buyLeg.symbol, side: 'sell',
                  contracts: contractsToSell,
                  price: exitPrice, tag: `${pos.id}-LEX-${stage}`,
                });
              }

              try {
                await supabase.from('trade_history').upsert(longExitSlices, { onConflict: 'trade_id', ignoreDuplicates: true });
              } catch (e) {
                logError(`Failed to record long-leg laddered exits for position ${pos.id}:`, e);
              }

              const fullyExited = stage >= exitLevels.length || pos.buyLeg.lotSize <= 0;
              if (fullyExited) {
                try {
                  await supabase.from('active_positions').delete().eq('id', pos.id);
                } catch (e) {
                  logError(`Failed to delete fully-laddered long position ${pos.id}:`, e);
                }
                log(`[${accountState.name}] 🪜 LONG FULLY EXITED: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${longExitSlices.length} slice(s) | Bid $${longBid}`);
                continue;
              }

              pos.margin = longOnlyMargin(pos);
              try {
                await supabase.from('active_positions').update({
                  buy_leg: JSON.stringify(pos.buyLeg),
                  entry_fee: pos.entryFee,
                  margin: pos.margin,
                }).eq('id', pos.id);
              } catch (e) {
                logError(`Failed to persist long-leg laddered exit for position ${pos.id}:`, e);
              }
              log(`[${accountState.name}] 🪜 LONG SLICE EXIT: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} | ${longExitSlices.length} slice(s) | remaining lot ${pos.buyLeg.lotSize} | stage ${stage}/5`);
            }
          }
          // remaining long lot (if any) still falls through to expiry / ATM-ITM-OTM exit below
        }

        // Dynamic ATM ratio-based scaling (shared helper — also runs in the armed-live resting model)
        await applyAtmRatioScaling(pos, { liveExitBuy, liveExitSell, tickerBuy });

        const latestBuy = liveExitBuy;
        const latestSell = liveExitSell;
        const latestBuyIv = tickerBuy?.bidIv ?? tickerBuy?.iv ?? null;
        const latestSellIv = tickerSell?.askIv ?? tickerSell?.iv ?? null;

        let shouldExit = false;
        let exitReason = '';
        let zombieExitTime = null;

        // Priority 2: Expiry settlement (2 min early)
        const expiryTs = new Date(pos.expiry).getTime();
        if (Date.now() >= expiryTs - 120000) {
          shouldExit = true;
          exitReason = 'Expiry Reached (2min Early)';
          if (Date.now() > expiryTs + 600000) {
            zombieExitTime = new Date(expiryTs).toISOString();
          }
        }

        // PnL calculations (for remaining lots only; partial exit PnL stored separately in trade_history with is_partial=true)
        const buyPriceDiff = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
        const sellPriceDiff = (latestSell != null && pos.entrySellPrice != null) ? (pos.entrySellPrice - latestSell) : 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) + (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize);
        const exitFee = calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) +
          calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        // Priority 3: Dynamic ATM/ITM/OTM exit
        if (!shouldExit) {
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          // Active-window exit rule (effectiveConfig), so open positions follow the
          // window that is live right now — not the account default.
          const exitType = effectiveConfig.exitType || 'ATM';
          const exitPoints = Math.abs(effectiveConfig.exitPoints || 0);

          let isExitMet = false;
          let reasonSuffix = '';

          // ITM/OTM direction reversed per the account's exit convention:
          // ITM = buyStrike − pts (call) / + pts (put); OTM = buyStrike + pts (call) / − pts (put).
          if (exitType === 'ITM') {
            isExitMet = isCall ? (spotPrice >= buyStrike - exitPoints) : (spotPrice <= buyStrike + exitPoints);
            reasonSuffix = ` @ ITM (${isCall ? '-' : '+'}${exitPoints}pts)`;
          } else if (exitType === 'OTM') {
            isExitMet = isCall ? (spotPrice >= buyStrike + exitPoints) : (spotPrice <= buyStrike - exitPoints);
            reasonSuffix = ` @ OTM (${isCall ? '+' : '-'}${exitPoints}pts)`;
          } else { // ATM
            isExitMet = isCall ? (spotPrice >= buyStrike) : (spotPrice <= buyStrike);
            reasonSuffix = ' @ ATM';
          }

          if (isExitMet) {
            shouldExit = true;
            exitReason = `Full Exit${reasonSuffix}`;
          }
        }

        if (shouldExit) {
          const finalGrossPnl = grossPnl;
          const finalExitFee = exitFee;
          const finalEntryFee = pos.entryFee || 0;
          const finalTotalFees = totalFees;
          const finalNetPnl = grossPnl - totalFees;
          const finalSellQty = pos.sellQty;
          const finalSellLeg = { ...pos.sellLeg, exitIv: latestSellIv };

          let exitBuyAtmPrice = null;
          let exitSellAtmPrice = null;
          let exitAtmRatio = null;
          if (atmStrike !== null) {
            exitBuyAtmPrice = getTickerPrice(atmStrike, pos.type, 'bid', pos.expiry);
            const targetSellStrike = pos.type === 'call' ? atmStrike + pos.strikeDiff : atmStrike - pos.strikeDiff;
            exitSellAtmPrice = getTickerPrice(targetSellStrike, pos.type, 'ask', pos.expiry);
            if (exitBuyAtmPrice != null && exitSellAtmPrice != null && exitSellAtmPrice > 0) {
              exitAtmRatio = parseFloat((Math.round((exitBuyAtmPrice / exitSellAtmPrice) / 0.25) * 0.25).toFixed(2));
            }
          }

          const tradeRecord = {
            ...pos,
            id: pos.id,
            sellQty: finalSellQty,
            buyLeg: {
              ...pos.buyLeg,
              exitIv: latestBuyIv,
              exitBuyAtmPrice,
              exitSellAtmPrice,
              exitAtmRatio
            },
            sellLeg: finalSellLeg,
            _exitedBuyQty: pos.buyLeg.lotSize,
            exitTime: new Date(),
            exitBuyPrice: latestBuy,
            exitSellPrice: latestSell,
            exitSpotPrice: spotPrice,
            realizedGrossPnl: finalGrossPnl,
            realizedNetPnl: finalNetPnl,
            entryFee: finalEntryFee,
            exitFee: finalExitFee,
            totalFees: finalTotalFees,
            exitReason,
            _latestBuy: latestBuy,
            _latestSell: latestSell,
            _isPartial: false,
            zombieExitTime,
          };
          exited.push(tradeRecord);
        } else {
          remaining.push(pos);
        }
      }

      // ── 1b. Hedge overlay drain ─────────────────────────────────────────
      // Long-only hedge overlays exit proportionally as the main book of that type
      // exits: with N = same-type open long positions at overlay entry, target lot =
      // buyQty × (open same-type main longs now / N). Each full exit of a main position
      // therefore sells one 1/N slice; when all have exited the overlay is fully closed.
      // Runs every cycle (incl. onlyExits). Sells at the long bid; books like a partial.
      for (const pos of remaining.filter(p => p.underlying === underlying && p.buyLeg?.isHedge)) {
        const N = Math.max(1, pos.buyLeg.hedgeN || 1);
        const buyQty = pos.buyLeg.hedgeBuyQty || pos.buyLeg.lotSize || 0;
        const openLongs = remaining.filter(p => p.underlying === underlying && p.type === pos.type && !p.buyLeg?.isHedge).length;
        const targetQty = Math.max(0, Math.min(buyQty, buyQty * (openLongs / N)));
        const currentQty = pos.buyLeg.lotSize || 0;
        const sellQty = Number((currentQty - targetQty).toFixed(4));
        if (sellQty <= 0.0001) continue; // no drain needed this cycle

        const tHedge = tickerData[pos.buyLeg.symbol];
        const exitPx = tHedge?.bid ?? tHedge?.lastPrice ?? tHedge?.markPrice;
        if (exitPx == null) continue; // no quote — hold

        const base = pos.buyLeg.originalLotSize || 1;
        const gross = (exitPx - pos.entryBuyPrice) * sellQty;
        const entryFeePortion = Math.min(pos.entryFee || 0, calculateFee(pos.entryBuyPrice, pos.entrySpotPrice, sellQty, base));
        const exitFee = calculateFee(exitPx, spotPrice, sellQty, base);
        const net = gross - (entryFeePortion + exitFee);
        const newLot = Number((currentQty - sellQty).toFixed(4));
        const fullyClosed = newLot <= 0.0001;
        lastDbWrite = Date.now();

        // LIVE (armed): reduce-only sell the drained contracts (no-op for paper/unarmed).
        // Size by the change in the ROUNDED contract count — round(before/base) −
        // round(after/base) — like the partial scale-down and long ladder. Entry bought
        // round(buyQty) whole contracts, but each drain slice is a fractional buyQty/N, so
        // `longContracts(sellQty)` (Math.max(1,…)) sold a whole contract for every
        // sub-contract slice → over-drained the overlay and drifted vs the exchange. The
        // rounded-count delta keeps Delta == round(lot/base) and telescopes to exactly what
        // entry bought; no order is sent on a cycle where the rounded count doesn't drop.
        if (accountState.mode === 'live' && accountState.live_enabled) {
          const contractsToSell = Math.max(0,
            Math.round(currentQty / base) - Math.round(newLot / base));
          if (contractsToSell >= 1) {
            await live.closeLeg({ symbol: pos.buyLeg.symbol, side: 'sell', contracts: contractsToSell, price: exitPx, tag: `${pos.id}-HDX` });
          }
        }
        try {
          await supabase.from('trade_history').upsert([{
            trade_id: fullyClosed ? pos.id : `${pos.id}-HD-${Date.now().toString(36).toUpperCase()}`,
            underlying: pos.underlying, expiry: pos.expiry, type: pos.type,
            buy_leg: JSON.stringify({ ...pos.buyLeg, lotSize: sellQty }),
            sell_leg: JSON.stringify({ lotSize: 0 }),
            sell_qty: 0, strike_diff: 0,
            entry_time: pos.entryTime.toISOString(),
            entry_buy_price: pos.entryBuyPrice, entry_sell_price: 0, entry_spot_price: pos.entrySpotPrice,
            margin: pos.margin, exit_time: new Date().toISOString(),
            exit_buy_price: exitPx, exit_sell_price: null, exit_spot_price: spotPrice,
            realized_gross_pnl: gross, realized_net_pnl: net, exit_fee: exitFee, total_fees: entryFeePortion + exitFee,
            exit_reason: `Hedge Drain (${openLongs}/${N} longs open)`, is_partial: !fullyClosed, account_id: accountState.id,
          }], { onConflict: 'trade_id', ignoreDuplicates: true });
          if (fullyClosed) {
            await supabase.from('active_positions').delete().eq('id', pos.id);
            const idx = remaining.indexOf(pos);
            if (idx >= 0) remaining.splice(idx, 1);
          } else {
            pos.buyLeg = { ...pos.buyLeg, lotSize: newLot };
            pos.entryFee = Math.max(0, (pos.entryFee || 0) - entryFeePortion);
            pos.margin = longOnlyMargin(pos);
            await supabase.from('active_positions').update({
              buy_leg: JSON.stringify(pos.buyLeg), entry_fee: pos.entryFee, margin: pos.margin,
            }).eq('id', pos.id);
          }
        } catch (e) { logError(`[${accountState.name}] Hedge drain booking failed for ${pos.id}:`, e); }
        log(`[${accountState.name}] 🛡️ HEDGE ${fullyClosed ? 'CLOSED' : 'DRAIN'}: ${pos.type.toUpperCase()} ${pos.buyLeg.strike} · sold ${sellQty} · ${openLongs}/${N} longs open · remaining ${newLot} · PnL $${net.toFixed(2)}`);
        notifyTrade({ title: fullyClosed ? '🛡️ HEDGE CLOSED' : '🛡️ HEDGE DRAIN', detail: `${pos.type.toUpperCase()} ${pos.buyLeg.strike} · sold ${sellQty} · ${openLongs}/${N} longs open · remaining ${newLot}`, pnl: net });
      }

      // ── 2. Open new positions (entries) ─────────────────────────────────
      const newEntries = [];

      // LIVE sizing context: divide the allocated wallet balance into equal parts
      // (1 part of margin per position). Only for armed live accounts; paper skips this.
      // Paused accounts keep managing open positions (exits ran above) but open
      // no NEW positions. Applies to paper and live alike; defaults false.
      const paused = !!accountState.paused;
      if (paused && !onlyExits) {
        log(`[${accountState.name}] ⏸ Paused — skipping new entries (open positions still managed).`);
      }

      // Day-of-week entry gate (v2/paper). Blocks NEW entries on a disabled weekday
      // (17:30 IST trading-day boundary); open positions still managed. v1 → always true.
      const dayAllowsEntry = isTradingDayEnabled();
      if (!dayAllowsEntry && !onlyExits && !paused) {
        log(`[${accountState.name}] 📅 Trading day disabled — skipping new entries (open positions still managed).`);
      }

      const liveArmed = accountState.mode === 'live' && !!accountState.live_enabled;

      // SELF-HEAL live margin basis. Positions opened before the account was armed (or
      // before live sizing existed) carry a PAPER notional margin (short term =
      // spot × sellQty × 1 / 200) that is ~100× a real Delta margin, so their summed
      // `usedMargin` dwarfs the live budget and blocks all new entries. Recompute each
      // open live position's margin on the real contract-value basis (the same basis
      // entry uses), backfill buyLeg.contractValue from symbolMeta, and persist on change
      // so carried-over positions self-correct over the next cycle. Runs on full cycles
      // for the current underlying only (spotPrice applies to it); armed-live only, so
      // paper accounts are untouched.
      if (liveArmed && !onlyExits) {
        for (const pos of remaining) {
          if (pos.underlying !== underlying) continue;
          // Prefer symbolMeta's contractValue (authoritative exchange constant) over the
          // stored one, so a WRONG stored value (e.g. a legacy `?? lotSize` default of 1)
          // self-corrects — not just a missing one. Fall back to the stored value only when
          // the symbol is no longer in meta (e.g. expired).
          const metaCV = symbolMeta[pos.buyLeg?.symbol]?.contractValue ?? null;
          const longCV = metaCV ?? pos.buyLeg?.contractValue ?? null;
          if (longCV == null) continue; // no contract-value basis available — leave as-is
          const corrected = contractBasisMargin(pos, longCV);
          const beforeCV = pos.buyLeg.contractValue;
          const cvChanged = beforeCV == null || Math.abs((beforeCV || 0) - longCV) > 1e-12;

          // Drift reference = the last value PERSISTED to the DB, anchored to the DB-loaded
          // margin on first encounter — captured BEFORE the in-memory overwrite below. Drift
          // is measured against THIS, not the value we rewrite each cycle; otherwise tiny
          // per-minute steps would each stay under the threshold and the DB would drift
          // unbounded from reality while never triggering a write.
          if (pos._persistedMargin == null) pos._persistedMargin = pos.margin ?? corrected;
          const ref = pos._persistedMargin;

          // Correct IN-MEMORY every cycle so THIS cycle's sizing (usedMargin) is accurate.
          // Free — no DB write, no realtime egress.
          if (cvChanged) pos.buyLeg.contractValue = longCV;
          pos.margin = corrected;

          // Persist (→ a realtime broadcast to every open UI tab) only on a MATERIAL change:
          // a contractValue fix, or margin drift past max($0.50, 2%) since the last persist.
          // Routine minute-to-minute spot drift stays in-memory only; a legacy paper→live
          // correction is large and always persists on the first cycle.
          const material = Math.abs((ref || 0) - corrected) > Math.max(0.5, 0.02 * Math.abs(ref || corrected));
          if (cvChanged || material) {
            try {
              await supabase.from('active_positions').update({
                margin: pos.margin,
                buy_leg: JSON.stringify(pos.buyLeg),
              }).eq('id', pos.id);
              pos._persistedMargin = corrected;
              const cvNote = cvChanged ? `, contractValue ${beforeCV == null ? 'backfilled' : `${beforeCV}→${longCV}`}` : '';
              const verb = cvChanged ? 'corrected' : 'refreshed';
              log(`[${accountState.name}] 🔧 Live margin ${verb} ${pos.id}: $${(ref || 0).toFixed(2)} → $${pos.margin.toFixed(2)} (contract-value basis${cvNote})`);
            } catch (e) {
              logError(`[${accountState.name}] Live margin self-heal persist failed for ${pos.id}:`, e);
            }
          }
        }
      }

      let partMargin = null;
      if (!onlyExits && !paused && dayAllowsEntry && liveArmed) {
        try {
          const bal = await live.walletBalance();
          if (bal != null && bal > 0) {
            const allocPct = config.balanceAllocationPct ?? 90;
            const budget = bal * (allocPct / 100);
            const maxPos = computeMaxPositions(); // PEAK cap across all windows (calls + puts)
            // Size on the REMAINING budget over the REMAINING free slots, not the raw
            // total ÷ cap. Positions already open (this underlying) lock margin and
            // occupy cap slots — subtracting both means positions carried over from a
            // smaller-cap window into a larger-cap one can never over-allocate (the
            // remaining budget shrinks to ~0 → new entries self-skip). Uses `remaining`
            // (post-exit survivors this cycle) so slots freed this cycle are reusable.
            const openHere = remaining.filter(p => p.underlying === underlying);
            const usedMargin = openHere.reduce((s, p) => s + (p.margin || 0), 0);
            const occupiedSlots = openHere.filter(p => p.sellQty > 0).length; // full spreads occupy cap slots
            const remainingBudget = Math.max(0, budget - usedMargin);
            const remainingSlots = Math.max(1, maxPos - occupiedSlots);
            partMargin = remainingBudget / remainingSlots;
            log(`[${accountState.name}] 💰 LIVE sizing: balance $${bal.toFixed(2)} × ${allocPct}% = $${budget.toFixed(2)} budget | used $${usedMargin.toFixed(2)} | remaining $${remainingBudget.toFixed(2)} ÷ ${remainingSlots} free slot(s) (peak cap ${maxPos}) = $${partMargin.toFixed(2)}/position`);
          } else {
            logWarn(`[${accountState.name}] LIVE sizing: wallet balance unavailable — skipping live entries this cycle.`);
          }
        } catch (e) {
          logError(`[${accountState.name}] LIVE sizing balance fetch error:`, e);
        }
      }

      if (!onlyExits && !paused && dayAllowsEntry) {
        for (const spread of uniqueTopSpreads) {
          // Live accounts need a valid per-position margin part to size safely.
          if (liveArmed && partMargin == null) continue;
          const bStrike = Number(spread.buyLeg.strike);
          const sStrike = Number(spread.sellLeg.strike);
          const spreadType = spread.buyLeg.type;

          // Expiry buffer guard
          const minutesToExpiry = (new Date(spread.buyLeg.symbol?.includes(config.expiry) ? config.expiry : config.expiry).getTime() - Date.now()) / 60000;
          const expiryCheck = (new Date(config.expiry).getTime() - Date.now()) / 60000;
          if (expiryCheck < 5) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: too close to expiry (${expiryCheck.toFixed(1)} mins remaining)`);
            continue;
          }

          // Days to expiry guard. Uses effectiveConfig so a strategy_version >= 2
          // account applies the ACTIVE WINDOW's min-days-to-expiry; v1 falls back to
          // the account-level config value (effectiveConfig.daysToExpiry === config).
          const daysRemaining = (new Date(config.expiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < (effectiveConfig.daysToExpiry || 0)) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: days to expiry (${daysRemaining.toFixed(2)}) is less than min required (${effectiveConfig.daysToExpiry})`);
            continue;
          }

          // Buy strike conflict check (hedge overlays excluded — they don't block spreads)
          const buyConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && !p.buyLeg?.isHedge && Number(p.buyLeg.strike) === bStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && !p.buyLeg?.isHedge && Number(p.buyLeg.strike) === bStrike
          );

          // Sell strike conflict check (ignore long-only held positions — their short leg is gone)
          const sellConflictPos = remaining.find(
            p => p.underlying === underlying && p.type === spreadType && p.sellQty > 0 && Number(p.sellLeg.strike) === sStrike
          ) || newEntries.find(
            p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === sStrike
          );

          if (buyConflictPos) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Buy strike conflict with active/new position ${buyConflictPos.id} (${buyConflictPos.buyLeg.strike}/${buyConflictPos.sellLeg.strike})`);
            continue;
          }
          if (sellConflictPos) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Sell strike conflict with active/new position ${sellConflictPos.id} (${sellConflictPos.buyLeg.strike}/${sellConflictPos.sellLeg.strike})`);
            continue;
          }

          // Portfolio cap — count only full spreads (positions with an active short leg).
          // Long-only held positions (sellQty === 0) free up a slot for new entries.
          let count = remaining.filter(p => p.underlying === underlying && p.type === spreadType && p.sellQty > 0).length +
            newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
          const typeCap = spreadType === 'call' ? effectiveConfig.numberOfCalls : effectiveConfig.numberOfPuts;
          if (count >= typeCap) {
            logWarn(`[${accountState.name}] Entry candidate ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: Portfolio cap of ${typeCap} reached for type ${spreadType}`);
            continue;
          }

          // Diversification guard removed

          // Entry pricing
          const entryBuyPrice = spread.buyPrice;
          const entrySellPrice = spread.sellPrice;
          const tickerBuyEntry = tickerData[spread.buyLeg.symbol];
          const tickerSellEntry = tickerData[spread.sellLeg.symbol];
          const entryBuyIv = tickerBuyEntry?.askIv ?? tickerBuyEntry?.iv ?? null;
          const entrySellIv = tickerSellEntry?.bidIv ?? tickerSellEntry?.iv ?? null;

          // Calculate ATM ratio scaling
          const buyIntrinsic = getTickerPrice(atmStrike, spreadType, 'bid', config.expiry);
          const targetSellStrike = spreadType === 'call' ? atmStrike + spread.strikeDiff : atmStrike - spread.strikeDiff;
          const sellIntrinsic = getTickerPrice(targetSellStrike, spreadType, 'ask', config.expiry);

          const entryAtmRatio = computeEntryAtmRatio(buyIntrinsic, sellIntrinsic);
          const ratioToUse = computeScaledSellQty(spread.sellQty, entryAtmRatio, spreadType, effectiveConfig);

          const originalLotSize = spread.buyLeg.lotSize || 1;
          const sellLotSize = spread.sellLeg.lotSize || originalLotSize;

          let adjustedLotSize = originalLotSize;
          let adjustedSellQty = ratioToUse;
          let scale = 1;
          let liveMargin = null; // real (contract_value-based) margin, stored for live positions
          let liveLongCV = null; // long-leg contract value — the LIVE margin basis (null = paper-sized)
          let liveShortCV = null; // short-leg contract value — persisted for the leg objects below

          if (liveArmed) {
            // LIVE: scale the 1:ratio base UNIT by (part budget ÷ one-unit margin), then
            // round the LONG to the nearest whole contract and derive the SHORT from
            // (rounded long × base ratio) so the ratio is PRESERVED exactly — no
            // independent-rounding drift. Not floored, so the full part is used; min 1
            // unit if the part can't fund even one.
            //   e.g. base 1:11,   scale 2.75 → long round(2.75)=3, short round(3×11)=33.
            //   e.g. base 1:7.25, scale 3.8  → long round(3.8)=4,  short round(4×7.25)=29.
            // Margin uses the REAL per-contract underlying amount (`contractValue`, e.g.
            // 0.001 BTC) and the CURRENT spot price — NOT the (paper) lotSize=1 — so the
            // estimate matches Delta's actual margin instead of blowing past the notional
            // cap and pinning scale to 1.
            // Live sizing/margin MUST use the real per-contract underlying amount
            // (contractValue, e.g. 0.001 BTC). If it's missing from symbolMeta, the old
            // `?? lotSize` default (=1) silently mis-sized the live order ~1000× (1 vs
            // 0.001) AND stamped a bad contractValue basis that the margin self-heal
            // couldn't fix. Skip the entry instead of guessing a size.
            const longCV = symbolMeta[spread.buyLeg.symbol]?.contractValue ?? null;
            const shortCV = symbolMeta[spread.sellLeg.symbol]?.contractValue ?? null;
            if (longCV == null || shortCV == null) {
              logWarn(`[${accountState.name}] LIVE entry ${spreadType.toUpperCase()} ${bStrike}/${sStrike} skipped: contractValue missing from symbolMeta (buy ${spread.buyLeg.symbol}=${longCV}, sell ${spread.sellLeg.symbol}=${shortCV}) — cannot size a live order safely.`);
              continue;
            }
            liveLongCV = longCV; // persist as the leg's margin basis for later long-only recompute
            liveShortCV = shortCV; // persist for the short leg object built after this block
            const baseMargin = calcMargin(entryBuyPrice, longCV, spotPrice, ratioToUse, shortCV);
            scale = (baseMargin > 0) ? (partMargin / baseMargin) : 1;
            if (scale < 1) {
              logWarn(`[${accountState.name}] LIVE size: one unit (margin $${baseMargin.toFixed(2)}) exceeds 1 part ($${partMargin.toFixed(2)}) — trading the minimum 1 unit.`);
              scale = 1;
            }
            let longC = Math.max(1, Math.round(scale));

            // Ratio-spread max-qty cap: never size the spread past what the ratio spread
            // itself supports. The SHORT notional (spot × short contracts × contract value)
            // must not exceed $195k — the same ceiling paper applies — so a large balance
            // can't fund a position bigger than the spread's max qty. Final qty =
            // min(balance-allocated qty, notional-cap qty). Min 1 long is still honoured
            // even if a single unit is already over the cap.
            const NOTIONAL_CAP = 195000;
            const shortNotionalPerContract = spotPrice * shortCV;
            const maxShortByNotional = shortNotionalPerContract > 0
              ? Math.floor(NOTIONAL_CAP / shortNotionalPerContract) : Infinity;
            const maxLongByNotional = ratioToUse > 0
              ? Math.floor(maxShortByNotional / ratioToUse) : Infinity;
            if (longC > maxLongByNotional) {
              log(`[${accountState.name}] 🧢 LIVE qty capped by ratio-spread max (short notional ≤ $${NOTIONAL_CAP}): long ${longC} → ${Math.max(1, maxLongByNotional)}`);
              longC = Math.max(1, maxLongByNotional);
            }

            // Short follows the rounded long at the base ratio (keeps 1:ratio exact), then
            // a final clamp so integer rounding can't push the short notional over the cap.
            let shortC = Math.max(1, Math.round(longC * ratioToUse));
            if (Number.isFinite(maxShortByNotional) && maxShortByNotional >= 1 && shortC > maxShortByNotional) {
              shortC = maxShortByNotional;
            }
            adjustedLotSize = Number((longCV * longC).toFixed(4));
            adjustedSellQty = shortC;
            liveMargin = calcMargin(entryBuyPrice, longCV * longC, spotPrice, adjustedSellQty, shortCV);
            log(`[${accountState.name}] 💰 LIVE size ${spreadType.toUpperCase()} ${bStrike}/${sStrike}: unit margin $${baseMargin.toFixed(2)} | part $${partMargin.toFixed(2)} → scale ${scale.toFixed(2)}× | long ${longC} short ${shortC} (base 1:${ratioToUse}) | est margin $${liveMargin.toFixed(2)} | cv ${longCV}/${shortCV}`);
          } else {
            // PAPER (unchanged): $195,000 / 200x notional cap.
            let shortValue = spotPrice * ratioToUse * sellLotSize;
            if (shortValue >= 195000) {
              scale = 195000 / shortValue;
              adjustedLotSize = Number((originalLotSize * scale).toFixed(2));
              adjustedSellQty = Number((ratioToUse * scale).toFixed(2));
              shortValue = 195000;
            }
          }

          const buyLegWithIv = {
            ...spread.buyLeg,
            lotSize: adjustedLotSize,
            entryIv: entryBuyIv,
            entryAtmRatio,
            entryBuyAtmPrice: buyIntrinsic,
            entrySellAtmPrice: sellIntrinsic,
            maxAtmRatio: entryAtmRatio,
            originalLotSize: liveArmed ? liveLongCV : (spread.buyLeg.lotSize || 1),
            originalSellQty: ratioToUse,
            initialScaledLotSize: adjustedLotSize,
            // LIVE margin basis (real per-contract underlying amount). Present only for
            // live-sized positions; null → paper-sized (margin uses lotSize). Read by
            // longOnlyMargin() so a short-exit recompute matches the entry margin basis.
            contractValue: liveLongCV
          };
          const sellLegWithIv = {
            ...spread.sellLeg,
            entryIv: entrySellIv,
            lotSize: liveArmed ? liveShortCV : (spread.sellLeg.lotSize || originalLotSize),
            contractValue: liveArmed ? liveShortCV : null
          };

          const entryBuyFee = calculateFee(entryBuyPrice, spotPrice, adjustedLotSize, buyLegWithIv.originalLotSize || 1);
          const entrySellFee = calculateFee(entrySellPrice, spotPrice, adjustedSellQty, sellLegWithIv.lotSize);
          const entryFee = entryBuyFee + entrySellFee;
          // Live: store the real contract_value-based margin (matches Delta + feeds the
          // remaining-budget sizing correctly). Paper: unchanged notional/200 estimate.
          const candidateMargin = liveMargin != null
            ? liveMargin
            : calcMargin(entryBuyPrice, adjustedLotSize, spotPrice, adjustedSellQty, spread.sellLeg.lotSize);



          const id = `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

          const newPos = {
            id, underlying, expiry: config.expiry, type: spreadType,
            buyLeg: buyLegWithIv, sellLeg: sellLegWithIv, sellQty: adjustedSellQty,
            strikeDiff: spread.strikeDiff, entryTime: new Date(),
            entryBuyPrice, entrySellPrice, entrySpotPrice: spotPrice,
            entryFee,
            margin: candidateMargin,
          };
          newEntries.push(newPos);
        }

        // ── Hedge overlay entry (long-only, strategy_version >= 2) ────────────
        // Buy one OTM long per enabled type whose ask is nearest the target premium,
        // sized as (sum of active short qty of that type) × pct. Entered ONCE while the
        // window is active and short exposure exists; then drained proportionally (1b).
        const hedgeType = effectiveConfig.hedgeStrikeType;
        if (config.strategyVersion >= 2 && hedgeType && hedgeType !== 'none') {
          const expiryMins = (new Date(config.expiry).getTime() - Date.now()) / 60000;
          const hTypes = hedgeType === 'both' ? ['call', 'put'] : [hedgeType];
          for (const hT of hTypes) {
            if (expiryMins < 5) continue; // too close to expiry
            const targetPrice = hT === 'call' ? effectiveConfig.hedgeCallPrice : effectiveConfig.hedgePutPrice;
            const pct = hT === 'call' ? effectiveConfig.hedgeCallPct : effectiveConfig.hedgePutPct;
            if (!(targetPrice > 0) || !(pct > 0)) continue;
            // One hedge overlay per type at a time.
            if ([...remaining, ...newEntries].some(p => p.underlying === underlying && p.type === hT && p.buyLeg?.isHedge)) continue;
            // Sum of active short qty of this type (this underlying), main positions only.
            const mainOfType = [...remaining, ...newEntries].filter(p => p.underlying === underlying && p.type === hT && !p.buyLeg?.isHedge);
            const shortSum = mainOfType.reduce((s, p) => s + (p.sellQty > 0 ? p.sellQty : 0), 0);
            if (shortSum <= 0) continue; // no shorts of this type → nothing to hedge
            const buyQty = Number((shortSum * (pct / 100)).toFixed(4));
            if (!(buyQty > 0)) continue;
            const N = Math.max(1, mainOfType.length); // that type's open long positions at entry
            // Nearest-premium OTM strike: call strike > spot, put strike < spot; min |ask − target|.
            let best = null, bestDist = Infinity;
            for (const t of allTickers) {
              if (t.type !== hT || t.expiry !== config.expiry) continue;
              const isOtm = hT === 'call' ? t.strike > spotPrice : t.strike < spotPrice;
              if (!isOtm) continue;
              const ask = t.ask ?? t.lastPrice ?? t.markPrice;
              if (ask == null || !(ask > 0)) continue;
              const d = Math.abs(ask - targetPrice);
              if (d < bestDist) { bestDist = d; best = { ...t, _ask: ask }; }
            }
            if (!best) { logWarn(`[${accountState.name}] Hedge ${hT} skipped: no OTM strike with a quote near $${targetPrice}`); continue; }
            const entryBuyPrice = best._ask;
            const id = `H${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            const buyLeg = {
              symbol: best.symbol, strike: best.strike, type: hT, expiry: config.expiry,
              lotSize: buyQty, originalLotSize: 1,
              isHedge: true, hedgeN: N, hedgeBuyQty: buyQty,
              entryIv: best.askIv ?? best.iv ?? null, contractValue: null,
            };
            const entryFee = calculateFee(entryBuyPrice, spotPrice, buyQty, 1);
            const margin = calcMargin(entryBuyPrice, buyQty, spotPrice, 0, 1);
            const hedgePos = {
              id, underlying, expiry: config.expiry, type: hT,
              buyLeg, sellLeg: { lotSize: 0 }, sellQty: 0,
              strikeDiff: 0, entryTime: new Date(),
              entryBuyPrice, entrySellPrice: 0, entrySpotPrice: spotPrice, entryFee, margin,
            };
            // LIVE (armed): buy the long-only overlay (no bracket — engine-drained). No-op for paper/unarmed.
            if (accountState.mode === 'live' && accountState.live_enabled) {
              const res = await live.openSpread(hedgePos, { long: longContracts(buyLeg), short: 0, buyPrice: entryBuyPrice });
              if (res && res.ok === false && !res.skipped) { logError(`[${accountState.name}] Hedge ${hT} live buy failed: ${res.error}`); continue; }
            }
            try {
              const { error: hErr } = await supabase.from('active_positions').insert([{
                id, underlying, expiry: config.expiry, type: hT,
                buy_leg: JSON.stringify(buyLeg), sell_leg: JSON.stringify({ lotSize: 0 }),
                sell_qty: 0, strike_diff: 0, entry_time: hedgePos.entryTime.toISOString(),
                entry_buy_price: entryBuyPrice, entry_sell_price: 0, entry_spot_price: spotPrice,
                margin, entry_fee: entryFee, accumulated_sell_pnl: 0,
                buy_strike: best.strike, sell_strike: best.strike,
                account_id: accountState.id,
              }]);
              if (hErr) { logError(`[${accountState.name}] Hedge insert error:`, hErr.message); continue; }
            } catch (e) { logError(`[${accountState.name}] Hedge entry persistence error:`, e); continue; }
            remaining.push(hedgePos);
            log(`[${accountState.name}] 🛡️ HEDGE ENTRY: ${hT.toUpperCase()} ${best.strike} @ $${entryBuyPrice} (~target $${targetPrice}) · qty ${buyQty} (${pct}% of ${shortSum} shorts) · N=${N}`);
            notifyTrade({ title: '🛡️ HEDGE ENTRY', detail: `${hT.toUpperCase()} ${best.strike} @ $${entryBuyPrice} · qty ${buyQty} (${pct}% of ${shortSum} shorts) · N=${N}` });
          }
        }
      }

      // ── 3. Supabase side effects ──────────────────────────────────────
      if (exited.length > 0 || newEntries.length > 0) {
        lastDbWrite = Date.now();
      }

      // Process exits
      for (const t of exited) {
        try {
          // Idempotent: trade_id is the stable position id, so a concurrent
          // evaluator's duplicate is silently ignored (ON CONFLICT DO NOTHING).
          const { error: histError } = await supabase.from('trade_history').upsert([{
            trade_id: t.id, underlying, expiry: t.expiry, type: t.type,
            buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
            sell_qty: t.sellQty, strike_diff: t.strikeDiff,
            entry_time: t.entryTime.toISOString(),
            entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
            entry_spot_price: t.entrySpotPrice, margin: t.margin,
            exit_time: t.zombieExitTime || new Date().toISOString(),
            exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell,
            exit_spot_price: t.exitSpotPrice,
            realized_gross_pnl: t.realizedGrossPnl, realized_net_pnl: t.realizedNetPnl,
            exit_fee: t.exitFee, total_fees: t.totalFees, exit_reason: t.exitReason,
            is_partial: t._isPartial || false,
            account_id: accountState.id,
          }], { onConflict: 'trade_id', ignoreDuplicates: true });
          if (histError) logError(`[${accountState.name}] History insert error:`, histError.message);

          // LIVE: close remaining legs. Skip on expiry — Delta cash-settles expired
          // options exchange-side, and orders that close to expiry are rejected.
          const isExpirySettlement = /expiry/i.test(t.exitReason || '');
          // Encode the strategy exit reason into the order tag (client_order_id) so the
          // live Order History UI can show ATM/ITM/OTM/Expiry — matching paper's exit_reason.
          const exReason = String(t.exitReason || '');
          const exCode = /expiry/i.test(exReason) ? 'EXP'
            : /ITM/.test(exReason) ? 'ITM'
              : /OTM/.test(exReason) ? 'OTM' : 'ATM';
          if (!isExpirySettlement) {
            if (t.buyLeg?.lotSize > 0) {
              await live.closeLeg({
                symbol: t.buyLeg.symbol, side: 'sell',
                contracts: longContracts(t.buyLeg),
                price: t._latestBuy, tag: `${t.id}-XB-${exCode}`,
              });
            }
            if (t.sellQty > 0) {
              await live.closeLeg({
                symbol: t.sellLeg.symbol, side: 'buy',
                contracts: shortContracts(t.sellQty),
                price: t._latestSell, tag: `${t.id}-XS-${exCode}`,
              });
            }
          }

          // Delete from active
          await supabase.from('active_positions').delete().eq('id', t.id);

          log(`[${accountState.name}] 📤 EXIT: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | ${t.exitReason} | PnL: $${t.realizedNetPnl?.toFixed(2)}`);
        } catch (err) { logError(`[${accountState.name}] Exit persistence error:`, err); }
      }

      // Process entries
      if (!onlyExits) {
        for (const t of newEntries) {
          try {
            // DB-level count guard per account — count only full spreads (active short leg).
            // Long-only held positions (sell_qty === 0) don't count toward the cap.
            const { data: activeOfType, error: countError } = await supabase
              .from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .gt('sell_qty', 0);
            const typeCap = t.type === 'call' ? effectiveConfig.numberOfCalls : effectiveConfig.numberOfPuts;
            if (!countError && (activeOfType?.length ?? 0) >= typeCap) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Active count on DB: ${activeOfType?.length ?? 0}`);
              continue;
            }

            // DB-level diversification guard check removed

            // Buy strike uniqueness per account
            const { data: buyConflict } = await supabase.from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .eq('buy_strike', t.buyLeg.strike).limit(1);
            if (buyConflict && buyConflict.length > 0) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Buy strike conflict on DB.`);
              continue;
            }

            // Sell strike uniqueness per account (ignore long-only held positions)
            const { data: sellConflict } = await supabase.from('active_positions').select('id')
              .eq('account_id', accountState.id)
              .eq('underlying', underlying).eq('type', t.type)
              .eq('sell_strike', t.sellLeg.strike).gt('sell_qty', 0).limit(1);
            if (sellConflict && sellConflict.length > 0) {
              logWarn(`[${accountState.name}] DB Guard: Entry for ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} blocked. Sell strike conflict on DB.`);
              continue;
            }

            // LIVE: place real orders before persisting. Paper/dry-run/disarmed
            // returns ok immediately; armed-live only persists if the orders succeed.
            // Live entry limit prices carry a premium-$ offset to fill marketable:
            // buy at ask + entryBuyOffset, sell at bid - entrySellOffset. The stored
            // entryBuyPrice/entrySellPrice (used for bookkeeping) are left as-is.
            const buyOff = config.entryBuyOffset ?? 5;
            const sellOff = config.entrySellOffset ?? 2;
            // Exchange-native brackets at the exit-type SPOT level (ATM/ITM/OTM):
            // long leg → take-profit, short leg → stop-loss. These fire even if the
            // engine is down, and are the account's hard risk exit.
            const bracketLevel = computeIndexTriggerLevel(t.type, t.buyLeg.strike, effectiveConfig);
            const liveEntry = await live.openSpread(t, {
              long: longContracts(t.buyLeg),
              short: shortContracts(t.sellQty),
              buyPrice: t.entryBuyPrice + buyOff,
              sellPrice: Math.max(0.05, t.entrySellPrice - sellOff),
              longTp: bracketLevel,
              shortSl: bracketLevel,
              // Chase each leg to a full fill; unwind + abort if it can't complete.
              chase: {
                attempts: ENTRY_CHASE.attempts,
                pollMs: ENTRY_CHASE.pollMs,
                bump: ENTRY_CHASE.bump,
                buyOffset: buyOff,
                sellOffset: sellOff,
                quote: (sym) => tickerData[sym],
              },
            });
            if (!liveEntry.ok) {
              logError(`[${accountState.name}] LIVE entry aborted (${liveEntry.legFailed} leg: ${liveEntry.error}) — not persisting ${t.buyLeg.strike}/${t.sellLeg.strike}`);
              notifyLiveFailure({ account: accountState.name, context: `Entry ABORTED — ${liveEntry.legFailed} leg could not fill (chase exhausted); position unwound, account left flat`, error: liveEntry.error, extra: `${t.type?.toUpperCase?.() || ''} ${t.buyLeg.strike}/${t.sellLeg.strike}` });
              continue;
            }
            // Remember the exchange bracket level on each leg so a later
            // exitType/exitPoints change can detect the drift and move the bracket
            // (resyncRestingOrders) instead of leaving it stale at the entry level.
            t.buyLeg = { ...t.buyLeg, brkLevel: bracketLevel };
            if (t.sellQty > 0) t.sellLeg = { ...t.sellLeg, brkLevel: bracketLevel };
            if (liveArmed && t.sellQty > 0) {
              log(`[${accountState.name}] 🎯 Brackets: long TP + short SL @ spot ${bracketLevel} (${effectiveConfig.exitType || 'ATM'})`);
            }

            // RESTING-EXIT MODEL (armed + REAL orders only): rest a reduce-only limit
            // BUY on the short leg at shortExitPrice ($1.1) so the short buy-back sits
            // in the exchange order book and fills on its own as the premium decays —
            // engine-independent. When it fills, the exit loop places the long ladder.
            // (Dry-run keeps the engine-active exit model; resting orders need a real
            // exchange to rest on.)
            if (liveArmed && !live.dryRun && t.sellQty > 0) {
              const exitPx = config.shortExitPrice ?? 1.1;
              const seRes = await live.closeLeg({
                symbol: t.sellLeg.symbol, side: 'buy',
                contracts: shortContracts(t.sellQty), price: exitPx, tag: `${t.id}-SEX`,
              });
              t.sellLeg = {
                ...t.sellLeg,
                exitOrderId: seRes?.order?.id ?? null,
                exitProductId: seRes?.order?.product_id ?? null,
                exitOrderPx: exitPx,
              };
              log(`[${accountState.name}] 🎯 Resting short-exit armed: limit BUY short ${t.sellLeg.strike} @ $${exitPx} (id ${seRes?.order?.id ?? '?'})`);
            }

            const { error: insertError } = await supabase.from('active_positions').insert([{
              id: t.id, underlying, expiry: config.expiry, type: t.type,
              buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff,
              entry_time: t.entryTime.toISOString(),
              entry_buy_price: t.entryBuyPrice, entry_sell_price: t.entrySellPrice,
              entry_spot_price: t.entrySpotPrice,
              margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
              buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
              account_id: accountState.id,
            }]);

            if (insertError) {
              if (insertError.code === '23505') {
                logWarn(`[${accountState.name}] DB Guard: Duplicate strike entry blocked for ${t.buyLeg.strike}/${t.sellLeg.strike}`);
              } else {
                logError(`[${accountState.name}] Insert error:`, insertError.message);
              }
            } else {
              const originalLotSize = t.sellLeg.lotSize || 1;
              const ratioLong = t.buyLeg.lotSize / originalLotSize;
              log(`[${accountState.name}] 📥 ENTRY: ${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} | Qty: ${ratioLong.toFixed(2)}:${t.sellQty} | Net: $${(t.sellQty * t.entrySellPrice - t.entryBuyPrice * ratioLong).toFixed(2)}`);
              notifyTrade({ title: '📥 LIVE ENTRY', detail: `${t.type.toUpperCase()} ${t.buyLeg.strike}/${t.sellLeg.strike} · qty ${ratioLong.toFixed(2)}:${t.sellQty} · net $${(t.sellQty * t.entrySellPrice - t.entryBuyPrice * ratioLong).toFixed(2)} · spot ${Math.round(t.entrySpotPrice)}` });
            }
          } catch (err) { logError(`[${accountState.name}] Entry persistence error:`, err); }
        }
      }

      // Update in-memory positions
      positions = [...remaining, ...newEntries];

      // Update heartbeat
      heartbeat.update({
        active_positions: positions.length,
        spot_price: spotPrice,
        underlying: config.underlying,
        expiry: config.expiry,
      });

    } catch (e) {
      logError(`[${accountState.name}] Strategy evaluation error:`, e);
    } finally {
      isEvaluating = false;
      evaluationStart = 0;
      if (!onlyExits) {
        lastEvaluated = Date.now();
      }
    }
  }

  // ── Config hot-reload via Supabase Realtime ───────────────────────────

  // ── Re-sync the resting short buy-back price when shortExitPrice changes ───
  // When shortExitPrice changes on an account with OPEN live positions, the resting
  // buy-back limit order was placed at the old price — edit it in place. Armed real live
  // only; no-op for paper, dry-run logs the intended edit.
  async function resyncRestingOrders(oldCfg) {
    if (accountState.mode !== 'live') return;
    const shortPxChanged = (oldCfg.shortExitPrice ?? 1.1) !== (config.shortExitPrice ?? 1.1);
    if (!shortPxChanged) return;
    log(`[${accountState.name}] 🔧 Short-exit price changed — re-syncing resting buy-backs on ${positions.length} open position(s) | shortPx ${oldCfg.shortExitPrice}→${config.shortExitPrice}`);
    for (const pos of positions) {
      if (pos.underlying !== config.underlying) continue;
      if (!(pos.sellQty > 0 && pos.sellLeg?.exitOrderId)) continue;
      try {
        const newPx = config.shortExitPrice ?? 1.1;
        const r = await live.editOrder({
          id: pos.sellLeg.exitOrderId, symbol: pos.sellLeg.symbol,
          price: newPx, size: shortContracts(pos.sellQty), tag: `${pos.id}-SEX-edit`,
        });
        if (r.ok && !r.skipped) {
          pos.sellLeg = { ...pos.sellLeg, exitOrderPx: newPx };
          await supabase.from('active_positions').update({ sell_leg: JSON.stringify(pos.sellLeg) }).eq('id', pos.id);
        }
      } catch (e) {
        logError(`[${accountState.name}] resyncRestingOrders failed for ${pos.id}:`, e);
      }
    }
  }

  // ── Move open positions' SL/TP brackets to the CURRENT effective exit level ─────
  // Idempotent: for each open leg it compares the stored bracket level (`brkLevel`, set
  // at entry / last sync) against the level the engine would exit at NOW — the active
  // schedule window's exit rule if one governs, else the base config — and only re-syncs
  // brackets that actually drifted. Because it compares the real target (not old-vs-new
  // config), it works no matter WHAT changed: the base filters, a schedule window, or a
  // window becoming active. Long leg → TP, short leg (while open) → SL.
  //
  // Delta has NO "edit position bracket" call: POST /v2/orders/bracket only CREATES (it
  // rejects `bracket_order_exists` when the entry bracket is already attached), and PUT
  // /v2/orders/bracket edits only ORDER-attached brackets (needs a live parent order id —
  // gone once filled). So we MOVE a bracket by cancel-then-recreate: cancel the leg's
  // existing bracket (stop) order, then POST a fresh bracket at the new level. Armed real
  // live only; dry-run logs intended calls (and does NOT latch brkLevel, so the real
  // re-sync still fires once the account is armed).
  async function syncExitBrackets(reason = 'config change') {
    if (accountState.mode !== 'live') return;
    const activeSchedule = getActiveSchedule();
    const effExit = {
      exitType: activeSchedule?.exitType ?? config.exitType,
      exitPoints: activeSchedule?.exitPoints ?? config.exitPoints,
    };

    // Which legs are out of sync? (pure in-memory — no API call unless there's real drift)
    const drift = [];
    for (const pos of positions) {
      if (pos.underlying !== config.underlying) continue;
      const newLevel = computeIndexTriggerLevel(pos.type, pos.buyLeg.strike, effExit);
      const needLong = (pos.buyLeg?.lotSize || 0) > 0 && pos.buyLeg?.brkLevel !== newLevel;
      const needShort = pos.sellQty > 0 && pos.sellLeg?.brkLevel !== newLevel;
      if (needLong || needShort) drift.push({ pos, newLevel, needLong, needShort });
    }
    if (drift.length === 0) return;

    // ATM = buy strike (points are NOT applied); only ITM/OTM add/subtract exitPoints.
    const exitDesc = effExit.exitType === 'ATM' ? 'ATM' : `${effExit.exitType}±${effExit.exitPoints ?? 0}`;
    log(`[${accountState.name}] 🔧 Exit brackets (${reason}): moving ${drift.length} position(s) to ${exitDesc}${activeSchedule ? ` [window "${activeSchedule.label}"]` : ''}`);

    // Fetch (armed real only) the product_ids and the CURRENT resting bracket/stop orders
    // per symbol, so we can cancel the existing bracket before re-posting. Only stop/bracket
    // orders are collected — the resting short buy-back (-SEX) and ladder (-LE) are plain
    // limit orders and must NOT be cancelled here.
    let pidBySymbol = {}, bracketOrdersBySymbol = {}, livePosOk = false;
    if (accountState.live_enabled && !live.dryRun) {
      const [livePos, liveOrders] = await Promise.all([live.positions(), live.orders()]);
      livePosOk = livePos != null; // fetch succeeded → the snapshot can be trusted for "is this leg open?"
      if (livePos != null) for (const p of livePos) pidBySymbol[p.product_symbol] = p.product_id;
      if (Array.isArray(liveOrders)) {
        for (const o of liveOrders) {
          const isBracket = !!(o.bracket_order || o.stop_order_type
            || o.bracket_stop_loss_price != null || o.bracket_take_profit_price != null);
          if (isBracket && o.product_symbol) {
            (bracketOrdersBySymbol[o.product_symbol] ||= []).push({ id: o.id, productId: o.product_id });
          }
        }
      }
    }

    // Cancel the leg's existing bracket order(s), then POST a fresh bracket at newLevel.
    // Two failure modes are handled so a risk exit is NEVER silently left unprotected:
    //   1. Leg not open on Delta → nothing to protect; skip quietly (reconcile cleans up).
    //   2. Bracket would fire immediately (level already breached) → close the leg NOW
    //      with a reduce-only market order — the real protective exit.
    const moveBracket = async (pos, symbol, side, newLevel) => {
      const isTp = side === 'tp';
      const tag = `${pos.id}-${isTp ? 'TP' : 'SL'}-resync`;

      // (1) Leg already closed on the exchange — only trust this when the positions
      // fetch actually succeeded, else an API blip would wrongly skip a real sync.
      if (livePosOk && pidBySymbol[symbol] == null) {
        log(`[${accountState.name}] ⏭️ Bracket skip ${isTp ? 'TP' : 'SL'} ${symbol} [${tag}]: leg not open on Delta (already closed) — reconcile will clean up.`);
        return { ok: false, notOpen: true };
      }

      for (const bo of (bracketOrdersBySymbol[symbol] || [])) {
        if (bo.id != null) await live.cancelStop(bo);
      }
      const r = await live.changePositionBracket({
        productId: pidBySymbol[symbol], symbol, side, stopPrice: newLevel, tag,
      });

      // (2) Level already breached → Delta won't rest a bracket that triggers instantly.
      // The exit is due NOW: market-close the leg (reduce-only) so it isn't left exposed.
      if (!r.ok && r.code === 'immediate_execution') {
        const closeSide = isTp ? 'sell' : 'buy'; // sell to close the long, buy to close the short
        const contracts = isTp ? longContracts(pos.buyLeg) : shortContracts(pos.sellQty);
        logWarn(`[${accountState.name}] ⚡ Bracket ${isTp ? 'TP' : 'SL'} ${symbol} would fire immediately (level ${newLevel} already breached) → protective MARKET close ${closeSide} ${contracts}x [${tag}]`);
        const c = await live.closeSymbol({ symbol, side: closeSide, contracts, tag: `${pos.id}-${isTp ? 'TP' : 'SL'}-immed` });
        const label = `${pos.type.toUpperCase()} ${pos.buyLeg.strike}${pos.sellQty > 0 ? '/' + pos.sellLeg.strike : ''}`;
        if (c.ok || c.dryRun || c.skipped) {
          notifyTrade({ title: isTp ? '🎯 TAKE PROFIT (immediate)' : '🚨 STOP LOSS (immediate)', detail: `${label} · ${symbol} level already breached → market-closed` });
        } else {
          notifyLiveFailure({ account: accountState.name, context: `Protective market close FAILED (${closeSide} ${symbol}) after bracket immediate-execution — leg may still be OPEN and UNPROTECTED`, error: { message: c.error }, extra: `[${tag}]` });
        }
        return { ok: false, immediateClosed: !!(c.ok || c.dryRun || c.skipped) };
      }
      return r;
    };

    for (const { pos, newLevel, needLong, needShort } of drift) {
      try {
        let persist = false;
        if (needLong) {
          const r = await moveBracket(pos, pos.buyLeg.symbol, 'tp', newLevel);
          // Latch brkLevel only on a REAL success so dry-run doesn't mark it done (which
          // would suppress the real re-sync once the account is armed).
          if (r.ok && !r.skipped && !r.dryRun) { pos.buyLeg = { ...pos.buyLeg, brkLevel: newLevel }; persist = true; }
        }
        if (needShort) {
          const r = await moveBracket(pos, pos.sellLeg.symbol, 'sl', newLevel);
          if (r.ok && !r.skipped && !r.dryRun) { pos.sellLeg = { ...pos.sellLeg, brkLevel: newLevel }; persist = true; }
        }
        if (persist) {
          await supabase.from('active_positions').update({
            buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
          }).eq('id', pos.id);
        }
      } catch (e) {
        logError(`[${accountState.name}] syncExitBrackets failed for ${pos.id}:`, e);
      }
    }
  }

  async function reloadConfigAndSync() {
    try {
      const oldUnderlying = config.underlying;
      const oldExpiry = config.expiry;
      const oldExitCfg = { shortExitPrice: config.shortExitPrice, exitType: config.exitType, exitPoints: config.exitPoints };
      await fetchConfig();

      if (config.underlying !== oldUnderlying || config.expiry !== oldExpiry) {
        log(`[${accountState.name}] Config changed (underlying/expiry): ${oldUnderlying}/${oldExpiry} → ${config.underlying}/${config.expiry}`);
        await refreshProducts();
        await fetchActivePositions();
        tickerData = {};
        startWebSocket();
        tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
      }

      // Modify open positions' resting orders to match the new exit config.
      await resyncRestingOrders(oldExitCfg);
      await syncExitBrackets('filter change');
    } catch (e) {
      logError(`[${accountState.name}] Error during config reload:`, e);
    }
  }

  // Debounce timers for Realtime config/schedule reload bursts (cleared in stop()).
  let configReloadTimer = null;
  let scheduleReloadTimer = null;

  function subscribeConfigChanges() {
    // Coalesce Realtime bursts into ONE reload. A schedule save is a DELETE-all +
    // INSERT-all, so it fires many events at once; debouncing (~400ms) collapses that
    // burst into a single fetch/reload — fewer reads and one log line instead of N,
    // with no loss of responsiveness.
    const debounceConfigReload = () => {
      if (configReloadTimer) clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(() => {
        configReloadTimer = null;
        log(`[${accountState.name}] Config change detected — reloading...`);
        reloadConfigAndSync().catch(e => logError(`[${accountState.name}] config reload failed:`, e));
      }, 400);
    };
    const debounceScheduleReload = () => {
      if (scheduleReloadTimer) clearTimeout(scheduleReloadTimer);
      scheduleReloadTimer = setTimeout(() => {
        scheduleReloadTimer = null;
        log(`[${accountState.name}] Schedules change detected — reloading...`);
        // Exit type/points live PER SCHEDULE WINDOW, so a window edit must also move the
        // brackets of open positions the window governs — reload the windows first, then
        // resync brackets to the new effective level (idempotent; no-op if nothing drifted).
        fetchSchedules()
          .then(() => syncExitBrackets('schedule change'))
          .catch(e => logError(`[${accountState.name}] schedules reload failed:`, e));
      }, 400);
    };
    const channel = supabase
      .channel(`paper_config_changes_${accountState.id}`)
      .on(
        'postgres_changes',
        // Server-side filter on account_id keeps Realtime egress scoped to this
        // engine's account (avoids cross-account fan-out when multiple engines run).
        { event: '*', schema: 'public', table: 'paper_trading_config', filter: `account_id=eq.${accountState.id}` },
        debounceConfigReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_schedules', filter: `account_id=eq.${accountState.id}` },
        debounceScheduleReload
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'active_positions', filter: `account_id=eq.${accountState.id}` },
        (payload) => {
          // The engine is the authoritative writer of active_positions — entries, exits
          // and scaling are applied to the in-memory `positions` array directly by the
          // evaluation loop, so its own INSERT/UPDATE echoes need no DB refetch. The only
          // external mutation is a UI manual exit (DELETE); patch that out of memory
          // instead of re-downloading the whole position set (with JSON legs) on every
          // change. The periodic positionsTimer remains the drift safety net.
          if ((payload.eventType || payload.type) !== 'DELETE') return;
          const deletedId = payload.old?.id;
          if (!deletedId || !positions.some(p => p.id === deletedId)) return;
          positions = positions.filter(p => p.id !== deletedId);
          heartbeat.update({ active_positions: positions.length });
          log(`[${accountState.name}] Active position DELETE via Realtime: ${deletedId}. Removed from memory (no refetch).`);
        }
      )
      .subscribe();

    return channel;
  }


  // ── Main startup sequence ─────────────────────────────────────────────

  log(`[${accountState.name}] ═══════════════════════════════════════════`);
  log(`[${accountState.name}] Paper Trading Engine starting...`);
  log(`[${accountState.name}] ═══════════════════════════════════════════`);

  // 1. Load config + schedules
  await fetchConfig();
  await loadCredentials();
  // Safety on startup: clear a stuck close_all flag and purge any request rows that
  // piled up while the engine was down, so a restart never bulk-executes old clicks.
  try {
    await supabase.from('paper_trading_accounts')
      .update({ close_all_requested: false }).eq('id', accountState.id).eq('close_all_requested', true);
    accountState.close_all_requested = false;
    await supabase.from('delta_close_requests').delete().eq('account_id', accountState.id);
    await supabase.from('delta_cancel_requests').delete().eq('account_id', accountState.id);
  } catch (e) { /* tables may not exist on older DBs — non-fatal */ }
  await fetchSchedules();
  log(`[${accountState.name}] Schedules loaded: ${schedules.length} window(s)`);

  // 2. Load products + expiry
  await refreshProducts();

  // 3. Fetch spot price
  await fetchSpot();
  if (spotPrice) log(`[${accountState.name}] Spot price: $${spotPrice.toFixed(2)}`);

  // 4. Fetch existing positions
  await fetchActivePositions();
  log(`[${accountState.name}] Active positions loaded: ${positions.length}`);

  // Sync resting orders + brackets to Delta on startup to match the current DB config.
  // (shortExitPrice: null → the short-px resync self-skips; the bracket sync is idempotent
  // and corrects any exit-level drift that happened while the engine was down.)
  try {
    if (accountState.mode === 'live') {
      await resyncRestingOrders({ shortExitPrice: null, exitType: null, exitPoints: null });
      await syncExitBrackets('startup');
    }
  } catch (e) {
    logError(`[${accountState.name}] Startup resting orders sync failed:`, e.message);
  }

  // 5. Build symbol map and backfill tickers via REST
  symbolMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
  tickerData = await backfillTickers(config.underlying, symbolMeta, tickerData);
  log(`[${accountState.name}] Ticker backfill complete: ${Object.keys(tickerData).length} symbols`);

  // 6. Start WebSocket
  startWebSocket();

  // 7. Start heartbeat
  heartbeat.update({
    underlying: config.underlying,
    expiry: config.expiry,
    active_positions: positions.length,
    spot_price: spotPrice,
    dry_run: isLiveDryRun(), // publish execution mode so the UI can show real vs simulated
  });
  await heartbeat.start();

  // 8. Subscribe to config changes
  const configChannel = subscribeConfigChanges();
  // ── Timers ────────────────────────────────────────────────────────────

  // Main evaluation loop — every 1 second (exits run every second, entries run at minute boundaries)
  const evalTimer = setInterval(async () => {
    try {
      if (!spotPrice || !config.expiry) return;

      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const lastMinute = Math.floor(lastEvaluated / 60000);

      if (currentMinute > lastMinute || lastEvaluated === 0) {
        await evaluateStrategy(false); // Full evaluation (exits + entries)
      } else {
        await evaluateStrategy(true);  // Exit-only evaluation
      }
    } catch (e) {
      logError(`[${accountState.name}] Error in evalTimer:`, e);
    }
  }, 1000);

  // Spot price polling — every 10 seconds
  const spotTimer = setInterval(async () => {
    try {
      await fetchSpot();
    } catch (e) {
      logError(`[${accountState.name}] Error in spotTimer:`, e);
    }
  }, 10000);

  // Product refresh — every 5 minutes
  const productTimer = setInterval(async () => {
    try {
      await refreshProducts();
      // Rebuild symbol meta and restart WS if needed
      const newMeta = buildSymbolMeta(products, config.expiry, config.underlying, positions);
      const newSymbols = Object.keys(newMeta).sort().join(',');
      const oldSymbols = Object.keys(symbolMeta).sort().join(',');
      if (newSymbols !== oldSymbols) {
        symbolMeta = newMeta;
        startWebSocket();
      }
    } catch (e) {
      logError(`[${accountState.name}] Error in productTimer:`, e);
    }
  }, 5 * 60 * 1000);

  // Active positions, config and schedules refresh — every 5 minutes. This is only a
  // drift safety net now that Realtime reliably delivers account-scoped changes (config,
  // schedules and external position deletes), so a longer interval cuts redundant egress
  // (each cycle reads config + schedules + all positions-with-legs, per account).
  const positionsTimer = setInterval(async () => {
    try {
      await reloadConfigAndSync();
      await fetchSchedules(); // Refresh schedules periodically
      await fetchActivePositions();
      await reconcileOrphans();
    } catch (e) {
      logError(`[${accountState.name}] Error in positionsTimer:`, e);
    }
  }, 300000);

  // Live wallet balance poll — every 60s for armed live accounts, surfaced to the
  // dashboard via the heartbeat (Wallet / Allocated / per-position figures).
  const balanceTimer = setInterval(async () => {
    try {
      if (accountState.mode === 'live' && accountState.live_enabled) {
        const bal = await live.walletBalance();
        // Publish the SAME max-positions the engine uses for sizing (max of
        // calls+puts across the base config AND every schedule window) + the live
        // allocation %, so the UI's per-position figure matches the engine exactly.
        const hb = { max_positions: computeMaxPositions(), allocation_pct: config.balanceAllocationPct ?? 90 };
        if (bal != null) hb.wallet_balance = bal;
        heartbeat.update(hb);
        // Also clean up any positions the exchange has closed under us (bracket /
        // manual / external), so the books + KPI converge with Delta within ~60s.
        await reconcileOrphans();
      } else {
        heartbeat.update({ wallet_balance: null, max_positions: null, allocation_pct: null });
      }
    } catch (e) { /* non-fatal */ }
  }, 60000);

  // Live exchange snapshot — every 20s for armed live accounts, READS real Delta
  // state (positions, resting/stop orders, fills, balances) and upserts it to
  // `live_exchange_state` so the UI's Positions/Open Orders/Stop Orders/Fills/Risk
  // tabs show exchange truth. Read-only w.r.t. the exchange; runs in dry-run too.
  // Structural fingerprint of a snapshot — captures what the UI cares about CHANGING
  // (open position set + size, resting/stop orders, fills, wallet) while deliberately
  // IGNORING tick-by-tick noise (mark_price / unrealized_pnl / liquidation_price /
  // balance fluctuations). Used to skip redundant upserts (see below).
  const snapSignature = (s) => {
    if (!s) return '';
    const pos = (s.positions || []).map(p => `${p.product_symbol}:${p.size}:${p.entry_price ?? ''}`).sort().join('|');
    const ord = (s.orders || []).map(o => `${o.id}:${o.limit_price ?? o.price ?? ''}:${o.size}:${o.state ?? ''}`).sort().join('|');
    const stp = (s.stopOrders || []).map(o => `${o.id}:${o.stop_price ?? o.limit_price ?? ''}:${o.size}:${o.state ?? ''}`).sort().join('|');
    const fills = `${(s.fills || []).length}:${(s.fills || [])[0]?.id ?? ''}`;
    const hist = `${(s.orderHistory || []).length}:${(s.orderHistory || [])[0]?.id ?? ''}`;
    const wallet = s.wallet != null ? Number(s.wallet).toFixed(2) : '';
    return `${pos}#${ord}#${stp}#${fills}#${hist}#${wallet}`;
  };
  // Only re-publish when the structure changed, else at most once per keepalive window.
  // This turns a full-snapshot Realtime broadcast + UI refetch every 20s (per open tab)
  // into one only when something meaningful moved. The keepalive still refreshes
  // updated_at (liveness; UI marks stale after 120s) and mark/PnL at least this often.
  const SNAP_KEEPALIVE_MS = 60000;
  let lastSnapSig = null;
  let lastSnapUpsertAt = 0;
  // Order history is the slow part of a snapshot, so fetch it only every 4th tick
  // (~40s at a 10s interval) and reuse the cached value in between. `force` (Sync
  // button / after an action) always refreshes it.
  let snapTick = 0;
  let cachedOrderHistory = [];
  const publishLiveSnapshot = async (force = false) => {
    if (!(accountState.mode === 'live' && accountState.live_enabled)) return;
    try {
      const includeHistory = force || (snapTick % 4 === 0);
      snapTick++;
      const snap = await live.snapshot({ includeHistory });
      if (!snap) return;
      if (includeHistory && Array.isArray(snap.orderHistory)) cachedOrderHistory = snap.orderHistory;
      snap.orderHistory = cachedOrderHistory; // reuse cache on non-history ticks
      const sig = snapSignature(snap);
      const now = Date.now();
      if (sig === lastSnapSig && (now - lastSnapUpsertAt) < SNAP_KEEPALIVE_MS) return;
      const { error } = await supabase.from('live_exchange_state').upsert({
        account_id: accountState.id,
        updated_at: new Date().toISOString(),
        positions: snap.positions,
        orders: snap.orders,
        stop_orders: snap.stopOrders,
        fills: snap.fills,
        order_history: snap.orderHistory,
        balances: snap.balances,
        wallet: snap.wallet,
      }, { onConflict: 'account_id' });
      if (error) { logError(`[${accountState.name}] live_exchange_state upsert error:`, error.message); return; }
      lastSnapSig = sig;
      lastSnapUpsertAt = now;
    } catch (e) {
      logWarn(`[${accountState.name}] live snapshot publish failed: ${e.message}`);
    }
  };
  const liveSnapshotTimer = setInterval(() => { publishLiveSnapshot(); }, 10000);
  publishLiveSnapshot(true); // prime immediately (with history) so the UI isn't blank

  // Fast orphan reconcile — every 12s, so exchange-closed positions clear from
  // active_positions quickly and stop blocking new entries.
  const reconcileTimer = setInterval(() => { reconcileOrphans().catch(() => {}); }, 30000);

  // Manual-action requests (per-position exit, Close All, per-leg close, order
  // cancel) are polled at the MANAGER level in ONE batched query across all
  // accounts (see pollAllRequests) rather than per-account here. This keeps
  // Supabase egress flat as the account count grows (4 queries/tick total instead
  // of 4×N). The manager calls this engine's processRequests() only for the
  // request types that actually have pending work — same ~1.5s responsiveness.


  log(`[${accountState.name}] Paper Trading Engine is LIVE`);

  // ── Return cleanup function ───────────────────────────────────────────
  return {
    async stop(isDeleted = false) {
      log(`[${accountState.name}] Paper Trading Engine shutting down... (isDeleted: ${isDeleted})`);
      clearInterval(evalTimer);
      clearInterval(spotTimer);
      clearInterval(productTimer);
      clearInterval(positionsTimer);
      clearInterval(balanceTimer);
      clearInterval(liveSnapshotTimer);
      clearInterval(reconcileTimer);
      if (configReloadTimer) clearTimeout(configReloadTimer);
      if (scheduleReloadTimer) clearTimeout(scheduleReloadTimer);
      if (wsHandle) { wsHandle.close(); wsHandle = null; }
      supabase.removeChannel(configChannel);

      await heartbeat.stop(isDeleted);

      log(`[${accountState.name}] Paper Trading Engine stopped.`);
    },
    // Whether this account is currently armed for live trading. The manager uses
    // this to skip the live-only request polls (delta close/cancel) when nothing
    // is live — those handlers no-op for paper accounts anyway — and to scope them
    // to just the live account ids otherwise. Reads live accountState so it tracks
    // updateAccount() mode flips.
    isLive() { return accountState.mode === 'live' && accountState.live_enabled; },
    updateAccount(newAccount) {
      const prevMode = accountState.mode;
      accountState = newAccount;
      log(`[${accountState.name}] Account state updated (mode: ${accountState.mode}, live_enabled: ${accountState.live_enabled})`);
      // Reload credentials if the account switched into live mode or lost them.
      if (accountState.mode === 'live' && (prevMode !== 'live' || !liveCreds)) {
        loadCredentials().catch(e => logError(`[${accountState.name}] updateAccount credential reload failed:`, e));
      } else if (accountState.mode !== 'live') {
        liveCreds = null;
      }
    },
    // Called by the manager's consolidated request poll. `flags` tells us which
    // request types the batched query found pending for THIS account, so we run
    // only those handlers (each self-gates by re-querying + acting).
    async processRequests(flags = {}) {
      if (flags.manualEx) await processManualExits().catch(() => {});
      if (flags.closeAll) await processCloseAll().catch(() => {});
      if (flags.closeReq) await processCloseRequests().catch(() => {});
      if (flags.cancelReq) await processCancelRequests().catch(() => {});
    }
  };
}

// ── Multi-Account Engine Manager ──────────────────────────────────────

export async function startPaperTradingEngine() {
  const runningEngines = {}; // accountId -> engineHandle
  const startingEngines = new Set(); // accountIds with an in-flight start (race guard)

  async function startAccountEngine(account) {
    const accountId = account.id;
    // Reserve the slot SYNCHRONOUSLY before the await below. Without this, a
    // concurrent trigger (initial fetch, 30s fallback sync, Realtime account
    // event) could pass the `runningEngines` check while a start is mid-flight
    // and spawn a SECOND engine — the loser gets overwritten in the map and
    // becomes an unstoppable zombie that double-books every exit forever.
    if (runningEngines[accountId] || startingEngines.has(accountId)) {
      logWarn(`Account engine ${accountId} (${account.name}) is already running or starting.`);
      return;
    }
    startingEngines.add(accountId);
    log(`Starting engine for account ${accountId} (${account.name})...`);
    try {
      const handle = await startSingleAccountEngine(account);
      runningEngines[accountId] = handle;
    } catch (e) {
      logError(`Failed to start engine for account ${accountId}:`, e);
    } finally {
      startingEngines.delete(accountId);
    }
  }

  async function stopAccountEngine(accountId, isDeleted = false) {
    const handle = runningEngines[accountId];
    if (handle) {
      log(`Stopping engine for account ${accountId}... (isDeleted: ${isDeleted})`);
      try {
        await handle.stop(isDeleted);
      } catch (e) {
        logError(`Error stopping engine for account ${accountId}:`, e);
      }
      delete runningEngines[accountId];
    }
  }

  // Fetch all active accounts
  const { data: accounts, error } = await supabase
    .from('paper_trading_accounts')
    .select('*')
    .eq('is_active', true);

  if (error) {
    logError('Failed to fetch paper trading accounts:', error.message);
  } else if (accounts) {
    log(`Starting ${accounts.length} account engines in parallel...`);
    await Promise.allSettled(accounts.map(acc => startAccountEngine(acc)));
    log(`All account engines started.`);
  }

  // Subscribe to paper_trading_accounts changes
  const accountsChannel = supabase
    .channel('paper_trading_accounts_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'paper_trading_accounts' },
      async (payload) => {
        const { eventType, new: newRecord, old: oldRecord } = payload;
        log(`Account change event detected: ${eventType}`);

        if (eventType === 'INSERT') {
          if (newRecord.is_active) {
            await startAccountEngine(newRecord);
          }
        } else if (eventType === 'DELETE') {
          await stopAccountEngine(oldRecord.id, true);
        } else if (eventType === 'UPDATE') {
          if (!newRecord.is_active) {
            await stopAccountEngine(newRecord.id);
          } else {
            if (!runningEngines[newRecord.id]) {
              await startAccountEngine(newRecord);
            } else {
              runningEngines[newRecord.id].updateAccount(newRecord);
            }
          }
        }
      }
    )
    .subscribe();

  // Periodic sync check — every 30 seconds as fallback for missed Realtime events
  const syncTimer = setInterval(async () => {
    try {
      // Only the columns the engine actually consumes (id, name, mode, live_enabled,
      // paused) plus is_active for the running/stopping decision. Avoids pulling the
      // full row — including large encrypted-credential blobs — every 30s. Credentials
      // are loaded separately via RPC (loadCredentials), never from this row.
      const { data: currentAccounts, error: syncError } = await supabase
        .from('paper_trading_accounts')
        .select('id, name, mode, live_enabled, paused, is_active');

      if (syncError || !currentAccounts) {
        logError('Fallback sync: failed to fetch accounts:', syncError?.message);
        return;
      }

      const activeAccounts = currentAccounts.filter(a => a.is_active);
      const activeIds = new Set(activeAccounts.map(a => a.id));

      // 1. Stop engines that are no longer active or have been deleted
      for (const accountId of Object.keys(runningEngines)) {
        if (!activeIds.has(accountId)) {
          const stillExists = currentAccounts.some(a => a.id === accountId);
          log(`Fallback sync: Account ${accountId} is no longer active or deleted. Stopping engine.`);
          await stopAccountEngine(accountId, !stillExists);
        }
      }

      // 2. Start engines for active accounts that are not running, and update state for running ones
      for (const acc of activeAccounts) {
        const running = runningEngines[acc.id];
        if (!running) {
          log(`Fallback sync: Account ${acc.id} (${acc.name}) is active but not running. Starting engine.`);
          await startAccountEngine(acc);
        } else {
          running.updateAccount(acc);
        }
      }
    } catch (e) {
      logError('Fallback sync exception:', e);
    }
  }, 30000);

  // ── Credential verification watcher ───────────────────────────────────
  // The browser drops encrypted verify requests into delta_verify_requests; we
  // run the balance check from THIS server's whitelisted IP and write the result
  // back. Requires the service_role key (to decrypt); no-op otherwise.
  async function processVerifyRequests() {
    if (!hasServiceRole) return;
    try {
      const { data: pending, error } = await supabase
        .from('delta_verify_requests')
        .select('id')
        .eq('status', 'pending')
        .limit(5);
      if (error) { logError('Verify watcher fetch error:', error.message); return; }

      for (const row of pending || []) {
        let status = 'error';
        let errMsg = null;
        let balanceVal = null;
        try {
          const { data: creds, error: dErr } = await supabase
            .rpc('get_delta_verify_request_decrypted', { p_id: row.id });
          if (dErr || !creds || !creds[0]) {
            errMsg = dErr?.message || 'Could not decrypt request';
          } else {
            try {
              const balances = await getBalance({ apiKey: creds[0].api_key, apiSecret: creds[0].api_secret });
              balanceVal = extractBalance(balances);
              status = 'verified';
            } catch (e) {
              status = 'error';
              errMsg = e.message;
            }
          }
        } catch (e) {
          errMsg = e.message;
        }
        await supabase.from('delta_verify_requests')
          .update({ status, error: errMsg, balance: balanceVal, api_secret_enc: null, processed_at: new Date().toISOString() })
          .eq('id', row.id);
        log(`Delta verify request ${row.id}: ${status}${balanceVal != null ? ` (USDT ${balanceVal})` : ''}${errMsg ? ` (${errMsg})` : ''}`);
      }

      // Purge processed/stale requests older than 1 hour (they hold no secret once processed).
      const cutoff = new Date(Date.now() - 3600000).toISOString();
      await supabase.from('delta_verify_requests').delete().lt('created_at', cutoff);
    } catch (e) {
      logError('Verify watcher exception:', e);
    }
  }
  const verifyTimer = setInterval(processVerifyRequests, 4000);

  // ── Consolidated manual-action request poll ───────────────────────────
  // One batched query PER TABLE across ALL running accounts every 1.5s, replacing
  // each account engine's own 4-table poll. At N accounts this cuts idle
  // request-poll egress from 4×N queries/tick to 4/tick, while keeping the same
  // ~1.5s manual-action responsiveness. Only accounts with actual pending work
  // get their handlers invoked.
  async function pollAllRequests() {
    const ids = Object.keys(runningEngines);
    if (!ids.length) return;
    // delta_close_requests / delta_cancel_requests can only ever have work for
    // armed live accounts (their handlers no-op for paper). When nothing is live,
    // skip those two queries entirely — halving idle request-poll egress on a
    // paper-only deployment — and scope them to just the live ids when present.
    // closeAll + manualEx still cover ALL accounts, so manual-action responsiveness
    // is unchanged (same 1.5s cadence, same handlers fire).
    const liveIds = ids.filter(id => runningEngines[id]?.isLive?.());
    try {
      const [closeAllRes, closeReqRes, cancelReqRes, manualExRes] = await Promise.all([
        supabase.from('paper_trading_accounts').select('id').eq('close_all_requested', true).in('id', ids),
        liveIds.length
          ? supabase.from('delta_close_requests').select('account_id').in('account_id', liveIds)
          : Promise.resolve({ data: [] }),
        liveIds.length
          ? supabase.from('delta_cancel_requests').select('account_id').in('account_id', liveIds)
          : Promise.resolve({ data: [] }),
        supabase.from('active_positions').select('account_id').eq('exit_requested', true).in('account_id', ids),
      ]);
      const pending = {};
      const mark = (rows, key, field) => {
        for (const r of (rows || [])) {
          const id = r[field];
          if (!id) continue;
          if (!pending[id]) pending[id] = {};
          pending[id][key] = true;
        }
      };
      mark(closeAllRes.data, 'closeAll', 'id');
      mark(closeReqRes.data, 'closeReq', 'account_id');
      mark(cancelReqRes.data, 'cancelReq', 'account_id');
      mark(manualExRes.data, 'manualEx', 'account_id');
      for (const [accountId, flags] of Object.entries(pending)) {
        const engine = runningEngines[accountId];
        if (engine?.processRequests) engine.processRequests(flags).catch(() => {});
      }
    } catch (e) {
      logError('Consolidated request poll error:', e);
    }
  }
  const requestPollTimer = setInterval(() => { pollAllRequests().catch(() => {}); }, 1500);

  return {
    async stop() {
      log('Shutting down all running account engines...');
      clearInterval(syncTimer);
      clearInterval(verifyTimer);
      clearInterval(requestPollTimer);
      supabase.removeChannel(accountsChannel);
      for (const accountId of Object.keys(runningEngines)) {
        await stopAccountEngine(accountId);
      }
      log('All account engines shut down.');
    }
  };
}
