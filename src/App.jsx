import {
  useEffect, useLayoutEffect, useRef, useState,
  useCallback, forwardRef, useImperativeHandle
} from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fetchCandles, sumCandles, putSymbol, fmtExpiry, findATM,
  createWS,
} from './api';
import './index.css';

const UNDERLYINGS = ['BTC', 'ETH'];
const TF_LIST = ['1m', '5m', '15m', '1h'];
const TF_SECS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };
const CANDLE_COUNT = 300;

// ── ChartPanel ────────────────────────────────────────────────────────────────
// Always mounted (never unmounts), shown/hidden via CSS by parent.
// Exposes setData() and update() via ref.
const ChartPanel = forwardRef(function ChartPanel({ title, colorUp, colorDown }, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

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
    setData(candles) {
      if (!seriesRef.current || !candles?.length) return;
      seriesRef.current.setData(candles);
      chartRef.current?.timeScale().fitContent();
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
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
});

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [underlying, setUnderlying] = useState('BTC');
  const [tf, setTf] = useState('1m');
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
    combRef.current?.update({
      time: c.time,
      open: c.open + p.open,
      high: c.high + p.high,
      low: c.low + p.low,
      close: c.close + p.close,
    });
  }, []);

  // ── START MONITORING ──────────────────────────────────────────────────────
  const startMonitoring = useCallback(async () => {
    if (!callSym) { setErrMsg('Select a valid strike first.'); return; }

    // Kill existing WS
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }

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
    const start = now - TF_SECS[tf] * CANDLE_COUNT;

    try {
      console.log(`Fetching: ${callSym} / ${pSym} @ ${tf}`);
      const [cCandles, pCandles] = await Promise.all([
        fetchCandles(callSym, tf, start, now),
        fetchCandles(pSym, tf, start, now),
      ]);
      console.log(`Candles: call=${cCandles.length} put=${pCandles.length}`);

      // Push data directly — charts are already mounted
      callRef.current?.setData(cCandles);
      putRef.current?.setData(pCandles);
      combRef.current?.setData(sumCandles(cCandles, pCandles));

      setActiveCall(callSym);
      setActivePut(pSym);
      setPhase('ready');

      if (cCandles.length) { lastC.current = cCandles.at(-1); setCallPrice(cCandles.at(-1).close); }
      if (pCandles.length) { lastP.current = pCandles.at(-1); setPutPrice(pCandles.at(-1).close); }

      // Connect WebSocket for live updates
      wsRef.current = createWS(
        callSym, pSym, tf,
        (sym, candle) => {
          if (sym === callSymRef.current) {
            callRef.current?.update(candle);
            lastC.current = candle;
            setCallPrice(candle.close);
            updateComb(candle, lastP.current);
          } else if (sym === putSymRef.current) {
            putRef.current?.update(candle);
            lastP.current = candle;
            setPutPrice(candle.close);
            updateComb(lastC.current, candle);
          }
        },
        (sym, price) => {
          if (sym === callSymRef.current) setCallPrice(price);
          if (sym === putSymRef.current) setPutPrice(price);
        },
        (status) => setWsStatus(status),
      );

    } catch (e) {
      console.error('startMonitoring:', e);
      setErrMsg('Error: ' + e.message);
      setPhase('idle');
    }
  }, [callSym, tf, updateComb]);

  useEffect(() => () => wsRef.current?.close(), []);

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
              <label>Candle Interval</label>
              <div className="tf-grid">
                {TF_LIST.map(t => (
                  <button key={t} className={`tf-btn ${tf === t ? 'active' : ''}`} onClick={() => setTf(t)}>{t}</button>
                ))}
              </div>
            </div>

            <button className="btn-start" disabled={phase === 'loading' || !callSym} onClick={startMonitoring}>
              {phase === 'loading' ? 'LOADING…' : 'START MONITORING'}
            </button>

            {errMsg && <div style={{ color: '#f85149', fontSize: 11, marginTop: 8, lineHeight: 1.4 }}>{errMsg}</div>}
          </div>

          <div className="card">
            <div className="card-title">Live Prices (Mark)</div>
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

          <div className="card">
            <div className="card-title">Engine Info</div>
            <div className="stat-row">
              <span className="stat-label">Routing</span>
              <span className="stat-val" style={{ color: '#00d9a3' }}>Serverless Edge</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Price</span>
              <span className="stat-val" style={{ fontSize: 10 }}>Mark Price</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Feed</span>
              <span className="stat-val" style={{ color: wsStatus === 'live' ? '#00d9a3' : '#f85149', fontSize: 10 }}>
                {wsStatus === 'live' ? 'WS LIVE' : 'IDLE'}
              </span>
            </div>
          </div>

          {/* Footer credit */}
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
            title={activeCall ? `COMBINED PREMIUM  ·  ${activeCall} + ${activePut}` : 'COMBINED PREMIUM'}
            colorUp="#e3b341"
            colorDown="#b08a2e"
          />

          {/* Call + Put — ALWAYS in DOM */}
          <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
            <ChartPanel
              ref={callRef}
              title={activeCall ? `CALL  ·  ${activeCall}` : 'CALL'}
              colorUp="#3fb950"
              colorDown="#238636"
            />
            <ChartPanel
              ref={putRef}
              title={activePut ? `PUT  ·  ${activePut}` : 'PUT'}
              colorUp="#f85149"
              colorDown="#b62324"
            />
          </div>
        </main>
      </div>
    </div>
  );
}
