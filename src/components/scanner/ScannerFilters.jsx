import React, { useState } from 'react';
import { RotateCcw, X, Plus, Check, RefreshCw } from 'lucide-react';
import { SCANNER_DEFAULTS, SAVED_SETTINGS_KEY } from './scannerDefaults';
import SendToWindow from './SendToWindow';
import { showConfirm } from '../common/dialogService';

const FIELD_KEYS = Object.keys(SCANNER_DEFAULTS);

const same = (a, b) => (typeof a === 'boolean' || typeof b === 'boolean')
  ? !!a === !!b
  : Number(a) === Number(b);

function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_SETTINGS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(p => p && p.name && p.values) : [];
  } catch {
    return [];
  }
}

function storeSaved(list) {
  try { localStorage.setItem(SAVED_SETTINGS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

/**
 * Top-bar toolbar: how many filters differ from default, the user's saved settings
 * (click to apply, × to delete, ⟳ to update the applied one with the current filters),
 * "+ Save" (name the current filters; an existing name is overwritten in place) and Reset.
 * Saved settings are a full snapshot of every filter, kept in this browser.
 */
export function ScannerFilterToolbar({ config, updateConfig, onSendToWindow }) {
  const [saved, setSaved] = useState(loadSaved);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  // The saved setting last applied here: once the filters are changed, its chip offers ⟳ Update.
  const [appliedName, setAppliedName] = useState(null);

  const val = (k) => config[k] ?? SCANNER_DEFAULTS[k];
  const changedCount = FIELD_KEYS.filter(k => !same(val(k), SCANNER_DEFAULTS[k])).length;
  const isActive = (values) => FIELD_KEYS.every(k => same(val(k), values[k] ?? SCANNER_DEFAULTS[k]));

  const currentValues = () => Object.fromEntries(FIELD_KEYS.map(k => [k, val(k)]));
  // Save under `n`: an existing entry is overwritten IN PLACE (keeps its position), else appended.
  const saveAs = (n) => {
    const values = currentValues();
    const exists = saved.some(p => p.name === n);
    const next = exists ? saved.map(p => (p.name === n ? { name: n, values } : p)) : [...saved, { name: n, values }];
    setSaved(next);
    storeSaved(next);
    setAppliedName(n);
  };
  const commit = async () => {
    const n = name.trim();
    if (!n) return;
    if (saved.some(p => p.name === n)
      && !(await showConfirm(`"${n}" already exists. Replace it with the current filters?`, { title: 'Replace saved settings', confirmLabel: 'Replace' }))) return;
    saveAs(n);
    setNaming(false);
    setName('');
  };
  const update = async (n) => {
    if (!(await showConfirm(`Update "${n}" with the current filters?`, { title: 'Update saved settings', confirmLabel: 'Update' }))) return;
    saveAs(n);
  };
  const cancel = () => { setNaming(false); setName(''); };
  const remove = (n) => {
    const next = saved.filter(p => p.name !== n);
    setSaved(next);
    storeSaved(next);
    if (appliedName === n) setAppliedName(null);
  };

  return (
    <div className="scanner-toolbar">
      {changedCount > 0 && (
        <span className="scanner-toolbar-count" title="Filters that differ from the defaults">{changedCount} changed</span>
      )}
      {saved.length > 0 && <span className="scanner-toolbar-label">Saved</span>}
      {saved.map(p => {
        const active = isActive(p.values);
        const modified = !active && p.name === appliedName;
        return (
        <span key={p.name} className={`scanner-saved ${active ? 'on' : ''} ${modified ? 'modified' : ''}`}>
          <button type="button" className="scanner-saved-apply"
            onClick={() => { updateConfig({ ...SCANNER_DEFAULTS, ...p.values }); setAppliedName(p.name); }}
            title={modified ? `Filters changed since "${p.name}" was applied — click to re-apply it` : `Apply "${p.name}"`}>
            {p.name}{modified ? ' •' : ''}
          </button>
          {modified && (
            <button type="button" className="scanner-saved-upd" onClick={() => update(p.name)}
              aria-label={`Update saved settings ${p.name}`} title={`Update "${p.name}" with the current filters`}>
              <RefreshCw size={11} strokeWidth={3} />
            </button>
          )}
          <button type="button" className="scanner-saved-del" onClick={() => remove(p.name)} aria-label={`Delete saved settings ${p.name}`} title="Delete">
            <X size={11} strokeWidth={3} />
          </button>
        </span>
        );
      })}
      {naming ? (
        <span className="scanner-saved-new">
          <input
            autoFocus
            type="text"
            className="custom-input-field"
            placeholder="Name these settings"
            maxLength={24}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
          />
          <button type="button" className="scanner-icon-btn" onClick={commit} disabled={!name.trim()} aria-label="Save settings"><Check size={13} strokeWidth={3} /></button>
          <button type="button" className="scanner-icon-btn" onClick={cancel} aria-label="Cancel"><X size={13} strokeWidth={3} /></button>
        </span>
      ) : (
        <button type="button" className="scanner-saved-add" onClick={() => setNaming(true)} title="Save the current filters under a name">
          <Plus size={12} strokeWidth={3} /> Save
        </button>
      )}
      {onSendToWindow && <SendToWindow config={config} onSendToWindow={onSendToWindow} />}
      <button
        type="button"
        className="scanner-reset-btn"
        onClick={() => updateConfig({ ...SCANNER_DEFAULTS })}
        disabled={changedCount === 0}
        title="Reset every filter to its default"
      >
        <RotateCcw size={12} strokeWidth={2.5} /> Reset
      </button>
    </div>
  );
}
