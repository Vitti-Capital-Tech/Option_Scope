"use client";
import React, { useState, useEffect, useRef } from 'react';

export default function CustomSelect({
  options,
  value,
  onChange,
  disabled = false,
  className = '',
  style = {},
  variant = 'default' // 'default' or 'inline'
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const selectedOption = options.find(opt => opt.value === value || (opt.value != null && value != null && String(opt.value) === String(value))) || options[0];

  return (
    <div className={`custom-dropdown-container ${className} ${disabled ? 'disabled' : ''} variant-${variant}`} style={style} ref={dropdownRef}>
      <button
        type="button"
        className={`custom-dropdown-trigger ${variant === 'inline' ? 'inline-trigger' : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <div className="custom-dropdown-trigger-content">
          <span className="custom-dropdown-name">{selectedOption?.label || 'Select...'}</span>
        </div>
        <svg
          className="custom-chevron-icon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease'
          }}
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>

      {isOpen && !disabled && (
        <div className="custom-dropdown-menu">
          <div className="custom-dropdown-list">
            {options.map(opt => {
              const isSelected = opt.value === value || (opt.value != null && value != null && String(opt.value) === String(value));
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                >
                  <div className="custom-dropdown-item-left">
                    <span>{opt.label}</span>
                  </div>
                  {isSelected && (
                    <svg className="custom-selected-checkmark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
