"use client";
import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Check } from 'lucide-react';

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
        <ChevronDown
          className="custom-chevron-icon"
          size={12}
          strokeWidth={2.5}
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease'
          }}
        />
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
                    <Check className="custom-selected-checkmark" size={14} strokeWidth={3} stroke="#3b82f6" />
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
