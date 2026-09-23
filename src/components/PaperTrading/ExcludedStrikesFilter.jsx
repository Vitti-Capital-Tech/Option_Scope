import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Check, X } from 'lucide-react';

// Sorted, de-duplicated, finite numbers — the one shape excludedStrikes is ever stored in,
// so the dirty check (element-wise compare) and the engine's Set both see a stable list.
const normalize = (arr) => [...new Set(arr.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);

/**
 * Excluded Strikes (migration 040) — paper only. Two ways to build ONE list:
 *   • pick from the current expiry's chain (multi-select dropdown), or
 *   • type strikes manually (comma/space separated), e.g. for a strike not listed yet.
 * The engine drops these strikes from the entry pool for calls AND puts.
 */
export default function ExcludedStrikesFilter({ value, onChange, chainStrikes = [], spotPrice }) {
  const selected = useMemo(() => normalize(Array.isArray(value) ? value : []), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const chainSet = useMemo(() => new Set(chainStrikes), [chainStrikes]);

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState('');
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
    const next = selectedSet.has(strike) ? selected.filter(s => s !== strike) : [...selected, strike];
    onChange(normalize(next));
  };

  const removeStrike = (strike) => onChange(selected.filter(s => s !== strike));

  const addManual = () => {
    const tokens = manual.split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return;
    const bad = tokens.filter(t => !(Number.isFinite(Number(t)) && Number(t) > 0));
    if (bad.length) {
      setManualError(`Not a valid strike: ${bad.join(', ')}`);
      return;
    }
    onChange(normalize([...selected, ...tokens.map(Number)]));
    setManual('');
    setManualError('');
  };

  const triggerLabel = selected.length === 0
    ? 'None excluded'
    : `${selected.length} strike${selected.length === 1 ? '' : 's'} excluded`;

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

        <div className="form-group">
          <label className="pt-field-label" style={{ marginBottom: 0 }}>Enter Manually</label>
          <div className="pt-excl-manual">
            <input
              type="text"
              inputMode="decimal"
              className={`custom-input-field ${manualError ? 'error' : ''}`}
              style={{ width: 180 }}
              placeholder="e.g. 78000, 78500"
              value={manual}
              onChange={e => { setManual(e.target.value); if (manualError) setManualError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
            />
            <button type="button" className="pt-excl-add-btn" onClick={addManual} disabled={!manual.trim()}>
              Add
            </button>
          </div>
        </div>
      </div>

      {manualError && <div className="pt-excl-error">{manualError}</div>}

      {selected.length > 0 && (
        <div className="pt-excl-chips">
          {selected.map(strike => {
            const offChain = chainStrikes.length > 0 && !chainSet.has(strike);
            return (
              <span
                key={strike}
                className={`pt-excl-chip ${offChain ? 'off-chain' : ''}`}
                title={offChain ? 'Not listed on the current expiry' : undefined}
              >
                {strike.toLocaleString()}
                <button type="button" aria-label={`Remove ${strike}`} onClick={() => removeStrike(strike)}>
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
