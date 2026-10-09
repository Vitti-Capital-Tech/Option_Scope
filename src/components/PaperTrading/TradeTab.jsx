import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../supabase';
import { createOrderBookStream } from '../../api';
import { showConfirm } from '../common/dialogService';

// ── Trade tab (live accounts) ───────────────────────────────────────────
// Pick an option → watch its live order book → punch a limit / market order. The browser
// never holds Delta keys: the order is queued in delta_order_requests (migration 055) and
// the engine places it within ~1.5s, writing the outcome back to the same row.

const BOOK_LEVELS = 10;
const STALE_PENDING_MS = 60000; // the engine expires requests it picks up later than this

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const decimalsOf = (tick) => {
  const s = String(tick ?? '');
  return s.includes('.') ? Math.min(s.split('.')[1].length, 6) : 0;
};
const fmtPx = (v, dp) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const fmtExpiry = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// ── Order book ──────────────────────────────────────────────────────────
function OrderBook({ book, status, dp, markPrice, onPickPrice }) {
  const asks = (book?.asks || []).slice(0, BOOK_LEVELS);
  const bids = (book?.bids || []).slice(0, BOOK_LEVELS);
  const cum = (levels) => levels.reduce((acc, l) => [...acc, (acc.at(-1) || 0) + l.size], []);
  const askCum = cum(asks);
  const bidCum = cum(bids);
  const maxCum = Math.max(askCum.at(-1) || 0, bidCum.at(-1) || 0, 1);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  const row = (l, total, side) => (
    <button type="button" key={`${side}-${l.price}`} className={`pt-ob-row ${side}`}
      onClick={() => onPickPrice(l.price)} title="Use this price">
      <span className="pt-ob-depth" style={{ width: `${(total / maxCum) * 100}%` }} />
      <span className="pt-ob-px">{fmtPx(l.price, dp)}</span>
      <span className="r">{l.size.toLocaleString('en-US')}</span>
      <span className="r pt-dim">{total.toLocaleString('en-US')}</span>
    </button>
  );

  return (
    <div className="pt-ob">
      <div className="pt-ob-head">
        <span>Order Book</span>
        <span className={`pt-ob-status ${status === 'live' ? 'live' : ''}`}>{status === 'live' ? '● Live' : status === 'error' ? 'Error' : 'Connecting…'}</span>
      </div>
      <div className="pt-ob-cols"><span>Price</span><span className="r">Size</span><span className="r">Total</span></div>
      <div className="pt-ob-side asks">
        {asks.length ? asks.map((l, i) => row(l, askCum[i], 'ask')).reverse() : <div className="pt-ob-empty">No asks</div>}
      </div>
      <div className="pt-ob-mid">
        <span>Mark <b>{fmtPx(markPrice, dp)}</b></span>
        <span className="pt-dim">Spread {spread != null ? fmtPx(spread, dp) : '—'}</span>
      </div>
      <div className="pt-ob-side bids">
        {bids.length ? bids.map((l, i) => row(l, bidCum[i], 'bid')) : <div className="pt-ob-empty">No bids</div>}
      </div>
    </div>
  );
}

// ── Recent manual orders ────────────────────────────────────────────────
const STATUS_LABEL = {
  pending: 'Sending…', processing: 'Sending…', placed: 'Placed', dry_run: 'Dry-run', failed: 'Rejected', expired: 'Expired',
};

function ManualOrdersTable({ rows, now }) {
  if (!rows.length) return <div className="pt-trade-note">Orders you punch here appear below with their status.</div>;
  return (
    <div className="pt-table-scroll">
      <table className="pt-table"><thead><tr>
        <th>Time</th><th>Symbol</th><th>Side</th><th>Type</th><th className="r">Size</th><th className="r">Price</th><th>Status</th><th>Detail</th>
      </tr></thead><tbody>
        {rows.map(r => {
          const waiting = (r.status === 'pending' || r.status === 'processing');
          const stuck = waiting && now - new Date(r.created_at).getTime() > STALE_PENDING_MS;
          const sell = r.side === 'sell';
          return (
            <tr key={r.id}>
              <td><span className="pt-dim">{fmtTime(r.created_at)}</span></td>
              <td><span className="pt-instrument">{r.product_symbol}</span></td>
              <td><span style={{ color: sell ? 'var(--put)' : 'var(--call)', fontWeight: 700 }}>{sell ? 'Sell' : 'Buy'}</span></td>
              <td>{r.order_type === 'market' ? 'Market' : 'Limit'}{r.reduce_only ? ' · RO' : ''}</td>
              <td className="r">{r.size}</td>
              <td className="r">{r.order_type === 'market' ? '—' : r.limit_price}</td>
              <td><span className={`pt-trade-status ${stuck ? 'failed' : r.status}`}>{stuck ? 'No response' : STATUS_LABEL[r.status] || r.status}</span></td>
              <td><span className="pt-dim" style={{ fontSize: 11 }}>
                {stuck ? 'The engine has not picked this up — is it running?'
                  : r.error || (r.exchange_order_id ? `Order #${r.exchange_order_id}${r.order_state ? ` · ${r.order_state}` : ''}` : '')}
              </span></td>
            </tr>
          );
        })}
      </tbody></table>
    </div>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────
export default function TradeTab({ accountId, accountArmed, engineDryRun, products, underlying, spotPrice, liveMarks, livePositions, group }) {
  const options = useMemo(
    () => (products || []).filter(p => p.contract_type === 'call_options' || p.contract_type === 'put_options'),
    [products],
  );
  const expiries = useMemo(() => [...new Set(options.map(p => p.settlement_time))].sort(), [options]);

  const [pickedExpiry, setExpiry] = useState(null);
  const [optType, setOptType] = useState('call');
  const [pickedStrike, setStrike] = useState(null);

  // Defaults are derived, not stored: the nearest expiry, and the strike nearest spot until
  // the user picks one (a picked value is kept while it still exists).
  const expiry = expiries.includes(pickedExpiry) ? pickedExpiry : (expiries[0] ?? null);
  const strikes = useMemo(() => [...new Set(options
    .filter(p => p.settlement_time === expiry && p.contract_type === `${optType}_options`)
    .map(p => Number(p.strike_price)))].sort((a, b) => a - b), [options, expiry, optType]);

  const atmRef = spotPrice || strikes[Math.floor(strikes.length / 2)];
  const strike = strikes.includes(pickedStrike) ? pickedStrike
    : (strikes.length ? strikes.reduce((best, s) => (Math.abs(s - atmRef) < Math.abs(best - atmRef) ? s : best), strikes[0]) : null);

  const product = options.find(p => p.settlement_time === expiry && p.contract_type === `${optType}_options` && Number(p.strike_price) === strike) || null;
  const symbol = product?.symbol || null;
  const tick = num(product?.tick_size) || 0.1;
  const dp = decimalsOf(product?.tick_size ?? tick);
  const contractValue = num(product?.contract_value) || 0.001;

  // Live book for the chosen symbol. State is tagged with its symbol, so a switch shows an
  // empty "Connecting…" book until the new symbol's data arrives.
  const [bookState, setBookState] = useState({ symbol: null, book: null, status: 'connecting' });
  useEffect(() => {
    if (!symbol) return undefined;
    const forSym = (s) => (s.symbol === symbol ? s : { symbol, book: null, status: 'connecting' });
    const stream = createOrderBookStream(symbol,
      (b) => setBookState(s => ({ ...forSym(s), book: b })),
      (st) => setBookState(s => ({ ...forSym(s), status: st })));
    return () => stream.close();
  }, [symbol]);
  const book = bookState.symbol === symbol ? bookState.book : null;
  const bookStatus = bookState.symbol === symbol ? bookState.status : 'connecting';

  // Ticket.
  const [side, setSide] = useState('buy');
  const [orderType, setOrderType] = useState('limit');
  // Price and form error belong to one symbol; switching symbols clears them.
  const [priceState, setPriceState] = useState({ symbol: null, value: '' });
  const price = priceState.symbol === symbol ? priceState.value : '';
  const setPrice = (value) => setPriceState({ symbol, value });
  const [size, setSize] = useState('1');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Grouped account: the same order can be punched on every live account of the group
  // (group owner / admin only — `group.canFanOut`). On by default.
  const [wholeGroup, setWholeGroup] = useState(true);
  const groupOthers = group?.canFanOut ? (group.memberCount || 1) - 1 : 0;
  const toGroup = wholeGroup && groupOthers > 0;
  const [notice, setNotice] = useState('');
  const [errorState, setErrorState] = useState({ symbol: null, msg: '' });
  const formError = errorState.symbol === symbol ? errorState.msg : '';
  const setFormError = (msg) => setErrorState({ symbol, msg });

  const bestBid = book?.bids?.[0]?.price ?? null;
  const bestAsk = book?.asks?.[0]?.price ?? null;
  const markPrice = num(liveMarks?.[symbol]?.markPrice);
  const pickPrice = (px) => { setOrderType('limit'); setPrice(String(Number(px.toFixed(dp)))); };

  const sizeN = Math.floor(Number(size));
  const priceN = Number(price);
  const refPx = orderType === 'limit' ? (priceN > 0 ? priceN : null) : (side === 'buy' ? bestAsk : bestBid);
  const premium = refPx != null && sizeN >= 1 ? refPx * sizeN * contractValue : null;

  const openPos = (livePositions || []).find(p => p.product_symbol === symbol && Number(p.size) !== 0);
  const myOptionPositions = (livePositions || []).filter(p => Number(p.size) !== 0 && options.some(o => o.symbol === p.product_symbol));
  const pickSymbol = (sym) => {
    const p = options.find(o => o.symbol === sym);
    if (!p) return;
    setExpiry(p.settlement_time);
    setOptType(p.contract_type === 'put_options' ? 'put' : 'call');
    setStrike(Number(p.strike_price));
  };

  // Recent manual orders for this account (realtime-updated by the engine).
  const [requests, setRequests] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!accountId) return undefined;
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase.from('delta_order_requests').select('*')
        .eq('account_id', accountId).order('created_at', { ascending: false }).limit(20);
      if (!cancelled && !error) setRequests(data || []);
    };
    load();
    const channel = supabase.channel(`delta_order_requests_${accountId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'delta_order_requests', filter: `account_id=eq.${accountId}` }, load)
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { cancelled = true; supabase.removeChannel(channel); clearInterval(tick); };
  }, [accountId]);

  const blocked = !accountArmed
    ? 'This account is not armed for live trading — arm it from the control panel to place orders.'
    : null;

  const submit = async () => {
    setFormError('');
    if (!symbol) return setFormError('Pick an option first.');
    if (!(sizeN >= 1) || sizeN !== Number(size)) return setFormError('Size must be a whole number of contracts (at least 1).');
    if (orderType === 'limit' && !(priceN > 0)) return setFormError('Enter a limit price.');
    const what = `${side.toUpperCase()} ${sizeN} × ${symbol} ${orderType === 'market' ? 'at MARKET' : `@ ${price}`}${reduceOnly ? ' (reduce-only)' : ''}`;
    const where = toGroup ? `\n\nOn ALL ${groupOthers + 1} accounts of group "${group.name}" (same size and price on each).` : '';
    const warn = engineDryRun ? '\n\nThe engine is in DRY-RUN mode: the order will be logged, not sent to Delta.' : '';
    if (!(await showConfirm(`${what}${where}${warn}`, {
      title: 'Place live order?',
      tone: side === 'sell' ? 'danger' : 'primary',
      confirmLabel: side === 'sell' ? 'Place sell order' : 'Place buy order',
    }))) return;
    setSubmitting(true);
    setNotice('');
    const { data: count, error } = await supabase.rpc('place_manual_order', {
      p_account: accountId,
      p_symbol: symbol,
      p_side: side,
      p_order_type: orderType,
      p_size: sizeN,
      p_limit_price: orderType === 'limit' ? priceN : null,
      p_reduce_only: reduceOnly,
      p_whole_group: toGroup,
    });
    setSubmitting(false);
    if (error) setFormError(`Could not send the order: ${error.message}`);
    else if (count > 1) setNotice(`Sent to ${count} accounts of group "${group.name}". Each account's status shows in its own Trade tab.`);
  };

  if (!options.length) {
    return <div className="pt-trade-note" style={{ padding: 24 }}>Loading {underlying} options…</div>;
  }

  return (
    <div className="pt-trade">
      {engineDryRun && <div className="pt-trade-banner">Engine is in dry-run mode — orders are logged by the engine, not sent to Delta.</div>}

      <div className="pt-trade-grid">
        <div className="pt-trade-panel">
          <div className="pt-trade-fields">
            <label>Expiry
              <select value={expiry ?? ''} onChange={e => setExpiry(e.target.value)}>
                {expiries.map(x => <option key={x} value={x}>{fmtExpiry(x)}</option>)}
              </select>
            </label>
            <label>Type
              <div className="pt-trade-seg">
                <button type="button" className={optType === 'call' ? 'on call' : ''} onClick={() => setOptType('call')}>Call</button>
                <button type="button" className={optType === 'put' ? 'on put' : ''} onClick={() => setOptType('put')}>Put</button>
              </div>
            </label>
            <label>Strike
              <select value={strike ?? ''} onChange={e => setStrike(Number(e.target.value))}>
                {strikes.map(s => <option key={s} value={s}>{s.toLocaleString('en-US')}</option>)}
              </select>
            </label>
          </div>

          <div className="pt-trade-symbol">
            <span className="pt-instrument">{symbol || '—'}</span>
            {openPos && (
              <span className="pt-dim">Position: <b style={{ color: Number(openPos.size) < 0 ? 'var(--put)' : 'var(--call)' }}>{Number(openPos.size) > 0 ? '+' : ''}{openPos.size}</b></span>
            )}
          </div>
          {myOptionPositions.length > 0 && (
            <div className="pt-trade-chips">
              {myOptionPositions.map(p => (
                <button type="button" key={p.product_symbol} className={p.product_symbol === symbol ? 'on' : ''}
                  onClick={() => pickSymbol(p.product_symbol)} title="Open position — select this option">
                  {p.product_symbol} <span className="pt-dim">{Number(p.size) > 0 ? '+' : ''}{p.size}</span>
                </button>
              ))}
            </div>
          )}

          <div className="pt-trade-seg pt-trade-side">
            <button type="button" className={side === 'buy' ? 'on call' : ''} onClick={() => setSide('buy')}>Buy</button>
            <button type="button" className={side === 'sell' ? 'on put' : ''} onClick={() => setSide('sell')}>Sell</button>
          </div>
          <div className="pt-trade-seg">
            <button type="button" className={orderType === 'limit' ? 'on' : ''} onClick={() => setOrderType('limit')}>Limit</button>
            <button type="button" className={orderType === 'market' ? 'on' : ''} onClick={() => setOrderType('market')}>Market</button>
          </div>

          <div className="pt-trade-fields">
            {orderType === 'limit' && (
              <label>Limit price
                <input type="number" min="0" step={tick} value={price} placeholder={fmtPx(side === 'buy' ? bestBid : bestAsk, dp)}
                  onChange={e => setPrice(e.target.value)} />
                <span className="pt-trade-quick">
                  <button type="button" disabled={bestBid == null} onClick={() => pickPrice(bestBid)}>Bid</button>
                  <button type="button" disabled={markPrice == null} onClick={() => pickPrice(markPrice)}>Mark</button>
                  <button type="button" disabled={bestAsk == null} onClick={() => pickPrice(bestAsk)}>Ask</button>
                </span>
              </label>
            )}
            <label>Size (contracts)
              <input type="number" min="1" step="1" value={size} onChange={e => setSize(e.target.value)} />
              <span className="pt-dim" style={{ fontSize: 11 }}>
                = {sizeN >= 1 ? +(sizeN * contractValue).toFixed(6) : 0} {underlying}
                {premium != null && <> · Premium ≈ ${premium.toLocaleString('en-US', { maximumFractionDigits: 2 })}</>}
              </span>
            </label>
          </div>

          <label className="pt-trade-check">
            <input type="checkbox" checked={reduceOnly} onChange={e => setReduceOnly(e.target.checked)} />
            Reduce-only <span className="pt-dim">(only reduces an open position)</span>
          </label>

          {groupOthers > 0 && (
            <label className="pt-trade-check">
              <input type="checkbox" checked={wholeGroup} onChange={e => setWholeGroup(e.target.checked)} />
              Whole group <span className="pt-dim">(same order on all {groupOthers + 1} accounts of “{group.name}”)</span>
            </label>
          )}

          {blocked && <div className="pt-trade-error">{blocked}</div>}
          {formError && <div className="pt-trade-error">{formError}</div>}
          {notice && <div className="pt-trade-note">{notice}</div>}
          <button type="button" className={`pt-trade-submit ${side}`} disabled={!!blocked || submitting || !symbol} onClick={submit}>
            {submitting ? 'Sending…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${sizeN >= 1 ? sizeN : ''} ${orderType === 'market' ? '@ Market' : price ? `@ ${price}` : ''}${toGroup ? ` · ${groupOthers + 1} accounts` : ''}`}
          </button>
        </div>

        <OrderBook book={book} status={bookStatus} dp={dp} markPrice={markPrice} onPickPrice={pickPrice} />
      </div>

      <div className="pt-trade-recent">
        <div className="pt-ob-head"><span>Manual orders</span></div>
        <ManualOrdersTable rows={requests} now={now} />
      </div>
    </div>
  );
}
