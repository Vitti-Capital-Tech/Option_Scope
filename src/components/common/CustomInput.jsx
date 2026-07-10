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
  ...props
}, ref) => {
  const hasAdornment = prefix != null || suffix != null;

  // Select the field's contents on focus so typing REPLACES the value instead of
  // appending after it (otherwise a field showing "0" turns into "05" when typed).
  const handleFocus = (e) => {
    try { e.target.select(); } catch { /* not selectable */ }
    if (onFocus) onFocus(e);
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
        step={type === 'number' ? step : undefined}
        min={min}
        value={value}
        onChange={onChange}
        onFocus={handleFocus}
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
        step={type === 'number' ? step : undefined}
        min={min}
        value={value}
        onChange={onChange}
        onFocus={handleFocus}
        {...props}
      />
      {suffix != null && <span className="uin-suf">{suffix}</span>}
    </div>
  );
});

CustomInput.displayName = 'CustomInput';

export default CustomInput;
