import React, {
  useEffect, useLayoutEffect, useRef, useState,
  useCallback, forwardRef, useImperativeHandle
} from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fetchCandles, sumCandles, putSymbol, fmtExpiry, findATM,
  createWS, TF_SECS
} from './api';
import './index.css';

const UNDERLYINGS = ['BTC', 'ETH'];
const TF_LIST = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
const CANDLE_COUNT = 300;

// ── ChartPanel ────────────────────────────────────────────────────────────────
// Always mounted (never unmounts), shown/hidden via CSS by parent.
// Exposes setData() and update() via ref.
const ChartPanel = forwardRef(function ChartPanel({ title, colorUp, colorDown }, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const legendRef = useRef(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: '#0a0d12' },
        textColor: '#7d8590',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#161c24' },
        horzLines: { color: '#161c24' },
      },
      crosshair: { mode: 1 },
      timeScale: { borderColor: '#1e2730', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1e2730' },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: colorUp,
      downColor: colorDown,
      borderVisible: false,
      wickUpColor: colorUp,
      wickDownColor: colorDown,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      if (!legendRef.current) return;
      if (!param.time || param.point.x < 0 || param.point.y < 0) {
        legendRef.current.innerHTML = '';
        return;
      }
      const data = param.seriesData.get(series);
      if (data) {
        legendRef.current.innerHTML = `
          <div style="display:flex;gap:12px;background:rgba(10,13,18,0.85);padding:6px 10px;border-radius:4px;border:1px solid #1e2730;backdrop-filter:blur(4px);">
            <span>O <span style="color:#fff">${data.open}</span></span>
            <span>H <span style="color:#fff">${data.high}</span></span>
            <span>L <span style="color:#fff">${data.low}</span></span>
            <span>C <span style="color:#fff">${data.close}</span></span>
          </div>
        `;
      }
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); };
  }, []); // mount once, never destroy until page unloads

  useImperativeHandle(ref, () => ({
    setData(candles, fit = true) {
      if (!seriesRef.current || !candles?.length) return;
      let range;
      if (!fit) range = chartRef.current?.timeScale().getVisibleLogicalRange();
      seriesRef.current.setData(candles);
      if (fit) {
        chartRef.current?.timeScale().fitContent();
      } else if (range) {
        chartRef.current?.timeScale().setVisibleLogicalRange(range);
      }
    },
    update(candle) {
      if (!seriesRef.current || !candle) return;
      try { seriesRef.current.update(candle); } catch (e) {
        console.warn('series.update error:', e.message);
      }
    },
    clearData() {
      if (!seriesRef.current) return;
      try { seriesRef.current.setData([]); } catch { }
    },
  }), []);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      border: '1px solid #1e2730', borderRadius: 8,
      overflow: 'hidden', minHeight: 0,
    }}>
      <div style={{
        padding: '6px 12px', background: '#0f1419',
        borderBottom: '1px solid #1e2730',
        fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
        color: '#7d8590', display: 'flex', alignItems: 'center',
        gap: 8, flexShrink: 0,
      }}>
        <span style={{ color: colorUp }}>▮</span>
        <span>{title}</span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={legendRef} style={{
          position: 'absolute', top: 8, left: 8, zIndex: 10,
          fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#7d8590', pointerEvents: 'none'
        }} />
      </div>
    </div>
  );
});

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [underlying, setUnderlying] = useState('BTC');
  const [tf, setTf] = useState('1m');
  const [priceType, setPriceType] = useState('mark');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [strikes, setStrikes] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [selStrike, setSelStrike] = useState('');
  const [callSym, setCallSym] = useState('');

  // 'idle' | 'loading' | 'ready'
  const [phase, setPhase] = useState('idle');
  const [errMsg, setErrMsg] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [callPrice, setCallPrice] = useState(null);
  const [putPrice, setPutPrice] = useState(null);

  // Chart refs — always valid since panels never unmount
  const combRef = useRef(null);
  const callRef = useRef(null);
  const putRef = useRef(null);
  const wsRef = useRef(null);
  const lastC = useRef(null);
  const lastP = useRef(null);
  const callSymRef = useRef('');
  const putSymRef = useRef('');
  const pollerRef = useRef(null);
  const offsetRef = useRef(0);
  const currentCandleTimer = useRef(null);
  const correctionTimerRef = useRef(null); // wall-clock based candle correction chain

  // ── Data Hub: stores ALL WebSocket streams for future use ──────────────
  const makeEmptySide = () => ({
    ticker: null,               // latest full v2/ticker snapshot
    greeks: null,               // { delta, gamma, vega, theta, rho, iv }
    markPrice: null,               // { price, timestamp }
    trades: [],                 // last 200 trades [ { price, size, side, ts } ]
    orderbook: { bids: [], asks: [] }, // latest L2 depth
  });
  const dataHubRef = useRef({ call: makeEmptySide(), put: makeEmptySide() });

  // Reactive Greeks for UI display (IV + Delta for Call)
  const [callGreeks, setCallGreeks] = useState(null);
  const [putGreeks, setPutGreeks] = useState(null);

  // Track what symbol the charts currently show
  const [activeCall, setActiveCall] = useState('');
  const [activePut, setActivePut] = useState('');


  // ── Load products on underlying change ───────────────────────────────────
  useEffect(() => {
    setExpiries([]); setStrikes([]);
    setSelExpiry(''); setSelStrike(''); setCallSym('');
    setErrMsg('');

    loadProducts(underlying)
      .then(prods => {
        setProducts(prods);
        const exps = getExpiries(prods);
        setExpiries(exps);
        if (exps.length) setSelExpiry(exps[0]);
      })
      .catch(e => setErrMsg('Failed to load products: ' + e.message));
  }, [underlying]);

  // ── Load strikes on expiry change ─────────────────────────────────────────
  useEffect(() => {
    if (!selExpiry || !products.length) return;
    const ss = getStrikes(products, selExpiry);
    setStrikes(ss);
    if (!ss.length) return;
    getSpotPrice(underlying)
      .then(spot => setSelStrike(String(findATM(ss, spot))))
      .catch(() => setSelStrike(String(ss[0])));
  }, [selExpiry, products, underlying]);

  // ── Derive call symbol ────────────────────────────────────────────────────
  useEffect(() => {
    if (!selExpiry || !selStrike || !products.length) { setCallSym(''); return; }
    const prod = products.find(p =>
      p.settlement_time === selExpiry &&
      parseFloat(p.strike_price) === parseFloat(selStrike)
    );
    setCallSym(prod?.symbol || '');
  }, [selExpiry, selStrike, products]);

  // ── Imperative combine update ─────────────────────────────────────────────
  const updateComb = useCallback((c, p) => {
    if (!c || !p) return;

    if (c.time === p.time) {
      combRef.current?.update({
        time: c.time,
        open: c.open + p.open,
        high: c.high + p.high,
        low: c.low + p.low,
        close: c.close + p.close,
      });
    } else {
      // If one candle ticked over to a new timestamp but the other hasn't,
      // use the newest timestamp. For the lagging candle, assume its price
      // stayed flat at its previous close.
      const time = Math.max(c.time, p.time);
      const cOpen = c.time === time ? c.open : c.close;
      const cHigh = c.time === time ? c.high : c.close;
      const cLow = c.time === time ? c.low : c.close;
      const cClose = c.time === time ? c.close : c.close;

      const pOpen = p.time === time ? p.open : p.close;
      const pHigh = p.time === time ? p.high : p.close;
      const pLow = p.time === time ? p.low : p.close;
      const pClose = p.time === time ? p.close : p.close;

      combRef.current?.update({
        time: time,
        open: cOpen + pOpen,
        high: cHigh + pHigh,
        low: cLow + pLow,
        close: cClose + pClose,
      });
    }
  }, []);
  // ── START MONITORING ──────────────────────────────────────────────────────
  const startMonitoring = useCallback(async () => {
    if (!callSym) { setErrMsg('Select a valid strike first.'); return; }

    // Kill existing WS
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (pollerRef.current) clearInterval(pollerRef.current);

    const pSym = putSymbol(callSym);
    callSymRef.current = callSym;
    putSymRef.current = pSym;

    setErrMsg('');
    setPhase('loading');
    setCallPrice(null);
    setPutPrice(null);
    lastC.current = null;
    lastP.current = null;

    const now = Math.floor(Date.now() / 1000);
    // Rough estimate of start time, relying on the API to limit to available data
    const start = now - 604800 * 2; // fetch enough back for CANDLE_COUNT

    try {
      console.log(`Fetching: ${callSym} / ${pSym} @ ${tf} (${priceType})`);
      const [cCandles, pCandles] = await Promise.all([
        fetchCandles(callSym, tf, start, now, priceType),
        fetchCandles(pSym, tf, start, now, priceType),
      ]);
      console.log(`Candles: call=${cCandles.length} put=${pCandles.length}`);

      // Push data directly — charts are already mounted
      callRef.current?.setData(cCandles, true);
      putRef.current?.setData(pCandles, true);
      combRef.current?.setData(sumCandles(cCandles, pCandles), true);

      setActiveCall(callSym);
      setActivePut(pSym);
      setPhase('ready');

      if (cCandles.length) { lastC.current = cCandles.at(-1); setCallPrice(cCandles.at(-1).close); }
      if (pCandles.length) { lastP.current = pCandles.at(-1); setPutPrice(pCandles.at(-1).close); }

      const bucketSecs = TF_SECS[tf] || 60;

      // ── Helper: fetch the current LIVE candle from REST and bless the chart ──
      // This is the source of truth for O/H/L — the ticker only gives Close.
      const refreshCurrentCandle = async () => {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const bucketSecs = TF_SECS[tf] || 60;
          const startTs = Math.max(0, nowSec - bucketSecs * 3); // fetch last 3 buckets to guarantee overlap

          const [cc, pc] = await Promise.all([
            fetchCandles(callSym, tf, startTs, nowSec + 1, priceType),
            fetchCandles(pSym, tf, startTs, nowSec + 1, priceType),
          ]);

          if (cc?.length) {
            cc.forEach(c => callRef.current?.update(c));
            const latestC = cc[cc.length - 1];
            // Only overwrite lastC.current if the REST candle is >= our temporary websocket candle
            if (!lastC.current || latestC.time >= lastC.current.time) {
              lastC.current = latestC;
            }
          }
          if (pc?.length) {
            pc.forEach(p => putRef.current?.update(p));
            const latestP = pc[pc.length - 1];
            if (!lastP.current || latestP.time >= lastP.current.time) {
              lastP.current = latestP;
            }
          }
          if (cc?.length && pc?.length) {
            const comb = sumCandles(cc, pc);
            comb.forEach(c => combRef.current?.update(c));
          }
        } catch (err) { console.warn('refreshCurrentCandle failed:', err); }
      };

      // ── Helper: completely refresh history when a candle closes ───────────
      // This guarantees that any slight inaccuracies from the final moments
      // of a live candle are permanently corrected with official REST data.
      const refreshAllHistory = async () => {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const bucketSecs = TF_SECS[tf] || 60;
          const startTs = nowSec - bucketSecs * CANDLE_COUNT;

          const [cc, pc] = await Promise.all([
            fetchCandles(callSym, tf, startTs, nowSec + 1, priceType),
            fetchCandles(pSym, tf, startTs, nowSec + 1, priceType),
          ]);

          if (cc?.length) {
            callRef.current?.setData(cc, false);
            lastC.current = cc[cc.length - 1];
            setCallPrice(lastC.current.close);
          }
          if (pc?.length) {
            putRef.current?.setData(pc, false);
            lastP.current = pc[pc.length - 1];
            setPutPrice(lastP.current.close);
          }
          if (cc?.length && pc?.length) {
            const comb = sumCandles(cc, pc);
            combRef.current?.setData(comb, false);
          }
          console.log(`[AutoCorrect] Full history refreshed perfectly.`);
        } catch (err) { console.warn('refreshAllHistory failed:', err); }
      };

      // ── Wall-clock candle correction scheduler ────────────────────────────
      // Fires precisely when each candle closes (regardless of ticker activity).
      // Waits 15s for REST to settle, then replaces the closed candle with
      // official exchange data — exactly like clicking Start Monitoring again.
      const scheduleCandleCorrections = () => {
        if (correctionTimerRef.current) clearTimeout(correctionTimerRef.current);

        const nowSec = Math.floor(Date.now() / 1000);
        const anchor = lastC.current?.time ?? Math.floor(nowSec / bucketSecs) * bucketSecs;
        const currentBucket = anchor + Math.floor((nowSec - anchor) / bucketSecs) * bucketSecs;
        const nextBoundary = currentBucket + bucketSecs;          // when current candle closes
        const msUntilClose = Math.max(0, (nextBoundary - nowSec) * 1000);
        const SETTLE_MS = 15000; // wait 15s after close for REST to finalise

        correctionTimerRef.current = setTimeout(async () => {
          // Fetch and replace the entire chart with official REST data
          console.log(`[AutoCorrect] Triggering full refresh to correct closed candle...`);
          await refreshAllHistory();
          // Chain: schedule correction for the NEXT candle
          scheduleCandleCorrections();
        }, msUntilClose + SETTLE_MS);

        console.log(`[AutoCorrect] Next correction in ${Math.round((msUntilClose + SETTLE_MS) / 1000)}s (candle closes in ${Math.round(msUntilClose / 1000)}s)`);
      };

      // Kick off the correction chain
      scheduleCandleCorrections();

      // Start the current-candle refresh interval (every 5 seconds)
      if (currentCandleTimer.current) clearInterval(currentCandleTimer.current);
      currentCandleTimer.current = setInterval(refreshCurrentCandle, 5000);

      // ── WebSocket: ticker updates Close price in real-time (zero latency) ──
      wsRef.current = createWS(
        callSym, pSym, tf, priceType,
        (sym, price) => {
          // Determine current bucket using wall-clock anchored to last known candle
          const nowSec = Math.floor(Date.now() / 1000);
          const anchor = lastC.current?.time ?? lastP.current?.time ?? Math.floor(nowSec / bucketSecs) * bucketSecs;
          const currentBucket = anchor + Math.floor((nowSec - anchor) / bucketSecs) * bucketSecs;

          if (sym === callSymRef.current) {
            setCallPrice(price);
            // !lastC.current handles LTP mode where no historical trades exist
            if (!lastC.current || currentBucket > lastC.current.time) {
              const prevTime = lastC.current?.time;
              const newC = { time: currentBucket, open: price, high: price, low: price, close: price };
              lastC.current = newC;
              callRef.current?.update(newC);
              updateComb(newC, lastP.current);
              if (prevTime) correctClosedCandle(prevTime);
            } else {
              // Same candle — update Close; also expand H/L as fallback for LTP (REST may miss)
              const upd = { ...lastC.current, close: price };
              if (price > upd.high) upd.high = price;
              if (price < upd.low) upd.low = price;
              lastC.current = upd;
              callRef.current?.update(upd);
              updateComb(upd, lastP.current);
            }
          }
          if (sym === putSymRef.current) {
            setPutPrice(price);
            if (!lastP.current || currentBucket > lastP.current.time) {
              const prevTime = lastP.current?.time;
              const newP = { time: currentBucket, open: price, high: price, low: price, close: price };
              lastP.current = newP;
              putRef.current?.update(newP);
              updateComb(lastC.current, newP);
              if (prevTime) correctClosedCandle(prevTime);
            } else {
              const upd = { ...lastP.current, close: price };
              if (price > upd.high) upd.high = price;
              if (price < upd.low) upd.low = price;
              lastP.current = upd;
              putRef.current?.update(upd);
              updateComb(lastC.current, upd);
            }
          }
        },
        // ── Data Hub: extract and store ALL WebSocket streams ──────────────
        (msg) => {
          const sym = msg.symbol;
          const side = sym === callSymRef.current ? 'call'
            : sym === putSymRef.current ? 'put'
              : null;

          // ── v2/ticker: full snapshot including Greeks + OI + quotes ──
          if (msg.type === 'v2/ticker') {
            if (side) {
              dataHubRef.current[side].ticker = msg;
              // Extract Greeks (only present for options)
              if (msg.greeks) {
                const g = {
                  delta: parseFloat(msg.greeks.delta),
                  gamma: parseFloat(msg.greeks.gamma),
                  vega: parseFloat(msg.greeks.vega),
                  theta: parseFloat(msg.greeks.theta),
                  rho: parseFloat(msg.greeks.rho),
                  iv: parseFloat(msg.implied_volatility ?? msg.greeks.iv ?? 0),
                };
                dataHubRef.current[side].greeks = g;
                if (side === 'call') setCallGreeks(g);
                else setPutGreeks(g);
              }
            }
          }

          // ── trades: public trade tape ─────────────────────────────────
          if (msg.type === 'trades' && Array.isArray(msg.trades)) {
            if (side) {
              const parsed = msg.trades.map(t => ({
                price: parseFloat(t.price),
                size: parseFloat(t.size),
                side: t.buyer_role === 'taker' ? 'buy' : 'sell',
                ts: parseInt(t.created_at ?? t.timestamp ?? 0),
              }));
              dataHubRef.current[side].trades = [
                ...parsed,
                ...dataHubRef.current[side].trades,
              ].slice(0, 200); // keep last 200 trades
            }
          }

          // ── l2_updates: incremental orderbook depth ───────────────────
          if (msg.type === 'l2_updates' && side) {
            const ob = dataHubRef.current[side].orderbook;
            // Delta sends full snapshot on first message, then increments
            if (msg.buy) ob.bids = msg.buy;   // array of { limit_price, size }
            if (msg.sell) ob.asks = msg.sell;
          }

          // ── mark_price: dedicated mark price stream ───────────────────
          if (msg.type === 'mark_price' && side) {
            dataHubRef.current[side].markPrice = {
              price: parseFloat(msg.price),
              ts: msg.timestamp ? Math.floor(parseInt(msg.timestamp) / 1000000) : Math.floor(Date.now() / 1000),
            };
          }
        },
        (status) => setWsStatus(status),
      );

    } catch (e) {
      console.error('startMonitoring:', e);
      setErrMsg('Error: ' + e.message);
      setPhase('idle');
    }
  }, [callSym, tf, priceType, updateComb]);

  useEffect(() => () => {
    wsRef.current?.close();
    if (currentCandleTimer.current) clearInterval(currentCandleTimer.current);
  }, []);

  const combPrice = (callPrice && putPrice) ? (callPrice + putPrice).toFixed(2) : '—';
  const pSym = callSym ? putSymbol(callSym) : '';

  return (
    <div className="app">
      {/* Navbar */}
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Inline SVG icon */}
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="#0d1117" />
            <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
            <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
            <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
            <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
            <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
            <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
            <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
            <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
            <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
            <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
          </svg>
          VITTI OPTION<span>SCOPE</span>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          {activeCall && (
            <span style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: '#7d8590' }}>
              {activeCall} / {activePut}
            </span>
          )}
          <div className="ws-badge">
            <div className={`ws-dot ${wsStatus === 'live' ? 'live' : ''}`} />
            <span>{wsStatus === 'live' ? 'Live Feed' : wsStatus === 'error' ? 'WS Error' : 'Disconnected'}</span>
          </div>
        </div>
      </nav>

      <div className="body">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="card">
            <div className="card-title">Configuration</div>

            <div className="form-group">
              <label>Underlying</label>
              <select value={underlying} onChange={e => setUnderlying(e.target.value)}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label>Expiry Date</label>
              <select value={selExpiry} onChange={e => setSelExpiry(e.target.value)} disabled={!expiries.length}>
                {!expiries.length
                  ? <option>Loading...</option>
                  : expiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)
                }
              </select>
            </div>

            <div className="form-group">
              <label>Strike Price</label>
              <select value={selStrike} onChange={e => setSelStrike(e.target.value)} disabled={!strikes.length}>
                {!strikes.length
                  ? <option>Select Expiry First</option>
                  : strikes.map(s => <option key={s} value={s}>{Number(s).toLocaleString()}</option>)
                }
              </select>
            </div>

            <div className="form-group">
              <label>Price Source</label>
              <select value={priceType} onChange={e => setPriceType(e.target.value)}>
                <option value="mark">Mark Price</option>
                <option value="ltp">Last Traded Price</option>
              </select>
            </div>

            <div className="form-group">
              <label>Candle Interval</label>
              <select value={tf} onChange={e => setTf(e.target.value)}>
                {TF_LIST.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <button className="btn-start" disabled={phase === 'loading' || !callSym} onClick={startMonitoring}>
              {phase === 'loading' ? 'LOADING…' : 'START MONITORING'}
            </button>

            {errMsg && <div style={{ color: '#f85149', fontSize: 11, marginTop: 8, lineHeight: 1.4 }}>{errMsg}</div>}
          </div>

          <div className="card">
            <div className="card-title">Live Prices ({priceType === 'mark' ? 'Mark' : 'LTP'})</div>
            <div className="stat-row">
              <span className="stat-label">CALL</span>
              <span className="stat-val call">{callPrice ? callPrice.toFixed(2) : '—'}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">PUT</span>
              <span className="stat-val put">{putPrice ? putPrice.toFixed(2) : '—'}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">COMBINED</span>
              <span className="stat-val comb">{combPrice}</span>
            </div>
          </div>

          {/* Greeks card — populated from WebSocket Data Hub */}
          {(callGreeks || putGreeks) && (
            <div className="card">
              <div className="card-title">Greeks (Live)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 8px', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>
                <span style={{ color: '#7d8590', fontWeight: 700 }}></span>
                <span style={{ color: '#3fb950', fontWeight: 700, textAlign: 'center' }}>CALL</span>
                <span style={{ color: '#f85149', fontWeight: 700, textAlign: 'center' }}>PUT</span>

                {[
                  { label: 'Δ Delta', key: 'delta', decimals: 4 },
                  { label: 'Γ Gamma', key: 'gamma', decimals: 4 },
                  { label: 'ν Vega', key: 'vega', decimals: 2 },
                  { label: 'Θ Theta', key: 'theta', decimals: 2 },
                  { label: 'ρ Rho', key: 'rho', decimals: 4 },
                  { label: 'IV %', key: 'iv', decimals: 1, scale: 100 },
                ].map(({ label, key, decimals, scale = 1 }) => (
                  <React.Fragment key={key}>
                    <span style={{ color: '#7d8590' }}>{label}</span>
                    <span style={{ color: '#e6edf3', textAlign: 'center' }}>
                      {callGreeks?.[key] != null ? (callGreeks[key] * scale).toFixed(decimals) : '—'}
                    </span>
                    <span style={{ color: '#e6edf3', textAlign: 'center' }}>
                      {putGreeks?.[key] != null ? (putGreeks[key] * scale).toFixed(decimals) : '—'}
                    </span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}


          <div style={{ marginTop: 'auto', paddingTop: 8 }}>
            <a
              href="https://minianonlink.vercel.app/tusharbhardwaj"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: '9px 12px',
                borderRadius: 7,
                border: '1px solid #1e2730',
                background: '#0f1419',
                textDecoration: 'none',
                fontSize: 11,
                color: '#7d8590',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: 0.5,
                transition: 'all 0.2s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = '#00d9a3';
                e.currentTarget.style.color = '#00d9a3';
                e.currentTarget.style.boxShadow = '0 0 12px rgba(0,217,163,0.15)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = '#1e2730';
                e.currentTarget.style.color = '#7d8590';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Link icon */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              Made with 💙 by Tushar
            </a>
          </div>
        </aside>

        {/* Chart area — charts ALWAYS mounted, overlay sits on top */}
        <main className="main" style={{ position: 'relative', padding: 12, gap: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Idle/Loading overlay — sits ON TOP of charts via absolute positioning */}
          {(phase === 'idle' || phase === 'loading') && (
            <div style={{
              position: 'absolute', inset: 12, zIndex: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(10,13,18,0.96)',
              borderRadius: 8, border: '1px solid #1e2730',
              gap: 12,
            }}>
              {phase === 'loading' && <div className="spinner" />}
              <div style={{ fontFamily: 'JetBrains Mono', fontSize: 14, fontWeight: 700, letterSpacing: 2 }}>
                {phase === 'loading' ? 'LOADING CANDLES' : 'OPTIONSCOPE'}
              </div>
              <div style={{ fontSize: 12, color: '#7d8590' }}>
                {phase === 'loading' ? callSym : 'Select underlying, expiry & strike → START MONITORING'}
              </div>
              {errMsg && <div style={{ color: '#f85149', fontSize: 12, maxWidth: 320, textAlign: 'center' }}>{errMsg}</div>}
            </div>
          )}

          {/* Combined chart — ALWAYS in DOM */}
          <ChartPanel
            ref={combRef}
            title={activeCall ? `COMBINED PREMIUM (${priceType.toUpperCase()})  ·  ${activeCall} + ${activePut}` : 'COMBINED PREMIUM'}
            colorUp="#e3b341"
            colorDown="#b08a2e"
          />

          {/* Call + Put — ALWAYS in DOM */}
          <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
            <ChartPanel
              ref={callRef}
              title={activeCall ? `CALL (${priceType.toUpperCase()})  ·  ${activeCall}` : 'CALL'}
              colorUp="#3fb950"
              colorDown="#238636"
            />
            <ChartPanel
              ref={putRef}
              title={activePut ? `PUT (${priceType.toUpperCase()})  ·  ${activePut}` : 'PUT'}
              colorUp="#f85149"
              colorDown="#b62324"
            />
          </div>
        </main>
      </div>
    </div>
  );
}
