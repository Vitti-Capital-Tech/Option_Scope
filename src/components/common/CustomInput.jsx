"use client";
import React from 'react';

const CustomInput = React.forwardRef(({
  type = 'text',
  disabled = false,
  className = '',
  style = {},
  error = false,
  prefix,        // inline unit shown before the value, e.g. "$" or "1:"
  suffix,        // inline unit shown after the value, e.g. "%"
  showStepper = false, // deprecated — steppers removed; kept for call-site compatibility
  step = 1,
  min,
  width,         // convenience: sets wrapper width when adorned
  value,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}, ref) => {
  const hasAdornment = prefix != null || suffix != null;
  const isNumber = type === 'number';

  // Number fields keep an editable "draft" string while focused so the user can
  // clear the field (backspace to empty) and type a fresh value, instead of it
  // snapping to 0 on every keystroke. The default (min, else 0) is only applied on
  // blur / Enter when the field is left empty. Non-number fields are unaffected.
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
      // Hold partial/empty input locally — don't push it to the parent (which would
      // coerce "" → 0). Wait until it's a valid number.
      if (isPartial(raw)) return;
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
    if (isNumber && e.key === 'Enter') e.target.blur(); // commit + apply default if empty
    if (onKeyDown) onKeyDown(e);
  };

  // Backward-compatible plain input (unchanged from the original component)
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
        value={displayValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        {...props}
      />
      {suffix != null && <span className="uin-suf">{suffix}</span>}
    </div>
  );
});

CustomInput.displayName = 'CustomInput';

export default CustomInput;
