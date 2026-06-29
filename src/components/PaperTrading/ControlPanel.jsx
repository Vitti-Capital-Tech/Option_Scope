import React from 'react';
import { fmtExpiry } from '../../api';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import SchedulePanel from './SchedulePanel';

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
  handleCancelFilters,
  isDefaultConfig,
  handleResetFilters,
  spotPrice,
  schedules,
  setSchedules,
  onSaveSchedules,
  isSavingSchedules,
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
            <CustomSelect
              value={underlying}
              onChange={val => updateConfig('underlying', val)}
              options={UNDERLYINGS.map(u => ({ label: u, value: u }))}
              style={{ width: '100px' }}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ marginBottom: 0 }}>Expiry:</label>
            <CustomSelect
              value={selExpiry}
              onChange={val => updateConfig('expiry', val)}
              disabled={!filteredExpiries.length}
              options={!filteredExpiries.length ? [{ label: 'Loading...', value: selExpiry }] : filteredExpiries.map(e => ({ label: fmtExpiry(e), value: e }))}
              style={{ width: '160px' }}
            />
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
            <span>{isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transition: 'transform 0.25s ease',
                transform: isFiltersCollapsed ? 'rotate(0deg)' : 'rotate(180deg)'
              }}
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>

        <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

        <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
          <span className="pt-control-label">Filters</span>
          {[
            { label: 'Min Spread Width', key: 'minStrikeDiff', width: 110, step: '50', prefix: '$' },
            { label: 'Min IV Edge', key: 'minIvDiff', width: 100, step: '0.25', suffix: '%' },
            { label: 'Max Delta Deviation', key: 'maxRatioDeviation', width: 110, step: '0.01' },
            { label: 'Min Short Premium', key: 'minSellPremium', width: 110, prefix: '$' },
            { label: 'Max Net Debit', key: 'maxNetPremium', width: 110, prefix: '$' },
            { label: 'Min Spot Distance', key: 'minLongDist', width: 110, step: '50', prefix: '$' },
            { label: 'Max Short Ratio', key: 'maxSellQty', width: 110, step: '0.25', prefix: '1:' },
            { label: 'Min Days to Expiry', key: 'daysToExpiry', width: 100 },
            { label: 'Max Open Calls', key: 'numberOfCalls', width: 100 },
            { label: 'Max Open Puts', key: 'numberOfPuts', width: 100 },
            { label: 'Re-entry Spot Step', key: 'spotDiff', width: 100, step: '0.1', suffix: '%' }
          ].map(({ label, key, width, step, prefix, suffix }) => (
            <div key={key} className="form-group">
              <label style={{ marginBottom: 0 }}>{label}</label>
              <CustomInput type="number" step={step} prefix={prefix} suffix={suffix} showStepper
                width={width} value={draftConfig?.[key] ?? ''}
                onChange={e => updateDraftConfig(key, Number(e.target.value))} />
            </div>
          ))}
          <div key="exitType" className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <label style={{ marginBottom: 0 }}>Exit Type:</label>
            <CustomSelect
              value={draftConfig?.exitType ?? 'ATM'}
              onChange={val => updateDraftConfig('exitType', val)}
              options={[
                { label: 'ATM', value: 'ATM' },
                { label: 'ITM', value: 'ITM' },
                { label: 'OTM', value: 'OTM' }
              ]}
              style={{ width: '85px' }}
            />
          </div>
          {(draftConfig?.exitType === 'ITM' || draftConfig?.exitType === 'OTM') && (
            <div key="exitPoints" className="form-group">
              <label style={{ marginBottom: 0 }}>Exit Points</label>
              <CustomInput type="number" step="1" showStepper width={100} value={draftConfig.exitPoints ?? 0}
                onChange={e => updateDraftConfig('exitPoints', Number(e.target.value))} />
            </div>
          )}
          <div key="atmRatioScaling" className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" id="atmRatioScaling" checked={draftConfig?.atmRatioScaling ?? false}
              onChange={e => updateDraftConfig('atmRatioScaling', e.target.checked)} />
            <label htmlFor="atmRatioScaling" style={{ marginBottom: 0, cursor: 'pointer' }}>Dynamic ATM Scaling</label>
          </div>
          {draftConfig?.atmRatioScaling && (
            <>
              <div key="atmRatioPctCall" className="form-group">
                <label style={{ marginBottom: 0 }}>Call Scaling</label>
                <CustomInput type="number" step="1" suffix="%" showStepper width={100} value={draftConfig.atmRatioPctCall ?? 50}
                  onChange={e => updateDraftConfig('atmRatioPctCall', Number(e.target.value))} />
              </div>
              <div key="atmRatioPctPut" className="form-group">
                <label style={{ marginBottom: 0 }}>Put Scaling</label>
                <CustomInput type="number" step="1" suffix="%" showStepper width={100} value={draftConfig.atmRatioPctPut ?? 25}
                  onChange={e => updateDraftConfig('atmRatioPctPut', Number(e.target.value))} />
              </div>
            </>
          )}

          {/* Apply, Cancel & Reset Buttons */}
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
              className="pt-btn-filter pt-btn-cancel"
              onClick={handleCancelFilters}
              disabled={!isFiltersDirty}
            >
              Cancel
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
      <div className='flex justify-between mt-3! px-10! mb-3!'>
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

      {/* ── Time-based Schedules ─────────────────────────────── */}
      <div className="pt-schedules-panel">
        <SchedulePanel
          schedules={schedules}
          setSchedules={setSchedules}
          onSave={onSaveSchedules}
          isSaving={isSavingSchedules}
        />
      </div>
    </>
  );
}
