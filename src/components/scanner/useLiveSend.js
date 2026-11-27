import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../supabase';

// State + actions for the scanner's 1-click orders (PAPER accounts for now) (see LiveSend.jsx for the UI and the
// full description). Kept apart from the components for React fast refresh.

const ACCOUNTS_KEY = 'vitti_scanner_send_accounts';
const POLL_MS = 1500;
const POLL_MAX_MS = 90000;
const DONE = new Set(['entered', 'skipped', 'failed', 'expired']);

const readPicked = () => {
  try {
    const v = JSON.parse(window.localStorage.getItem(ACCOUNTS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
};
const writePicked = (ids) => { try { window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(ids)); } catch { /* not saved */ } };

export const rowSendKey = (type, row) => `${String(type).toLowerCase()}|${row.buyLeg.strike}|${row.sellLeg.strike}`;

export function useLiveSend({ underlying, expiry, config }) {
  const [on, setOn] = useState(false);
  const [accounts, setAccounts] = useState(null); // null = not loaded
  const [loadError, setLoadError] = useState('');
  const [picked, setPicked] = useState(readPicked);
  const [rowState, setRowState] = useState({}); // rowKey → 'sending' | 'sent' | 'error'
  const [sends, setSends] = useState([]); // latest first: { id, label, at, rows: [...], error }
  const timers = useRef(new Set());

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const loadAccounts = useCallback(async () => {
    setLoadError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setAccounts([]); setLoadError('Log in on the Paper Trading page first.'); return; }
      const { data, error } = await supabase.from('paper_trading_accounts')
        .select('id, name, mode, live_enabled, paused, user_id')
        // Paper accounts only for now (migration 077); live is promoted later.
        .or('mode.is.null,mode.neq.live').order('created_at', { ascending: true });
      if (error) throw error;
      setAccounts(data || []);
    } catch (e) {
      setAccounts([]);
      setLoadError(`Couldn't load paper accounts: ${e.message}`);
    }
  }, []);

  // Accounts that are picked AND still exist / visible to this user.
  const pickedAccounts = useMemo(
    () => (accounts || []).filter(a => picked.includes(a.id)),
    [accounts, picked],
  );

  const togglePick = (id) => {
    setPicked(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      writePicked(next);
      return next;
    });
  };
  const setAll = (ids) => { writePicked(ids); setPicked(ids); };

  const poll = useCallback((groupId, startedAt) => {
    const tick = async () => {
      const { data } = await supabase.from('scanner_entry_requests')
        .select('id, account_id, status, message, position_id')
        .eq('group_request_id', groupId);
      if (data) {
        setSends(prev => prev.map(s => (s.id === groupId ? { ...s, rows: data } : s)));
        if (data.length && data.every(r => DONE.has(r.status))) return;
      }
      if (Date.now() - startedAt > POLL_MAX_MS) return;
      const t = setTimeout(() => { timers.current.delete(t); tick(); }, POLL_MS);
      timers.current.add(t);
    };
    tick();
  }, []);

  const send = useCallback(async (type, row) => {
    const key = rowSendKey(type, row);
    const ids = pickedAccounts.map(a => a.id);
    if (!on || !ids.length) return;
    const t = String(type).toLowerCase();
    const hedgeStrike = config?.hedgeEnabled && row.hedge ? Number(row.hedge.strike) : null;
    const label = `${t.toUpperCase()} ${row.buyLeg.strike}/${row.sellLeg.strike}${hedgeStrike != null ? ` + H ${hedgeStrike}` : ''}`;
    setRowState(s => ({ ...s, [key]: 'sending' }));
    const { data: groupId, error } = await supabase.rpc('request_scanner_entry', {
      p_accounts: ids,
      p_underlying: underlying,
      p_expiry: expiry,
      p_type: t,
      p_buy_strike: Number(row.buyLeg.strike),
      p_sell_strike: Number(row.sellLeg.strike),
      p_hedge_strike: hedgeStrike,
      p_hedge_lot_pct: hedgeStrike != null ? Number(config.hedgeLotPct) || 0 : null,
      p_atm_ratio_scaling: !!config?.atmRatioScaling,
      p_atm_ratio_pct_call: Number(config?.atmRatioPctCall) || 0,
      p_atm_ratio_pct_put: Number(config?.atmRatioPctPut) || 0,
    });
    if (error) {
      const missing = /could not find the function|does not exist|PGRST202/i.test(`${error.code || ''} ${error.message || ''}`);
      const msg = missing ? 'Database update 077 has not been run yet.' : error.message;
      setRowState(s => ({ ...s, [key]: 'error' }));
      setSends(prev => [{ id: `err-${Date.now()}`, label, at: Date.now(), rows: [], error: msg }, ...prev].slice(0, 5));
      return;
    }
    setRowState(s => ({ ...s, [key]: 'sent' }));
    const t2 = setTimeout(() => { timers.current.delete(t2); setRowState(s => { const n = { ...s }; delete n[key]; return n; }); }, 4000);
    timers.current.add(t2);
    setSends(prev => [{ id: groupId, label, at: Date.now(), rows: ids.map(id => ({ account_id: id, status: 'pending' })) }, ...prev].slice(0, 5));
    poll(groupId, Date.now());
  }, [on, pickedAccounts, config, underlying, expiry, poll]);

  const dismiss = (id) => setSends(prev => prev.filter(s => s.id !== id));

  return {
    on, setOn, accounts, loadAccounts, loadError, picked, pickedAccounts, togglePick, setAll,
    ready: on && pickedAccounts.length > 0 && !!expiry,
    rowState, send, sends, dismiss,
  };
}
