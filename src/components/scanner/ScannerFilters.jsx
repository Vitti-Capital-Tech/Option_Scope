import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Info, RotateCcw, Plus, X, Check, ChevronDown } from 'lucide-react';
import CustomInput from '../common/CustomInput';
import { SCANNER_DEFAULTS, BUILTIN_PRESETS, CUSTOM_PRESETS_KEY } from './scannerDefaults';

const FIELD_KEYS = Object.keys(SCANNER_DEFAULTS);

const same = (a, b) => (typeof a === 'boolean' || typeof b === 'boolean')
  ? !!a === !!b
  : Number(a) === Number(b);

const matches = (config, values) => Object.keys(values).every(k => same(config[k], values[k]));

function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(p => p && p.name && p.values) : [];
  } catch {
    return [];
  }
}

function saveCustomPresets(list) {
  try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

// Which filter cards are collapsed (per browser). Every card starts open.
const CARDS_KEY = 'vitti_scanner_cards_v1';

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// A filter card whose header toggles it open / closed. Collapsed, the header lists every
// condition in the card as one or two lines of "Label value   Label value" text (amber dot
// = changed from default), so the active filters stay readable without opening it.
function Cluster({ id, title, summary, collapsed, onToggle, children }) {
  return (
    <div className={`scanner-cluster ${collapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="scanner-cluster-head"
        onClick={() => onToggle(id)}
        aria-expanded={!collapsed}
        aria-controls={`card-${id}`}
        title={collapsed ? `Show ${title}` : `Hide ${title}`}
      >
        <span className="scanner-cluster-title">{title}</span>
        <span className="scanner-cluster-rule" />
        <ChevronDown className="scanner-cluster-chevron" size={14} strokeWidth={2.5} />
        {collapsed && (
          <span
            className="scanner-cluster-line"
            title={summary.map(i => `${i.label} ${i.value}`).join(' · ')}
          >
            {summary.map(i => (
              <span key={i.label} className={`item ${i.changed ? 'changed' : ''} ${i.off ? 'off' : ''}`}>
                <span className="k">{i.label}</span>
                <span className="v">{i.value}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      {!collapsed && <div id={`card-${id}`} className="scanner-cluster-fields">{children}</div>}
    </div>
  );
}

// Tooltip copy: `text` explains the filter, optional `eg` shows a worked example.
const HINTS = {
  minStrikeDiff: { text: 'Minimum gap between the long and short strikes. Higher = wider spreads, fewer matches.', eg: '800 → long 84,000 needs a short at 84,800 or beyond' },
  minLongDist: { text: 'How far the long strike must be from spot. Higher = further OTM entries.', eg: '1,000 with spot 84,000 → call long ≥ 85,000' },
  maxSellQty: { text: 'Largest short-to-long ratio allowed.', eg: '10 → up to 10 shorts per long (1:10)' },
  maxRatioDeviation: { text: 'How far the premium ratio may drift from the delta ratio. Lower = stricter delta-neutral pairs.', eg: '0.25 → within 25%' },
  minIvDiff: { text: 'Minimum IV gap between the long and short legs: |long IV − short IV|.', eg: '5 → long 30% needs a short at 35% or 25%' },
  minSellPremium: { text: 'The short leg must be bid at least this much.' },
  maxNetPremium: { text: 'Largest net debit allowed. A negative value turns it into a minimum net credit.', eg: '−21 → needs $21 credit · 20 → up to $20 debit' },
  minAtmPnl: { text: 'Minimum P&L if spot moves to the long strike (ATM).' },
  minAtmRoi: { text: 'Minimum ATM P&L as a % of the required margin.' },
  atmRatioScaling: { text: 'Scale the short qty toward the ATM ratio by the Call / Put %.' },
  atmRatioPctCall: { text: 'How far to move a call spread\'s short qty toward the ATM ratio.', eg: '50% → halfway from the delta ratio to the ATM ratio' },
  atmRatioPctPut: { text: 'How far to move a put spread\'s short qty toward the ATM ratio.', eg: '50% → halfway from the delta ratio to the ATM ratio' },
  hedgeEnabled: { text: 'Show each spread\'s 3rd long (hedge) and include it in net premium, delta, ATM P&L and margin.' },
  hedgeLotPct: { text: 'Hedge qty as a % of the scaled short qty.', eg: '50% of 20 shorts → 10 hedge longs' },
  hedgeMaxPrice: { text: 'The hedge strike\'s price must be below this.' },
  hedgeIvDiff: { text: 'The hedge strike is the one nearest the short whose |hedge IV − short IV| falls inside this range.', eg: '0–2% with a short at 42% → hedge IV 40–44%' },
};

// Styled tooltip for the ⓘ button: opens on hover/focus (desktop) or tap (phones, pinned
// until an outside tap or Esc). Fixed-positioned from the button's rect so the scanner's
// overflow-hidden panels can't clip it; flips above when there's no room below and is
// clamped inside the viewport.
function HintTip({ id, label, hint, pinned, onTogglePin, onClose }) {
  const btnRef = useRef(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState(null);
  const open = hover || pinned;
  const tipId = `tip-${id}`;

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(270, vw - 16);
      const center = r.left + r.width / 2;
      const left = Math.min(Math.max(center - width / 2, 8), vw - width - 8);
      const below = r.bottom + 130 < vh;
      setPos({ left, width, top: below ? r.bottom + 10 : r.top - 10, below, arrow: Math.min(Math.max(center - left, 14), width - 14) });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!pinned) return undefined;
    const onDown = (e) => { if (!btnRef.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned, onClose]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`scanner-hint-btn ${open ? 'open' : ''}`}
        aria-label={`About ${label}`}
        aria-expanded={pinned}
        aria-describedby={open ? tipId : undefined}
        onClick={() => onTogglePin(id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <Info size={11} strokeWidth={2.5} />
      </button>
      {open && pos && (
        <div
          id={tipId}
          role="tooltip"
          className={`scanner-tip ${pos.below ? 'below' : 'above'}`}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
        >
          <span className="scanner-tip-arrow" style={{ left: pos.arrow }} />
          <div className="scanner-tip-title">
            <Info size={11} strokeWidth={2.75} />
            {label}
          </div>
          <div className="scanner-tip-body">{hint.text}</div>
          {hint.eg && <div className="scanner-tip-eg"><span>e.g.</span> {hint.eg}</div>}
        </div>
      )}
    </>
  );
}

// One filter: label (+ changed dot + ⓘ), control, and an optional full-width hint /
// caption row. `changed` marks a value that differs from the default.
function Field({ id, label, changed, defaultText, hintKey, openHint, onToggleHint, onCloseHint, caption, tone, disabled, extra, className = '', children }) {
  const hint = HINTS[hintKey || id];
  return (
    <div className={`form-group row-inline scanner-field ${disabled ? 'is-disabled' : ''} ${className}`}>
      <div className="scanner-field-label">
        <label htmlFor={id}>{label}</label>
        {changed && <span className="scanner-changed-dot" title={`Changed from default (${defaultText})`} />}
        {hint && (
          <HintTip
            id={id}
            label={label}
            hint={hint}
            pinned={openHint === id}
            onTogglePin={onToggleHint}
            onClose={onCloseHint}
          />
        )}
        {extra != null && <span className="scanner-field-extra">{extra}</span>}
      </div>
      <div className="scanner-field-control">{children}</div>
      {caption && <div className={`scanner-caption ${tone || ''}`}>{caption}</div>}
    </div>
  );
}

// Two-thumb range slider (two overlapping native range inputs over one track).
function RangeSlider({ min, max, step, low, high, onChange, disabled, idLow, idHigh }) {
  const clamp = (v) => Math.min(Math.max(Number(v) || 0, min), max);
  const pct = (v) => ((clamp(v) - min) / (max - min)) * 100;
  return (
    <div className={`scanner-range ${disabled ? 'disabled' : ''}`}>
      <div className="scanner-range-track">
        <div className="scanner-range-fill" style={{ left: `${pct(low)}%`, width: `${Math.max(0, pct(high) - pct(low))}%` }} />
      </div>
      <input
        id={idLow} type="range" min={min} max={max} step={step} value={clamp(low)} disabled={disabled}
        aria-label="Minimum"
        onChange={e => onChange(Math.min(Number(e.target.value), Number(high)), Number(high))}
      />
      <input
        id={idHigh} type="range" min={min} max={max} step={step} value={clamp(high)} disabled={disabled}
        aria-label="Maximum"
        onChange={e => onChange(Number(low), Math.max(Number(e.target.value), Number(low)))}
      />
    </div>
  );
}

function Switch({ id, checked, onChange, title }) {
  return (
    <label className="pt-switch" title={title}>
      <input type="checkbox" id={id} checked={!!checked} onChange={e => onChange(e.target.checked)} />
      <span className="pt-slider"></span>
    </label>
  );
}

/**
 * The scanner's filter panel: presets bar + four clusters. Renders a fragment so each
 * cluster is a direct grid item of .scanner-filters-container.
 */
export function ScannerFilters({ config, updateConfig }) {
  const [openHint, setOpenHint] = useState(null);
  const [customPresets, setCustomPresets] = useState(loadCustomPresets);
  const [saving, setSaving] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleCard = (id) => setCollapsed(c => {
    const next = { ...c, [id]: !c[id] };
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });

  const toggleHint = (id) => setOpenHint(h => (h === id ? null : id));
  const closeHint = React.useCallback(() => setOpenHint(null), []);
  const changed = (k) => !same(config[k], SCANNER_DEFAULTS[k]);
  const anyChanged = FIELD_KEYS.some(changed);
  const f = (k) => config[k] ?? SCANNER_DEFAULTS[k];

  const setNum = (k) => (e) => updateConfig(k, Number(e.target.value));
  const common = (k) => ({ id: k, changed: changed(k), defaultText: String(SCANNER_DEFAULTS[k]), openHint, onToggleHint: toggleHint, onCloseHint: closeHint });

  const scalingOn = !!config.atmRatioScaling;
  const hedgeOn = !!config.hedgeEnabled;

  // Validation (red border + caption)
  const err = {
    maxRatioDeviation: !(Number(f('maxRatioDeviation')) > 0) ? 'Must be greater than 0' : null,
    maxSellQty: !(Number(f('maxSellQty')) >= 1) ? 'Must be at least 1:1' : null,
    hedgeLotPct: hedgeOn && !(Number(f('hedgeLotPct')) > 0 && Number(f('hedgeLotPct')) <= 100) ? 'Use 1–100%' : null,
    hedgeMaxPrice: hedgeOn && !(Number(f('hedgeMaxPrice')) > 0) ? 'Must be greater than $0' : null,
    hedgeIvDiff: Number(f('hedgeIvDiffMin')) > Number(f('hedgeIvDiffMax')) ? 'Min is above max' : null,
  };

  const netDebit = Number(f('maxNetPremium'));
  const netCaption = netDebit < 0
    ? `Needs ≥ $${Math.abs(netDebit)} net credit`
    : netDebit === 0 ? 'No net debit allowed' : `Allows up to $${netDebit} debit`;

  // Collapsed-card chips: full condition names + values. `keys` drive the "changed" dot.
  const money = (k) => `$${Number(f(k)).toLocaleString()}`;
  const item = (label, value, keys, extra = {}) => ({ label, value, changed: keys.some(changed), ...extra });
  const summaries = {
    spread: [
      item('Spread Width', `≥ ${money('minStrikeDiff')}`, ['minStrikeDiff']),
      item('Spot Distance', `≥ ${money('minLongDist')}`, ['minLongDist']),
      item('Short Ratio', `≤ 1:${f('maxSellQty')}`, ['maxSellQty']),
      item('Delta Deviation', `≤ ${f('maxRatioDeviation')}`, ['maxRatioDeviation']),
    ],
    premium: [
      item('IV Edge', `≥ ${f('minIvDiff')}%`, ['minIvDiff']),
      item('Short Premium', `≥ ${money('minSellPremium')}`, ['minSellPremium']),
      netDebit < 0
        ? item('Net Credit', `≥ $${Math.abs(netDebit).toLocaleString()}`, ['maxNetPremium'])
        : item('Net Debit', netDebit === 0 ? 'None allowed' : `≤ ${money('maxNetPremium')}`, ['maxNetPremium']),
    ],
    atm: [
      item('ATM P&L', `≥ ${money('minAtmPnl')}`, ['minAtmPnl']),
      item('ATM ROI', `≥ ${f('minAtmRoi')}%`, ['minAtmRoi']),
      scalingOn
        ? item('Call / Put Scaling', `${f('atmRatioPctCall')}% / ${f('atmRatioPctPut')}%`, ['atmRatioScaling', 'atmRatioPctCall', 'atmRatioPctPut'])
        : item('ATM Scaling', 'Off', ['atmRatioScaling'], { off: true }),
    ],
    hedge: hedgeOn
      ? [
        item('Hedge Lot', `${f('hedgeLotPct')}%`, ['hedgeLotPct']),
        item('Hedge Price', `< ${money('hedgeMaxPrice')}`, ['hedgeMaxPrice']),
        item('Hedge IV Diff', `${f('hedgeIvDiffMin')}–${f('hedgeIvDiffMax')}%`, ['hedgeIvDiffMin', 'hedgeIvDiffMax']),
      ]
      : [item('Hedge Leg', 'Off', ['hedgeEnabled'], { off: true })],
  };
  const cardProps = (id, title) => ({ id, title, summary: summaries[id], collapsed: !!collapsed[id], onToggle: toggleCard });

  const activeBuiltin = BUILTIN_PRESETS.find(p => matches(config, p.values))?.id;
  const activeCustom = customPresets.find(p => matches(config, p.values))?.name;

  const commitPreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const values = Object.fromEntries(FIELD_KEYS.map(k => [k, config[k] ?? SCANNER_DEFAULTS[k]]));
    const next = [...customPresets.filter(p => p.name !== name), { name, values }];
    setCustomPresets(next);
    saveCustomPresets(next);
    setSaving(false);
    setPresetName('');
  };
  const deletePreset = (name) => {
    const next = customPresets.filter(p => p.name !== name);
    setCustomPresets(next);
    saveCustomPresets(next);
  };

  return (
    <>
      <div className="scanner-presets">
        <span className="scanner-presets-label">Presets</span>
        <div className="scanner-presets-list">
          {BUILTIN_PRESETS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`scanner-preset ${activeBuiltin === p.id ? 'on' : ''}`}
              onClick={() => updateConfig(p.values)}
              title={`Apply ${p.name} entry filters (toggles unchanged)`}
            >
              {p.name}
            </button>
          ))}
          {customPresets.map(p => (
            <span key={p.name} className={`scanner-preset custom ${activeCustom === p.name ? 'on' : ''}`}>
              <button type="button" className="scanner-preset-apply" onClick={() => updateConfig(p.values)} title={`Apply "${p.name}"`}>
                {p.name}
              </button>
              <button type="button" className="scanner-preset-del" onClick={() => deletePreset(p.name)} aria-label={`Delete preset ${p.name}`} title="Delete preset">
                <X size={11} strokeWidth={3} />
              </button>
            </span>
          ))}
          {saving ? (
            <span className="scanner-preset-save">
              <input
                autoFocus
                type="text"
                className="custom-input-field"
                placeholder="Preset name"
                maxLength={24}
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitPreset();
                  if (e.key === 'Escape') { setSaving(false); setPresetName(''); }
                }}
              />
              <button type="button" className="scanner-icon-btn" onClick={commitPreset} disabled={!presetName.trim()} aria-label="Save preset"><Check size={13} strokeWidth={3} /></button>
              <button type="button" className="scanner-icon-btn" onClick={() => { setSaving(false); setPresetName(''); }} aria-label="Cancel"><X size={13} strokeWidth={3} /></button>
            </span>
          ) : (
            <button type="button" className="scanner-preset add" onClick={() => setSaving(true)} title="Save the current filters as a preset">
              <Plus size={12} strokeWidth={3} /> Save
            </button>
          )}
        </div>
        <button
          type="button"
          className="scanner-reset-btn"
          onClick={() => updateConfig({ ...SCANNER_DEFAULTS })}
          disabled={!anyChanged}
          title="Reset every filter to its default"
        >
          <RotateCcw size={12} strokeWidth={2.5} /> Reset
        </button>
      </div>

      <Cluster {...cardProps('spread', 'Spread')}>
          <Field {...common('minStrikeDiff')} label="Min Spread Width">
            <CustomInput id="minStrikeDiff" type="number" prefix="$" showStepper width={110} step="50" value={f('minStrikeDiff')} onChange={setNum('minStrikeDiff')} />
          </Field>
          <Field {...common('minLongDist')} label="Min Spot Distance">
            <CustomInput id="minLongDist" type="number" prefix="$" showStepper width={110} step="50" value={f('minLongDist')} onChange={setNum('minLongDist')} />
          </Field>
          <Field {...common('maxSellQty')} label="Max Short Ratio" caption={err.maxSellQty} tone="bad">
            <CustomInput id="maxSellQty" type="number" step="0.25" prefix="1:" showStepper width={110} error={!!err.maxSellQty} value={f('maxSellQty')} onChange={setNum('maxSellQty')} />
          </Field>
          <Field {...common('maxRatioDeviation')} label="Max Delta Deviation" caption={err.maxRatioDeviation} tone="bad">
            <CustomInput id="maxRatioDeviation" type="number" step="0.01" showStepper width={110} error={!!err.maxRatioDeviation} value={f('maxRatioDeviation')} onChange={setNum('maxRatioDeviation')} />
          </Field>
      </Cluster>

      <Cluster {...cardProps('premium', 'Premium & IV')}>
          <Field {...common('minIvDiff')} label="Min IV Edge">
            <CustomInput id="minIvDiff" type="number" suffix="%" showStepper width={110} step="0.25" value={f('minIvDiff')} onChange={setNum('minIvDiff')} />
          </Field>
          <Field {...common('minSellPremium')} label="Min Short Premium">
            <CustomInput id="minSellPremium" type="number" prefix="$" showStepper width={110} value={f('minSellPremium')} onChange={setNum('minSellPremium')} />
          </Field>
          <Field {...common('maxNetPremium')} label="Max Net Debit" caption={netCaption} tone={netDebit < 0 ? 'good' : ''}>
            <CustomInput id="maxNetPremium" type="number" prefix="$" showStepper width={110} value={f('maxNetPremium')} onChange={setNum('maxNetPremium')} />
          </Field>
      </Cluster>

      <Cluster {...cardProps('atm', 'ATM Edge')}>
          <Field {...common('minAtmPnl')} label="Min ATM P&L">
            <CustomInput id="minAtmPnl" type="number" prefix="$" step="10" showStepper width={110} value={f('minAtmPnl')} onChange={setNum('minAtmPnl')} />
          </Field>
          <Field {...common('minAtmRoi')} label="Min ATM ROI">
            <CustomInput id="minAtmRoi" type="number" suffix="%" step="1" showStepper width={110} value={f('minAtmRoi')} onChange={setNum('minAtmRoi')} />
          </Field>
          <Field {...common('atmRatioScaling')} label="Dynamic ATM Scaling" className="scanner-switch-row">
            <Switch id="atmRatioScaling" checked={scalingOn} onChange={v => updateConfig('atmRatioScaling', v)} title="Scale the short qty toward the ATM ratio" />
          </Field>
          <Field {...common('atmRatioPctCall')} label="Call Scaling" disabled={!scalingOn}>
            <CustomInput id="atmRatioPctCall" type="number" step="5" suffix="%" showStepper width={110} disabled={!scalingOn} value={f('atmRatioPctCall')} onChange={setNum('atmRatioPctCall')} />
          </Field>
          <Field {...common('atmRatioPctPut')} label="Put Scaling" disabled={!scalingOn}>
            <CustomInput id="atmRatioPctPut" type="number" step="5" suffix="%" showStepper width={110} disabled={!scalingOn} value={f('atmRatioPctPut')} onChange={setNum('atmRatioPctPut')} />
          </Field>
      </Cluster>

      <Cluster {...cardProps('hedge', 'Hedge Leg')}>
          <Field {...common('hedgeEnabled')} label="Show Hedge Leg" className="scanner-switch-row">
            <Switch id="hedgeEnabled" checked={hedgeOn} onChange={v => updateConfig('hedgeEnabled', v)} title="Show each spread's 3rd long (hedge) leg" />
          </Field>
          <Field
            {...common('hedgeLotPct')}
            label="Hedge Lot"
            className="scanner-lot-field"
            disabled={!hedgeOn}
            caption={err.hedgeLotPct || (
              <span className="scanner-chips">
                {[25, 50, 75, 100].map(v => (
                  <button
                    key={v}
                    type="button"
                    className={`scanner-chip ${same(f('hedgeLotPct'), v) ? 'on' : ''}`}
                    disabled={!hedgeOn}
                    onClick={() => updateConfig('hedgeLotPct', v)}
                  >
                    {v}%
                  </button>
                ))}
              </span>
            )}
            tone={err.hedgeLotPct ? 'bad' : ''}
          >
            <CustomInput id="hedgeLotPct" type="number" step="5" min="0" max="100" suffix="%" showStepper width={110} disabled={!hedgeOn} error={!!err.hedgeLotPct} value={f('hedgeLotPct')} onChange={setNum('hedgeLotPct')} />
          </Field>
          <Field {...common('hedgeMaxPrice')} label="Max Hedge Price" disabled={!hedgeOn} caption={err.hedgeMaxPrice} tone="bad">
            <CustomInput id="hedgeMaxPrice" type="number" step="1" min="0" prefix="$" showStepper width={110} disabled={!hedgeOn} error={!!err.hedgeMaxPrice} value={f('hedgeMaxPrice')} onChange={setNum('hedgeMaxPrice')} />
          </Field>
          <Field
            id="hedgeIvDiffMin"
            hintKey="hedgeIvDiff"
            label="Hedge IV Diff"
            changed={changed('hedgeIvDiffMin') || changed('hedgeIvDiffMax')}
            defaultText={`${SCANNER_DEFAULTS.hedgeIvDiffMin}–${SCANNER_DEFAULTS.hedgeIvDiffMax}%`}
            openHint={openHint}
            onToggleHint={toggleHint}
            onCloseHint={closeHint}
            disabled={!hedgeOn}
            className="scanner-range-field"
            caption={err.hedgeIvDiff}
            tone="bad"
          >
            {/* Slider for quick dragging + number boxes for exact values; both edit the
                same two fields. The slider spans 0–10%; a typed value above 10 still
                applies (the thumb just sits at the end). */}
            <div className="scanner-range-box">
              <div className="scanner-range-wrap">
                <RangeSlider
                  idLow="hedgeIvDiffMinRange" idHigh="hedgeIvDiffMaxRange"
                  min={0} max={10} step={0.25}
                  low={f('hedgeIvDiffMin')} high={f('hedgeIvDiffMax')}
                  disabled={!hedgeOn}
                  onChange={(lo, hi) => updateConfig({ hedgeIvDiffMin: lo, hedgeIvDiffMax: hi })}
                />
              </div>
              <div className="scanner-range-nums">
                <CustomInput
                  id="hedgeIvDiffMin" type="number" step="0.25" min="0" showStepper={false}
                  disabled={!hedgeOn} error={!!err.hedgeIvDiff} aria-label="Hedge IV diff minimum"
                  value={f('hedgeIvDiffMin')} onChange={setNum('hedgeIvDiffMin')}
                />
                <span>to</span>
                <CustomInput
                  id="hedgeIvDiffMax" type="number" step="0.25" min="0" showStepper={false}
                  disabled={!hedgeOn} error={!!err.hedgeIvDiff} aria-label="Hedge IV diff maximum"
                  value={f('hedgeIvDiffMax')} onChange={setNum('hedgeIvDiffMax')}
                />
                <span>%</span>
              </div>
            </div>
          </Field>
      </Cluster>
    </>
  );
}

/**
 * One-line summary of the active filters, shown on phones while the panel is collapsed.
 * Tapping it opens the panel.
 */
export function ScannerFilterSummary({ config, onOpen }) {
  const c = { ...SCANNER_DEFAULTS, ...config };
  const net = Number(c.maxNetPremium);
  const preset = BUILTIN_PRESETS.find(p => matches(c, p.values))?.name;
  const parts = [
    `Width ≥$${c.minStrikeDiff}`,
    `Spot ≥$${c.minLongDist}`,
    `IV ≥${c.minIvDiff}%`,
    `Short ≥$${c.minSellPremium}`,
    net < 0 ? `Credit ≥$${Math.abs(net)}` : `Debit ≤$${net}`,
    `Ratio ≤1:${c.maxSellQty}`,
    (Number(c.minAtmPnl) || Number(c.minAtmRoi)) ? `ATM ≥$${c.minAtmPnl} · ${c.minAtmRoi}%` : null,
    c.atmRatioScaling ? `Scaling ${c.atmRatioPctCall}/${c.atmRatioPctPut}%` : null,
    c.hedgeEnabled ? `Hedge ${c.hedgeLotPct}% <$${c.hedgeMaxPrice} · IV ${c.hedgeIvDiffMin}–${c.hedgeIvDiffMax}` : null,
  ].filter(Boolean);
  return (
    <button type="button" className="scanner-filter-summary" onClick={onOpen} title="Show filters">
      {preset && <span className="scanner-summary-preset">{preset}</span>}
      {parts.map(p => <span key={p} className="scanner-summary-chip">{p}</span>)}
    </button>
  );
}
