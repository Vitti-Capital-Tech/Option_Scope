"use client";
import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

const CustomInput = React.forwardRef(({
  type = 'text',
  disabled = false,
  className = '',
  style = {},
  error = false,
  prefix,        // inline unit shown before the value, e.g. "$" or "1:"
  suffix,        // inline unit shown after the value, e.g. "%"
  showStepper = true, // steppers show on number inputs by default; pass false to hide
  step = 1,
  min,
  max,
  width,         // convenience: sets wrapper width when adorned
  value,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}, ref) => {
  const isNumber = type === 'number';
  const showStep = isNumber && showStepper !== false;
  const hasAdornment = prefix != null || suffix != null || showStep;

  // Number fields keep an editable "draft" string while focused so the user can
  // clear the field (backspace to empty) and type a fresh value, instead of it
  // snapping to 0 on every keystroke. The default (min, else 0) is applied on
  // blur / Enter when the field is left empty.
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const isPartial = (v) => v === '' || v === '-' || v === '.' || v === '-.';

  const displayValue = isNumber
    ? (focused ? draft : (value == null ? '' : value))
    : value;

  const handleFocus = (e) => {
    if (isNumber) { setFocused(true); setDraft(value == null ? '' : String(value)); }
    try { e.target.select(); } catch { /* not selectable */ }
    if (onFocus) onFocus(e);
  };

  const handleChange = (e) => {
    if (isNumber) {
      const raw = e.target.value;
      setDraft(raw);
      if (isPartial(raw)) return; // hold partial input locally; don't emit "" → 0
      if (onChange) onChange(e);
      return;
    }
    if (onChange) onChange(e);
  };

  const handleBlur = (e) => {
    if (isNumber) {
      setFocused(false);
      if (isPartial(draft)) {
        const fallback = min != null ? min : 0;
        if (onChange) onChange({ target: { value: String(fallback) } });
      }
    }
    if (onBlur) onBlur(e);
  };

  const handleKeyDown = (e) => {
    if (isNumber && e.key === 'Enter') e.target.blur();
    if (onKeyDown) onKeyDown(e);
  };

  // Stepper: bump the committed value by `step`, clamped to min/max.
  const decimals = String(step).includes('.') ? (String(step).split('.')[1] || '').length : 0;
  const bump = (dir) => {
    if (disabled) return;
    const base = Number.isFinite(Number(value)) ? Number(value) : 0;
    let next = base + dir * (Number(step) || 1);
    if (min != null) next = Math.max(Number(min), next);
    if (max != null) next = Math.min(Number(max), next);
    const out = decimals ? Number(next.toFixed(decimals)) : next;
    setDraft(String(out));
    if (onChange) onChange({ target: { value: String(out) } });
  };

  // Plain input (no adornment) — text/date/time, or number with steppers disabled.
  if (!hasAdornment) {
    return (
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        className={`custom-input-field ${error ? 'error' : ''} ${className}`}
        style={style}
        step={isNumber ? step : undefined}
        min={min}
        max={max}
        value={displayValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  }

  const wrapperStyle = width != null ? { width, ...style } : style;

  return (
    <div
      className={`uin ${error ? 'error' : ''} ${disabled ? 'disabled' : ''} ${className}`}
      style={wrapperStyle}
    >
      {prefix != null && <span className="uin-pre">{prefix}</span>}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        className="uin-input"
        step={isNumber ? step : undefined}
        min={min}
        max={max}
        value={displayValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        {...props}
      />
      {suffix != null && <span className="uin-suf">{suffix}</span>}
      {showStep && (
        <span className="uin-step">
          <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => bump(1)} disabled={disabled}>
            <ChevronUp size={9} strokeWidth={3} />
          </button>
          <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => bump(-1)} disabled={disabled}>
            <ChevronDown size={9} strokeWidth={3} />
          </button>
        </span>
      )}
    </div>
  );
});

CustomInput.displayName = 'CustomInput';

export default CustomInput;
