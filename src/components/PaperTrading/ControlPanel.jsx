import React from 'react';
import { fmtExpiry } from '../../api';

export default function ControlPanel({
  underlying,
  updateConfig,
  selExpiry,
  filteredExpiries,
  activeAccountId,
  activeAccount,
  accounts,
  triggerEditAccount,
  isFiltersCollapsed,
  setIsFiltersCollapsed,
  draftConfig,
  updateDraftConfig,
  isFiltersDirty,
  handleApplyFilters,
  isDefaultConfig,
  handleResetFilters,
  spotPrice
}) {
  const UNDERLYINGS = ['BTC', 'ETH'];

  return (
    <>
      {/* ── Control Panel ───────────────────────────── */}
      <div className="pt-control-panel">
        <div className="pt-control-section">
          <span className="pt-control-label">Algo</span>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ marginBottom: 0 }}>Underlying:</label>
            <select value={underlying} onChange={e => updateConfig('underlying', e.target.value)}
              style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
              {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ marginBottom: 0 }}>Expiry:</label>
            <select value={selExpiry} onChange={e => updateConfig('expiry', e.target.value)}
              disabled={!filteredExpiries.length}
              style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
              {!filteredExpiries.length
                ? <option>Loading...</option>
                : filteredExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
            </select>
          </div>
          {activeAccountId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg)', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Active:</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  {accounts.find(a => a.id === activeAccountId)?.name ?? ''}
                </span>
              </div>
              <button
                onClick={triggerEditAccount}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  padding: '2px',
                  borderRadius: '4px',
                  marginLeft: '4px',
                  outline: 'none',
                  transition: 'color 0.2s'
                }}
                onMouseOver={e => e.currentTarget.style.color = 'var(--accent)'}
                onMouseOut={e => e.currentTarget.style.color = 'var(--text-dim)'}
                title="Edit Account Details"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            </div>
          )}
          <button
            className="pt-filters-toggle-btn"
            onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
          >
            {isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}
          </button>
        </div>

        <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

        <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
          <span className="pt-control-label">Filters</span>
          {[
            { label: 'Min Strike Diff ($):', key: 'minStrikeDiff', width: 60 },
            { label: 'Min IV Diff (%):', key: 'minIvDiff', width: 50 },
            { label: 'Max Ratio Dev:', key: 'maxRatioDeviation', width: 60, step: '0.01' },
            { label: 'Min Sell Prem ($):', key: 'minSellPremium', width: 60 },
            { label: 'Max Debit ($):', key: 'maxNetPremium', width: 60 },
            { label: 'Min Long Dist:', key: 'minLongDist', width: 60 },
            { label: 'Max Ratio (1:X):', key: 'maxSellQty', width: 65, step: '0.25' },
            { label: 'Days to Expiry:', key: 'daysToExpiry', width: 50 },
            { label: 'Max Calls (#):', key: 'numberOfCalls', width: 50 },
            { label: 'Max Puts (#):', key: 'numberOfPuts', width: 50 },
          ].map(({ label, key, width, step }) => (
            <div key={key} className="form-group">
              <label style={{ marginBottom: 0 }}>{label}</label>
              <input type="number" step={step} value={draftConfig?.[key] ?? ''}
                onChange={e => updateDraftConfig(key, Number(e.target.value))}
                style={{ width, padding: '4px 8px', fontSize: '13px' }} />
            </div>
          ))}
          <div key="atmRatioScaling" className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" id="atmRatioScaling" checked={draftConfig?.atmRatioScaling ?? false}
              onChange={e => updateDraftConfig('atmRatioScaling', e.target.checked)} />
            <label htmlFor="atmRatioScaling" style={{ marginBottom: 0, cursor: 'pointer' }}>ATM Ratio Entry</label>
          </div>
          {draftConfig?.atmRatioScaling && (
            <>
              <div key="atmRatioPctCall" className="form-group">
                <label style={{ marginBottom: 0 }}>Call ATM Pct (%):</label>
                <input type="number" step="1" value={draftConfig.atmRatioPctCall ?? 50}
                  onChange={e => updateDraftConfig('atmRatioPctCall', Number(e.target.value))}
                  style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
              </div>
              <div key="atmRatioPctPut" className="form-group">
                <label style={{ marginBottom: 0 }}>Put ATM Pct (%):</label>
                <input type="number" step="1" value={draftConfig.atmRatioPctPut ?? 50}
                  onChange={e => updateDraftConfig('atmRatioPctPut', Number(e.target.value))}
                  style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
              </div>
            </>
          )}
          
          {/* Apply & Reset Buttons */}
          <div className="pt-filter-actions">
            <button 
              type="button"
              className={`pt-btn-filter pt-btn-apply ${isFiltersDirty ? 'active' : ''}`}
              onClick={handleApplyFilters} 
              disabled={!isFiltersDirty}
            >
              Apply
            </button>
            <button 
              type="button"
              className="pt-btn-filter pt-btn-reset"
              onClick={handleResetFilters} 
              disabled={isDefaultConfig}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
      <div className='flex justify-between mt-3! px-10!'>
        {spotPrice && (
          <div className="pt-spot-display">
            <span className="pt-spot-label">SPOT</span>
            <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
          </div>
        )}

        <div className="pt-status-badge live ml-10">
          <span className="pt-pulse"></span>
          LIVE ALGO
        </div>
      </div>
    </>
  );
}
