import React, { useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import CustomSelect from '../common/CustomSelect';
import { supabase } from '../../supabase';
import { SCANNER_DEFAULTS } from './scannerDefaults';
import { sortSchedulesByStart } from '../PaperTrading/scheduleShared';

const COPIED = 'Min Spread Width, Min Spot Distance, Min IV Edge, Max Net Debit, ATM Scaling (Call/Put %), and Hedge settings on v2 paper accounts';
const SKIPPED = 'Max Delta Deviation, Min Short Premium, Max Short Ratio, ATM P&L/ROI';

/**
 * Toolbar button: pick an account + one of its schedule windows, then jump to that
 * trading dashboard with the current scanner filters filled into the window as an
 * UNSAVED edit. Nothing is written here — the user reviews it and clicks Apply there.
 * Accounts and windows come from Supabase under the normal RLS (own accounts; admins all).
 */
export default function SendToWindow({ config, onSendToWindow }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [windows, setWindows] = useState(null); // null = not loaded for this account yet
  const [windowId, setWindowId] = useState('');

  const openModal = async () => {
    setOpen(true);
    setError('');
    setAccountId('');
    setWindows(null);
    setWindowId('');
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError('Log in on the Paper or Live Trading page first.'); setAccounts([]); return; }
      const { data, error: accErr } = await supabase
        .from('paper_trading_accounts')
        .select('id, name, mode')
        .order('created_at', { ascending: true });
      if (accErr) throw accErr;
      setAccounts((data || []).map(a => ({ ...a, mode: a.mode === 'live' ? 'live' : 'paper' })));
    } catch (e) {
      setError(`Couldn't load accounts: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const pickAccount = async (id) => {
    setAccountId(id);
    setWindows(null);
    setWindowId('');
    if (!id) return;
    setLoading(true);
    try {
      const { data, error: schErr } = await supabase
        .from('paper_trading_schedules')
        .select('id, start_time, end_time, sort_order')
        .eq('account_id', id)
        .order('sort_order', { ascending: true });
      if (schErr) throw schErr;
      const list = sortSchedulesByStart(data || []);
      setWindows(list);
      if (list.length > 0) setWindowId(list[0].id);
    } catch (e) {
      setError(`Couldn't load windows: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const send = () => {
    const account = accounts.find(a => a.id === accountId);
    if (!account || !windowId) return;
    onSendToWindow({
      mode: account.mode,
      accountId,
      windowId,
      values: { ...SCANNER_DEFAULTS, ...config },
      sourceName: 'Current scanner filters',
    });
    setOpen(false);
  };

  const hhmm = (t) => (t || '').substring(0, 5);

  return (
    <>
      <button type="button" className="scanner-saved-add" onClick={openModal} title="Copy the current filters into a Paper/Live Trading schedule window (you'll review and Apply there)">
        <Send size={12} strokeWidth={2.5} /> Send to window
      </button>

      {open && (
        <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" style={{ maxWidth: 420, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text)' }}>
              Send Filters to a Schedule Window
            </h3>

            {error && <p style={{ margin: 0, fontSize: '12px', color: '#f85149' }}>{error}</p>}

            {!error && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Account</label>
                  <CustomSelect
                    value={accountId}
                    onChange={pickAccount}
                    options={[
                      { label: accounts.length ? 'Choose an account…' : 'No accounts', value: '' },
                      ...accounts.map(a => ({ label: `${a.name} (${a.mode === 'live' ? 'Live' : 'Paper'})`, value: a.id })),
                    ]}
                  />
                </div>

                {accountId && windows && windows.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Window</label>
                    <CustomSelect
                      value={windowId}
                      onChange={setWindowId}
                      options={windows.map(w => ({ label: `${w.label} (${hhmm(w.start_time)} – ${hhmm(w.end_time)})`, value: w.id }))}
                    />
                  </div>
                )}
                {accountId && windows && windows.length === 0 && (
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)' }}>
                    This account has no saved windows yet. Open it on the trading page once and click Apply, then try again.
                  </p>
                )}

                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Copies: {COPIED}. Not copied (no per-window setting): {SKIPPED}.<br />
                  You'll be taken to the account with the window filled in but <strong>not saved</strong> — click <strong>Apply</strong> there to save. Unsaved schedule edits on another account on that page will be discarded.
                </p>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
              {loading && <Loader2 size={14} className="animate-spin" strokeWidth={3} style={{ color: 'var(--text-dim)' }} />}
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={!windowId || loading}
                style={{ padding: '7px 14px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: '#ffffff', cursor: windowId && !loading ? 'pointer' : 'not-allowed', opacity: windowId && !loading ? 1 : 0.5, fontSize: '12px', fontWeight: 600 }}
              >
                Open in Window
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
