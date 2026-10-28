import React, { useState } from 'react';
import { Layers, Plus, RotateCcw, Trash2, X } from 'lucide-react';

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `g${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

// Edit the Daily Report's account groups (migration 067): rename, add / remove accounts,
// create or delete groups, or reset to the automatic name groups. Reporting only — it never
// touches the trading Account Groups. An account sits in at most one report group, so adding
// it to one moves it out of another.
export default function ReportGroupsModal({ accounts, groups, isCustom, onSave, onReset, onClose }) {
  const [draft, setDraft] = useState(() => groups.map(g => ({ id: g.key.replace(/^group:/, ''), label: g.label, ids: [...g.ids] })));
  const [addPick, setAddPick] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = (id) => accounts.find(a => a.id === id)?.name ?? id;
  const groupOf = (id) => draft.find(g => g.ids.includes(id));
  const update = (id, fn) => setDraft(d => d.map(g => (g.id === id ? fn(g) : g)));

  const addMember = (g) => {
    const acc = addPick[g.id];
    if (!acc) return;
    setDraft(d => d.map(x => (x.id === g.id ? { ...x, ids: [...x.ids, acc] } : { ...x, ids: x.ids.filter(i => i !== acc) })));
    setAddPick(p => ({ ...p, [g.id]: '' }));
  };

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); onClose(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const save = () => {
    const bad = draft.find(g => !g.label.trim() || g.ids.length < 2);
    if (bad) { setError('Each group needs a name and at least 2 accounts.'); return; }
    run(() => onSave(draft.map(g => ({ id: g.id, label: g.label.trim(), ids: g.ids }))));
  };

  return (
    <div className="modal-overlay-wrapper" onClick={onClose}>
      <div className="ag-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Report groups">
        <div className="ag-head">
          <h3><Layers size={16} /> Report Groups</h3>
          <button type="button" className="ag-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="ag-intro">
          Groups combine accounts in the Daily Report only — trading settings are not affected.
          {isCustom ? ' You are using your own groups.' : ' These are the automatic groups (same name, different number).'}
        </p>

        {error && <div className="ag-error">{error}</div>}

        <div className="ag-section-title">Groups</div>
        {draft.length === 0 && <div className="ag-empty">No groups.</div>}
        {draft.map(g => {
          const candidates = accounts.filter(a => !g.ids.includes(a.id));
          return (
            <div key={g.id} className="ag-group">
              <div className="ag-group-head">
                <input className="ag-input" value={g.label} placeholder="Group name" aria-label="Group name"
                  onChange={e => update(g.id, x => ({ ...x, label: e.target.value }))} />
                <span className="ag-count">{g.ids.length} account{g.ids.length === 1 ? '' : 's'}</span>
                <button type="button" className="ag-icon-btn danger" title="Delete group" disabled={busy}
                  onClick={() => setDraft(d => d.filter(x => x.id !== g.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="ag-members">
                {g.ids.length === 0 && <span className="ag-empty">No accounts</span>}
                {g.ids.map(id => (
                  <span key={id} className="ag-chip">
                    {nameOf(id)}
                    <button type="button" disabled={busy} aria-label={`Remove ${nameOf(id)}`} title={`Remove ${nameOf(id)}`}
                      onClick={() => update(g.id, x => ({ ...x, ids: x.ids.filter(i => i !== id) }))}><X size={11} /></button>
                  </span>
                ))}
              </div>
              {candidates.length > 0 && (
                <div className="ag-add">
                  <select className="ag-input" value={addPick[g.id] || ''} onChange={e => setAddPick(p => ({ ...p, [g.id]: e.target.value }))}>
                    <option value="">Add account…</option>
                    {candidates.map(a => {
                      const other = groupOf(a.id);
                      return <option key={a.id} value={a.id}>{a.name}{other ? ` (in ${other.label || 'another group'})` : ''}</option>;
                    })}
                  </select>
                  <button type="button" className="ag-btn" disabled={busy || !addPick[g.id]} onClick={() => addMember(g)}><Plus size={13} /> Add</button>
                </div>
              )}
            </div>
          );
        })}

        <button type="button" className="ag-btn" disabled={busy}
          onClick={() => setDraft(d => [...d, { id: newId(), label: 'New group', ids: [] }])}>
          <Plus size={13} /> New group
        </button>

        <div className="ag-actions" style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
          <button type="button" className="ag-btn" disabled={busy || !isCustom} onClick={() => run(onReset)}
            title="Go back to the automatic groups (same name, different number)">
            <RotateCcw size={13} /> Reset to automatic
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="ag-btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="ag-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
