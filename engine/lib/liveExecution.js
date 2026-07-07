/**
 * Live-execution layer for the paper trading engine.
 *
 * Wraps real Delta Exchange order placement behind two gates:
 *   1. Per-account arming:  mode === 'live' && live_enabled  (else: no orders at all)
 *   2. Global dry-run flag:  DELTA_LIVE_DRYRUN (default TRUE) — when on, intended
 *      orders are LOGGED but never sent, so the whole path can be validated against
 *      a real account before any money moves.
 *
 * The engine's paper bookkeeping is unchanged: these helpers are additive
 * side-effects invoked at the same points where positions are written to Supabase.
 *
 * ⚠ SIZE UNITS: the paper engine sizes positions as fractional notional "lots"
 * (contract_size-scaled). Delta orders take an INTEGER number of contracts. The
 * contract counts below are a BEST-EFFORT mapping (≈1 contract per long unit,
 * `sellQty` for the short). Validate the dry-run order log against your intended
 * real sizes BEFORE arming an account.
 */
import { placeOrder, getLivePositions, getBalance } from './deltaTradeApi.js';
import { log, logWarn, logError } from './utils.js';

// Default ON. Only the literal string 'false' (any case) disarms the dry-run.
const DRY_RUN = String(process.env.DELTA_LIVE_DRYRUN ?? 'true').toLowerCase() !== 'false';

export function isLiveDryRun() {
  return DRY_RUN;
}

/** Best-effort integer contract count for a long leg quantity. */
export function longContracts(leg, lotOverride = null) {
  const qty = lotOverride != null ? lotOverride : (leg?.lotSize || 0);
  const base = leg?.originalLotSize || leg?.lotSize || 1;
  return Math.max(1, Math.round(qty / base));
}

/** Best-effort integer contract count for a short leg (sellQty is already a lot ratio). */
export function shortContracts(sellQty) {
  return Math.max(1, Math.round(sellQty || 0));
}

/**
 * Extract a usable wallet balance from Delta's /v2/wallet/balances response,
 * tolerant of asset naming/shape: prefer USDT, then USD, else the wallet with the
 * largest balance. Reads balance/available_balance regardless of nesting.
 */
export function extractBalance(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return null;
  const sym = (b) => String(b.asset_symbol || b.asset?.symbol || '').toUpperCase();
  const amt = (b) => {
    const v = parseFloat(b.balance ?? b.available_balance ?? b.wallet_balance ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  const pick =
    balances.find((b) => sym(b) === 'USDT') ||
    balances.find((b) => sym(b) === 'USD') ||
    [...balances].sort((a, b) => amt(b) - amt(a))[0];
  if (!pick) return null;
  const v = amt(pick);
  return Number.isFinite(v) ? v : null;
}

/**
 * @param getCtx () => ({ accountName, mode, liveEnabled, creds })
 *   `creds` = { apiKey, apiSecret } or null.
 */
export function createLiveExecutor(getCtx) {
  let warnedNoCreds = false;

  function armed() {
    const { mode, liveEnabled } = getCtx();
    return mode === 'live' && !!liveEnabled;
  }

  async function submit({ symbol, side, contracts, price, reduceOnly = false, tag }) {
    const { accountName, creds } = getCtx();
    const size = Math.max(1, Math.round(contracts || 0));
    const priceStr = (price != null && Number.isFinite(price)) ? String(price) : null;
    const summary = `${side.toUpperCase()} ${size}x ${symbol} @ ${priceStr ?? '—'}${reduceOnly ? ' reduceOnly' : ''} [${tag}]`;

    if (DRY_RUN) {
      log(`[${accountName}] 🧪 DRY-RUN live order (not sent): ${summary}`);
      return { ok: true, dryRun: true };
    }

    if (!creds?.apiKey || !creds?.apiSecret) {
      if (!warnedNoCreds) {
        logError(`[${accountName}] LIVE armed but no decrypted credentials available — cannot place orders. (Is the engine using the service_role key?)`);
        warnedNoCreds = true;
      }
      return { ok: false, error: 'no-credentials' };
    }
    if (!priceStr) {
      logError(`[${accountName}] LIVE order skipped — no valid limit price: ${summary}`);
      return { ok: false, error: 'no-price' };
    }

    try {
      const order = await placeOrder(creds, {
        product_symbol: symbol,
        size,
        side,
        order_type: 'limit_order',
        limit_price: priceStr,
        time_in_force: 'gtc',
        reduce_only: !!reduceOnly,
        client_order_id: tag,
      });
      log(`[${accountName}] ✅ LIVE order sent: ${summary} → id ${order?.id ?? '?'} state ${order?.state ?? '?'}`);
      return { ok: true, order };
    } catch (e) {
      logError(`[${accountName}] ✖ LIVE order FAILED: ${summary}:`, e.message);
      return { ok: false, error: e.message };
    }
  }

  return {
    isArmed: armed,
    dryRun: DRY_RUN,

    /**
     * Open a spread: buy the long leg (@ ask), sell the short leg (@ bid).
     * Returns { ok }. On the SELL leg failing after the BUY succeeded (live send
     * only), the caller should NOT persist the position; we log for reconciliation.
     */
    async openSpread(pos, { long, short, buyPrice, sellPrice }) {
      if (!armed()) return { ok: true, skipped: true };
      const buy = await submit({
        symbol: pos.buyLeg.symbol, side: 'buy', contracts: long,
        price: buyPrice ?? pos.entryBuyPrice, reduceOnly: false, tag: `${pos.id}-EB`,
      });
      if (!buy.ok) return { ok: false, legFailed: 'buy', error: buy.error };

      if (short > 0) {
        const sell = await submit({
          symbol: pos.sellLeg.symbol, side: 'sell', contracts: short,
          price: sellPrice ?? pos.entrySellPrice, reduceOnly: false, tag: `${pos.id}-ES`,
        });
        if (!sell.ok) {
          const { accountName } = getCtx();
          logError(`[${accountName}] ⚠ Entry SELL leg failed after BUY leg placed for ${pos.id} — manual reconciliation may be required.`);
          return { ok: false, legFailed: 'sell', error: sell.error, buyOrder: buy.order };
        }
        return { ok: true, buyOrder: buy.order, sellOrder: sell.order };
      }
      return { ok: true, buyOrder: buy.order };
    },

    /** Close (or reduce) a single leg. `side` is the closing side. */
    async closeLeg({ symbol, side, contracts, price, tag }) {
      if (!armed()) return { ok: true, skipped: true };
      return submit({ symbol, side, contracts, price, reduceOnly: true, tag });
    },

    /**
     * Place a resting reduce_only STOP (market) order triggered on the INDEX
     * (spot_price). Used for the short-leg SL and long-leg TP in the live model.
     * `side` is the closing side (buy to close a short, sell to close a long).
     */
    async placeStop({ symbol, side, contracts, stopPrice, tag }) {
      if (!armed()) return { ok: true, skipped: true };
      const { accountName, creds } = getCtx();
      const size = Math.max(1, Math.round(contracts || 0));
      const stopStr = (stopPrice != null && Number.isFinite(stopPrice)) ? String(stopPrice) : null;
      const summary = `STOP ${side.toUpperCase()} ${size}x ${symbol} trigger@index ${stopStr ?? '—'} reduceOnly [${tag}]`;

      if (DRY_RUN) {
        log(`[${accountName}] 🧪 DRY-RUN stop order (not sent): ${summary}`);
        return { ok: true, dryRun: true };
      }
      if (!creds?.apiKey || !creds?.apiSecret) {
        if (!warnedNoCreds) { logError(`[${accountName}] LIVE armed but no credentials — cannot place stop.`); warnedNoCreds = true; }
        return { ok: false, error: 'no-credentials' };
      }
      if (!stopStr) {
        logError(`[${accountName}] LIVE stop skipped — no valid stop price: ${summary}`);
        return { ok: false, error: 'no-stop-price' };
      }
      try {
        const order = await placeOrder(creds, {
          product_symbol: symbol,
          size,
          side,
          order_type: 'market_order',
          stop_order_type: 'stop_loss_order',
          stop_price: stopStr,
          stop_trigger_method: 'spot_price', // index/spot-triggered
          reduce_only: true,
          client_order_id: tag,
        });
        log(`[${accountName}] ✅ LIVE stop placed: ${summary} → id ${order?.id ?? '?'} state ${order?.state ?? '?'}`);
        return { ok: true, order };
      } catch (e) {
        logError(`[${accountName}] ✖ LIVE stop FAILED: ${summary}:`, e.message);
        return { ok: false, error: e.message };
      }
    },

    /** Raw open positions from the exchange (armed accounts only), else []. */
    async positions() {
      if (!armed()) return [];
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return [];
      try {
        const res = await getLivePositions(creds);
        return Array.isArray(res) ? res : [];
      } catch (e) {
        logWarn(`[${accountName}] positions() fetch failed: ${e.message}`);
        return [];
      }
    },

    /**
     * Live USDT wallet balance (armed accounts only). This is a READ, so it runs
     * even in dry-run — the sizing math needs the real balance to be validated.
     * Returns null if not armed, no creds, or the balance can't be read.
     */
    async walletBalance() {
      if (!armed()) return null;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return null;
      try {
        const balances = await getBalance(creds);
        return extractBalance(balances);
      } catch (e) {
        logWarn(`[${accountName}] Wallet balance fetch failed: ${e.message}`);
        return null;
      }
    },

    /** Log-only reconciliation: compare engine position count with the exchange. */
    async reconcile(enginePositionCount) {
      if (!armed() || DRY_RUN) return;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return;
      try {
        const live = await getLivePositions(creds);
        const openLive = Array.isArray(live) ? live.filter(p => Number(p.size) !== 0).length : 0;
        // Exchange positions are per-leg; the engine counts spreads (1–2 legs each),
        // so this is informational — flag only the clearly-wrong "engine open but
        // exchange flat" case.
        if (enginePositionCount > 0 && openLive === 0) {
          logWarn(`[${accountName}] RECONCILE: engine holds ${enginePositionCount} position(s) but Delta reports 0 open legs — review manually.`);
        } else {
          log(`[${accountName}] Reconcile: engine ${enginePositionCount} spread(s) / Delta ${openLive} open leg(s).`);
        }
      } catch (e) {
        logWarn(`[${accountName}] Reconcile check failed: ${e.message}`);
      }
    },
  };
}
