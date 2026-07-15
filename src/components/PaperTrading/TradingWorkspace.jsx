import React, { useState } from 'react';
import ActivePositionsTable from './ActivePositionsTable';
import TradeHistoryTable from './TradeHistoryTable';
import { formatDateTime } from '../../scannerUtils';
import { Activity, Clock, AlertOctagon, Check, History, Shield, Loader2, ChevronLeft, ChevronRight, Calendar, Download, RefreshCw } from 'lucide-react';

// ── Icons ───────────────────────────────────────────────────────────────
const IconMap = {
  positions: Activity,
  open: Clock,
  stop: AlertOctagon,
  fills: Check,
  history: History,
  risk: Shield,
};

const Icon = ({ name, size = 15 }) => {
  const Comp = IconMap[name];
  if (!Comp) return null;
  return <Comp size={size} strokeWidth={2} />;
};

// Exit trigger for a position — mirrors ActivePositionsTable's logic so the
// Stop Orders tab stays consistent with the distance-to-exit meter there.
function exitTrigger(p, exitType, exitPoints) {
  const isCall = p.type === 'call';
  const buyStrike = Number(p.buyLeg.strike);
  let triggerPrice = buyStrike;
  // Exit convention: ITM = strike + pts (call) / − pts (put);
  // OTM = strike − pts (call) / + pts (put).
  if (exitType === 'ITM') triggerPrice = isCall ? buyStrike + exitPoints : buyStrike - exitPoints;
  else if (exitType === 'OTM') triggerPrice = isCall ? buyStrike - exitPoints : buyStrike + exitPoints;
  const operator = isCall ? '≥' : '≤';
  return { triggerPrice, operator, isCall };
}

// ── Loading state (live view still resolving on reload) ───────────────────
function LoadingPanel() {
  return (
    <div className="pt-empty">
      <div className="pt-empty-icon idle">
        <Loader2 size={24} stroke="var(--text-dim)" strokeWidth={2} style={{ animation: 'spin 0.8s linear infinite' }} />
      </div>
      <span className="pt-empty-title">Loading live data…</span>
      <span className="pt-empty-desc">Fetching positions, orders and history from Delta Exchange.</span>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────
function EmptyPanel({ icon, title, desc }) {
  return (
    <div className="pt-empty">
      <div className="pt-empty-icon idle">
        <Icon name={icon} size={24} />
      </div>
      <span className="pt-empty-title">{title}</span>
      <span className="pt-empty-desc">{desc}</span>
    </div>
  );
}

// ── Stop Orders — derived from active positions' exit triggers ────────────
function StopOrdersTab({ positions, underlying, spotPrice, exitType, exitPoints, onExitPosition }) {
  // Spreads only — long-only positions exit via their scale-out ladder and live
  // under Open Orders, not as spot-trigger stops.
  const rows = positions.filter(p => p.underlying === underlying && (p.sellQty || 0) > 0);
  if (rows.length === 0) {
    return (
      <EmptyPanel icon="stop" title="No Stop Orders"
        desc="Each open position arms an automatic exit trigger. They appear here while the engine watches spot against the exit level." />
    );
  }
  const liveSpot = spotPrice || 0;
  return (
    <div className="pt-table-scroll">
      <table className="pt-table">
        <thead><tr>
          <th>Linked Position</th>
          <th>Trigger</th>
          <th>Condition</th>
          <th>Trigger Spot</th>
          <th>Spot Now</th>
          <th>Distance</th>
          <th>Action</th>
          <th>Status</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>
          {rows.map(p => {
            const isLongOnly = (p.sellQty || 0) === 0;
            const { triggerPrice, operator, isCall } = exitTrigger(p, exitType, exitPoints);
            const away = Math.abs(triggerPrice - liveSpot);
            const awayPct = liveSpot > 0 ? (away / liveSpot) * 100 : 0;
            const hit = isCall ? liveSpot >= triggerPrice : liveSpot <= triggerPrice;
            return (
              <tr key={p.id} className={`pt-row-${p.type}`}>
                <td>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className={`pt-legrail ${p.type}`} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>
                        {p.buyLeg.strike.toLocaleString()}{isLongOnly ? '' : ` / ${p.sellLeg.strike.toLocaleString()}`}
                      </span>
                    </div>
                  </div>
                </td>
                <td><span className="pt-exit-badge atm">{isLongOnly ? 'LADDER' : `${exitType} EXIT`}</span></td>
                <td><span style={{ fontFamily: 'Inter', fontWeight: 600, color: 'var(--text-dim)' }}>Spot {operator}</span></td>
                <td><span style={{ color: 'var(--accent)', fontWeight: 700 }}>{triggerPrice.toLocaleString()}</span></td>
                <td><span style={{ fontWeight: 600 }}>{liveSpot ? liveSpot.toLocaleString() : '—'}</span></td>
                <td>
                  <span className={hit ? 'pt-pnl negative' : ''} style={{ fontWeight: 700 }}>
                    {Math.round(away).toLocaleString()}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 4 }}>
                    ({awayPct.toFixed(2)}%)
                  </span>
                </td>
                <td><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Close {isLongOnly ? 'long' : 'spread'}</span></td>
                <td>
                  <span className="pt-stop-status" style={{ color: hit ? 'var(--put)' : 'var(--call)' }}>
                    <span className="pt-status-pulse" style={{ background: hit ? 'var(--put)' : 'var(--call)' }} />
                    {hit ? 'Triggering' : 'Armed'}
                  </span>
                </td>
                <td>
                  <button onClick={() => onExitPosition(p)} className="pt-btn-exit-pos pt-mini-btn">
                    Close now
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Risk & Margin — derived from open positions + margin math ─────────────
function RiskMarginTab({ positions, underlying, spotPrice, totalMargin, calculatePositionMargin, includeFees }) {
  const rows = positions.filter(p => p.underlying === underlying);
  if (rows.length === 0) {
    return (
      <EmptyPanel icon="risk" title="No Exposure"
        desc="Margin, exposure and risk metrics for open positions appear here once the engine enters a trade." />
    );
  }

  const totalUnrl = rows.reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0)), 0);
  const calls = rows.filter(p => p.type === 'call').length;
  const puts = rows.filter(p => p.type === 'put').length;
  const maxMargin = Math.max(...rows.map(calculatePositionMargin), 1);
  const worst = rows.reduce((a, b) => (calculatePositionMargin(b) > calculatePositionMargin(a) ? b : a), rows[0]);
  // Rough notional at risk: short-leg notional across positions.
  const notional = rows.reduce((s, p) => {
    const sellLot = p.sellLeg?.lotSize || 0;
    return s + (spotPrice || p.entrySpotPrice || 0) * (p.sellQty || 0) * sellLot;
  }, 0);

  const cards = [
    { label: 'Total Margin Used', big: `$${totalMargin.toFixed(0)}`, sub: `Across ${rows.length} position${rows.length !== 1 ? 's' : ''}`, pct: 100, color: 'var(--accent)' },
    { label: 'Unrealized P&L', big: `${totalUnrl >= 0 ? '+' : ''}${totalUnrl.toFixed(2)}`, sub: includeFees ? 'Net of fees' : 'Gross', pct: Math.min(100, Math.abs(totalUnrl) / (totalMargin || 1) * 100), color: totalUnrl >= 0 ? 'var(--call)' : 'var(--put)', valClass: totalUnrl >= 0 ? 'positive' : 'negative' },
    { label: 'Open Exposure', big: `${calls}C · ${puts}P`, sub: `Short notional ≈ $${notional.toFixed(0)}`, pct: (calls + puts) ? (calls / (calls + puts)) * 100 : 0, color: 'var(--call)' },
    { label: 'Largest Position', big: `$${calculatePositionMargin(worst).toFixed(0)}`, sub: `${worst.type.toUpperCase()} ${worst.buyLeg.strike.toLocaleString()}`, pct: (calculatePositionMargin(worst) / (totalMargin || 1)) * 100, color: 'var(--accent)' },
  ];

  return (
    <>
      <div className="pt-risk-grid">
        {cards.map((c, i) => (
          <div key={i} className="pt-risk-card">
            <h4>{c.label}</h4>
            <span className={`pt-risk-big ${c.valClass || ''}`}>{c.big}</span>
            <div className="pt-meter"><i style={{ width: `${c.pct}%`, background: c.color }} /></div>
            <span className="pt-risk-sub">{c.sub}</span>
          </div>
        ))}
      </div>

      <div className="pt-table-scroll" style={{ borderTop: '1px solid var(--border)' }}>
        <table className="pt-table">
          <thead><tr>
            <th>Position</th>
            <th>Strikes (L/S)</th>
            <th>Req. Margin</th>
            <th>% of Total</th>
            <th>Unrealized P&L</th>
          </tr></thead>
          <tbody>
            {rows.map(p => {
              const m = calculatePositionMargin(p);
              const pnl = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
              const isLongOnly = (p.sellQty || 0) === 0;
              return (
                <tr key={p.id} className={`pt-row-${p.type}`}>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className={`pt-legrail ${p.type}`} />
                      <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                    </div>
                  </td>
                  <td>
                    <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                    <span className="pt-strike-sell" style={{ marginLeft: 6, opacity: 0.8 }}>{isLongOnly ? '—' : p.sellLeg.strike.toLocaleString()}</span>
                  </td>
                  <td><span style={{ fontWeight: 600 }}>${m.toFixed(0)}</span></td>
                  <td>
                    <div className="pt-margin-cell">
                      <span>{((m / (totalMargin || 1)) * 100).toFixed(1)}%</span>
                      <div className="pt-margin-bar"><div className="pt-margin-fill" style={{ width: `${Math.min(100, (m / maxMargin) * 100)}%` }} /></div>
                    </div>
                  </td>
                  <td><span className={`pt-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero'}`}>{pnl > 0 ? '+' : ''}{pnl.toFixed(2)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  LIVE (real Delta) views — fed by the `live_exchange_state` snapshot the
//  engine publishes for armed live accounts. These render exchange TRUTH and
//  replace the engine-derived views above when a live snapshot is present.
// ══════════════════════════════════════════════════════════════════════════

const fmtNum = (v, d = 2) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—';
};
const fmtTs = (t) => { try { return t ? formatDateTime(new Date(t)) : '—'; } catch { return '—'; } };
const sideColor = (side) => String(side).toLowerCase() === 'buy' ? 'var(--call)' : 'var(--put)';
const Tag = ({ text, color = 'var(--accent)' }) => (
  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 5, color, border: `1px solid ${color}`, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
    {String(text ?? '—')}
  </span>
);

// ── Open Orders (live) — resting limit orders on Delta ────────────────────
function LiveOrdersTab({ orders, spotPrice, onCancelOrder }) {
  if (!orders?.length) {
    return <EmptyPanel icon="open" title="No Open Orders"
      desc="Resting limit orders on Delta Exchange appear here. Spread entries rest at their limit price until filled." />;
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const idx = num(spotPrice);
  return (
    <div className="pt-table-scroll">
      <table className="pt-table pt-delta-table"><thead><tr>
        <th>Symbol</th><th className="r">Qty (Lot)</th><th className="r">Filled</th><th className="r">Size</th>
        <th className="r">Notional</th><th>Type</th><th className="r">Reduce Only</th><th className="r">Limit Price</th>
        <th className="r">Exec Price</th><th>TP / SL</th><th className="r">Time</th><th className="r">Action</th>
      </tr></thead><tbody>
        {orders.map(o => {
          const size = num(o.size) || 0;
          const sell = String(o.side) === 'sell';
          const qty = sell ? -size : size;
          const unfilled = num(o.unfilled_size) ?? size;
          const filled = Math.max(0, size - unfilled);
          const cv = num(o.product?.contract_value) ?? 0.001;
          const unit = o.product?.underlying_asset?.symbol || 'BTC';
          const sizeBtc = parseFloat((size * cv).toFixed(6));
          const notional = idx != null ? Math.abs(size) * cv * idx : null;
          const tp = num(o.bracket_take_profit_price);
          const sl = num(o.bracket_stop_loss_price);
          const isCall = (o.product_symbol || '').startsWith('C-');
          return (
            <tr key={o.id ?? o.client_order_id} className={`pt-row-${isCall ? 'call' : 'put'}`}>
              {/* Vertical rail before the symbol: GREEN for a long (buy) order, RED for a short (sell). */}
              <td><span className={`pt-legrail ${sell ? 'short' : 'long'}`} /><span className="pt-instrument">{o.product_symbol || '—'}</span></td>
              <td className="r"><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 700 }}>{qty > 0 ? '+' : ''}{qty}</span></td>
              <td className="r">{fmtNum(filled, 0)}</td>
              <td className="r">{sizeBtc} {unit}</td>
              <td className="r">{notional != null ? `$${fmtNum(notional)}` : '—'}</td>
              <td>{String(o.order_type || '').replace('_order', '').replace(/^\w/, c => c.toUpperCase())}</td>
              <td className="r">{o.reduce_only ? '✓' : '—'}</td>
              <td className="r">{fmtNum(o.limit_price)}</td>
              <td className="r">{o.average_fill_price ? fmtNum(o.average_fill_price) : '—'}</td>
              <td><span style={{ fontSize: 11 }}><span style={{ color: 'var(--call)' }}>TP {tp != null ? tp : '—'}</span> · <span style={{ color: 'var(--put)' }}>SL {sl != null ? sl : '—'}</span></span></td>
              <td className="r"><span className="pt-dim" style={{ fontSize: 11 }}>{fmtTs(o.created_at)}</span></td>
              <td className="r"><button onClick={() => onCancelOrder && onCancelOrder(o)} className="pt-btn-close" title="Cancel order">✕</button></td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

// ── Stop Orders (live) — reduce-only stops resting on Delta ────────────────
function LiveStopOrdersTab({ stopOrders, spotPrice, onCancelOrder }) {
  if (!stopOrders?.length) {
    return <EmptyPanel icon="stop" title="No Stop Orders"
      desc="Reduce-only stop orders resting on Delta (short-leg SL / long-leg TP) appear here once armed." />;
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const idx = num(spotPrice);
  const typeLabel = (o) => {
    const t = String(o.stop_order_type || '');
    const kind = t.includes('take_profit') ? 'TP' : t.includes('stop_loss') ? 'SL' : 'Stop';
    return o.bracket_order ? `Bracket - ${kind}` : kind;
  };
  const statusLabel = (s) => (String(s) === 'pending' ? 'Untriggered' : String(s || '—'));
  return (
    <div className="pt-table-scroll">
      <table className="pt-table pt-delta-table"><thead><tr>
        <th>Symbol</th><th className="r">Qty (Lot)</th><th className="r">Size</th><th className="r">Notional</th>
        <th className="r">Trigger Price</th><th>Trigger Index</th><th className="r">Triggering Price</th>
        <th>Type</th><th className="r">Limit Price</th><th className="r">Reduce Only</th>
        <th>Status</th><th className="r">Time</th><th className="r">Action</th>
      </tr></thead><tbody>
        {stopOrders.map(o => {
          const size = num(o.size) || 0;
          const sell = String(o.side) === 'sell';
          const qty = sell ? -size : size;
          const cv = num(o.product?.contract_value) ?? 0.001;
          const unit = o.product?.underlying_asset?.symbol || 'BTC';
          const sizeBtc = parseFloat((size * cv).toFixed(6));
          const notional = idx != null ? Math.abs(size) * cv * idx : null;
          const trigMethod = String(o.stop_trigger_method || '') === 'spot_price' ? 'Index Price'
            : String(o.stop_trigger_method || '') === 'mark_price' ? 'Mark Price' : (o.stop_trigger_method || '—');
          // Trigger price value comes straight from Delta. The >=/<= operator is
          // NOT in the order feed — Delta fixes it from the index at placement
          // time, which we can't reproduce — so we show the value without an
          // operator rather than a possibly-wrong arrow.
          const trig = num(o.stop_price);
          const isCall = (o.product_symbol || '').startsWith('C-');
          return (
            <tr key={o.id ?? o.client_order_id} className={`pt-row-${isCall ? 'call' : 'put'}`}>
              <td><span className={`pt-legrail ${sell ? 'short' : 'long'}`} /><span className="pt-instrument">{o.product_symbol || '—'}</span></td>
              <td className="r"><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 700 }}>{qty > 0 ? '+' : ''}{qty}</span></td>
              <td className="r">{sizeBtc} {unit}</td>
              <td className="r">{notional != null ? `$${fmtNum(notional)}` : '—'}</td>
              <td className="r"><span style={{ color: 'var(--text)', fontWeight: 700 }}>{trig != null ? fmtNum(trig) : '—'}</span></td>
              <td>{trigMethod}</td>
              <td className="r">{idx != null ? fmtNum(idx) : '—'}</td>
              <td><span style={{ color: typeLabel(o).includes('TP') ? 'var(--call)' : 'var(--put)', fontWeight: 600, fontSize: 11 }}>{typeLabel(o)}</span></td>
              <td className="r">{o.limit_price ? fmtNum(o.limit_price) : '—'}</td>
              <td className="r">{o.reduce_only ? '✓' : '—'}</td>
              <td><span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{statusLabel(o.state)}</span></td>
              <td className="r"><span className="pt-dim" style={{ fontSize: 11 }}>{fmtTs(o.created_at)}</span></td>
              <td className="r"><button onClick={() => onCancelOrder && onCancelOrder(o)} className="pt-btn-close" title="Cancel order">✕</button></td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

// ── Fills (live) — individual leg executions from Delta ────────────────────
function LiveFillsTab({ fills }) {
  if (!fills?.length) {
    return <EmptyPanel icon="fills" title="No Fills Yet"
      desc="Individual leg executions from Delta Exchange appear here as orders fill." />;
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const cap = (s) => (s ? String(s).replace(/^\w/, c => c.toUpperCase()) : '—');
  const orderTypeLabel = (t) => (t ? String(t).replace('_order', '').replace(/^\w/, c => c.toUpperCase()) : '—');
  return (
    <div className="pt-table-scroll">
      <table className="pt-table pt-delta-table"><thead><tr>
        <th>Symbol</th><th className="r">Fill Qty (Lot)</th><th>Side</th><th className="r">Order Qty (Lot)</th>
        <th className="r">Exec Price</th><th className="r">Notional</th><th className="r">Size</th>
        <th>Fill Type</th><th>Order Type</th><th>Role</th><th className="r">Time</th>
      </tr></thead><tbody>
        {fills.map(f => {
          const size = num(f.size) || 0;
          const sell = String(f.side) === 'sell';
          const cv = num(f.product?.contract_value) ?? 0.001;
          const unit = f.product?.underlying_asset?.symbol || 'BTC';
          const sizeBtc = parseFloat((size * cv).toFixed(6)) * (sell ? -1 : 1);
          const notional = num(f.notional);                                  // FIXED at fill time (no live spot)
          const orderQty = num(f.meta_data?.order_size) ?? size;
          const orderType = f.meta_data?.order_type;
          const isCall = (f.product_symbol || '').startsWith('C-');
          return (
            <tr key={f.id ?? `${f.order_id}-${f.created_at}`} className={`pt-row-${isCall ? 'call' : 'put'}`}>
              <td><span className={`pt-legrail ${sell ? 'short' : 'long'}`} /><span className="pt-instrument">{f.product_symbol || '—'}</span></td>
              <td className="r"><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 700 }}>{fmtNum(size, 0)}</span></td>
              <td><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 600 }}>{cap(f.side)}</span></td>
              <td className="r">{fmtNum(orderQty, 0)}</td>
              <td className="r">{fmtNum(f.price)}</td>
              <td className="r">{notional != null ? `$${notional.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '—'}</td>
              <td className="r"><span style={{ color: sell ? 'var(--put)' : 'var(--call)' }}>{sizeBtc > 0 ? '+' : ''}{sizeBtc} {unit}</span></td>
              <td>{cap(f.fill_type) === '—' ? 'Normal' : cap(f.fill_type)}</td>
              <td>{orderTypeLabel(orderType)}</td>
              <td>{cap(f.role)}</td>
              <td className="r"><span className="pt-dim" style={{ fontSize: 11 }}>{fmtTs(f.created_at)}</span></td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

// ── Order History (live) — Delta's real order-history feed ─────────────────
// Mirrors Delta's Order History tab: every past order (filled + cancelled) with
// side/status/qty/type/prices, cashflow, realized pnl, commission, reduce-only.
// Read-only snapshot from `live_exchange_state.order_history`.
function LiveOrderHistoryTab({ orderHistory }) {
  const [filterDate, setFilterDate] = useState(''); // '' = all dates; else YYYY-MM-DD (local)
  if (!orderHistory?.length) {
    return <EmptyPanel icon="history" title="No Order History"
      desc="Filled and cancelled orders on Delta Exchange appear here, newest first." />;
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const cap = (s) => (s ? String(s).replace(/^\w/, c => c.toUpperCase()) : '—');

  // Local (IST for this user) YYYY-MM-DD of an order's fill/close time — matches the
  // Time column and the date the user picks in the filter.
  const localYmd = (v) => {
    try {
      const d = new Date(v);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch { return ''; }
  };

  // Delta's Order History Time column is the order's updated_at (fill/close time),
  // and Delta sorts by it descending — not by created_at or order id. Sort the same
  // way (updated_at desc, id desc tiebreak) so our sequence + times match Delta.
  const ts = (o) => new Date(o.updated_at ?? o.created_at ?? 0).getTime();
  const rows = orderHistory
    .filter(o => !filterDate || localYmd(o.updated_at ?? o.created_at) === filterDate)
    .sort((a, b) => (ts(b) - ts(a)) || (Number(b.id || 0) - Number(a.id || 0)));

  const statusLabel = (o) => {
    const s = String(o.state || '').toLowerCase();
    if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
    const filled = (num(o.size) || 0) - (num(o.unfilled_size) ?? 0);
    if (s === 'closed') return filled > 0 ? 'Filled' : 'Cancelled';
    return cap(s);
  };
  const statusColor = (label) => label === 'Filled' ? 'var(--call)' : label === 'Cancelled' ? 'var(--put)' : 'var(--text-dim)';
  const typeLabel = (o) => {
    const st = String(o.stop_order_type || '');
    if (o.bracket_order || st) {
      const kind = st.includes('take_profit') ? 'TP' : st.includes('stop_loss') ? 'SL' : null;
      if (kind) return `Bracket - ${kind}`;
    }
    return String(o.order_type || '').replace('_order', '').replace(/^\w/, c => c.toUpperCase()) || '—';
  };

  // Exit reason — mirrors the paper Order History's reason, derived from what Delta
  // echoes back per order: the bracket stop type (exchange-side TP/SL exits) and the
  // engine's own `client_order_id` tag, which encodes why each closing order was sent.
  // Opening legs (entry) and unmatched orders show "—" since they have no exit reason.
  const exitReasonOf = (o) => {
    const st = String(o.stop_order_type || '');
    if (st.includes('take_profit')) return 'Take Profit';
    if (st.includes('stop_loss')) return 'Stop Loss';
    const coid = String(o.client_order_id || '');
    if (/-CAX[BS]\b/.test(coid)) return 'Close All';
    if (/-X[BS]-EXP\b/.test(coid)) return 'Expiry';
    if (/-X[BS]-ITM\b/.test(coid)) return 'Exit @ ITM';
    if (/-X[BS]-OTM\b/.test(coid)) return 'Exit @ OTM';
    if (/-X[BS]-ATM\b/.test(coid)) return 'Exit @ ATM';
    if (/-X[BS]\b/.test(coid)) return 'Strategy Exit';        // legacy tag (no reason code)
    if (/-SEX(\b|-)/.test(coid)) return 'Short Leg Exit';
    if (/-PEX(\b|-)/.test(coid)) return 'Partial Exit';
    if (/-LEX?(\b|-)/.test(coid)) return 'Long Leg Exit';
    if (/-MX[BS]\b/.test(coid)) return 'Manual Exit';
    if (/-MLC(\b|-)/.test(coid)) return 'Manual Leg Close';
    if (/-CX\b/.test(coid)) return 'Manual Close';
    if (/-TP(\b|-)/.test(coid)) return 'Take Profit';
    return '—'; // entry legs (-EB/-ES) and anything unmatched
  };
  const reasonColor = (r) =>
    r === 'Take Profit' ? 'var(--call)'
      : r === 'Stop Loss' ? 'var(--put)'
        : r === '—' ? 'var(--text-dim)' : 'var(--text)';

  const arrowBtn = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', cursor: 'pointer' };
  const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const shiftDate = (delta) => {
    const base = filterDate ? new Date(`${filterDate}T00:00:00`) : new Date();
    base.setDate(base.getDate() + delta);
    setFilterDate(`${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`);
  };

  const exportLiveHistoryCSV = () => {
    if (!rows.length) return;
    const headers = [
      'Time', 'Order ID', 'Symbol', 'Side', 'Status',
      'Qty (Lot)', 'Filled Qty', 'Type', 'Limit Price',
      'Trigger Price', 'Exec Price', 'Size', 'Realized PnL',
      'Exit Reason', 'Reduce Only'
    ];
    const csvRows = rows.map((o, idxVal) => {
      const size = num(o.size) || 0;
      const sell = String(o.side) === 'sell';
      const qty = Math.abs(size);
      const filled = Math.max(0, size - (num(o.unfilled_size) ?? 0));
      const cv = num(o.product?.contract_value) ?? 0.001;
      const unit = o.product?.underlying_asset?.symbol || 'BTC';
      const sizeBtc = parseFloat((size * cv).toFixed(6)) * (sell ? -1 : 1);
      const rpnl = num(o.meta_data?.pnl ?? o.realized_pnl ?? o.realised_pnl);
      const status = statusLabel(o);
      const sideLabel = `${o.reduce_only ? 'Close' : 'Open'} ${cap(o.side)}`;
      const isLimitType = String(o.order_type || '').includes('limit');
      const trigger = num(o.stop_price) ?? num(o.bracket_stop_loss_price) ?? num(o.bracket_take_profit_price);
      const r = exitReasonOf(o);

      return [
        fmtTs(o.updated_at ?? o.created_at),
        o.id ?? '',
        o.product_symbol || '—',
        sideLabel,
        status,
        qty,
        filled,
        typeLabel(o),
        isLimitType && o.limit_price ? o.limit_price : '',
        trigger != null ? trigger : '',
        o.average_fill_price ? o.average_fill_price : '',
        `${sizeBtc > 0 ? '+' : ''}${sizeBtc} ${unit}`,
        rpnl != null ? rpnl : '',
        r !== '—' ? r : '',
        o.reduce_only ? 'TRUE' : 'FALSE'
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    });

    const csvContent = [headers.map(h => `"${h}"`).join(','), ...csvRows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live_order_history_${filterDate || 'all_time'}_${Date.now()}.csv`;
    a.click();
  };

  return (
    <>
      {/* Date filter & Export CSV header wrapper */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px 0', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Delta Live Feed ({rows.length} order{rows.length !== 1 ? 's' : ''})
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" onClick={() => shiftDate(-1)} title="Previous day" style={arrowBtn}>
            <ChevronLeft size={11} strokeWidth={3} />
          </button>
          {filterDate ? (
            <input
              type="date"
              className="pt-date-input"
              value={filterDate}
              onChange={e => setFilterDate(e.target.value)}
              style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 5, padding: '3px 6px', fontSize: 11, fontWeight: 600, colorScheme: 'dark', outline: 'none', width: 118, boxSizing: 'border-box' }}
            />
          ) : (
            <button type="button" onClick={() => setFilterDate(todayYmd())} title="Filter by date"
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text)', cursor: 'pointer', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em' }}>
              <Calendar size={12} strokeWidth={2.2} stroke="#fff" />
              ALL DATES
            </button>
          )}
          <button type="button" onClick={() => shiftDate(1)} title="Next day" style={arrowBtn}>
            <ChevronRight size={11} strokeWidth={3} />
          </button>
          {filterDate && (
            <button type="button" onClick={() => setFilterDate('')} title="Show all dates"
              style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-dim)', cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}>
              All
            </button>
          )}

          {rows.length > 0 && (
            <button
              type="button"
              className="pt-export-btn"
              onClick={exportLiveHistoryCSV}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '4px 10px', borderRadius: '5px',
                background: 'var(--bg3)', border: '1px solid var(--border)',
                color: 'var(--text)', fontSize: '10px', fontWeight: 700,
                cursor: 'pointer', height: 22, margin: 0,
                letterSpacing: '0.04em'
              }}
            >
              <Download size={12} strokeWidth={2.5} />
              EXPORT CSV
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyPanel icon="history" title="No orders on this date"
          desc="No filled or cancelled orders match the selected date. Clear the filter to see all." />
      ) : (
      <div className="pt-table-scroll">
      <table className="pt-table pt-delta-table"><thead><tr>
        <th>Symbol</th><th>Side</th><th>Status</th><th className="r">Qty (Lot)</th>
        <th className="r">Filled</th><th>Type</th><th className="r">Limit Price</th>
        <th className="r">Trigger Price</th><th className="r">Exec Price</th><th className="r">Size</th>
        <th className="r">Realized PnL</th><th>Exit Reason</th>
        <th className="r">Reduce Only</th><th className="r">Order ID</th><th className="r">Time</th>
      </tr></thead><tbody>
        {rows.map((o, i) => {
          const size = num(o.size) || 0;
          const sell = String(o.side) === 'sell';
          const qty = sell ? -size : size;
          const filled = Math.max(0, size - (num(o.unfilled_size) ?? 0));
          const cv = num(o.product?.contract_value) ?? 0.001;
          const unit = o.product?.underlying_asset?.symbol || 'BTC';
          const sizeBtc = parseFloat((size * cv).toFixed(6)) * (sell ? -1 : 1);
          // Realized PnL (USD) lives in meta_data.pnl on Delta's order-history
          // record (only present once a leg realizes, e.g. a reduce-only close).
          const rpnl = num(o.meta_data?.pnl ?? o.realized_pnl ?? o.realised_pnl);
          const status = statusLabel(o);
          const isCall = (o.product_symbol || '').startsWith('C-');
          const optColor = isCall ? 'var(--call)' : 'var(--put)'; // red for puts, green for calls
          const sideLabel = `${o.reduce_only ? 'Close' : 'Open'} ${cap(o.side)}`;
          // Delta only shows a limit price for limit-type orders; market orders carry
          // an internal protective limit that Delta hides (shows "—").
          const isLimitType = String(o.order_type || '').includes('limit');
          const trigger = num(o.stop_price) ?? num(o.bracket_stop_loss_price) ?? num(o.bracket_take_profit_price);
          return (
            <tr key={o.id ?? `${o.client_order_id}-${i}`} className={`pt-row-${isCall ? 'call' : 'put'}`}>
              <td><span className={`pt-legrail ${sell ? 'short' : 'long'}`} /><span className="pt-instrument">{o.product_symbol || '—'}</span></td>
              <td><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 600 }}>{sideLabel}</span></td>
              <td><span style={{ color: statusColor(status), fontWeight: 600 }}>{status}</span></td>
              <td className="r"><span style={{ color: optColor, fontWeight: 700 }}>{Math.abs(size)}</span></td>
              <td className="r">{fmtNum(filled, 0)}</td>
              <td>{typeLabel(o)}</td>
              <td className="r">{isLimitType && o.limit_price ? fmtNum(o.limit_price) : '—'}</td>
              <td className="r">{trigger != null ? fmtNum(trigger) : '—'}</td>
              <td className="r">{o.average_fill_price ? fmtNum(o.average_fill_price) : '—'}</td>
              <td className="r"><span style={{ color: sell ? 'var(--put)' : 'var(--call)' }}>{sizeBtc > 0 ? '+' : ''}{sizeBtc} {unit}</span></td>
              <td className="r">{rpnl != null ? <span className={`pt-pnl ${rpnl > 0 ? 'positive' : rpnl < 0 ? 'negative' : 'zero'}`}>{rpnl > 0 ? '+' : ''}{fmtNum(rpnl)}</span> : '—'}</td>
              <td>{(() => { const r = exitReasonOf(o); return <span style={{ color: reasonColor(r), fontWeight: r === '—' ? 400 : 600, fontSize: 11 }}>{r}</span>; })()}</td>
              <td className="r">{o.reduce_only ? '✓' : '✕'}</td>
              <td className="r"><span className="pt-dim" style={{ fontSize: 11 }}>{o.id ?? '—'}</span></td>
              <td className="r"><span className="pt-dim" style={{ fontSize: 11 }}>{fmtTs(o.updated_at ?? o.created_at)}</span></td>
            </tr>
          );
        })}
      </tbody></table>
      </div>
      )}
    </>
  );
}

// Live unrealized P&L + mark for one Delta position leg. The engine's snapshot suppresses
// mark/unrealized updates to keep egress flat (~60s stale), so prefer the live WS mark
// (~1s fresh) and recompute exactly as Delta does: size × contract_value × (mark − entry) —
// signed size makes shorts profit on decay. Falls back to the snapshot's own unrealized_pnl /
// mark_price when no live mark is available (symbol not on the WS feed / cross-expiry / orphan).
function livePnlOf(p, liveMarks) {
  const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const size = n(p.size) || 0;
  const cv = n(p.product?.contract_value) ?? 0.001;
  const entry = n(p.entry_price);
  const liveMark = n(liveMarks?.[p.product_symbol]?.markPrice);
  if (liveMark != null && entry != null) {
    return { pnl: size * cv * (liveMark - entry), mark: liveMark };
  }
  return { pnl: n(p.unrealized_pnl ?? p.unrealised_pnl) ?? 0, mark: n(p.mark_price) };
}

// ── Risk & Margin (live) — real margin/liquidation from Delta ──────────────
function LiveRiskMargin({ positions, wallet, liveMarks }) {
  const open = (positions || []).filter(p => Number(p.size) !== 0);
  const totalMargin = open.reduce((s, p) => s + (Number(p.margin) || 0), 0);
  const totalUnrl = open.reduce((s, p) => s + livePnlOf(p, liveMarks).pnl, 0);
  const usedPct = wallet ? Math.min(100, (totalMargin / wallet) * 100) : 0;

  const cards = [
    { label: 'Wallet Balance', big: wallet != null ? `$${fmtNum(wallet)}` : '—', sub: 'USDT on Delta', pct: 100, color: 'var(--accent)' },
    { label: 'Margin Used', big: `$${fmtNum(totalMargin)}`, sub: wallet ? `${usedPct.toFixed(1)}% of wallet` : `${open.length} position${open.length !== 1 ? 's' : ''}`, pct: usedPct || 100, color: 'var(--accent)' },
    { label: 'Unrealized P&L', big: `${totalUnrl >= 0 ? '+' : ''}${fmtNum(totalUnrl)}`, sub: 'Mark-to-market', pct: Math.min(100, Math.abs(totalUnrl) / (totalMargin || 1) * 100), color: totalUnrl >= 0 ? 'var(--call)' : 'var(--put)', valClass: totalUnrl >= 0 ? 'positive' : 'negative' },
    { label: 'Open Legs', big: `${open.length}`, sub: 'Positions on exchange', pct: 100, color: 'var(--call)' },
  ];

  return (
    <>
      <div className="pt-risk-grid">
        {cards.map((c, i) => (
          <div key={i} className="pt-risk-card">
            <h4>{c.label}</h4>
            <span className={`pt-risk-big ${c.valClass || ''}`}>{c.big}</span>
            <div className="pt-meter"><i style={{ width: `${c.pct}%`, background: c.color }} /></div>
            <span className="pt-risk-sub">{c.sub}</span>
          </div>
        ))}
      </div>

      {open.length === 0 ? (
        <EmptyPanel icon="risk" title="No Open Exposure"
          desc="Delta reports no open positions for this account. Margin and liquidation figures appear here once a position is live." />
      ) : (
        <div className="pt-table-scroll" style={{ borderTop: '1px solid var(--border)' }}>
          <table className="pt-table"><thead><tr>
            <th>Instrument</th><th>Size</th><th>Entry</th><th>Mark</th>
            <th>Liq. Price</th><th>Margin</th><th>Unrealized P&L</th>
          </tr></thead><tbody>
            {open.map((p, i) => {
              const pnl = Number(p.unrealized_pnl ?? p.unrealised_pnl) || 0;
              const size = Number(p.size) || 0;
              return (
                <tr key={p.product_id ?? p.product_symbol ?? i}>
                  <td><span className="pt-instrument">{p.product_symbol || '—'}</span></td>
                  <td><Tag text={size > 0 ? 'LONG' : 'SHORT'} color={size > 0 ? 'var(--call)' : 'var(--put)'} /> <span style={{ marginLeft: 6, fontWeight: 600 }}>{fmtNum(Math.abs(size), 0)}</span></td>
                  <td>{fmtNum(p.entry_price)}</td>
                  <td>{fmtNum(p.mark_price)}</td>
                  <td><span style={{ color: 'var(--put)', fontWeight: 600 }}>{fmtNum(p.liquidation_price)}</span></td>
                  <td><span style={{ fontWeight: 600 }}>${fmtNum(p.margin)}</span></td>
                  <td><span className={`pt-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero'}`}>{pnl > 0 ? '+' : ''}{fmtNum(pnl)}</span></td>
                </tr>
              );
            })}
          </tbody></table>
        </div>
      )}
    </>
  );
}

// ── Positions (live) — raw margined positions from Delta ───────────────────
// Delta-style positions table — mirrors the columns/layout of Delta's Positions
// tab (Symbol · Size · Notional · Entry · TP/SL · Index · Mark · Margin · UPNL ·
// Action), rendering the live exchange snapshot per leg. Close (×) maps the leg
// back to its engine position so it exits the whole spread.
function DeltaPositionsTable({ positions, enginePositions, onExitPosition, onCloseOrphan, spotPrice, stopOrders, liveMarks }) {
  const open = (positions || []).filter(p => Number(p.size) !== 0);
  if (open.length === 0) {
    return <EmptyPanel icon="positions" title="No Open Positions"
      desc="Open positions reported by Delta Exchange appear here. The engine enters them automatically when conditions are met." />;
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  // Map each leg back to its engine position (for Close) — by leg symbol.
  const posBySymbol = {};
  for (const ep of (enginePositions || [])) {
    if (ep.buyLeg?.symbol) posBySymbol[ep.buyLeg.symbol] = ep;
    if (ep.sellLeg?.symbol) posBySymbol[ep.sellLeg.symbol] = ep;
  }
  // TP/SL per leg come from the resting stop orders, matched by product_symbol.
  const stopBySymbol = {};
  for (const so of (stopOrders || [])) {
    const sym = so.product_symbol;
    if (!sym) continue;
    const type = String(so.stop_order_type || '');
    const level = num(so.stop_price);
    if (!stopBySymbol[sym]) stopBySymbol[sym] = { tp: null, sl: null };
    if (type.includes('take_profit')) stopBySymbol[sym].tp = level;
    else if (type.includes('stop_loss')) stopBySymbol[sym].sl = level;
  }
  const idx = num(spotPrice);

  return (
    <div className="pt-table-scroll">
      <table className="pt-table pt-delta-table">
        <thead><tr>
          <th>Symbol</th><th className="r">Size</th><th className="r">Notional</th>
          <th className="r">Entry</th><th>TP / SL</th><th className="r">Index</th>
          <th className="r">Mark</th><th className="r">Margin</th><th className="r">UPNL</th><th className="r">Cashflow</th><th className="r">Action</th>
        </tr></thead>
        <tbody>
          {open.map((p, i) => {
            const size = num(p.size) || 0;                          // contracts (lots), signed
            const cv = num(p.product?.contract_value) ?? 0.001;     // BTC per contract
            const unit = p.product?.underlying_asset?.symbol || 'BTC';
            const long = size > 0;
            const isCall = (p.product_symbol || '').startsWith('C-');
            const btc = parseFloat((size * cv).toFixed(6));         // signed size in underlying
            const notional = idx != null ? Math.abs(size) * cv * idx : null;
            // Fresh mark-to-market from the live WS mark (falls back to the snapshot).
            const { pnl, mark } = livePnlOf(p, liveMarks);
            const entryCost = num(p.entry_price) != null ? Math.abs(size) * cv * num(p.entry_price) : null;
            const pnlPct = (entryCost && entryCost !== 0) ? (pnl / entryCost) * 100 : null;
            const margin = num(p.margin);
            // Delta's cashflow for the position (premium in/out). Prefer Delta's own
            // field; fall back to the entry cashflow: short (sold) = cash in (+),
            // long (bought) = cash out (−).
            const cashflow = num(p.realized_cashflow ?? p.cashflow ?? p.meta_data?.cashflow)
              ?? (num(p.entry_price) != null ? -(size * cv * num(p.entry_price)) : null);
            const st = stopBySymbol[p.product_symbol] || { tp: null, sl: null };
            const enginePos = posBySymbol[p.product_symbol];
            return (
              <tr key={p.product_id ?? p.product_symbol ?? i} className={`pt-row-${isCall ? 'call' : 'put'}`}>
                <td className='flex flex-row gap-2 items-center'>
                  {/* Vertical rail before the symbol: GREEN for a long position, RED for a short. */}
                  <span className={`pt-legrail ${long ? 'long' : 'short'}`} />
                  <span className="pt-instrument">{p.product_symbol || '—'}</span>
                </td>
                <td className="r"><span style={{ color: long ? 'var(--call)' : 'var(--put)', fontWeight: 700 }}>{long ? '+' : ''}{btc} {unit}</span></td>
                <td className="r">{notional != null ? `$${fmtNum(notional)}` : '—'}</td>
                <td className="r">{fmtNum(p.entry_price)}</td>
                <td>
                  <span style={{ fontSize: 11 }}>
                    <span style={{ color: 'var(--call)' }}>TP {st.tp != null ? st.tp : '—'}</span>
                    <span style={{ color: 'var(--text-dim)' }}> · </span>
                    <span style={{ color: 'var(--put)' }}>SL {st.sl != null ? st.sl : '—'}</span>
                  </span>
                </td>
                <td className="r">{idx != null ? fmtNum(idx) : '—'}</td>
                <td className="r">{fmtNum(mark)}</td>
                <td className="r">{margin != null && margin > 0 ? `$${fmtNum(margin)}` : '—'}</td>
                <td className="r">
                  <span className={`pt-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero'}`}>{pnl > 0 ? '+' : ''}{fmtNum(pnl)}</span>
                  {pnlPct != null && <span style={{ display: 'block', fontSize: 10, color: pnl >= 0 ? 'var(--call)' : 'var(--put)' }}>{pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>}
                </td>
                <td className="r">{cashflow != null ? <span className={`pt-pnl ${cashflow > 0 ? 'positive' : cashflow < 0 ? 'negative' : 'zero'}`}>{cashflow > 0 ? '+' : ''}{fmtNum(cashflow)}</span> : '—'}</td>
                <td className="r">
                  {/* Per-leg close (like Delta): ✕ closes only THIS leg, not the spread. */}
                  <button onClick={() => onCloseOrphan && onCloseOrphan(p.product_symbol)} className="pt-btn-close" title="Close this leg on Delta">✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LivePositionsTab({ positions, enginePositions, onExitPosition }) {
  const open = (positions || []).filter(p => Number(p.size) !== 0);
  if (open.length === 0) {
    return <EmptyPanel icon="positions" title="No Open Positions"
      desc="Open positions reported by Delta Exchange appear here. The engine enters them automatically when conditions are met." />;
  }
  // Map a Delta leg (product_symbol) back to its owning engine position so the
  // per-row Close exits the whole spread (both legs), not just that leg.
  const posBySymbol = {};
  for (const ep of (enginePositions || [])) {
    if (ep.buyLeg?.symbol) posBySymbol[ep.buyLeg.symbol] = ep;
    if (ep.sellLeg?.symbol) posBySymbol[ep.sellLeg.symbol] = ep;
  }
  return (
    <div className="pt-table-scroll">
      <table className="pt-table"><thead><tr>
        <th>Instrument</th><th>Side</th><th>Size</th><th>Entry</th>
        <th>Mark</th><th>Liq. Price</th><th>Margin</th><th>Unrealized P&L</th>
        {onExitPosition && <th>Action</th>}
      </tr></thead><tbody>
        {open.map((p, i) => {
          const size = Number(p.size) || 0;
          const pnl = Number(p.unrealized_pnl ?? p.unrealised_pnl) || 0;
          const enginePos = posBySymbol[p.product_symbol];
          return (
            <tr key={p.product_id ?? p.product_symbol ?? i}>
              <td><span className="pt-instrument">{p.product_symbol || '—'}</span></td>
              <td><Tag text={size > 0 ? 'LONG' : 'SHORT'} color={size > 0 ? 'var(--call)' : 'var(--put)'} /></td>
              <td style={{ fontWeight: 600 }}>{fmtNum(Math.abs(size), 0)}</td>
              <td>{fmtNum(p.entry_price)}</td>
              <td>{fmtNum(p.mark_price)}</td>
              <td><span style={{ color: 'var(--put)', fontWeight: 600 }}>{fmtNum(p.liquidation_price)}</span></td>
              <td>${fmtNum(p.margin)}</td>
              <td><span className={`pt-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero'}`}>{pnl > 0 ? '+' : ''}{fmtNum(pnl)}</span></td>
              {onExitPosition && (
                <td>
                  {enginePos
                    ? <button onClick={() => onExitPosition(enginePos)} className="pt-btn-close">Close</button>
                    : <span style={{ opacity: 0.4, fontSize: 11 }}>—</span>}
                </td>
              )}
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

// ── Workspace shell ───────────────────────────────────────────────────────
export default function TradingWorkspace(props) {
  const { positions, underlying, filteredTradeHistory, isLiveAccount, liveExchangeState, engineDryRun, liveLoading } = props;

  const [tab, setTab] = useState('positions');

  const [sessionOpen, setSessionOpen] = useState({});
  if (props.spotPrice != null && sessionOpen[underlying] == null) {
    setSessionOpen(prev => (prev[underlying] == null ? { ...prev, [underlying]: props.spotPrice } : prev));
  }
  const openSpot = sessionOpen[underlying];
  const spotChangePct = (openSpot && props.spotPrice) ? ((props.spotPrice - openSpot) / openSpot) * 100 : null;

  const visible = positions.filter(p => p.underlying === underlying);
  const spreadCount = visible.filter(p => (p.sellQty || 0) > 0).length;
  const longCount = visible.filter(p => (p.sellQty || 0) === 0).length;
  const histCount = filteredTradeHistory.length;

  // The exchange-fed tabs (Positions / Open Orders / Stop Orders / Fills / Risk)
  // render Delta truth ONLY when the engine is placing REAL orders — i.e. a live
  // account whose engine is armed and NOT in dry-run (engineDryRun === false),
  // with a fresh snapshot. In dry-run the engine only simulates, so Delta reports
  // nothing real; the engine/paper views are the truth and we fall back to them.
  // Paper accounts and stale/absent snapshots also fall back. Order History also
  // mirrors Delta's real order-history feed when live; otherwise it shows the
  // engine's closed-trade ledger (paper / dry-run).
  const useLive = isLiveAccount && engineDryRun === false && !!liveExchangeState;
  const live = useLive ? liveExchangeState : null;
  const liveOpenLegs = live ? (live.positions || []).filter(p => Number(p.size) !== 0).length : null;

  // While a live account's view is still resolving, don't show paper-derived
  // counts (they'd flash the wrong numbers before the live tables load).
  const showLoading = !!liveLoading && !live;
  const paperCount = (n) => (showLoading ? null : n);
  // Open positions right now — drives whether Close All shows (hidden when flat).
  const openCount = live ? (liveOpenLegs || 0) : visible.length;
  const TABS = [
    { key: 'positions', label: 'Positions', icon: 'positions', count: live ? liveOpenLegs : paperCount(spreadCount) },
    { key: 'open', label: 'Open Orders', icon: 'open', count: live ? (live.orders?.length ?? 0) : paperCount(longCount) },
    { key: 'stop', label: 'Stop Orders', icon: 'stop', count: live ? (live.stop_orders?.length ?? 0) : paperCount(spreadCount) },
    { key: 'fills', label: 'Fills', icon: 'fills', count: live ? (live.fills?.length ?? 0) : null },
    { key: 'history', label: 'Order History', icon: 'history', count: live ? (live.order_history?.length ?? 0) : paperCount(histCount) },
    { key: 'risk', label: 'Risk & Margin', icon: 'risk', count: null },
  ];

  return (
    <div className="pt-tables-container">
      <div className="pt-workspace pt-section">
        <div className="pt-tabbar" role="tablist">
          <div className="pt-tab-group">
            {TABS.map(t => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                className={`pt-tab ${tab === t.key ? 'on' : ''}`}
                onClick={() => setTab(t.key)}
              >
                <Icon name={t.icon} />
                <span>{t.label}</span>
                {t.count != null && <span className="pt-tab-count">{t.count}</span>}
              </button>
            ))}
          </div>
          <div className="pt-tab-actions">
            {props.spotPrice != null && (
              <div className="pt-spot-display" style={{ height: '28px', padding: '0 12px', gap: '6px', border: '1px solid rgba(63, 185, 80, 0.25)', background: 'rgba(63, 185, 80, 0.08)', borderRadius: '8px', fontSize: '11px', display: 'flex', alignItems: 'center', marginRight: '8px' }}>
                <span className="pt-spot-label" style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.5px', color: 'var(--text-dim)' }}>SPOT</span>
                <span className="pt-spot-value" style={{ fontWeight: 700, color: 'var(--text)', fontFamily: 'Inter', fontVariantNumeric: 'tabular-nums' }}>${props.spotPrice.toLocaleString()}</span>
                {spotChangePct != null && (
                  <span className={`pt-spot-chg ${spotChangePct >= 0 ? 'up' : 'down'}`} style={{ fontSize: '10px', fontWeight: 700, color: spotChangePct >= 0 ? 'var(--call)' : 'var(--put)' }}>
                    {spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%
                  </span>
                )}
              </div>
            )}
            {props.onSync && (
              <button type="button" onClick={props.onSync} disabled={props.isSyncing} className="pt-btn-sync"
                title="Refresh positions, orders and history from the engine">
                <RefreshCw size={12} strokeWidth={2.5}
                  style={props.isSyncing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
                <span className="pt-btn-text">{props.isSyncing ? 'Syncing…' : 'Sync'}</span>
              </button>
            )}
            {props.onCloseAll && openCount > 0 && (
              <button type="button" onClick={props.onCloseAll} className="pt-btn-close"
                style={{ background: '#f85149', color: '#fff', borderColor: '#f85149', fontWeight: 700 }}>
                ✕ <span className="pt-btn-text">Close All</span>
              </button>
            )}
          </div>
        </div>

        <div className="pt-workspace-body">
          {showLoading ? <LoadingPanel /> : (
          <>
          {tab === 'positions' && (
            <>
              {live ? (
                <DeltaPositionsTable
                  positions={live.positions}
                  enginePositions={props.positions}
                  onExitPosition={props.onExitPosition}
                  onCloseOrphan={props.onCloseOrphan}
                  spotPrice={props.spotPrice}
                  stopOrders={live.stopOrders || live.stop_orders}
                  liveMarks={props.liveMarks}
                />
              ) : (
              <ActivePositionsTable
                positions={props.positions}
                underlying={props.underlying}
                lastEvaluated={props.lastEvaluated}
                fetchSupabaseActivePositions={props.fetchSupabaseActivePositions}
                fetchSupabaseTradeHistory={props.fetchSupabaseTradeHistory}
                fetchHeartbeat={props.fetchHeartbeat}
                now={props.now}
                includeFees={props.includeFees}
                setIncludeFees={props.setIncludeFees}
                spotPrice={props.spotPrice}
                engineStatusColor={props.engineStatusColor}
                engineStatusLabel={props.engineStatusLabel}
                calculatePositionMargin={props.calculatePositionMargin}
                totalMargin={props.totalMargin}
                exitType={props.exitType}
                exitPoints={props.exitPoints}
                onExitPosition={props.onExitPosition}
                embedded
                legFilter="spread"
                title="Open Positions"
                emptyTitle="No Open Positions"
                emptyDesc="Spread positions (long + short legs) appear here. The engine enters them automatically when conditions are met."
              />
              )}
            </>
          )}

          {tab === 'open' && (
            live ? (
              <LiveOrdersTab orders={live.orders} spotPrice={props.spotPrice} onCancelOrder={props.onCancelOrder} />
            ) : (
              <ActivePositionsTable
                positions={props.positions}
                underlying={props.underlying}
                lastEvaluated={props.lastEvaluated}
                fetchSupabaseActivePositions={props.fetchSupabaseActivePositions}
                fetchSupabaseTradeHistory={props.fetchSupabaseTradeHistory}
                fetchHeartbeat={props.fetchHeartbeat}
                now={props.now}
                includeFees={props.includeFees}
                setIncludeFees={props.setIncludeFees}
                spotPrice={props.spotPrice}
                engineStatusColor={props.engineStatusColor}
                engineStatusLabel={props.engineStatusLabel}
                calculatePositionMargin={props.calculatePositionMargin}
                totalMargin={props.totalMargin}
                exitType={props.exitType}
                exitPoints={props.exitPoints}
                onExitPosition={props.onExitPosition}
                embedded
                legFilter="long"
                title="Open Orders"
                emptyTitle="No Open Orders"
                emptyDesc="Long-only holdings (short leg already exited, scaling out via the ladder) appear here."
              />
            )
          )}

          {tab === 'stop' && (
            live ? (
              <LiveStopOrdersTab stopOrders={live.stop_orders} spotPrice={props.spotPrice} onCancelOrder={props.onCancelOrder} />
            ) : (
              <StopOrdersTab
                positions={props.positions}
                underlying={props.underlying}
                spotPrice={props.spotPrice}
                exitType={props.exitType}
                exitPoints={props.exitPoints}
                onExitPosition={props.onExitPosition}
              />
            )
          )}

          {tab === 'fills' && (
            live ? (
              <LiveFillsTab fills={live.fills} spotPrice={props.spotPrice} />
            ) : (
              <EmptyPanel
                icon="fills"
                title="No Fills Yet"
                desc={isLiveAccount
                  ? 'Individual leg executions from Delta Exchange appear here as orders fill.'
                  : 'Leg-by-leg fills are reported for live accounts. Closed paper trades are summarised under Order History.'}
              />
            )
          )}

          {tab === 'history' && (
            live ? (
              <LiveOrderHistoryTab orderHistory={live.order_history} />
            ) : (
            <TradeHistoryTable
              filteredTradeHistory={props.filteredTradeHistory}
              historyFilterDate={props.historyFilterDate}
              setHistoryFilterDate={props.setHistoryFilterDate}
              adjustFilterDay={props.adjustFilterDay}
              resetToToday={props.resetToToday}
              filteredRealizedPnl={props.filteredRealizedPnl}
              filteredWins={props.filteredWins}
              exportCSV={props.exportCSV}
              includeFees={props.includeFees}
              schedules={props.schedules}
              positions={props.positions}
              underlying={props.underlying}
              tradeHistory={props.tradeHistory || []}
              embedded
            />
            )
          )}

          {tab === 'risk' && (
            live ? (
              <LiveRiskMargin positions={live.positions} wallet={live.wallet} liveMarks={props.liveMarks} />
            ) : (
              <RiskMarginTab
                positions={props.positions}
                underlying={props.underlying}
                spotPrice={props.spotPrice}
                totalMargin={props.totalMargin}
                calculatePositionMargin={props.calculatePositionMargin}
                includeFees={props.includeFees}
              />
            )
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}
