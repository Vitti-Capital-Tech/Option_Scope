import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Check, X } from 'lucide-react';
import { fmtExpiry } from '../../api';
import { normalizeExcludedStrikes } from '../../scannerUtils';

/**
 * Excluded Strikes (migration 040) — paper AND live. Strikes are picked from the current
 * expiry's chain and each is stored with that expiry ({ strike, expiry }), so the engine
 * skips it on that expiry only and the entry drops off once the expiry settles. Entries
 * with no expiry (saved before this change) still apply to every expiry until removed.
 */
export default function ExcludedStrikesFilter({ value, onChange, chainStrikes = [], expiry, spotPrice }) {
  const entries = useMemo(() => normalizeExcludedStrikes(value), [value]);
  // Strikes excluded on the expiry whose chain the picker shows.
  const selectedSet = useMemo(
    () => new Set(entries.filter(e => e.expiry === expiry).map(e => e.strike)),
    [entries, expiry]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [menuCoords, setMenuCoords] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const menuRef = useRef(null);
  const listRef = useRef(null);
  const atmItemRef = useRef(null);

  const atmStrike = useMemo(() => {
    if (spotPrice == null || !chainStrikes.length) return null;
    return chainStrikes.reduce((best, s) => (Math.abs(s - spotPrice) < Math.abs(best - spotPrice) ? s : best), chainStrikes[0]);
  }, [chainStrikes, spotPrice]);

  const visibleStrikes = useMemo(() => {
    const q = search.trim();
    return q ? chainStrikes.filter(s => String(s).includes(q)) : chainStrikes;
  }, [chainStrikes, search]);

  // Close on outside click (the menu is position:fixed, so check it separately).
  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Same fixed-position menu as CustomSelect, so it isn't clipped by the collapsible panel.
  useEffect(() => {
    if (!isOpen) return;
    function updatePosition() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setMenuCoords({ top: rect.bottom, left: rect.left, width: Math.max(rect.width, 220) });
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

  // Open centred on the ATM strike — that's where the strikes worth excluding are.
  useEffect(() => {
    // Set scrollTop directly: scrollIntoView would also scroll the page behind the menu.
    const list = listRef.current, item = atmItemRef.current;
    if (isOpen && !search && list && item) {
      list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
    }
  }, [isOpen, search]);

  const toggleStrike = (strike) => {
    if (!expiry) return;
    const next = selectedSet.has(strike)
      ? entries.filter(e => !(e.expiry === expiry && e.strike === strike))
      : [...entries, { strike, expiry }];
    onChange(normalizeExcludedStrikes(next));
  };

  const removeEntry = (entry) => onChange(entries.filter(e => !(e.expiry === entry.expiry && e.strike === entry.strike)));

  const triggerLabel = selectedSet.size === 0
    ? 'None excluded'
    : `${selectedSet.size} strike${selectedSet.size === 1 ? '' : 's'} excluded`;

  return (
    <div className="pt-excl-strikes">
      <div className="pt-cluster-fields">
        <div className="form-group">
          <label className="pt-field-label" style={{ marginBottom: 0 }}>Pick From Chain</label>
          <div
            className={`custom-dropdown-container ${!chainStrikes.length ? 'disabled' : ''}`}
            style={{ width: 200 }}
            ref={containerRef}
          >
            <button
              type="button"
              className="custom-dropdown-trigger"
              onClick={() => chainStrikes.length && setIsOpen(o => !o)}
              disabled={!chainStrikes.length}
            >
              <div className="custom-dropdown-trigger-content">
                <span className="custom-dropdown-name">{chainStrikes.length ? triggerLabel : 'Loading chain...'}</span>
              </div>
              <ChevronDown
                className="custom-chevron-icon"
                size={12}
                strokeWidth={2.5}
                style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
              />
            </button>
          </div>
        </div>

      </div>

      {entries.length > 0 && (
        <div className="pt-excl-chips">
          {entries.map(entry => {
            // Excluded on another expiry (or, from before this change, on every expiry):
            // shown dimmed — it does not apply to the chain on screen.
            const otherExpiry = entry.expiry !== expiry;
            const label = entry.expiry ? fmtExpiry(entry.expiry) : 'all expiries';
            return (
              <span
                key={`${entry.expiry ?? ''}|${entry.strike}`}
                className={`pt-excl-chip ${otherExpiry ? 'off-chain' : ''}`}
                title={entry.expiry
                  ? `Excluded on the ${label} expiry only${otherExpiry ? ' — not the expiry shown' : ''}`
                  : 'Saved before strikes were tied to an expiry — applies to every expiry until removed'}
              >
                {entry.strike.toLocaleString()} <span className="pt-excl-chip-exp">· {label}</span>
                <button type="button" aria-label={`Remove ${entry.strike} (${label})`} onClick={() => removeEntry(entry)}>
                  <X size={11} strokeWidth={3} />
                </button>
              </span>
            );
          })}
          <button type="button" className="pt-excl-clear" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}

      {isOpen && chainStrikes.length > 0 && (
        <div
          ref={menuRef}
          className="custom-dropdown-menu pt-excl-menu"
          style={{
            position: 'fixed',
            top: `${menuCoords.top + 6}px`,
            left: `${menuCoords.left}px`,
            width: `${menuCoords.width}px`,
            zIndex: 10000,
            visibility: menuCoords.width > 0 ? 'visible' : 'hidden'
          }}
        >
          <div className="pt-excl-search">
            <input
              type="text"
              inputMode="decimal"
              className="custom-input-field"
              placeholder="Search strike..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="custom-dropdown-list" ref={listRef}>
            {visibleStrikes.length === 0 && <div className="pt-excl-empty">No matching strike</div>}
            {visibleStrikes.map(strike => {
              const isSel = selectedSet.has(strike);
              const isAtm = strike === atmStrike;
              return (
                <button
                  key={strike}
                  ref={isAtm ? atmItemRef : undefined}
                  type="button"
                  className={`custom-dropdown-item ${isSel ? 'selected' : ''}`}
                  onClick={() => toggleStrike(strike)}
                >
                  <div className="custom-dropdown-item-left">
                    <span className={`pt-excl-box ${isSel ? 'on' : ''}`}>
                      {isSel && <Check size={10} strokeWidth={3.5} />}
                    </span>
                    <span>{strike.toLocaleString()}</span>
                  </div>
                  {isAtm && <span className="pt-excl-atm">ATM</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
