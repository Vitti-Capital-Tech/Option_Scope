import os

code = """
  useEffect(() => {
    let interval = null;
    if (trading) {
      interval = setInterval(() => { evaluateStrategy(); }, 1000);
      const updateTime = () => {
        const nextMin = (Math.floor(Date.now() / 60000) + 1) * 60000;
        setTimeRemaining(Math.max(0, Math.ceil((nextMin - Date.now()) / 1000)));
      };
      updateTime();
      const timerInt = setInterval(updateTime, 1000);
      return () => { clearInterval(interval); clearInterval(timerInt); };
    }
  }, [trading, evaluateStrategy]);

  const { broadcast } = useTabListener((type, data) => {
    if (type === 'ATM_EXIT_CONFIG_SYNC') {
      setConfig(prev => ({ ...prev, ...data.config }));
    }
  });
  const tabBroadcast = (type, data) => { if (broadcast) broadcast({ type, data }); };

  const closeTrade = async (pos) => {
    const live = latestTickerDataRef.current;
    const tickerBuy = live[pos.buyLeg.symbol], tickerSell = live[pos.sellLeg.symbol];
    const liveExitBuy = tickerBuy?.bid ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
    const liveExitSell = tickerSell?.ask ?? tickerSell?.markPrice ?? pos.currentSellPrice;
    if (liveExitBuy == null || liveExitSell == null) return;
    const grossPnl = (liveExitBuy - pos.entryBuyPrice) * pos.buyLeg.lotSize - (liveExitSell - pos.entrySellPrice) * pos.sellQty * pos.sellLeg.lotSize + (pos.accumulatedSellPnl || 0);
    const exitFee = calculateFee(liveExitBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(liveExitSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize);
    const totalFees = (pos.entryFee || 0) + exitFee;
    const tradeRecord = {
      ...pos, exitTime: new Date(), exitBuyPrice: liveExitBuy, exitSellPrice: liveExitSell, exitSpotPrice: spotPrice,
      realizedGrossPnl: grossPnl, realizedNetPnl: grossPnl - totalFees, entryFee: pos.entryFee || 0, exitFee, totalFees, exitReason: 'Manual Exit',
    };
    try {
      await supabase.from('atm_exit_active_positions').delete().eq('id', pos.id);
      await upsertAnalytics(tradeRecord);
      await supabase.from('atm_exit_trade_history').insert([{
        trade_id: pos.id, underlying, expiry: pos.expiry, type: pos.type, buy_leg: JSON.stringify(pos.buyLeg), sell_leg: JSON.stringify(pos.sellLeg),
        sell_qty: pos.sellQty, strike_diff: pos.strikeDiff, entry_time: pos.entryTime.toISOString(), entry_buy_price: pos.entryBuyPrice,
        entry_sell_price: pos.entrySellPrice, entry_spot_price: pos.entrySpotPrice, margin: pos.margin, exit_time: tradeRecord.exitTime.toISOString(),
        exit_buy_price: liveExitBuy, exit_sell_price: liveExitSell, exit_spot_price: spotPrice, realized_gross_pnl: grossPnl, realized_net_pnl: grossPnl - totalFees,
        exit_fee: exitFee, total_fees: totalFees, exit_reason: 'Manual Exit'
      }]);
      setPositions(prev => prev.filter(p => p.id !== pos.id));
      setTradeHistory(th => [tradeRecord, ...th]);
    } catch (e) {}
  };

  const currentTotalUnrlPnl = positions.reduce((sum, p) => sum + ((includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) || 0), 0);
  const todaysTrades = tradeHistory.filter(t => t.exitTime && t.exitTime.toISOString().startsWith(historyFilterDate));
  const dailyRealizedPnl = todaysTrades.reduce((sum, t) => sum + ((includeFees ? t.realizedNetPnl : t.realizedGrossPnl) || 0), 0);

  const getAnalyticsValue = (val, isTotal, count) => {
    if (!isTotal) return Number(val || 0).toFixed(2);
    return Number((val || 0) * (count || 1)).toFixed(2);
  };

  return (
    <div className={`app-container ${theme}-theme`}>
      <header className="app-header">
        <div className="header-left">
          <h2>ATM Exit Trading 🚀</h2>
          <select value={underlying} onChange={e => updateConfig('underlying', e.target.value)} className="underlying-select" disabled={trading}>
            {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          {expiries.length > 0 && (
            <select value={selExpiry} onChange={e => updateConfig('expiry', e.target.value)} className="expiry-select" disabled={trading}>
              {expiries.map(exp => <option key={exp} value={exp}>{fmtExpiry(exp)}</option>)}
            </select>
          )}
        </div>
        <div className="header-center">
          <div className="metrics-bar">
            <div className="metric-box"><span>Spot</span><strong>${spotPrice ? spotPrice.toFixed(2) : '---'}</strong></div>
            <div className={`metric-box ${currentTotalUnrlPnl >= 0 ? 'profit' : 'loss'}`}><span>Unrealized (Open)</span><strong>${currentTotalUnrlPnl.toFixed(2)}</strong></div>
            <div className={`metric-box ${dailyRealizedPnl >= 0 ? 'profit' : 'loss'}`}><span>Realized ({historyFilterDate})</span><strong>${dailyRealizedPnl.toFixed(2)}</strong></div>
          </div>
        </div>
        <div className="header-right">
          <div className="toggle-group" style={{ marginRight: '1rem' }}>
            <span className="toggle-label">Fees</span>
            <label className="switch">
              <input type="checkbox" checked={includeFees} onChange={() => setIncludeFees(!includeFees)} />
              <span className="slider"></span>
            </label>
          </div>
          <button className="nav-btn" onClick={() => onNavigate('charts')}>Charts</button>
          <button className="nav-btn" onClick={() => onNavigate('scanner')}>Ratio Spread</button>
          <button className="nav-btn" onClick={() => onNavigate('trading')}>Paper Trading</button>
          <button className="nav-btn active">ATM Exit</button>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle Theme">{theme === 'dark' ? '☀️' : '🌙'}</button>
        </div>
      </header>
      <main className="main-content trading-layout">
        <aside className="trading-sidebar">
          <div className="settings-panel">
            <h3>Configuration</h3>
            <div className="setting-group">
              <label>Min Strike Diff</label>
              <input type="number" step="100" value={config.minStrikeDiff} onChange={e => updateConfig('minStrikeDiff', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Min IV Diff (%)</label>
              <input type="number" step="1" value={config.minIvDiff} onChange={e => updateConfig('minIvDiff', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Max Ratio Dev.</label>
              <input type="number" step="0.05" value={config.maxRatioDeviation} onChange={e => updateConfig('maxRatioDeviation', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Min Sell Prem ($)</label>
              <input type="number" step="1" value={config.minSellPremium} onChange={e => updateConfig('minSellPremium', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Max Net Prem (+/- $)</label>
              <input type="number" step="1" value={config.maxNetPremium} onChange={e => updateConfig('maxNetPremium', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Min Long Dist</label>
              <input type="number" step="100" value={config.minLongDist} onChange={e => updateConfig('minLongDist', Number(e.target.value))} disabled={trading} />
            </div>
            <div className="setting-group">
              <label>Max Sell Qty</label>
              <input type="number" step="1" value={config.maxSellQty} onChange={e => updateConfig('maxSellQty', Number(e.target.value))} disabled={trading} />
            </div>
            <button className={`trade-btn ${trading ? 'stop' : 'start'}`} onClick={trading ? stopTrading : startTrading}>
              {trading ? 'Stop Trading' : 'Start Trading'}
            </button>
          </div>
        </aside>
        
        <div className="trading-body">
          <div className="positions-panel">
            <div className="panel-header">
              <h3>Active Positions ({positions.length}/6)</h3>
              {trading && <div className="timer-badge">Evaluating in {timeRemaining}s</div>}
            </div>
            <div className="positions-grid">
              {positions.length === 0 ? <p className="no-data">No active positions</p> : (
                <table className="data-table">
                  <thead><tr><th>ID</th><th>Type</th><th>Long Leg</th><th>Short Leg</th><th>Qty</th><th>Margin</th><th>Buy (E / L)</th><th>Sell (E / L)</th><th>Unrl PnL</th><th>Time</th><th>Action</th></tr></thead>
                  <tbody>
                    {positions.map(p => (
                      <tr key={p.id}>
                        <td>{p.id.slice(-4)}</td>
                        <td><span className={`badge ${p.type}`}>{p.type.toUpperCase()}</span></td>
                        <td>{p.buyLeg.strike}</td>
                        <td>{p.sellLeg.strike}</td>
                        <td>{p.sellQty}</td>
                        <td>${(p.margin || 0).toFixed(0)}</td>
                        <td>${p.entryBuyPrice?.toFixed(2)} / ${p.currentBuyPrice?.toFixed(2)}</td>
                        <td>${p.entrySellPrice?.toFixed(2)} / ${p.currentSellPrice?.toFixed(2)}</td>
                        <td className={(includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) >= 0 ? 'profit' : 'loss'}>${((includeFees ? p.unrealizedNetPnl : p.unrealizedGrossPnl) || 0).toFixed(2)}</td>
                        <td>{formatTime(new Date(p.entryTime))}</td>
                        <td><button className="action-btn exit" onClick={() => closeTrade(p)}>Close</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          
          <div className="history-panel">
            <div className="panel-header history-header">
              <h3>Trade History</h3>
              <div className="history-filters">
                <button className="nav-btn small" onClick={() => adjustFilterDay(-1)}>← Prev</button>
                <span className="filter-date">{historyFilterDate}</span>
                <button className="nav-btn small" onClick={() => adjustFilterDay(1)}>Next →</button>
                <button className="nav-btn small" onClick={resetToToday}>Today</button>
              </div>
            </div>
            <div className="history-grid">
              {todaysTrades.length === 0 ? <p className="no-data">No trades on {historyFilterDate}</p> : (
                <table className="data-table">
                  <thead><tr><th>ID</th><th>Type</th><th>Legs</th><th>Qty</th><th>Margin</th><th>Entry</th><th>Exit</th><th>PnL (Net)</th><th>Reason</th></tr></thead>
                  <tbody>
                    {todaysTrades.map(t => {
                      const pnl = includeFees ? t.realizedNetPnl : t.realizedGrossPnl;
                      return (
                        <tr key={t.id}>
                          <td>{t.id.slice(-4)}</td>
                          <td><span className={`badge ${t.type}`}>{t.type.toUpperCase()}</span></td>
                          <td>{t.buyLeg?.strike} / {t.sellLeg?.strike}</td>
                          <td>{t.sellQty}</td>
                          <td>${(t.margin || 0).toFixed(0)}</td>
                          <td>{formatTime(t.entryTime)}</td>
                          <td>{formatTime(t.exitTime)}</td>
                          <td className={pnl >= 0 ? 'profit' : 'loss'}>${pnl?.toFixed(2)}</td>
                          <td><span className="exit-reason">{t.exitReason}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          
          <div className="analytics-panel">
            <div className="panel-header">
              <h3>Analytics (ATM Exit)</h3>
              <div className="toggle-group">
                <span className="toggle-label">{showTotalMode ? 'Total' : 'Average'}</span>
                <label className="switch">
                  <input type="checkbox" checked={showTotalMode} onChange={() => setShowTotalMode(!showTotalMode)} />
                  <span className="slider"></span>
                </label>
              </div>
            </div>
            
            <div className="analytics-grid">
              {Object.entries({
                'atm_exit_qty_0_2_5': '<= 2.5',
                'atm_exit_qty_2_5_5': '2.5 to 5',
                'atm_exit_qty_5_7_5': '5 to 7.5',
                'atm_exit_qty_7_5_10': '7.5 to 10',
              }).map(([tableName, label]) => (
                <div key={tableName} className="analytics-table-container">
                  <h4>Sell Qty: {label}</h4>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Strike Diff</th>
                        <th>Trades</th>
                        <th>Avg Margin</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} Net Premium</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} Fees</th>
                        <th>{showTotalMode ? 'Total' : 'Avg'} PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(analyticsData[tableName] || []).map(row => {
                         const np = row.avg_net_premium || 0;
                         const isCredit = np < 0;
                         const pnlModeValue = getAnalyticsValue(row.avg_pnl, showTotalMode, row.trade_count);
                         const feesModeValue = getAnalyticsValue(row.avg_fees, showTotalMode, row.trade_count);
                         const npModeValue = getAnalyticsValue(Math.abs(np), showTotalMode, row.trade_count);
                         return (
                           <tr key={`${row.type}-${row.strike_diff}`}>
                             <td>{row.strike_diff} ({row.type.toUpperCase()})</td>
                             <td>{row.trade_count}</td>
                             <td>${Number(row.avg_margin || 0).toFixed(2)}</td>
                             <td className={isCredit ? 'profit' : 'loss'}>${npModeValue} {isCredit ? '(Cr)' : '(Db)'}</td>
                             <td className="loss">${feesModeValue}</td>
                             <td className={Number(pnlModeValue) >= 0 ? 'profit' : 'loss'}>${pnlModeValue}</td>
                           </tr>
                         );
                      })}
                      {!(analyticsData[tableName]?.length) && (
                        <tr><td colSpan="6" style={{textAlign: 'center'}}>No data</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
          
        </div>
      </main>
    </div>
  );
}
"""

with open('src/ATMExitTrading.jsx', 'a', encoding='utf-8') as f:
    f.write(code)

print("Part 5 written successfully.")
