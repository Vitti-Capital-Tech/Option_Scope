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

  // Uncontrolled ONLY for the react-hook-form `{...register(...)}` case: RHF passes NO
  // `value` and DOES forward a `ref` (routed to `ref` here), driving the input through that
  // ref. Forcing `value=""` there (the earlier bug) blanked the field on mount and wiped it
  // on blur, because RHF never feeds `value` back. Everything else stays CONTROLLED — a
  // `value={…}`/`onChange` caller (no ref) that happens to pass `undefined` keeps its old
  // empty-string behaviour, so no existing usage regresses. The number "draft" UX
  // (empty-while-typing, default-on-blur) applies to the controlled path only.
  const isControlled = value !== undefined || ref == null;

  // Keep our own ref so the steppers can read the current value in uncontrolled mode,
  // while still forwarding the node to the caller's ref (e.g. RHF's register ref). The
  // forwarded ref is read through a ref cell so `setRefs` stays stable (empty deps) — a
  // changing callback-ref identity would make React detach/reattach it every render.
  const innerRef = React.useRef(null);
  const forwardedRef = React.useRef(ref);
  forwardedRef.current = ref;
  const setRefs = React.useCallback((node) => {
    innerRef.current = node;
    const r = forwardedRef.current;
    if (typeof r === 'function') r(node);
    else if (r) r.current = node;
  }, []);

  // Number fields keep an editable "draft" string while focused so the user can
  // clear the field (backspace to empty) and type a fresh value, instead of it
  // snapping to 0 on every keystroke. The default (min, else 0) is applied on
  // blur / Enter when the field is left empty. Controlled mode only.
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const isPartial = (v) => v === '' || v === '-' || v === '.' || v === '-.';

  const displayValue = isNumber
    ? (focused ? draft : (value == null ? '' : value))
    : value;

  const handleFocus = (e) => {
    if (isNumber && isControlled) { setFocused(true); setDraft(value == null ? '' : String(value)); }
    try { e.target.select(); } catch { /* not selectable */ }
    if (onFocus) onFocus(e);
  };

  const handleChange = (e) => {
    // Uncontrolled (register): the DOM/ref owns the value and RHF reads it — pass the
    // native event straight through, no local draft handling.
    if (!isControlled) { if (onChange) onChange(e); return; }
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
    if (isNumber && isControlled) {
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

  // Stepper: bump the committed value by `step`, clamped to min/max. Reads the current
  // value from the `value` prop (controlled) or the DOM node (uncontrolled / register).
  const decimals = String(step).includes('.') ? (String(step).split('.')[1] || '').length : 0;
  const bump = (dir) => {
    if (disabled) return;
    const cur = isControlled ? value : (innerRef.current ? innerRef.current.value : '');
    const base = Number.isFinite(Number(cur)) ? Number(cur) : 0;
    let next = base + dir * (Number(step) || 1);
    if (min != null) next = Math.max(Number(min), next);
    if (max != null) next = Math.min(Number(max), next);
    const out = decimals ? Number(next.toFixed(decimals)) : next;
    if (isControlled) {
      setDraft(String(out));
      if (onChange) onChange({ target: { value: String(out) } });
    } else if (innerRef.current) {
      // Write through the DOM node so RHF's ref sees the new value, then notify onChange.
      innerRef.current.value = String(out);
      if (onChange) onChange({ target: innerRef.current });
    }
  };

  // `value` is set ONLY in controlled mode; omitting it in uncontrolled mode keeps the
  // input ref-managed (RHF), which is what fixes the blank-on-open / wipe-on-blur bug.
  const valueProp = isControlled ? { value: displayValue } : {};

  // Plain input (no adornment) — text/date/time, or number with steppers disabled.
  if (!hasAdornment) {
    return (
      <input
        ref={setRefs}
        type={type}
        disabled={disabled}
        className={`custom-input-field ${error ? 'error' : ''} ${className}`}
        style={style}
        step={isNumber ? step : undefined}
        min={min}
        max={max}
        {...valueProp}
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
        ref={setRefs}
        type={type}
        disabled={disabled}
        className="uin-input"
        step={isNumber ? step : undefined}
        min={min}
        max={max}
        {...valueProp}
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
