import React, { useState } from 'react';
import { Users, X, Plus, Trash2, Loader2, Pencil, Check } from 'lucide-react';

// Account groups (migration 050): accounts of one mode that share ALL strategy settings
// (Control Panel filters, schedule windows, excluded strikes, allocation % / caps). Settings are
// still stored per account; saving on any member copies them to the others
// (sync_account_group). Balances, positions and live controls stay per account.

// Default for new and existing groups (migration 058 column default): fixed 25-point steps.
const DEFAULT_MODE = 'fixed';
const DEFAULT_STEP = 25;
const DEFAULT_RMIN = 10;
const DEFAULT_RMAX = 50;
const clampStep = (v) => Math.min(1000, Math.max(0, Math.round(Number(v) || 0)));
// Normalised setting: whole numbers in 0–1000 and min <= max.
const normDiff = (d) => {
  const min = clampStep(d.min);
  return { mode: d.mode, step: clampStep(d.step), min, max: Math.max(min, clampStep(d.max)) };
};
const DEFAULT_DIFF = { mode: DEFAULT_MODE, step: DEFAULT_STEP, min: DEFAULT_RMIN, max: DEFAULT_RMAX };

// Exit-points difference between a group's members (migration 058): RANDOM ±10–50 per member
// (053/054; range editable, default 10–50) or FIXED steps of an arithmetic progression around the saved account (e.g. −50,
// −25, 0, +25, +50 at step 25). `onApply` set → edits a saved group (Apply button);
// otherwise it is a controlled field of the New-group form.
function ExitDiffControl({ value, onChange, onApply, busy }) {
  const [draft, setDraft] = useState(value);
  const cur = onApply ? draft : value;
  const set = (patch) => (onApply ? setDraft(d => ({ ...d, ...patch })) : onChange({ ...value, ...patch }));
  const n = normDiff(draft);
  const dirty = onApply && (n.mode !== value.mode || n.step !== value.step || n.min !== value.min || n.max !== value.max);
  const range = normDiff(cur);
  return (
    <div className="ag-diff">
      <span className="ag-diff-label" title="How the exit points of a group's schedule windows differ between its accounts">Exit points difference</span>
      <div className="ag-diff-seg" role="group" aria-label="Exit points difference">
        <button type="button" className={cur.mode === 'random' ? 'on' : ''} disabled={busy} onClick={() => set({ mode: 'random' })}
          title="Each other account gets the saved account's exit points ± a random number in the From–To range (unique per window)">Random</button>
        <button type="button" className={cur.mode === 'fixed' ? 'on' : ''} disabled={busy} onClick={() => set({ mode: 'fixed' })}
          title="Accounts get fixed steps around the saved account: …, −2×step, −step, 0, +step, +2×step, …">Fixed</button>
      </div>
      {cur.mode === 'fixed' && (
        <label className="ag-diff-step">
          Step
          <input className="ag-input" type="number" min="0" max="1000" step="5" value={cur.step} disabled={busy}
            onChange={e => set({ step: e.target.value })} />
          pts
        </label>
      )}
      {cur.mode === 'random' && (
        <label className="ag-diff-step">
          From
          <input className="ag-input" type="number" min="0" max="1000" step="5" value={cur.min} disabled={busy}
            onChange={e => set({ min: e.target.value })} />
          To
          <input className="ag-input" type="number" min="0" max="1000" step="5" value={cur.max} disabled={busy}
            onChange={e => set({ max: e.target.value })} />
          pts
        </label>
      )}
      <span className="ag-diff-hint">
        {cur.mode === 'fixed'
          ? `e.g. ${[-2, -1, 0, 1, 2].map(i => { const v = i * clampStep(cur.step); return v > 0 ? `+${v}` : String(v); }).join(', ')}`
          : `each account ± random ${range.min}–${range.max}`}
      </span>
      {dirty && (
        <button type="button" className="ag-btn primary" disabled={busy}
          onClick={() => onApply(n)}>Apply</button>
      )}
    </div>
  );
}

export default function AccountGroupsModal({
  isOpen, onClose, mode, groups, accounts, busy, error,
  onCreate, onAddMember, onRemoveMember, onRename, onDelete, onUpdateExitDiff,
}) {
  const [name, setName] = useState('');
  const [newDiff, setNewDiff] = useState(DEFAULT_DIFF);
  const [picked, setPicked] = useState([]);
  const [sourceId, setSourceId] = useState('');
  const [addPick, setAddPick] = useState({});
  const [editing, setEditing] = useState(null); // { id, name }

  if (!isOpen) return null;

  const groupName = (id) => groups.find(g => g.id === id)?.name;
  const membersOf = (gid) => accounts.filter(a => a.group_id === gid);
  const source = picked.includes(sourceId) ? sourceId : picked[0] ?? '';
  const togglePick = (id) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));

  const create = async () => {
    const others = picked.filter(id => id !== source).map(id => accounts.find(a => a.id === id)?.name).filter(Boolean);
    const moving = picked.map(id => accounts.find(a => a.id === id)).filter(a => a?.group_id);
    const msg = `Create group "${name.trim()}"?\n\n`
      + `${others.length ? `${others.join(', ')} will get ALL settings (filters, schedule windows, excluded strikes, allocation %) copied from ${accounts.find(a => a.id === source)?.name}. Their own current settings are replaced.\n` : ''}`
      + `${moving.length ? `\n${moving.map(a => `${a.name} leaves "${groupName(a.group_id)}"`).join(', ')}.\n` : ''}`
      + '\nBalances, open positions and live controls are not changed.';
    if (!window.confirm(msg)) return;
    const ok = await onCreate(name.trim(), picked, source, normDiff(newDiff));
    if (ok) { setName(''); setPicked([]); setSourceId(''); setNewDiff(DEFAULT_DIFF); }
  };

  const add = async (g) => {
    const id = addPick[g.id];
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    const from = membersOf(g.id)[0];
    const msg = `Add ${acc.name} to "${g.name}"?\n\n${acc.name}'s settings (filters, schedule windows, excluded strikes, allocation %) will be replaced by the group's${from ? ` (copied from ${from.name})` : ''}.`
      + `${acc.group_id ? `\nIt leaves "${groupName(acc.group_id)}".` : ''}\n\nBalance, open positions and live controls are not changed.`;
    if (!window.confirm(msg)) return;
    const ok = await onAddMember(g.id, id);
    if (ok) setAddPick(p => ({ ...p, [g.id]: '' }));
  };

  return (
    <div className="modal-overlay-wrapper" onClick={onClose}>
      <div className="ag-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Account groups">
        <div className="ag-head">
          <h3><Users size={16} /> Account Groups <span className="ag-mode">{mode}</span></h3>
          <button type="button" className="ag-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="ag-intro">
          Accounts in a group share <b>all</b> settings — Control Panel filters, schedule windows, excluded strikes, allocation % and
          position caps. Save a change on any member and it is copied to the others. Each account still trades and is monitored on its
          own: balance, open positions, P&amp;L{mode === 'live' ? ', credentials, Start Live / Disarm' : ''} and Pause stay per account.
        </p>

        {error && <div className="ag-error">{error}</div>}

        <div className="ag-section-title">Groups</div>
        {groups.length === 0 && <div className="ag-empty">No groups yet.</div>}
        {groups.map(g => {
          const members = membersOf(g.id);
          const candidates = accounts.filter(a => a.group_id !== g.id);
          return (
            <div key={g.id} className="ag-group">
              <div className="ag-group-head">
                {editing?.id === g.id ? (
                  <>
                    <input className="ag-input" value={editing.name} autoFocus
                      onChange={e => setEditing({ id: g.id, name: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter' && editing.name.trim()) { onRename(g.id, editing.name.trim()); setEditing(null); } }} />
                    <button type="button" className="ag-icon-btn" disabled={busy || !editing.name.trim()} title="Save name"
                      onClick={() => { onRename(g.id, editing.name.trim()); setEditing(null); }}><Check size={14} /></button>
                  </>
                ) : (
                  <>
                    <strong>{g.name}</strong>
                    <span className="ag-count">{members.length} account{members.length === 1 ? '' : 's'}</span>
                    <button type="button" className="ag-icon-btn" title="Rename" onClick={() => setEditing({ id: g.id, name: g.name })}><Pencil size={13} /></button>
                  </>
                )}
                <button type="button" className="ag-icon-btn danger" disabled={busy} title="Delete group (accounts keep their current settings)"
                  onClick={() => window.confirm(`Delete group "${g.name}"? Its accounts keep their current settings and become independent again.`) && onDelete(g.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="ag-members">
                {members.length === 0 && <span className="ag-empty">No accounts</span>}
                {members.map(a => (
                  <span key={a.id} className="ag-chip">
                    {a.name}
                    <button type="button" disabled={busy} title={`Remove ${a.name} (keeps its current settings)`}
                      onClick={() => onRemoveMember(a.id)} aria-label={`Remove ${a.name}`}><X size={11} /></button>
                  </span>
                ))}
              </div>
              {onUpdateExitDiff && (
                <ExitDiffControl
                  key={`${g.id}-${g.exit_points_mode}-${g.exit_points_step}-${g.exit_points_random_min}-${g.exit_points_random_max}`}
                  value={{
                    mode: g.exit_points_mode || DEFAULT_MODE,
                    step: g.exit_points_step ?? DEFAULT_STEP,
                    min: g.exit_points_random_min ?? DEFAULT_RMIN,
                    max: g.exit_points_random_max ?? DEFAULT_RMAX,
                  }}
                  busy={busy}
                  onApply={(v) => {
                    const msg = `Use a ${v.mode === 'fixed' ? `FIXED ${v.step}-point` : `RANDOM (±${v.min}–${v.max})`} exit-points difference in "${g.name}"?\n\n`
                      + "The group's schedule windows are re-copied now from its first account so it applies immediately (other members' window settings are replaced by that account's, as on any group save).";
                    if (window.confirm(msg)) onUpdateExitDiff(g.id, v);
                  }}
                />
              )}
              {candidates.length > 0 && (
                <div className="ag-add">
                  <select className="ag-input" value={addPick[g.id] || ''} onChange={e => setAddPick(p => ({ ...p, [g.id]: e.target.value }))}>
                    <option value="">Add account…</option>
                    {candidates.map(a => (
                      <option key={a.id} value={a.id}>{a.name}{a.group_id ? ` (in ${groupName(a.group_id) ?? 'another group'})` : ''}</option>
                    ))}
                  </select>
                  <button type="button" className="ag-btn" disabled={busy || !addPick[g.id]} onClick={() => add(g)}><Plus size={13} /> Add</button>
                </div>
              )}
            </div>
          );
        })}

        <div className="ag-section-title">New group</div>
        <div className="ag-create">
          <input className="ag-input" placeholder="Group name" value={name} onChange={e => setName(e.target.value)} />
          <div className="ag-pick-head">
            <span>Accounts · {picked.length} selected</span>
            {accounts.length > 0 && (
              <button type="button" onClick={() => setPicked(picked.length === accounts.length ? [] : accounts.map(a => a.id))}>
                {picked.length === accounts.length ? 'Clear' : 'Select all'}
              </button>
            )}
          </div>
          <div className="ag-pick">
            {accounts.map(a => (
              <label key={a.id} className={`ag-pick-item${picked.includes(a.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(a.id)} onChange={() => togglePick(a.id)} />
                <span>{a.name}</span>
                {a.group_id && <em>in {groupName(a.group_id) ?? 'a group'}</em>}
              </label>
            ))}
          </div>
          <ExitDiffControl value={newDiff} onChange={setNewDiff} busy={busy} />
          {picked.length > 1 && (
            <label className="ag-source">
              <span>Copy settings from</span>
              <select className="ag-input" value={source} onChange={e => setSourceId(e.target.value)}>
                {picked.map(id => <option key={id} value={id}>{accounts.find(a => a.id === id)?.name}</option>)}
              </select>
            </label>
          )}
          <div className="ag-actions">
            <span className="ag-hint">Pick at least 2 accounts{mode === 'paper' ? ' on the same strategy version' : ''}. Accounts of different users can share a group.</span>
            <button type="button" className="ag-btn primary" disabled={busy || !name.trim() || picked.length < 2} onClick={create}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create group
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
