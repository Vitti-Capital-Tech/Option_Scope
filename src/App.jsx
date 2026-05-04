import React, {
  useEffect, useLayoutEffect, useRef, useState,
  useCallback, forwardRef, useImperativeHandle
} from 'react';
import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fetchCandles, sumCandles, putSymbol, fmtExpiry, findATM,
  createWS, TF_SECS
} from './api';
import { useTabListener } from './useTabSync';
import './index.css';

const UNDERLYINGS = ['BTC', 'ETH'];
const TF_LIST = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
const CANDLE_COUNT = 300;

const playAlertSound = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playNote = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.1, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    playNote(880, ctx.currentTime, 0.2); // A5
    playNote(1108.73, ctx.currentTime + 0.15, 0.4); // C#6
  } catch (e) { console.warn('Audio play failed', e); }
};

const formatCombinedTitle = (callSym, putSym, priceType) => {
  if (!callSym && !putSym) return 'PREMIUM CHART';
  if (!callSym) return `PUT PREMIUM (${priceType.toUpperCase()}) · ${putSym}`;
  if (!putSym) return `CALL PREMIUM (${priceType.toUpperCase()}) · ${callSym}`;

  const cParts = callSym.split('-');
  const pParts = putSym.split('-');
  if (cParts.length < 4 || pParts.length < 4) return `COMBINED PREMIUM · ${callSym} + ${putSym}`;

  const typeC = cParts[0];
  const asset = cParts[1];
  const strikeC = cParts[2];
  const expiry = cParts[3];
  const typeP = pParts[0];
  const strikeP = pParts[2];

  if (strikeC === strikeP) {
    return `COMBINED PREMIUM (${priceType.toUpperCase()}) · ${asset}-${strikeC}-${expiry} (${typeC}+${typeP})`;
  }
  return `COMBINED PREMIUM (${priceType.toUpperCase()}) · ${typeC}-${strikeC} + ${typeP}-${strikeP} · ${asset}-${expiry}`;
};

// ── ChartPanel ────────────────────────────────────────────────────────────────
// Always mounted (never unmounts), shown/hidden via CSS by parent.
// Exposes setData() and update() via ref.
const ChartPanel = forwardRef(function ChartPanel({
  title, colorUp, colorDown, iconColor,
  alerts = [], onAddAlert, onRemoveAlert,
  showIvCall, showIvPut, theme
}, ref) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const legendRef = useRef(null);
  const alertLinesRef = useRef({}); // { [id]: line }
  const callIvRef = useRef(null);
  const putIvRef = useRef(null);
  const combIvRef = useRef(null);
  const smaSeriesRef = useRef(null);
  const candlesCacheRef = useRef([]);
  const [showSma, setShowSma] = useState(false);
  
  const drawnLinesRef = useRef([]);
  const [drawMode, setDrawMode] = useState(false);
  const drawModeRef = useRef(false);
  const [drawnCount, setDrawnCount] = useState(0);
  const [newAlert, setNewAlert] = useState({ price: '', dir: '>=' });

  const toggleDrawMode = () => {
    const next = !drawMode;
    setDrawMode(next);
    drawModeRef.current = next;
    if (containerRef.current) {
      containerRef.current.style.cursor = next ? 'crosshair' : 'default';
    }
  };

  useEffect(() => {
    if (!seriesRef.current) return;
    
    // Remove all old lines
    Object.values(alertLinesRef.current).forEach(line => {
      seriesRef.current.removePriceLine(line);
    });
    alertLinesRef.current = {};

    // Add current lines
    alerts.forEach(a => {
      if (!a.price) return;
      const line = seriesRef.current.createPriceLine({
        price: parseFloat(a.price),
        color: a.dir === '>=' ? '#3fb950' : '#f85149',
        lineWidth: 2,
        lineStyle: 1, // Dotted
        axisLabelVisible: true,
        title: `ALERT ${a.dir}`,
      });
      alertLinesRef.current[a.id] = line;
    });
  }, [alerts]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: theme === 'dark' ? '#0a0d12' : '#fff' },
        textColor: theme === 'dark' ? '#7d8590' : '#000',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: theme === 'dark' ? '#161c24' : '#e5e7eb' },
        horzLines: { color: theme === 'dark' ? '#161c24' : '#e5e7eb' },
      },
      crosshair: { mode: 1 },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: {
        scaleMargins: { top: 0.05, bottom: 0.35 },
      },
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

    let ivScaleCreated = false;

    if (showIvCall && showIvPut) {
      combIvRef.current = chart.addSeries(LineSeries, {
        priceScaleId: 'ivScale', color: '#e3b341', lineWidth: 1.5, title: 'Comb IV', crosshairMarkerRadius: 3
      });
      ivScaleCreated = true;
    } else {
      if (showIvCall) {
        callIvRef.current = chart.addSeries(LineSeries, {
          priceScaleId: 'ivScale', color: '#00d9a3', lineWidth: 1.5, title: 'Call IV', crosshairMarkerRadius: 3
        });
        ivScaleCreated = true;
      }
      if (showIvPut) {
        putIvRef.current = chart.addSeries(LineSeries, {
          priceScaleId: 'ivScale', color: '#ff2ebd', lineWidth: 1.5, title: 'Put IV', crosshairMarkerRadius: 3
        });
        ivScaleCreated = true;
      }
    }

    if (ivScaleCreated) {
      chart.priceScale('ivScale').applyOptions({
        scaleMargins: { top: 0.75, bottom: 0.05 },
        borderColor: theme === 'dark' ? '#1e2730' : '#1e2730',
      });
    }

    chart.subscribeCrosshairMove((param) => {
      if (!legendRef.current) return;
      if (!param.time || param.point.x < 0 || param.point.y < 0) {
        legendRef.current.innerHTML = '';
        return;
      }
      const data = param.seriesData.get(series);
      if (data) {
        let ivHtml = '';
        if (callIvRef.current) {
          const callData = param.seriesData.get(callIvRef.current);
          if (callData) ivHtml += `<span style="color:#00d9a3;margin-left:8px;">Call IV <span style="color:#fff">${(callData.value * 100).toFixed(1)}%</span></span>`;
        }
        if (putIvRef.current) {
          const putData = param.seriesData.get(putIvRef.current);
          if (putData) ivHtml += `<span style="color:#ff2ebd;margin-left:8px;">Put IV <span style="color:#fff">${(putData.value * 100).toFixed(1)}%</span></span>`;
        }
        if (combIvRef.current) {
          const combData = param.seriesData.get(combIvRef.current);
          if (combData) ivHtml += `<span style="color:#e3b341;margin-left:8px;">Comb IV <span style="color:#fff">${(combData.value * 100).toFixed(1)}%</span></span>`;
        }
        legendRef.current.innerHTML = `
          <div style="display:flex;gap:12px;background:rgba(10,13,18,0.85);padding:6px 10px;border-radius:4px;border:1px solid #1e2730;backdrop-filter:blur(4px);align-items:center;">
            <span>O <span style="color:#fff">${data.open}</span></span>
            <span>H <span style="color:#fff">${data.high}</span></span>
            <span>L <span style="color:#fff">${data.low}</span></span>
            <span>C <span style="color:#fff">${data.close}</span></span>
            ${ivHtml}
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

  useEffect(() => {
    if (!chartRef.current) return;
    const isLight = theme === 'light';
    chartRef.current.applyOptions({
      layout: {
        background: { color: 'transparent' },
        textColor: isLight ? '#6b7280' : '#7d8590',
      },
      grid: {
        vertLines: { color: isLight ? '#e5e7eb' : '#161c24' },
        horzLines: { color: isLight ? '#e5e7eb' : '#161c24' },
      },
      timeScale: { borderColor: isLight ? '#d1d5db' : '#1e2730' },
      rightPriceScale: { borderColor: isLight ? '#d1d5db' : '#1e2730' },
    });
  }, [theme]);

  useEffect(() => {
    if (!chartRef.current) return;
    
    if (showSma) {
      if (!smaSeriesRef.current) {
        smaSeriesRef.current = chartRef.current.addSeries(LineSeries, {
          color: '#2f81f7',
          lineWidth: 2,
          title: 'SMA 20',
          crosshairMarkerRadius: 4,
          priceScaleId: 'right'
        });
        
        const candles = candlesCacheRef.current;
        if (candles.length >= 20) {
          const smaData = [];
          for (let i = 19; i < candles.length; i++) {
            let sum = 0;
            for (let j = 0; j < 20; j++) sum += candles[i - j].close;
            smaData.push({ time: candles[i].time, value: sum / 20 });
          }
          smaSeriesRef.current.setData(smaData);
        }
      }
    } else {
      if (smaSeriesRef.current) {
        chartRef.current.removeSeries(smaSeriesRef.current);
        smaSeriesRef.current = null;
      }
    }
  }, [showSma]);

  // Handle Chart Clicks for Drawing
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;
    
    const clickHandler = (param) => {
      console.log('Chart clicked:', param);
      if (!drawModeRef.current) return;
      
      let price = null;
      if (param.point) {
        price = seriesRef.current.coordinateToPrice(param.point.y);
      } else if (param.time) {
        const data = param.seriesData.get(seriesRef.current);
        if (data && data.close !== undefined) price = data.close;
      }

      if (price !== null && !isNaN(price)) {
        console.log('Drawing line at price:', price);
        const line = seriesRef.current.createPriceLine({
          price: price,
          color: theme === 'dark' ? '#e3b341' : '#d29922',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'S/R',
        });
        drawnLinesRef.current.push(line);
        setDrawnCount(prev => prev + 1);
        
        // Auto-off
        setDrawMode(false);
        drawModeRef.current = false;
        if (containerRef.current) containerRef.current.style.cursor = 'default';
      }
    };
    
    chartRef.current.subscribeClick(clickHandler);

    return () => {
      if (chartRef.current) {
        chartRef.current.unsubscribeClick(clickHandler);
      }
    };
  }, [theme]); // Re-bind only if theme changes (for color), drawMode is handled via ref

  useImperativeHandle(ref, () => ({
    setData(candles, fit = true) {
      if (!seriesRef.current || !candles?.length) return;
      candlesCacheRef.current = [...candles];
      let range;
      if (!fit) range = chartRef.current?.timeScale().getVisibleLogicalRange();
      seriesRef.current.setData(candles);
      
      if (smaSeriesRef.current && candles.length >= 20) {
        const smaData = [];
        for (let i = 19; i < candles.length; i++) {
          let sum = 0;
          for (let j = 0; j < 20; j++) sum += candles[i - j].close;
          smaData.push({ time: candles[i].time, value: sum / 20 });
        }
        smaSeriesRef.current.setData(smaData);
      }

      if (fit) {
        chartRef.current?.timeScale().fitContent();
      } else if (range) {
        chartRef.current?.timeScale().setVisibleLogicalRange(range);
      }
    },
    update(candle) {
      if (!seriesRef.current || !candle) return;
      try {
        // Lightweight-charts update handles newer or same-time candles perfectly.
        // For older candles, we should ideally use setData, but for small corrections
        // to the "live" tip, this works.
        seriesRef.current.update(candle);
        
        const cache = candlesCacheRef.current;
        if (cache.length === 0) {
          cache.push(candle);
        } else {
          const lastIdx = cache.length - 1;
          if (candle.time === cache[lastIdx].time) {
            cache[lastIdx] = candle;
          } else if (candle.time > cache[lastIdx].time) {
            cache.push(candle);
          } else {
            // Historical correction: find and update
            const idx = cache.findIndex(c => c.time === candle.time);
            if (idx !== -1) cache[idx] = candle;
          }
        }
        
        // Always maintain max history for SMA
        if (cache.length > 500) cache.shift();

        if (smaSeriesRef.current && cache.length >= 20) {
          const idx = cache.findIndex(c => c.time === candle.time);
          if (idx >= 19) {
            let sum = 0;
            for (let j = 0; j < 20; j++) sum += cache[idx - j].close;
            smaSeriesRef.current.update({ time: candle.time, value: sum / 20 });
          }
        }

        if (callIvRef.current && candle.callIv !== undefined && !isNaN(candle.callIv)) {
          callIvRef.current.update({ time: candle.time, value: candle.callIv });
        }
        if (putIvRef.current && candle.putIv !== undefined && !isNaN(candle.putIv)) {
          putIvRef.current.update({ time: candle.time, value: candle.putIv });
        }
        if (combIvRef.current && candle.callIv !== undefined && candle.putIv !== undefined) {
          const sum = candle.callIv + candle.putIv;
          if (!isNaN(sum)) {
            combIvRef.current.update({ time: candle.time, value: sum });
          }
        }
      } catch (e) {
        // console.warn('series.update error:', e.message);
      }
    },
    clearIvData() {
      try {
        if (callIvRef.current) callIvRef.current.setData([]);
        if (putIvRef.current) putIvRef.current.setData([]);
        if (combIvRef.current) combIvRef.current.setData([]);
      } catch { }
    },
    clearData() {
      if (!seriesRef.current) return;
      try { seriesRef.current.setData([]); } catch { }
    },
  }), []);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 8,
      overflow: 'hidden', minHeight: 0, background: 'var(--bg)'
    }}>
      <div style={{
        padding: '6px 12px', background: 'var(--bg2)',
        borderBottom: '1px solid var(--border)',
        fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
        color: 'var(--text-dim)', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: iconColor || colorUp }}>▮</span>
            <span>{title}</span>
          </div>

          <div style={{ width: 1, height: 14, background: 'var(--border)' }} />

          {/* Tools */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setShowSma(!showSma)}
              style={{
                background: showSma ? 'rgba(47, 129, 247, 0.15)' : 'transparent',
                border: `1px solid ${showSma ? 'rgba(47, 129, 247, 0.4)' : 'var(--border)'}`,
                color: showSma ? '#2f81f7' : 'var(--text-dim)',
                padding: '2px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                fontWeight: 600, transition: 'all 0.15s'
              }}
            >
              SMA 20
            </button>
            <button
              onClick={toggleDrawMode}
              title="Toggle Trendline Tool"
              style={{
                background: drawMode ? 'rgba(56, 139, 253, 0.15)' : 'transparent',
                border: `1px solid ${drawMode ? '#388bfd' : 'var(--border)'}`,
                color: drawMode ? '#388bfd' : 'var(--text-dim)',
                padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600
              }}
            >
              DRAW
            </button>
          </div>

          <div style={{ width: 1, height: 14, background: 'var(--border)' }} />

          {/* Multiple Alerts UI */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#161b22', padding: '2px 6px', borderRadius: 6, border: '1px solid #30363d' }}>
              <select
                value={newAlert.dir}
                onChange={e => setNewAlert(prev => ({ ...prev, dir: e.target.value }))}
                style={{ 
                  background: 'transparent', border: 'none', 
                  color: newAlert.dir === '>=' ? '#3fb950' : '#f85149', 
                  fontSize: 11, fontWeight: 700, outline: 'none', cursor: 'pointer' 
                }}
              >
                <option value=">=" style={{ color: '#3fb950' }}>&ge;</option>
                <option value="<=" style={{ color: '#f85149' }}>&le;</option>
              </select>
              <input
                type="number"
                placeholder="Alert Price"
                value={newAlert.price}
                onChange={e => setNewAlert(prev => ({ ...prev, price: e.target.value }))}
                style={{ background: 'transparent', border: 'none', color: '#e6edf3', width: 70, fontSize: 11, fontFamily: 'JetBrains Mono', outline: 'none' }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newAlert.price) {
                    onAddAlert(newAlert.dir, newAlert.price);
                    setNewAlert(prev => ({ ...prev, price: '' }));
                  }
                }}
              />
              <button
                onClick={() => {
                  if (newAlert.price) {
                    onAddAlert(newAlert.dir, newAlert.price);
                    setNewAlert(prev => ({ ...prev, price: '' }));
                  }
                }}
                disabled={!newAlert.price}
                style={{ background: '#238636', border: 'none', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer', opacity: newAlert.price ? 1 : 0.5 }}
              >
                SET ALERT
              </button>
            </div>

            {/* Active Alerts List */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', overflowX: 'auto', maxWidth: 400, scrollbarWidth: 'none' }}>
              {alerts.map(a => (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6, background: a.dir === '>=' ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)',
                  border: `1px solid ${a.dir === '>=' ? 'rgba(63, 185, 80, 0.3)' : 'rgba(248, 81, 73, 0.3)'}`,
                  padding: '3px 8px', borderRadius: 4, fontSize: 10, color: a.dir === '>=' ? '#3fb950' : '#f85149', fontWeight: 700, flexShrink: 0
                }}>
                  {a.dir} {parseFloat(a.price).toFixed(2)}
                  <div 
                    onClick={() => onRemoveAlert(a.id)} 
                    style={{ cursor: 'pointer', marginLeft: 6, display: 'flex', alignItems: 'center', opacity: 0.7 }}
                    className="alert-delete-icon"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={legendRef} style={{
          position: 'absolute', top: 8, left: 8, zIndex: 10,
          fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#7d8590', pointerEvents: 'none'
        }} />
        {(showIvCall || showIvPut) && (
          <div style={{
            position: 'absolute',
            top: '70%',
            left: 0,
            right: 0,
            height: '1px',
            background: '#1e2730',
            zIndex: 5,
            pointerEvents: 'none'
          }} />
        )}
        
        {/* TradingView-style Tools */}
        <div style={{
          position: 'absolute', bottom: 12, right: 12, zIndex: 10,
          display: 'flex', gap: 4, background: theme === 'dark' ? 'rgba(10, 13, 18, 0.8)' : 'rgba(255, 255, 255, 0.8)', padding: 4,
          borderRadius: 8, border: '1px solid var(--border)', backdropFilter: 'blur(4px)'
        }}>
          <button title="Scroll Left" className="tv-btn" onClick={() => {
             const ts = chartRef.current?.timeScale();
             if(!ts) return;
             const range = ts.getVisibleLogicalRange();
             if(!range) return;
             const shift = (range.to - range.from) * 0.2;
             ts.setVisibleLogicalRange({ from: range.from - shift, to: range.to - shift });
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          
          <button title="Scroll Right" className="tv-btn" onClick={() => {
             const ts = chartRef.current?.timeScale();
             if(!ts) return;
             const range = ts.getVisibleLogicalRange();
             if(!range) return;
             const shift = (range.to - range.from) * 0.2;
             ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>

          <button title="Go to Current Time" className="tv-btn" onClick={() => {
             const ts = chartRef.current?.timeScale();
             if(!ts || !candlesCacheRef.current.length) return;
             
             const lastIndex = candlesCacheRef.current.length - 1;
             const width = ts.width();
             const barSpacing = ts.options().barSpacing || 6;
             const barsVisible = width / barSpacing;
             
             ts.setVisibleLogicalRange({
               from: lastIndex - barsVisible / 2,
               to: lastIndex + barsVisible / 2
             });
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>
          </button>

          <div style={{ width: 1, background: 'var(--border)', margin: '4px 4px' }} />

          <button title="Draw S/R Line" className="tv-btn" onClick={toggleDrawMode} style={{ color: drawMode ? '#e3b341' : 'var(--text-dim)', background: drawMode ? 'rgba(227, 179, 65, 0.15)' : 'transparent' }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2v20"></path><path d="M8 8l4-4 4 4"></path><path d="M8 16l4 4 4-4"></path></svg>
          </button>
          
          {drawnCount > 0 && (
            <>
              <button title="Undo Last Line" className="tv-btn" onClick={() => {
                const last = drawnLinesRef.current.pop();
                if (last) {
                  try { seriesRef.current.removePriceLine(last); } catch(e){}
                  setDrawnCount(drawnLinesRef.current.length);
                }
              }}>
                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path></svg>
              </button>
              <button title="Clear All S/R Lines" className="tv-btn" onClick={() => {
                drawnLinesRef.current.forEach(line => {
                  try { seriesRef.current.removePriceLine(line); } catch(e){}
                });
                drawnLinesRef.current = [];
                setDrawnCount(0);
              }} style={{ color: '#f85149' }}>
                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </>
          )}

          <div style={{ width: 1, background: 'var(--border)', margin: '4px 4px' }} />

          <button title="Zoom Out" className="tv-btn" onClick={() => {
             const ts = chartRef.current?.timeScale();
             if(!ts) return;
             const range = ts.getVisibleLogicalRange();
             if(!range) return;
             const diff = (range.to - range.from) * 0.2;
             ts.setVisibleLogicalRange({ from: range.from - diff, to: range.to + diff });
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
          </button>
          
          <button title="Zoom In" className="tv-btn" onClick={() => {
             const ts = chartRef.current?.timeScale();
             if(!ts) return;
             const range = ts.getVisibleLogicalRange();
             if(!range) return;
             const diff = (range.to - range.from) * 0.2;
             ts.setVisibleLogicalRange({ from: range.from + diff, to: range.to - diff });
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
          </button>

          <div style={{ width: 1, background: 'var(--border)', margin: '4px 4px' }} />

          <button title="Auto Fit" className="tv-btn" onClick={() => {
             chartRef.current?.timeScale().fitContent();
          }}>
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          </button>
        </div>
      </div>
    </div>
  );
});

// ── App ───────────────────────────────────────────────────────────────────────
export default function App({ onNavigate, theme, toggleTheme }) {
  const [underlying, setUnderlying] = useState('BTC');
  const [tf, setTf] = useState('1m');
  const [priceType, setPriceType] = useState('mark');
  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [strikes, setStrikes] = useState([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [selCallStrike, setSelCallStrike] = useState('');
  const [selPutStrike, setSelPutStrike] = useState('');
  const [callSym, setCallSym] = useState('');
  const [putSym, setPutSym] = useState('');
  const [legType, setLegType] = useState('combined'); // 'combined' | 'call' | 'put'
  const [watchList, setWatchList] = useState([]);
  const watchListRef = useRef(watchList);
  useEffect(() => { watchListRef.current = watchList; }, [watchList]);
  const [listData, setListData] = useState({}); // Stores { price, high, low } per item ID
  const [selectedWatchId, setSelectedWatchId] = useState(null);

  // ── Cross-tab sync for Watchlist ─────────────────────────────────────────
  const isRemoteUpdateRef = useRef(false);
  const selectedWatchIdRef = useRef(selectedWatchId);
  useEffect(() => { selectedWatchIdRef.current = selectedWatchId; }, [selectedWatchId]);

  const { broadcast: tabBroadcast } = useTabListener({
    WATCHLIST_SYNC: (payload) => {
      const currentStr = JSON.stringify(watchListRef.current);
      const newStr = JSON.stringify(payload.watchList);
      if (currentStr !== newStr) {
        isRemoteUpdateRef.current = true;
        setWatchList(payload.watchList);

        // Handle selected item state when watchlist changes remotely
        const currSelected = selectedWatchIdRef.current;
        if (currSelected) {
          const exists = payload.watchList.find(w => w.id === currSelected);
          if (!exists) {
            setSelectedWatchId(payload.watchList.length ? payload.watchList[0].id : null);
          }
        } else if (payload.watchList.length > 0) {
          setSelectedWatchId(payload.watchList[0].id);
        }
      }
    }
  });

  useEffect(() => {
    watchListRef.current = watchList;
    if (isRemoteUpdateRef.current) {
      isRemoteUpdateRef.current = false;
      return;
    }
    tabBroadcast('WATCHLIST_SYNC', { watchList });
  }, [watchList, tabBroadcast]);
  // ─────────────────────────────────────────────────────────────────────────

  const addToWatchList = async () => {
    if (legType !== 'put' && !callSym) { setErrMsg('Select valid call strike.'); return; }
    if (legType !== 'call' && !putSym) { setErrMsg('Select valid put strike.'); return; }
    setErrMsg('');

    const id = Date.now().toString();
    const item = {
      id,
      type: legType,
      callSym: legType !== 'put' ? callSym : null,
      putSym: legType !== 'call' ? putSym : null,
      callStrike: selCallStrike,
      putStrike: selPutStrike,
      expiry: selExpiry,
      underlying,
      priceType,
      alerts: [], // Array of { id, dir, price }
    };

    setWatchList(prev => {
      const next = [...prev, item];
      if (next.length === 1) setTimeout(() => setSelectedWatchId(id), 0);
      return next;
    });

    try {
      const now = Math.floor(Date.now() / 1000);
      const start = now - 3600;
      let hc = 0, lc = Infinity, hp = 0, lp = Infinity;

      if (item.callSym) {
        const c = await fetchCandles(item.callSym, '1h', start, now, priceType);
        if (c.length) { hc = c[c.length - 1].high; lc = c[c.length - 1].low; }
      }
      if (item.putSym) {
        const p = await fetchCandles(item.putSym, '1h', start, now, priceType);
        if (p.length) { hp = p[p.length - 1].high; lp = p[p.length - 1].low; }
      }

      let initialHigh = 0, initialLow = Infinity;
      if (item.type === 'combined' && hc && hp) {
        initialHigh = hc + hp;
        initialLow = lc + lp;
      } else if (item.type === 'call') {
        initialHigh = hc; initialLow = lc;
      } else if (item.type === 'put') {
        initialHigh = hp; initialLow = lp;
      }
      if (initialLow === Infinity) initialLow = 0;

      setListData(prev => ({
        ...prev,
        [id]: { price: 0, high: initialHigh, low: initialLow }
      }));
    } catch (e) { console.error('High/Low error', e); }
  };

  // 'idle' | 'loading' | 'ready'
  const [phase, setPhase] = useState('idle');
  const [errMsg, setErrMsg] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [callPrice, setCallPrice] = useState(null);
  const [putPrice, setPutPrice] = useState(null);
  const [spotPrice, setSpotPrice] = useState(null);

  // Chart refs — always valid since panels never unmount
  const combRef = useRef(null);
  const wsRef = useRef(null);
  const lastC = useRef(null);
  const lastP = useRef(null);
  const lastComb = useRef(null); // Accurate H/L tracker for combined
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

  const [alertLogs, setAlertLogs] = useState([]);

  const triggeredAlerts = useRef(new Set());
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'alert') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    
    if (type === 'alert') {
      setAlertLogs(prev => [{
        id: Date.now(),
        time: new Date().toLocaleTimeString(),
        msg
      }, ...prev].slice(0, 50));
    }
    
    setTimeout(() => {
      setToasts(t => t.filter(x => x.id !== id));
    }, 8000);
  }, []);

  const listWsRef = useRef(null);
  const tickerCacheRef = useRef({}); // { [sym]: price }

  const greekCacheRef = useRef({}); // { [sym]: greeks }

  useEffect(() => {
    if (!watchList.length) {
      if (listWsRef.current) { listWsRef.current.close(); listWsRef.current = null; }
      return;
    }

    const syms = new Set();
    watchList.forEach(w => {
      if (w.callSym) syms.add(w.callSym);
      if (w.putSym) syms.add(w.putSym);
    });

    if (listWsRef.current) listWsRef.current.close();

    const ws = new WebSocket('wss://socket.delta.exchange');
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'subscribe',
        payload: { channels: [{ name: 'v2/ticker', symbols: Array.from(syms) }] }
      }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'v2/ticker') {
        const sym = msg.symbol;
        const mark = parseFloat(msg.mark_price || 0);
        const ltp = parseFloat(msg.close || 0);
        if (!mark && !ltp) return;
        const prevCache = tickerCacheRef.current[sym] || { mark: 0, ltp: 0 };
        tickerCacheRef.current[sym] = {
           mark: mark || prevCache.mark,
           ltp: ltp || prevCache.ltp
        };

        if (msg.greeks) {
          greekCacheRef.current[sym] = {
            delta: parseFloat(msg.greeks.delta || 0),
            gamma: parseFloat(msg.greeks.gamma || 0),
            vega: parseFloat(msg.greeks.vega || 0),
            theta: parseFloat(msg.greeks.theta || 0),
            rho: parseFloat(msg.greeks.rho || 0),
            iv: parseFloat(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv ?? 0),
          };
        }

        setListData(prev => {
          let changed = false;
          const next = { ...prev };
          watchList.forEach(w => {
            const pcCache = tickerCacheRef.current[w.callSym] || { mark: 0, ltp: 0 };
            const ppCache = tickerCacheRef.current[w.putSym] || { mark: 0, ltp: 0 };
            const pC = w.priceType === 'ltp' ? (pcCache.ltp || pcCache.mark) : (pcCache.mark || pcCache.ltp);
            const pP = w.priceType === 'ltp' ? (ppCache.ltp || ppCache.mark) : (ppCache.mark || ppCache.ltp);
            
            const gC = greekCacheRef.current[w.callSym];
            const gP = greekCacheRef.current[w.putSym];

            let newPrice = 0;
            if (w.type === 'combined') newPrice = pC + pP;
            else if (w.type === 'call') newPrice = pC;
            else if (w.type === 'put') newPrice = pP;

            let newGreeks = null;
            if (w.type === 'combined') {
              if (gC && gP) {
                newGreeks = {
                  delta: gC.delta + gP.delta,
                  gamma: gC.gamma + gP.gamma,
                  vega: gC.vega + gP.vega,
                  theta: gC.theta + gP.theta,
                  rho: gC.rho + gP.rho,
                  iv: (gC.iv + gP.iv) / 2
                };
              }
            } else if (w.type === 'call') {
              if (gC) newGreeks = gC;
            } else if (w.type === 'put') {
              if (gP) newGreeks = gP;
            }

            const old = prev[w.id] || { price: 0, high: 0, low: Infinity, greeks: null };
            const priceChanged = old.price !== newPrice && newPrice !== 0 && (w.type === 'combined' ? (pC && pP) : true);
            const greeksChanged = JSON.stringify(old.greeks) !== JSON.stringify(newGreeks);

            if (priceChanged || greeksChanged) {
              changed = true;
              let newHigh = Math.max(old.high, newPrice);
              let newLow = old.low === Infinity || old.low === 0 ? newPrice : Math.min(old.low, newPrice);
              next[w.id] = { ...old, price: newPrice, high: newHigh, low: newLow, greeks: newGreeks };

              if (priceChanged) {
                (w.alerts || []).forEach(alertObj => {
                  if (!alertObj.price) return;
                  const target = parseFloat(alertObj.price);
                  const alertId = `${w.id}-${alertObj.id}`;
                  const triggered = alertObj.dir === '>=' ? newPrice >= target : newPrice <= target;
                  
                  if (triggered && !triggeredAlerts.current.has(alertId)) {
                    triggeredAlerts.current.add(alertId);
                    playAlertSound();
                    const name = w.type === 'combined' ? `STRADDLE ${w.callStrike}/${w.putStrike}`
                      : w.type === 'call' ? `CALL ${w.callStrike}C`
                        : `PUT ${w.putStrike}P`;
                    addToast(`Watchlist Alert: ${name} ${alertObj.dir} ${target} (Hit: ${newPrice.toFixed(2)})`);
                    
                    // Auto-remove triggered alert
                    setWatchList(prevW => prevW.map(item => 
                      item.id === w.id ? { ...item, alerts: (item.alerts || []).filter(a => a.id !== alertObj.id) } : item
                    ));
                  } else if (!triggered) {
                    triggeredAlerts.current.delete(alertId);
                  }
                });
              }
            }
          });
          return changed ? next : prev;
        });
        }
      };
      listWsRef.current = ws;
      return () => ws.close();
    }, [watchList, addToast]);


  // ── Notification Permissions ──────────────────────────────────────────────
  useEffect(() => {
    if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }, []);



  // ── Load products on underlying change ───────────────────────────────────
  useEffect(() => {
    setExpiries([]); setStrikes([]);
    setSelExpiry(''); setSelCallStrike(''); setSelPutStrike(''); setCallSym(''); setPutSym('');
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
      .then(spot => {
        const atm = String(findATM(ss, spot));
        setSelCallStrike(atm);
        setSelPutStrike(atm);
      })
      .catch(() => {
        setSelCallStrike(String(ss[0]));
        setSelPutStrike(String(ss[0]));
      });
  }, [selExpiry, products, underlying]);

  // ── Fetch spot price ────────────────────────────────────────────────────
  useEffect(() => {
    const fetchSpot = () => {
      getSpotPrice(underlying)
        .then(sp => { if (sp) setSpotPrice(sp); })
        .catch(() => { });
    };
    fetchSpot();
    const interval = setInterval(fetchSpot, 10000);
    return () => clearInterval(interval);
  }, [underlying]);

  // ── Derive symbols ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selExpiry || !products.length) { setCallSym(''); setPutSym(''); return; }

    if (selCallStrike) {
      const callProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(selCallStrike)
      );
      setCallSym(callProd?.symbol || '');
    } else setCallSym('');

    if (selPutStrike) {
      const putProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(selPutStrike)
      );
      setPutSym(putProd ? putSymbol(putProd.symbol) : '');
    } else setPutSym('');
  }, [selExpiry, selCallStrike, selPutStrike, products]);

  // ── Imperative combine update ─────────────────────────────────────────────
  const updateComb = useCallback((c, p) => {
    if (!c || !p) return;
    
    // At candle boundaries, call and put may temporarily have different timestamps.
    // Use the OLDER timestamp to keep the combined chart stable until both legs
    // have transitioned to the new bucket.
    const time = Math.min(c.time, p.time);
    
    // If the two legs are in different buckets, use the old bucket's close
    // from whichever leg has already rolled over, to avoid a spike.
    let cClose = c.close, pClose = p.close;
    if (c.time !== p.time) {
      // One leg jumped to a new candle while the other is still on the old one.
      // Use the close from both legs' perspective at the shared (older) time.
      // The leg that's ahead just opened, so its open ≈ its close — that's fine.
      // We just don't create a new candle until both legs agree.
      cClose = c.time === time ? c.close : c.open;  // if c jumped ahead, use its open (≈ previous close)
      pClose = p.time === time ? p.close : p.open;
    }
    
    const combinedPrice = cClose + pClose;
    
    let current = lastComb.current;
    
    if (!current || time > current.time) {
      // New bucket started or first data
      current = {
        time: time,
        open: combinedPrice,
        high: combinedPrice,
        low: combinedPrice,
        close: combinedPrice,
        callIv: c.callIv,
        putIv: p.putIv
      };
    } else {
      // Existing bucket - update close and expand H/L based on THIS tick
      current = {
        ...current,
        close: combinedPrice,
        callIv: c.callIv,
        putIv: p.putIv
      };
      if (combinedPrice > current.high) current.high = combinedPrice;
      if (combinedPrice < current.low) current.low = combinedPrice;
    }
    
    lastComb.current = current;
    combRef.current?.update(current);
  }, []);
  // ── START MONITORING ──────────────────────────────────────────────────────
  const startMonitoring = useCallback(async () => {
    const item = watchListRef.current.find(w => w.id === selectedWatchId);
    if (!item) return;

    const cSym = item.callSym || '';
    const pSym = item.putSym || '';
    const pType = item.priceType || priceType;

    if (!cSym && !pSym) { setErrMsg('Select valid strikes first.'); return; }

    // Kill existing WS
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (pollerRef.current) clearInterval(pollerRef.current);

    callSymRef.current = cSym;
    putSymRef.current = pSym;

    setErrMsg('');
    setPhase('loading');
    setCallPrice(null);
    setPutPrice(null);
    setCallGreeks(null);
    setPutGreeks(null);
    dataHubRef.current = { call: makeEmptySide(), put: makeEmptySide() };
    lastC.current = null;
    lastP.current = null;
    lastComb.current = null;

    const now = Math.floor(Date.now() / 1000);
    // Rough estimate of start time, relying on the API to limit to available data
    const start = now - 604800 * 2; // fetch enough back for CANDLE_COUNT

    try {
      console.log(`Fetching: ${cSym} / ${pSym} @ ${tf} (${pType})`);
      const [cCandles, pCandles] = await Promise.all([
        cSym ? fetchCandles(cSym, tf, start, now, pType) : Promise.resolve([]),
        pSym ? fetchCandles(pSym, tf, start, now, pType) : Promise.resolve([]),
      ]);
      console.log(`Candles: call=${cCandles.length} put=${pCandles.length}`);

      // Push data directly — charts are already mounted
      combRef.current?.clearIvData();

      combRef.current?.setData(sumCandles(cCandles, pCandles), true);

      setActiveCall(cSym);
      setActivePut(pSym);
      setPhase('ready');

      if (cCandles.length) { lastC.current = cCandles.at(-1); setCallPrice(cCandles.at(-1).close); }
      if (pCandles.length) { lastP.current = pCandles.at(-1); setPutPrice(pCandles.at(-1).close); }

      const bucketSecs = TF_SECS[tf] || 60;

      // ── Helper: refresh only CLOSED candles from REST ──────────────────────
      // Never overwrites the live candle — the WS-driven updateComb tracks
      // accurate tick-by-tick combined OHLC. REST's sumCandles gives incorrect
      // H/L (callHigh + putHigh ≠ combinedHigh) because peaks occur at
      // different times, so we must protect the live candle from it.
      const refreshCurrentCandle = async () => {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const bSecs = TF_SECS[tf] || 60;
          const currentBucket = Math.floor(nowSec / bSecs) * bSecs;
          const startTs = Math.max(0, nowSec - bSecs * 3);

          const [cc, pc] = await Promise.all([
            cSym ? fetchCandles(cSym, tf, startTs, nowSec + 1, pType) : Promise.resolve([]),
            pSym ? fetchCandles(pSym, tf, startTs, nowSec + 1, pType) : Promise.resolve([]),
          ]);

          // Update lastC/lastP refs for the WS candle builder
          if (cc?.length) {
            const latestC = cc[cc.length - 1];
            if (!lastC.current || latestC.time >= lastC.current.time) {
              lastC.current = latestC;
            }
          }
          if (pc?.length) {
            const latestP = pc[pc.length - 1];
            if (!lastP.current || latestP.time >= lastP.current.time) {
              lastP.current = latestP;
            }
          }

          // Only update CLOSED candles on the chart — skip the live bucket
          const comb = sumCandles(cc, pc);
          comb.forEach(c => {
            if (c.time < currentBucket) {
              combRef.current?.update(c);
            }
            // Live candle (c.time >= currentBucket) is managed by WS updateComb
          });
        } catch (err) { console.warn('refreshCurrentCandle failed:', err); }
      };

      // ── Helper: completely refresh history when a candle closes ───────────
      // Replaces all CLOSED candles with official REST data, then appends the
      // current live candle from lastComb.current to keep it smooth.
      const refreshAllHistory = async () => {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const bSecs = TF_SECS[tf] || 60;
          const currentBucket = Math.floor(nowSec / bSecs) * bSecs;
          const startTs = nowSec - bSecs * CANDLE_COUNT;

          const [cc, pc] = await Promise.all([
            cSym ? fetchCandles(cSym, tf, startTs, nowSec + 1, pType) : Promise.resolve([]),
            pSym ? fetchCandles(pSym, tf, startTs, nowSec + 1, pType) : Promise.resolve([]),
          ]);

          if (cc?.length) {
            lastC.current = cc[cc.length - 1];
            setCallPrice(lastC.current.close);
          }
          if (pc?.length) {
            lastP.current = pc[pc.length - 1];
            setPutPrice(lastP.current.close);
          }

          const comb = sumCandles(cc, pc);
          if (comb.length) {
            // Split: closed candles from REST + live candle from WS tracker
            const closedCandles = comb.filter(c => c.time < currentBucket);
            const finalData = [...closedCandles];

            // Preserve the WS-tracked live candle (accurate combined H/L)
            if (lastComb.current && lastComb.current.time >= currentBucket) {
              finalData.push(lastComb.current);
            } else {
              // Fallback: if WS hasn't started the live candle yet, use REST's
              const restLive = comb.find(c => c.time >= currentBucket);
              if (restLive) finalData.push(restLive);
            }

            // Atomic replacement — preserves scroll position
            combRef.current?.setData(finalData, false);

            // ── Alert Engine (EVALUATES ONLY ON OFFICIALLY CLOSED CANDLES) ──
            const closedComb = [...closedCandles].reverse()[0]; // most recent closed

            if (closedComb) {
              const activeItem = watchListRef.current.find(w => w.id === selectedWatchId);
              const alerts = (activeItem?.alerts || []);
              alerts.forEach(alertObj => {
                if (!alertObj.price) return;
                const target = parseFloat(alertObj.price);
                const alertId = `comb-${alertObj.id}`;
                const isTriggered = alertObj.dir === '>=' ? closedComb.close >= target : closedComb.close <= target;

                if (isTriggered && !triggeredAlerts.current.has(alertId)) {
                  triggeredAlerts.current.add(alertId);
                  playAlertSound();
                  const title = formatCombinedTitle(cSym, pSym, pType);
                  const msg = `${title} confirmed crossing at close! Price: ${closedComb.close.toFixed(2)} (${alertObj.dir} ${target})`;
                  if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification('OptionScope Alert', { body: msg });
                  }
                  addToast(msg);

                  // Auto-remove triggered alert
                  setWatchList(prev => prev.map(w => 
                    w.id === selectedWatchId ? { ...w, alerts: w.alerts.filter(a => a.id !== alertObj.id) } : w
                  ));
                } else if (!isTriggered) {
                  triggeredAlerts.current.delete(alertId);
                }
              });
            }
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
      // ── Debounced correction: both call and put may fire new-candle events
      // within milliseconds of each other — debounce so only one REST fetch runs.
      let correctionDebounce = null;
      const correctClosedCandle = () => {
        if (correctionDebounce) clearTimeout(correctionDebounce);
        correctionDebounce = setTimeout(() => {
          correctionDebounce = null;
          refreshAllHistory();
        }, 2000); // wait 2s for both legs to roll over before fetching
      };

      wsRef.current = createWS(
        cSym, pSym, tf, pType,
        (sym, price, _ts, iv) => {
          // Use exchange timestamp if available, fallback to wall-clock
          const nowSec = _ts || Math.floor(Date.now() / 1000);
          const anchor = lastC.current?.time ?? lastP.current?.time ?? Math.floor(nowSec / bucketSecs) * bucketSecs;
          const currentBucket = anchor + Math.floor((nowSec - anchor) / bucketSecs) * bucketSecs;

          if (sym === callSymRef.current) {
            setCallPrice(price);
            if (!lastC.current || currentBucket > lastC.current.time) {
              const prevTime = lastC.current?.time;
              const newC = { time: currentBucket, open: price, high: price, low: price, close: price, callIv: iv };
              lastC.current = newC;
              if (lastP.current) updateComb(newC, lastP.current);
              if (prevTime) correctClosedCandle();
            } else {
              const upd = { ...lastC.current, close: price, callIv: iv };
              if (price > upd.high) upd.high = price;
              if (price < upd.low) upd.low = price;
              lastC.current = upd;
              if (lastP.current) updateComb(upd, lastP.current);
            }
          }
          if (sym === putSymRef.current) {
            setPutPrice(price);
            if (!lastP.current || currentBucket > lastP.current.time) {
              const prevTime = lastP.current?.time;
              const newP = { time: currentBucket, open: price, high: price, low: price, close: price, putIv: iv };
              lastP.current = newP;
              if (lastC.current) updateComb(lastC.current, newP);
              if (prevTime) correctClosedCandle();
            } else {
              const upd = { ...lastP.current, close: price, putIv: iv };
              if (price > upd.high) upd.high = price;
              if (price < upd.low) upd.low = price;
              lastP.current = upd;
              if (lastC.current) updateComb(lastC.current, upd);
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
                  delta: parseFloat(msg.greeks.delta || 0),
                  gamma: parseFloat(msg.greeks.gamma || 0),
                  vega: parseFloat(msg.greeks.vega || 0),
                  theta: parseFloat(msg.greeks.theta || 0),
                  rho: parseFloat(msg.greeks.rho || 0),
                  iv: parseFloat(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv ?? 0),
                };
                dataHubRef.current[side].greeks = g;
                if (side === 'call') setCallGreeks(g);
                else setPutGreeks(g);
              } else if (msg.mark_vol || msg.quotes?.mark_iv) {
                // Fallback: update only IV if greeks object is missing
                const iv = parseFloat(msg.mark_vol ?? msg.quotes?.mark_iv ?? 0);
                const prev = dataHubRef.current[side].greeks || {};
                const g = { ...prev, iv };
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
  }, [selectedWatchId, tf, priceType, updateComb, addToast]);

  // Trigger startMonitoring whenever selectedWatchId changes
  useEffect(() => {
    if (selectedWatchId) {
      startMonitoring();
    } else {
      setPhase('idle');
      combRef.current?.clearData();
      combRef.current?.clearIvData();
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    }
  }, [selectedWatchId, startMonitoring]);

  useEffect(() => () => {
    wsRef.current?.close();
    if (currentCandleTimer.current) clearInterval(currentCandleTimer.current);
  }, []);

  const combPrice = (callPrice && putPrice) ? (callPrice + putPrice).toFixed(2) : '—';

  return (
    <div className="app">
      {/* Toast Container */}
      <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none' }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            background: 'rgba(10, 13, 18, 0.98)', border: '1px solid rgba(227, 179, 65, 0.3)', borderLeft: '4px solid #e3b341',
            padding: '12px 16px', borderRadius: 8, color: '#fff', fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
            boxShadow: '0 12px 32px rgba(0,0,0,0.7)', minWidth: 280,
            animation: 'slideIn 0.3s ease-out'
          }}>
            <div style={{ color: '#e3b341', fontWeight: 800, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, letterSpacing: 1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              ALERT TRIGGERED
            </div>
            <div style={{ color: '#e6edf3', lineHeight: 1.5, opacity: 0.9 }}>{t.msg}</div>
          </div>
        ))}
      </div>

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

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nav-tab active">
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 20H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="7" y="12" width="3" height="6" rx="0.6" fill="currentColor" />
                <rect x="12" y="9" width="3" height="9" rx="0.6" fill="currentColor" />
                <rect x="17" y="6" width="3" height="12" rx="0.6" fill="currentColor" />
              </svg>
            </span> Charts
          </button>
          <button className="nav-tab" onClick={() => onNavigate('scanner')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> Ratio Spread
          </button>
          <button className="nav-tab" onClick={() => onNavigate('trading')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> Paper Trading
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          {activeCall && (
            <span style={{ fontFamily: 'JetBrains Mono', fontSize: 11, color: '#7d8590' }}>
              {activeCall} / {activePut}
            </span>
          )}
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
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

            <div className="form-group" style={{ opacity: legType === 'put' ? 0.5 : 1 }}>
              <label>Call Strike</label>
              <select value={selCallStrike} onChange={e => setSelCallStrike(e.target.value)} disabled={!strikes.length || legType === 'put'}>
                {!strikes.length
                  ? <option>Select Expiry First</option>
                  : strikes.map(s => <option key={s} value={s}>{Number(s).toLocaleString()}</option>)
                }
              </select>
            </div>

            <div className="form-group" style={{ opacity: legType === 'call' ? 0.5 : 1 }}>
              <label>Put Strike</label>
              <select value={selPutStrike} onChange={e => setSelPutStrike(e.target.value)} disabled={!strikes.length || legType === 'call'}>
                {!strikes.length
                  ? <option>Select Expiry First</option>
                  : strikes.map(s => <option key={s} value={s}>{Number(s).toLocaleString()}</option>)
                }
              </select>
            </div>

            <div className="form-group">
              <label>Leg Type</label>
              <select value={legType} onChange={e => setLegType(e.target.value)}>
                <option value="combined">Combined (Straddle/Strangle)</option>
                <option value="call">Call Premium Only</option>
                <option value="put">Put Premium Only</option>
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

            <button className="btn-start" disabled={(!callSym && !putSym) || (legType !== 'put' && !callSym) || (legType !== 'call' && !putSym)} onClick={addToWatchList}>
              ADD TO WATCHLIST
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

          {/* Alert History card */}
          <div className="card">
            <div className="card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Alert History</span>
              <span onClick={() => setAlertLogs([])} style={{ fontSize: 9, cursor: 'pointer', opacity: 0.6 }}>Clear</span>
            </div>
            <div className="trade-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {!alertLogs.length && <div style={{ textAlign: 'center', padding: 20, color: '#484f58', fontSize: 11 }}>No alerts logged yet.</div>}
              {alertLogs.map(log => (
                <div key={log.id} style={{
                  padding: '6px 0', borderBottom: '1px solid #21262d', fontSize: 11,
                  display: 'flex', flexDirection: 'column', gap: 2
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e3b341', fontWeight: 800, fontSize: 10 }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                      TRIGGERED
                    </div>
                    <span style={{ color: '#7d8590', fontSize: 10 }}>{log.time}</span>
                  </div>
                  <div style={{ color: '#e6edf3', lineHeight: 1.4 }}>{log.msg}</div>
                </div>
              ))}
            </div>
          </div>



        </aside>

        {/* Chart area — charts ALWAYS mounted, overlay sits on top */}
        <main className="main" style={{ position: 'relative', padding: 12, gap: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          <div style={{ fontFamily: 'JetBrains Mono', fontSize: 16, fontWeight: 700, color: theme === 'dark' ? '#e6edf3' : '#1e2730', display: 'flex', alignItems: 'center' }}>
            SPOT: <span style={{ color: '#e3b341', marginLeft: 8 }}>{spotPrice ? spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</span>
          </div>

          <div className="watchlist-container" style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', paddingBottom: 8, minHeight: 80, maxHeight: '35vh', zIndex: 11 }}>
            {watchList.length === 0 ? (
              <div style={{ color: '#7d8590', fontSize: 12, padding: 12, border: '1px dashed #1e2730', borderRadius: 8, textAlign: 'center' }}>
                No strategies in watchlist. Add one from the sidebar.
              </div>
            ) : (
              watchList.map(item => {
                let data = listData[item.id] || { price: 0, high: 0, low: Infinity };
                const isSelected = selectedWatchId === item.id;

                if (isSelected) {
                  let chartPrice = 0, chartHigh = 0, chartLow = Infinity;
                  let chartGreeks = null;

                  if (item.type === 'combined') {
                    if (lastComb.current) {
                      chartPrice = lastComb.current.close;
                      chartHigh = lastComb.current.high;
                      chartLow = lastComb.current.low;
                    }
                    if (callGreeks && putGreeks) {
                      chartGreeks = {
                        delta: callGreeks.delta + putGreeks.delta,
                        gamma: callGreeks.gamma + putGreeks.gamma,
                        vega: callGreeks.vega + putGreeks.vega,
                        theta: callGreeks.theta + putGreeks.theta,
                        rho: callGreeks.rho + putGreeks.rho,
                        iv: (callGreeks.iv + putGreeks.iv) / 2
                      };
                    }
                  } else if (item.type === 'call') {
                    if (lastC.current) {
                      chartPrice = lastC.current.close;
                      chartHigh = lastC.current.high;
                      chartLow = lastC.current.low;
                    }
                    chartGreeks = callGreeks;
                  } else if (item.type === 'put') {
                    if (lastP.current) {
                      chartPrice = lastP.current.close;
                      chartHigh = lastP.current.high;
                      chartLow = lastP.current.low;
                    }
                    chartGreeks = putGreeks;
                  }
                  
                  if (chartPrice > 0) {
                     data = {
                        ...data,
                        price: chartPrice,
                        high: chartHigh > 0 ? chartHigh : data.high,
                        low: chartLow < Infinity ? chartLow : data.low,
                        greeks: chartGreeks || data.greeks
                     };
                  }
                }

                return (
                  <div key={item.id} onClick={() => setSelectedWatchId(item.id)}
                    className={`watch-item ${isSelected ? 'selected' : ''}`}
                    style={{ backgroundColor: theme == 'dark' ? '' : isSelected ? '#b8f5f7' : '#e6edf3' }}>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 16 }}>
                      <div className="watch-item-title">
                        {item.type === 'combined' ? (
                          <><span className="badge comb">STRADDLE</span> {item.callStrike}C + {item.putStrike}P</>
                        ) : item.type === 'call' ? (
                          <><span className="badge call">CALL</span> {item.callStrike}C</>
                        ) : (
                          <><span className="badge put">PUT</span> {item.putStrike}P</>
                        )}
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, letterSpacing: 0.5 }}>{fmtExpiry(item.expiry)}</div>
                      </div>

                      <div className="watch-item-prices">
                        <div className="watch-price-block">
                          <span className="watch-price-label">LIVE</span>
                          <span className={`watch-price-val live ${data.price > 0 ? 'highlight' : ''}`}>{data.price > 0 ? data.price.toFixed(2) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">1H HIGH</span>
                          <span className="watch-price-val high">{data.high > 0 ? data.high.toFixed(2) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">1H LOW</span>
                          <span className="watch-price-val low">{data.low < Infinity && data.low > 0 ? data.low.toFixed(2) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">DELTA</span>
                          <span className="watch-price-val" style={{ color: 'var(--accent)', fontSize: 13 }}>{data.greeks?.delta != null ? data.greeks.delta.toFixed(4) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">GAMMA</span>
                          <span className="watch-price-val" style={{ color: 'var(--accent)', fontSize: 13 }}>{data.greeks?.gamma != null ? data.greeks.gamma.toFixed(5) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">VEGA</span>
                          <span className="watch-price-val" style={{ color: 'var(--comb)', fontSize: 13 }}>{data.greeks?.vega != null ? data.greeks.vega.toFixed(2) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">THETA</span>
                          <span className="watch-price-val" style={{ color: '#ff7b72', fontSize: 13 }}>{data.greeks?.theta != null ? data.greeks.theta.toFixed(2) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">RHO</span>
                          <span className="watch-price-val" style={{ color: '#58a6ff', fontSize: 13 }}>{data.greeks?.rho != null ? data.greeks.rho.toFixed(4) : '—'}</span>
                        </div>
                        <div className="watch-price-block">
                          <span className="watch-price-label">IV %</span>
                          <span className="watch-price-val" style={{ color: 'var(--comb)', fontSize: 13 }}>{data.greeks?.iv != null ? (data.greeks.iv * 100).toFixed(1) : '—'}%</span>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} onClick={e => e.stopPropagation()}>
                      {/* Alerts Section */}
                      <div className="watch-alert-pill" style={{ height: 'auto', minHeight: 32, padding: '4px 8px' }}>
                        <div className="watch-alert-icon-wrap" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e3b341" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                            <circle cx="12" cy="3" r="1" fill="#e3b341" />
                          </svg>
                        </div>
                        
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {(item.alerts || []).map(a => (
                              <div key={a.id} style={{
                                display: 'flex', alignItems: 'center', gap: 6, background: '#161b22', border: '1px solid #30363d',
                                padding: '2px 8px', borderRadius: 4, fontSize: 10, color: a.dir === '>=' ? '#3fb950' : '#f85149', fontWeight: 700
                              }}>
                                {a.dir} {parseFloat(a.price).toFixed(2)}
                                <div 
                                  onClick={() => {
                                    setWatchList(prev => prev.map(w => w.id === item.id ? { ...w, alerts: w.alerts.filter(x => x.id !== a.id) } : w));
                                  }} 
                                  style={{ cursor: 'pointer', opacity: 0.6, marginLeft: 4, display: 'flex', alignItems: 'center' }}
                                  className="alert-delete-icon"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                  </svg>
                                </div>
                              </div>
                            ))}
                          </div>

                          <div className="watch-alert-inputs" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <select 
                              id={`dir-${item.id}`}
                              style={{ 
                                background: 'transparent', border: 'none', 
                                color: document.getElementById(`dir-${item.id}`)?.value === '<=' ? '#f85149' : '#3fb950',
                                fontSize: 10, fontWeight: 700, outline: 'none', cursor: 'pointer' 
                              }}
                              onChange={(e) => e.target.style.color = e.target.value === '>=' ? '#3fb950' : '#f85149'}
                            >
                              <option value=">=" style={{ color: '#3fb950' }}>&ge;</option>
                              <option value="<=" style={{ color: '#f85149' }}>&le;</option>
                            </select>
                            <input
                              type="number"
                              placeholder="Price"
                              id={`price-${item.id}`}
                              style={{ background: 'transparent', border: 'none', color: '#e6edf3', width: 50, fontSize: 10, fontFamily: 'JetBrains Mono', outline: 'none' }}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  const dir = document.getElementById(`dir-${item.id}`).value;
                                  const price = e.target.value;
                                  if (price) {
                                    setWatchList(prev => prev.map(w => w.id === item.id ? { ...w, alerts: [...(w.alerts || []), { id: Date.now(), dir, price }] } : w));
                                    e.target.value = '';
                                    addToast(`Alert set: ${dir} ${price}`, 'info');
                                  }
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                const dir = document.getElementById(`dir-${item.id}`).value;
                                const input = document.getElementById(`price-${item.id}`);
                                const price = input.value;
                                if (price) {
                                  setWatchList(prev => prev.map(w => w.id === item.id ? { ...w, alerts: [...(w.alerts || []), { id: Date.now(), dir, price }] } : w));
                                  input.value = '';
                                  addToast(`Alert set: ${dir} ${price}`, 'info');
                                }
                              }}
                              style={{ background: 'rgba(56, 139, 253, 0.1)', border: '1px solid rgba(56, 139, 253, 0.3)', color: '#58a6ff', padding: '0 6px', borderRadius: 4, fontSize: 9, fontWeight: 700, cursor: 'pointer' }}
                            >
                              ADD
                            </button>
                          </div>
                        </div>
                      </div>

                      <button className="watch-delete-btn" title="Remove strategy" onClick={() => {
                        setWatchList(prev => prev.filter(w => w.id !== item.id));
                        setListData(prev => { const next = { ...prev }; delete next[item.id]; return next; });
                        if (selectedWatchId === item.id) setSelectedWatchId(null);
                      }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Idle/Loading overlay — sits ON TOP of charts via absolute positioning */}
          {(phase === 'idle' || phase === 'loading') && (
            <div style={{
              position: 'absolute', inset: 12, zIndex: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              background: theme === 'dark' ? 'rgba(10,13,18,0.96)' : 'rgba(255,255,255,0.96)',
              borderRadius: 8, border: '1px solid #1e2730',
              gap: 12,
            }}>
              {phase === 'loading' && <div className="spinner" />}
              <div style={{ fontFamily: 'JetBrains Mono', fontSize: 14, fontWeight: 700, letterSpacing: 2 }}>
                {phase === 'loading' ? 'LOADING CANDLES' : 'OPTIONSCOPE'}
              </div>
              <div style={{ fontSize: 12, color: '#7d8590' }}>
                {phase === 'loading' ? 'Loading chart data...' : 'Add a strategy to your watchlist and select it to view the chart.'}
              </div>
              {errMsg && <div style={{ color: '#f85149', fontSize: 12, maxWidth: 320, textAlign: 'center' }}>{errMsg}</div>}
            </div>
          )}

          {/* Combined chart — ALWAYS in DOM */}
          <ChartPanel
            ref={combRef}
            title={formatCombinedTitle(activeCall, activePut, priceType)}
            colorUp="#3fb950"
            colorDown="#f85149"
            iconColor="#e3b341"
            alerts={watchList.find(w => w.id === selectedWatchId)?.alerts || []}
            onAddAlert={(dir, price) => {
              const id = Date.now();
              setWatchList(prev => prev.map(w => w.id === selectedWatchId ? { ...w, alerts: [...(w.alerts || []), { id, dir, price }] } : w));
              addToast(`Alert set: ${dir} ${price}`, 'info');
            }}
            onRemoveAlert={(id) => {
              setWatchList(prev => prev.map(w => w.id === selectedWatchId ? { ...w, alerts: w.alerts.filter(a => a.id !== id) } : w));
            }}
            showIvCall={true}
            showIvPut={true}
            theme={theme}
          />
        </main>
      </div>
    </div>
  );
}
