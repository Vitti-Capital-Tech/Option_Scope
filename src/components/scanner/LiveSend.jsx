import React, { useEffect, useRef, useState } from 'react';
import { Zap, Loader2, X, Check, AlertTriangle } from 'lucide-react';

// Ratio Spread Scanner → PAPER accounts, one click (migration 077). Paper first; live is
// promoted later (the RPC, the engine and the account list below each gate it).
//
// The user picks accounts once (remembered in this browser) and switches "1-click" on
// (NOT remembered — every page load starts off, so a stray click after a refresh can't trade).
// While on, each scanner row shows a Send button: one click calls request_scanner_entry for all
// picked accounts; each account's engine enters that spread through its normal entry path (own
// sizing, entry offsets, fill / abort, brackets, exits) and writes the outcome back, which the
// results box below polls.

// Toolbar control: the ⚡ button + its panel (accounts + on/off).
export function LiveSendControl({ ls }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { loadAccounts } = ls;

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const n = ls.pickedAccounts.length;
  return (
    <div className="ls-wrap" ref={ref}>
      <button type="button" className={`scanner-saved-add ls-btn ${ls.on ? 'ls-on' : ''}`} onClick={() => setOpen(o => !o)}
        title="Send a scanner row to paper accounts in one click">
        <Zap size={12} strokeWidth={2.5} /> 1-click Paper{ls.on ? ` · ON · ${n}` : ''}
      </button>
      {open && (
        <div className="ls-panel" role="dialog" aria-label="1-click paper orders">
          <div className="ls-head">
            <span>1-click paper orders</span>
            <label className={`ls-switch ${ls.on ? 'on' : ''}`} title={n ? '' : 'Pick at least one account first'}>
              <input type="checkbox" checked={ls.on} disabled={!n && !ls.on} onChange={e => ls.setOn(e.target.checked)} />
              <span>{ls.on ? 'ON' : 'OFF'}</span>
            </label>
          </div>
          <p className="ls-note">
            With ON, each row gets a <b>Send</b> button: one click enters that spread on every account below
            — no confirmation. Each account uses its own sizing and exits (paper accounts only for now;
            live comes later). Window filters are skipped; max positions, margin, held strikes, quotes and depth
            are still checked. Turns OFF on every page load.
          </p>
          {ls.loadError && <p className="ls-error">{ls.loadError}</p>}
          {ls.accounts == null && <p className="ls-note"><Loader2 size={12} className="spin" /> Loading accounts…</p>}
          {ls.accounts && ls.accounts.length > 0 && (
            <>
              <div className="ls-acc-actions">
                <button type="button" onClick={() => ls.setAll(ls.accounts.filter(a => !a.paused).map(a => a.id))}>All</button>
                <button type="button" onClick={() => { ls.setAll([]); ls.setOn(false); }}>None</button>
              </div>
              <div className="ls-acc-list">
                {ls.accounts.map(a => (
                  <label key={a.id} className={`ls-acc ${ls.picked.includes(a.id) ? 'on' : ''}`}>
                    <input type="checkbox" checked={ls.picked.includes(a.id)} onChange={() => ls.togglePick(a.id)} />
                    <span className="ls-acc-name">{a.name}</span>
                    {a.paused && <span className="ls-tag">paused</span>}
                  </label>
                ))}
              </div>
            </>
          )}
          {ls.accounts && ls.accounts.length === 0 && !ls.loadError && <p className="ls-note">No paper accounts.</p>}
        </div>
      )}
    </div>
  );
}

// Per-row Send button (rendered by ResultTable when 1-click is ready).
export function LiveSendButton({ state, onSend }) {
  const busy = state === 'sending';
  return (
    <button type="button" className={`ls-row-btn ${state || ''}`} disabled={busy}
      onClick={(e) => { e.stopPropagation(); if (!busy) onSend(); }}
      title="Enter this spread on the picked paper accounts now (no confirmation)">
      {busy ? <Loader2 size={11} className="spin" /> : state === 'sent' ? <Check size={11} /> : state === 'error' ? <AlertTriangle size={11} /> : <Zap size={11} />}
      {busy ? 'Sending' : state === 'sent' ? 'Sent' : state === 'error' ? 'Error' : 'Send'}
    </button>
  );
}

const STATUS_TXT = { pending: 'waiting', processing: 'placing…', entered: 'entered', skipped: 'not entered', failed: 'failed', expired: 'expired' };

// Results of the last sends (bottom-right).
export function LiveSendResults({ ls }) {
  if (!ls.sends.length) return null;
  const nameOf = Object.fromEntries((ls.accounts || []).map(a => [a.id, a.name]));
  return (
    <div className="ls-results">
      {ls.sends.map(s => (
        <div key={s.id} className="ls-res">
          <div className="ls-res-head">
            <span><Zap size={11} /> {s.label}</span>
            <button type="button" onClick={() => ls.dismiss(s.id)} aria-label="Dismiss"><X size={12} /></button>
          </div>
          {s.error && <div className="ls-res-row failed">{s.error}</div>}
          {s.rows.map(r => (
            <div key={r.account_id} className={`ls-res-row ${r.status}`} title={r.message || ''}>
              <span className="ls-res-acc">{nameOf[r.account_id] || 'Account'}</span>
              <span className="ls-res-st">{STATUS_TXT[r.status] || r.status}</span>
              {r.message && r.status !== 'entered' && <span className="ls-res-msg">{r.message}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
