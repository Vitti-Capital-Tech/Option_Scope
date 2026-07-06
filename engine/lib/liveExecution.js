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
import { placeOrder, getLivePositions } from './deltaTradeApi.js';
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
    async openSpread(pos, { long, short }) {
      if (!armed()) return { ok: true, skipped: true };
      const buy = await submit({
        symbol: pos.buyLeg.symbol, side: 'buy', contracts: long,
        price: pos.entryBuyPrice, reduceOnly: false, tag: `${pos.id}-EB`,
      });
      if (!buy.ok) return { ok: false, legFailed: 'buy', error: buy.error };

      if (short > 0) {
        const sell = await submit({
          symbol: pos.sellLeg.symbol, side: 'sell', contracts: short,
          price: pos.entrySellPrice, reduceOnly: false, tag: `${pos.id}-ES`,
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

    /** Log-only reconciliation: compare engine position count with the exchange. */
    async reconcile(enginePositionCount) {
      if (!armed() || DRY_RUN) return;
      const { accountName, creds } = getCtx();
      if (!creds?.apiKey) return;
      try {
        const live = await getLivePositions(creds);
        const openLive = Array.isArray(live) ? live.filter(p => Number(p.size) !== 0).length : 0;
        if (openLive !== enginePositionCount) {
          logWarn(`[${accountName}] RECONCILE drift: engine has ${enginePositionCount} position(s), Delta reports ${openLive} open. Review manually.`);
        } else {
          log(`[${accountName}] Reconcile OK: ${openLive} live position(s) match engine.`);
        }
      } catch (e) {
        logWarn(`[${accountName}] Reconcile check failed: ${e.message}`);
      }
    },
  };
}
