import os

code = """
  const getSymbolMeta = useCallback(() => {
    if (!selExpiry || !products.length) return {};
    const strikes = getStrikes(products, selExpiry);
    const symbolMeta = {};
    for (const strike of strikes) {
      const callProd = products.find(p => p.settlement_time === selExpiry && parseFloat(p.strike_price) === parseFloat(strike) && matchesOptionType(p, 'call'));
      if (callProd) {
        const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
        symbolMeta[callProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'call', symbol: callProd.symbol };
      }
      const putProd = products.find(p => p.settlement_time === selExpiry && parseFloat(p.strike_price) === parseFloat(strike) && matchesOptionType(p, 'put'));
      if (putProd) {
        const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
        symbolMeta[putProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'put', symbol: putProd.symbol };
      }
    }
    positionsRef.current.forEach(pos => {
      if (pos.underlying === underlying) {
        if (pos.buyLeg && !symbolMeta[pos.buyLeg.symbol]) symbolMeta[pos.buyLeg.symbol] = { strike: pos.buyLeg.strike, lotSize: pos.buyLeg.lotSize, type: pos.type, symbol: pos.buyLeg.symbol };
        if (pos.sellLeg && !symbolMeta[pos.sellLeg.symbol]) symbolMeta[pos.sellLeg.symbol] = { strike: pos.sellLeg.strike, lotSize: pos.sellLeg.lotSize, type: pos.type, symbol: pos.sellLeg.symbol };
      }
    });
    return symbolMeta;
  }, [selExpiry, products, underlying]);

  const refreshAllTickers = useCallback(async () => {
    const symbolMeta = getSymbolMeta();
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.length) return false;
    try {
      const res = await getTickers(underlying, allSymbols);
      if (res) {
        const backfill = {};
        res.forEach(t => {
          const meta = symbolMeta[t.symbol];
          if (meta) {
            const prev = latestTickerDataRef.current[t.symbol];
            const markPrice = toFiniteNumber(t.mark_price ?? t.last_price ?? t.close);
            const iv = normalizeIv(toFiniteNumber(t.mark_vol ?? t.quotes?.mark_iv ?? t.greeks?.iv));
            const bid = toFiniteNumber(t.quotes?.best_bid);
            const ask = toFiniteNumber(t.quotes?.best_ask);
            const bidIv = normalizeIv(toFiniteNumber(t.quotes?.best_bid_iv));
            const askIv = normalizeIv(toFiniteNumber(t.quotes?.best_ask_iv));
            backfill[t.symbol] = {
              symbol: t.symbol, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
              markPrice: (markPrice && markPrice > 0) ? markPrice : (prev?.markPrice ?? null),
              bid: bid ?? (prev?.bid ?? null), ask: ask ?? (prev?.ask ?? null),
              bidIv: bidIv ?? (prev?.bidIv ?? null), askIv: askIv ?? (prev?.askIv ?? null),
              iv: iv ?? (prev?.iv ?? null),
              delta: t.greeks ? toFiniteNumber(t.greeks.delta) : (prev?.delta ?? null),
              deltaNotional: t.greeks ? Math.abs(t.greeks.delta) * meta.lotSize : (prev?.deltaNotional ?? null),
            };
          }
        });
        latestTickerDataRef.current = { ...latestTickerDataRef.current, ...backfill };
        setTickerData(prev => ({ ...prev, ...backfill }));
        return true;
      }
    } catch (e) {}
    return false;
  }, [underlying, getSymbolMeta]);

  const startTrading = useCallback(() => {
    if (!selExpiry || !products.length) return;
    const configSymbols = [...new Set(products.map(p => p.symbol))];
    const symHash = configSymbols.sort().join(',');
    if (wsRef.current && lastWsSymbolsRef.current === symHash) return;
    if (wsRef.current) { try { wsRef.current.close(); } catch (e) {} wsRef.current = null; }
    lastWsSymbolsRef.current = symHash;
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(true);
    setTickerData({});
    latestTickerDataRef.current = {};
    lastEvaluatedRef.current = 0;
    setLastEvaluated(0);
    setTimeRemaining(null);

    const symbolMeta = getSymbolMeta();
    const allSymbols = Object.keys(symbolMeta);
    if (allSymbols.length < 2) { setTrading(false); return; }

    refreshAllTickers().then(success => {
      if (success) setTimeout(() => evaluateStrategy(true), 100);
    });

    wsRef.current = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        const meta = symbolMeta[sym];
        if (!meta) return;
        const markPrice = toFiniteNumber(msg.mark_price ?? msg.last_price ?? msg.close);
        const bid = toFiniteNumber(msg.quotes?.best_bid);
        const ask = toFiniteNumber(msg.quotes?.best_ask);
        const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.best_bid_iv));
        const askIv = normalizeIv(toFiniteNumber(msg.quotes?.best_ask_iv));
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;
        const prevBuffered = tickerBufferRef.current[sym] ?? latestTickerDataRef.current[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
          markPrice: markPrice ?? prevBuffered?.markPrice ?? null,
          bid: bid ?? prevBuffered?.bid ?? null, ask: ask ?? prevBuffered?.ask ?? null,
          bidIv: bidIv ?? prevBuffered?.bidIv ?? null, askIv: askIv ?? prevBuffered?.askIv ?? null,
          iv: iv ?? prevBuffered?.iv ?? null, delta: delta !== null ? delta : prevBuffered?.delta,
          deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prevBuffered?.deltaNotional,
        };
        if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
      },
      () => {}
    );
  }, [selExpiry, products, flushTickerBuffer, getSymbolMeta, refreshAllTickers]);

  useEffect(() => { if (products.length && selExpiry) startTrading(); }, [products, selExpiry, startTrading]);

  const stopTrading = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    tickerBufferRef.current = {};
    setTrading(false);
  }, []);

  const scanTickers = useCallback((tickers) => {
    const sorted = [...tickers].sort((a, b) => a.strike - b.strike);
    const validPairs = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const buy = sorted[i], sell = sorted[j];
        let buyLeg, sellLeg;
        if (buy.type === 'call') { buyLeg = buy; sellLeg = sell; } 
        else { buyLeg = sell; sellLeg = buy; }

        const strikeDiff = Math.abs(sellLeg.strike - buyLeg.strike);
        if (strikeDiff < config.minStrikeDiff) continue;
        
        const buyPrice = buyLeg.ask ?? buyLeg.markPrice;
        const sellPrice = sellLeg.bid ?? sellLeg.markPrice;
        const buyIv = buyLeg.askIv ?? buyLeg.iv;
        const sellIv = sellLeg.bidIv ?? sellLeg.iv;
        if (buyIv == null || sellIv == null) continue;
        
        const ivDiff = Math.abs(buyIv - sellIv);
        if (ivDiff <= config.minIvDiff) continue;
        const spotDist = Math.abs(buyLeg.strike - spotPrice);
        if (spotDist < (config.minLongDist || 0)) continue;
        if (!sellPrice || sellPrice < config.minSellPremium) continue;

        const buyDN = buyLeg.deltaNotional, sellDN = sellLeg.deltaNotional;
        if (!buyDN || !sellDN || !buyPrice || !sellPrice) continue;
        
        const premiumRatio = buyPrice / sellPrice, deltaNotionalRatio = buyDN / sellDN;
        const ratioDeviation = Math.abs(premiumRatio - deltaNotionalRatio) / deltaNotionalRatio;
        if (ratioDeviation > config.maxRatioDeviation) continue;
        
        const rawQty = buyDN / sellDN;
        const sellQty = Math.max(1, Math.round(rawQty / 0.25) * 0.25);
        if (sellQty > (config.maxSellQty || 10)) continue;
        
        const netPrem = buyPrice - sellQty * sellPrice;
        const maxNet = Math.abs(config.maxNetPremium);
        if (netPrem < -maxNet || netPrem > maxNet) continue;

        validPairs.push({ buyLeg, sellLeg, strikeDiff, sellQty, netPremium: netPrem, buyPrice, sellPrice, buyIv, sellIv });
      }
    }
    validPairs.sort((a, b) => {
      const distA = Math.abs(a.buyLeg.strike - spotPrice);
      const distB = Math.abs(b.buyLeg.strike - spotPrice);
      if (distA !== distB) return distA - distB;
      return a.netPremium - b.netPremium;
    });
    return validPairs.slice(0, 50);
  }, [config, spotPrice]);

  const pickTopUniqueStrikes = useCallback((spreads, limit = 3) => {
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
  }, []);
"""

with open('src/ATMExitTrading.jsx', 'a', encoding='utf-8') as f:
    f.write(code)

print("Part 3 written successfully.")
