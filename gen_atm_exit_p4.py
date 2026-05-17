import os

code = """
  const evaluateStrategy = useCallback(async (force = false) => {
    if (!trading || !spotPrice || isEvaluatingRef.current) return;
    isEvaluatingRef.current = true;
    try {
      const allTickers = Object.values(latestTickerDataRef.current);
      if (allTickers.length === 0) return;

      const nowTime = Date.now();
      const currentMinute = Math.floor(nowTime / 60000);
      const lastMinute = Math.floor(lastEvaluatedRef.current / 60000);

      const shouldEvaluateAlgo = force || currentMinute > lastMinute || lastEvaluatedRef.current === 0;

      if (!shouldEvaluateAlgo) {
        if (nowTime - lastEvaluatedRef.current < 1000) return;
        setPositions(prev => {
          if (prev.length === 0) return prev;
          const live = latestTickerDataRef.current;
          return prev.map(pos => {
            const tickerBuy = live[pos.buyLeg.symbol];
            const latestBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice ?? pos.buyLeg.markPrice;
            const tickerSell = live[pos.sellLeg.symbol];
            const latestSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice ?? pos.sellLeg.markPrice;

            const buyPnl = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
            const sellPnl = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) * pos.sellQty : 0;
            const grossPnl = (buyPnl * pos.buyLeg.lotSize) - (sellPnl * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);

            const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
            const totalFees = (pos.entryFee || 0) + exitFee;
            return { ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees };
          });
        });
        lastEvaluatedRef.current = nowTime;
        return;
      }

      const nowAtEval = Date.now();
      lastEvaluatedRef.current = nowAtEval;
      setLastEvaluated(nowAtEval);

      if (currentMinute % 5 === 0) refreshProducts();

      let atmStrike = null;
      let minDiff = Infinity;
      for (const t of allTickers) {
        const diff = Math.abs(t.strike - spotPrice);
        if (diff < minDiff) { minDiff = diff; atmStrike = t.strike; }
      }

      const callTickers = allTickers.filter(t => t.type === 'call' && (atmStrike === null || t.strike >= atmStrike));
      const putTickers = allTickers.filter(t => t.type === 'put' && (atmStrike === null || t.strike <= atmStrike));

      const topSpreads = [...scanTickers(callTickers), ...scanTickers(putTickers)];
      const uniqueTopSpreads = [...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'call'), 10), ...pickTopUniqueStrikes(topSpreads.filter(s => s.buyLeg.type === 'put'), 10)];

      const prevPositions = positionsRef.current;
      const activeCallsCount = prevPositions.filter(p => p.type === 'call' && p.underlying === underlying).length;
      const activePutsCount = prevPositions.filter(p => p.type === 'put' && p.underlying === underlying).length;
      let callRotationsApproved = 0, putRotationsApproved = 0;
      const MAX_ROTATIONS = 3;

      const remaining = [], exited = [];
      const sortedPositions = [...prevPositions].sort((a, b) => Math.abs(b.buyLeg.strike - spotPrice) - Math.abs(a.buyLeg.strike - spotPrice));
      
      for (const pos of sortedPositions) {
        if (pos.underlying !== underlying) { remaining.push(pos); continue; }

        const live = latestTickerDataRef.current;
        const tickerBuy = live[pos.buyLeg.symbol], tickerSell = live[pos.sellLeg.symbol];
        const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
        const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice;

        if (liveExitBuy == null || liveExitSell == null) { remaining.push(pos); continue; }

        const latestBuy = liveExitBuy, latestSell = liveExitSell;
        let shouldExit = false, exitReason = '', zombieExitTime = null;

        const expiryTs = new Date(pos.expiry).getTime();
        if (Date.now() >= expiryTs - 120000) {
          shouldExit = true; exitReason = 'Expiry Reached';
          if (Date.now() > expiryTs + 600000) zombieExitTime = new Date(expiryTs).toISOString();
        }

        const buyPriceDiff = (latestBuy != null && pos.entryBuyPrice != null) ? (latestBuy - pos.entryBuyPrice) : 0;
        const sellPriceDiff = (latestSell != null && pos.entrySellPrice != null) ? (latestSell - pos.entrySellPrice) : 0;
        const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) - (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);
        const exitFee = calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
        const totalFees = (pos.entryFee || 0) + exitFee;

        const inTop3 = uniqueTopSpreads.some(s => s.buyLeg.type === pos.type && Number(s.buyLeg.strike) === Number(pos.buyLeg.strike));

        if (!shouldExit && pos.expiry === selExpiry && uniqueTopSpreads.length > 0 && !inTop3) {
          shouldExit = true; exitReason = `Lost Top 3`;
        }

        if (!shouldExit) {
          // Exit 100% ATM ONLY
          const isCall = pos.type === 'call';
          const buyStrike = pos.buyLeg.strike;
          const isAtmMET = isCall ? spotPrice >= buyStrike : spotPrice <= buyStrike;
          if (isAtmMET) {
            shouldExit = true; exitReason = 'Full Exit @ ATM';
          }
        }

        const canRotate = pos.type === 'call' ? (activeCallsCount >= 3 && callRotationsApproved < MAX_ROTATIONS) : (activePutsCount >= 3 && putRotationsApproved < MAX_ROTATIONS);
        let rotationApproved = false;
        if (!canRotate && exitReason.includes('Lost Top 3')) {
          if (shouldExit) shouldExit = false;
        } else if (canRotate && exitReason.includes('Lost Top 3')) {
          if (shouldExit) {
            rotationApproved = true;
            if (pos.type === 'call') callRotationsApproved++; else putRotationsApproved++;
          }
        }

        if (shouldExit) {
          if (exitReason.includes('Lost Top 3') && !rotationApproved) {
            shouldExit = false;
            remaining.push({ ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees });
            continue;
          }
          const tradeRecord = {
            ...pos, exitTime: new Date(), exitBuyPrice: latestBuy, exitSellPrice: latestSell, exitSpotPrice: spotPrice,
            realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, entryFee: pos.entryFee || 0, exitFee, totalFees, exitReason,
            _latestBuy: latestBuy, _latestSell: latestSell, zombieExitTime
          };
          exited.push(tradeRecord);
        } else {
          remaining.push({ ...pos, currentBuyPrice: latestBuy, currentSellPrice: latestSell, unrealizedGrossPnl: grossPnl, unrealizedNetPnl: grossPnl - totalFees, currentExitFee: exitFee, currentTotalFees: totalFees, margin: calcMargin(pos.entryBuyPrice, pos.buyLeg.lotSize, Math.max(pos.entrySpotPrice || spotPrice, spotPrice), pos.sellQty, pos.sellLeg.lotSize) });
        }
      }

      const newEntries = [];
      const callsRef = lastEntrySpotRef.current.call;
      const putsRef = lastEntrySpotRef.current.put;

      for (const spread of topSpreads) {
        const spreadType = spread.buyLeg.type;
        const count = remaining.filter(p => p.underlying === underlying && p.type === spreadType).length + newEntries.filter(p => p.underlying === underlying && p.type === spreadType).length;
        if (count >= 3) continue;

        const minutesToExpiry = (new Date(spread.expiry).getTime() - Date.now()) / 60000;
        if (minutesToExpiry < 5) continue;

        // Entry Spot Gating
        const lastEntrySpot = spreadType === 'call' ? callsRef : putsRef;
        if (lastEntrySpot !== null && count > 0) {
          if (Math.abs(spotPrice - lastEntrySpot) / lastEntrySpot < 0.005) {
            continue;
          }
        }

        const existingOfType = remaining.filter(p => p.underlying === underlying && p.type === spreadType);
        const candidateLongStrike = Number(spread.buyLeg.strike);
        
        let validStrikeDiff = true;
        for (const p of existingOfType) {
          if (Math.abs(candidateLongStrike - Number(p.buyLeg.strike)) < 400) { validStrikeDiff = false; break; }
        }
        if (!validStrikeDiff) continue;
        
        const buyConflict = remaining.some(p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === candidateLongStrike) || newEntries.some(p => p.underlying === underlying && p.type === spreadType && Number(p.buyLeg.strike) === candidateLongStrike);
        const sellConflict = remaining.some(p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === Number(spread.sellLeg.strike)) || newEntries.some(p => p.underlying === underlying && p.type === spreadType && Number(p.sellLeg.strike) === Number(spread.sellLeg.strike));
        if (buyConflict || sellConflict) continue;

        const entryFee = calculateFee(spread.buyPrice, spotPrice, 1, spread.buyLeg.lotSize) + calculateFee(spread.sellPrice, spotPrice, spread.sellQty, spread.sellLeg.lotSize);
        const id = `ATM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        newEntries.push({
          id, underlying, expiry: selExpiry, type: spreadType, buyLeg: spread.buyLeg, sellLeg: spread.sellLeg,
          sellQty: spread.sellQty, strikeDiff: spread.strikeDiff, entryTime: new Date(), entryBuyPrice: spread.buyPrice,
          entrySellPrice: spread.sellPrice, entrySpotPrice: spotPrice, currentBuyPrice: spread.buyPrice, currentSellPrice: spread.sellPrice,
          unrealizedGrossPnl: 0, unrealizedNetPnl: -entryFee, entryFee, currentExitFee: entryFee, currentTotalFees: entryFee * 2,
          margin: calcMargin(spread.buyPrice, spread.buyLeg.lotSize, spotPrice, spread.sellQty, spread.sellLeg.lotSize)
        });

        if (spreadType === 'call') lastEntrySpotRef.current.call = spotPrice;
        else lastEntrySpotRef.current.put = spotPrice;
      }

      if (exited.length > 0 || newEntries.length > 0) lastDbWriteRef.current = Date.now();

      if (exited.length > 0) {
        setTradeHistory(th => [...exited, ...th]);
        for (const t of exited) {
          try {
            await upsertAnalytics(t);
            await supabase.from('atm_exit_trade_history').insert([{
              trade_id: t.id, underlying, expiry: t.expiry, type: t.type, buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
              entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice, margin: t.margin, exit_time: t.zombieExitTime || new Date().toISOString(),
              exit_buy_price: t._latestBuy, exit_sell_price: t._latestSell, exit_spot_price: t.exitSpotPrice, realized_gross_pnl: t.realizedGrossPnl,
              realized_net_pnl: t.realizedNetPnl, exit_fee: t.exitFee, total_fees: t.totalFees, exit_reason: t.exitReason
            }]);
            await supabase.from('atm_exit_active_positions').delete().eq('id', t.id);
          } catch (e) {}
        }
      }
      
      if (newEntries.length > 0) {
        for (const t of newEntries) {
          try {
            const { data } = await supabase.from('atm_exit_active_positions').select('id').eq('underlying', underlying).eq('type', t.type);
            if (data?.length >= 3) continue;
            await supabase.from('atm_exit_active_positions').insert([{
              id: t.id, underlying, expiry: selExpiry, type: t.type, buy_leg: JSON.stringify(t.buyLeg), sell_leg: JSON.stringify(t.sellLeg),
              sell_qty: t.sellQty, strike_diff: t.strikeDiff, entry_time: t.entryTime.toISOString(), entry_buy_price: t.entryBuyPrice,
              entry_sell_price: t.entrySellPrice, entry_spot_price: t.entrySpotPrice, margin: t.margin, entry_fee: t.entryFee, accumulated_sell_pnl: 0,
              buy_strike: t.buyLeg.strike, sell_strike: t.sellLeg.strike,
            }]);
          } catch (e) {}
        }
      }
      
      const finalPositions = [...remaining, ...newEntries].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
        return a.type === 'call' ? (a.buyLeg?.strike ?? 0) - (b.buyLeg?.strike ?? 0) : (b.buyLeg?.strike ?? 0) - (a.buyLeg?.strike ?? 0);
      });
      positionsRef.current = finalPositions;
      if (exited.length > 0 || newEntries.length > 0) setPositions(finalPositions);
      else setPositions(prev => { if (prev.length === 0) return prev; const byId = new Map(finalPositions.map(p => [p.id, p])); return prev.map(p => byId.get(p.id) ?? p); });
    } finally { isEvaluatingRef.current = false; }
  }, [trading, underlying, selExpiry, spotPrice, pickTopUniqueStrikes, scanTickers]);
"""

with open('src/ATMExitTrading.jsx', 'a', encoding='utf-8') as f:
    f.write(code)

print("Part 4 written successfully.")
