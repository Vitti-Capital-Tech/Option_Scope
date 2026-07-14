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
  const [menuCoords, setMenuCoords] = useState({ top: 0, left: 0, width: 0 });

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

  useEffect(() => {
    if (!isOpen) return;

    function updatePosition() {
      if (dropdownRef.current) {
        const rect = dropdownRef.current.getBoundingClientRect();
        setMenuCoords({
          top: rect.bottom,
          left: rect.left,
          width: rect.width
        });
      }
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

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
        <div 
          className="custom-dropdown-menu"
          style={{
            position: 'fixed',
            top: `${menuCoords.top + 6}px`,
            left: `${menuCoords.left}px`,
            width: `${menuCoords.width}px`,
            zIndex: 10000,
            visibility: menuCoords.width > 0 ? 'visible' : 'hidden'
          }}
        >
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
