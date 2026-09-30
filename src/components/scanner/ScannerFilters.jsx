import React, { useState } from 'react';
import { RotateCcw, X, Plus, Check } from 'lucide-react';
import { SCANNER_DEFAULTS, SAVED_SETTINGS_KEY } from './scannerDefaults';
import SendToWindow from './SendToWindow';

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
 * (click to apply, × to delete), "+ Save" (name the current filters) and Reset.
 * Saved settings are a full snapshot of every filter, kept in this browser.
 */
export function ScannerFilterToolbar({ config, updateConfig, onSendToWindow }) {
  const [saved, setSaved] = useState(loadSaved);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const val = (k) => config[k] ?? SCANNER_DEFAULTS[k];
  const changedCount = FIELD_KEYS.filter(k => !same(val(k), SCANNER_DEFAULTS[k])).length;
  const isActive = (values) => FIELD_KEYS.every(k => same(val(k), values[k] ?? SCANNER_DEFAULTS[k]));

  const commit = () => {
    const n = name.trim();
    if (!n) return;
    const values = Object.fromEntries(FIELD_KEYS.map(k => [k, val(k)]));
    const next = [...saved.filter(p => p.name !== n), { name: n, values }];
    setSaved(next);
    storeSaved(next);
    setNaming(false);
    setName('');
  };
  const cancel = () => { setNaming(false); setName(''); };
  const remove = (n) => {
    const next = saved.filter(p => p.name !== n);
    setSaved(next);
    storeSaved(next);
  };

  return (
    <div className="scanner-toolbar">
      {changedCount > 0 && (
        <span className="scanner-toolbar-count" title="Filters that differ from the defaults">{changedCount} changed</span>
      )}
      {saved.length > 0 && <span className="scanner-toolbar-label">Saved</span>}
      {saved.map(p => (
        <span key={p.name} className={`scanner-saved ${isActive(p.values) ? 'on' : ''}`}>
          <button type="button" className="scanner-saved-apply" onClick={() => updateConfig({ ...SCANNER_DEFAULTS, ...p.values })} title={`Apply "${p.name}"`}>
            {p.name}
          </button>
          <button type="button" className="scanner-saved-del" onClick={() => remove(p.name)} aria-label={`Delete saved settings ${p.name}`} title="Delete">
            <X size={11} strokeWidth={3} />
          </button>
        </span>
      ))}
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
