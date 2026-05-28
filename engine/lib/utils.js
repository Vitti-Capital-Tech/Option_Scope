/**
 * Shared utility functions for the server-side trading engine.
 * Extracted from scannerUtils.js, PaperTrading.jsx, and ATMExitTrading.jsx.
 * No browser/React dependencies.
 */

export function normalizeIv(iv) {
  if (!Number.isFinite(iv)) return null;
  return iv <= 1 ? iv * 100 : iv;
}

export function toFiniteNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function matchesOptionType(product, optionType) {
  const wanted = optionType === 'call' ? 'call_options' : 'put_options';
  return product?.contract_type === wanted
    || product?.contract_types === wanted
    || (optionType === 'call' ? /^C-/.test(product?.symbol || '') : /^P-/.test(product?.symbol || ''));
}

export function calculateFee(price, spot, qty, lotSize) {
  if (!price || !spot) return 0;
  const feePerUnit = Math.min(0.035 * price, 0.0001 * spot);
  return feePerUnit * qty * lotSize;
}

export function safeParseLeg(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  return null;
}

/**
 * Tiered margin calculation matching Delta Exchange leverage tiers.
 * margin = (entryBuyPrice × buyLotSize) + (shortValue / leverage)
 */
export function calcMargin(buyPrice, buyLot, spot, sellQty, sellLot = 1) {
  const longMargin = (buyPrice || 0) * (buyLot || 1);
  const shortValue = Math.min(200000, (spot || 0) * (sellQty || 0) * sellLot);
  const leverage = 200; // Fixed leverage as 200
  return longMargin + (shortValue / leverage);
}

/**
 * Greedy selection of top N spreads with unique buy strikes.
 * Scans the sorted pair list and adds spreads whose buy strike
 * has not been seen yet, up to the requested limit.
 */
export function pickTopUniqueStrikes(spreads, limit = 3) {
  const out = [];
  const seenBuy = new Set();
  for (const s of spreads) {
    const bStrike = s?.buyLeg?.strike != null ? Number(s.buyLeg.strike) : null;
    if (bStrike == null) continue;
    if (seenBuy.has(bStrike)) continue;
    seenBuy.add(bStrike);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * O(N²) pair scanner for ratio spread candidates.
 * Identical logic to PaperTrading.jsx scanTickers / ATMExitTrading.jsx scanTickers.
 */
export function scanTickers(tickers, config, spotPrice) {
  const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
  const validPairs = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const buy = sorted[i];
      const sell = sorted[j];
      let buyLeg, sellLeg;

      if (buy.type === 'call') {
        buyLeg = buy; sellLeg = sell;
      } else {
        buyLeg = sell; sellLeg = buy;
      }

      const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
      if (strikeDiff < config.minStrikeDiff) continue;

      const buyPrice = buyLeg.ask ?? buyLeg.markPrice;
      const sellPrice = sellLeg.bid ?? sellLeg.markPrice;
      const buyIv = buyLeg.askIv ?? buyLeg.iv;
      const sellIv = sellLeg.bidIv ?? sellLeg.iv;

      if (buyIv == null || sellIv == null) continue;
      const ivDiff = Math.abs(buyIv - sellIv);
      if (ivDiff < config.minIvDiff) continue;

      const spotDist = Math.abs(buyLeg.strike - spotPrice);
      if (spotDist < (config.minLongDist || 0)) continue;

      if (!sellPrice || sellPrice < config.minSellPremium) continue;

      const buyDN = buyLeg.deltaNotional;
      const sellDN = sellLeg.deltaNotional;
      if (!buyDN || !sellDN || !buyPrice || !sellPrice) continue;

      const premiumRatio = buyPrice / sellPrice;
      const deltaNotionalRatio = buyDN / sellDN;
      const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
      if (ratioDeviation > config.maxRatioDeviation) continue;

      const rawQty = buyDN / sellDN;
      const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
      if (sellQty > (config.maxSellQty || 10)) continue;

      const netPrem = buyPrice - sellQty * sellPrice;

      if (netPrem > config.maxNetPremium) continue;

      validPairs.push({
        buyLeg, sellLeg, strikeDiff, sellQty,
        netPremium: netPrem, buyPrice, sellPrice, buyIv, sellIv
      });
    }
  }

  validPairs.sort((a, b) => {
    const distA = Math.abs(a.buyLeg.strike - spotPrice);
    const distB = Math.abs(b.buyLeg.strike - spotPrice);
    if (distA !== distB) return distA - distB;
    return a.netPremium - b.netPremium;
  });

  return validPairs.slice(0, 50);
}

/**
 * Format a timestamp for console logging.
 */
export function formatLog(msg) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  return `[${ts}] ${msg}`;
}

export function log(msg) {
  console.log(formatLog(msg));
}

export function logWarn(msg) {
  console.warn(formatLog(`⚠ ${msg}`));
}

export function logError(msg, err) {
  console.error(formatLog(`✖ ${msg}`), err || '');
}
