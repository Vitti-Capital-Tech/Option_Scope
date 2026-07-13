import React, { useState } from 'react';
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
  isSavingSchedules,
  isSchedulesDirty,
  onApplySchedules,
  onCancelSchedules,
  onResetSchedules,
  positions,
  tradeHistory,
}) {
  const UNDERLYINGS = ['BTC', 'ETH'];

  // Session % change: capture the first spot seen for each underlying (this page
  // session) and compare the live spot against it. Uses React's supported
  // "adjust state during render" pattern — the guard makes it run once per
  // underlying, so it can't loop. Resets naturally on remount.
  const [sessionOpen, setSessionOpen] = useState({});
  if (spotPrice != null && sessionOpen[underlying] == null) {
    setSessionOpen(prev => (prev[underlying] == null ? { ...prev, [underlying]: spotPrice } : prev));
  }
  const openSpot = sessionOpen[underlying];
  const spotChangePct = (openSpot && spotPrice) ? ((spotPrice - openSpot) / openSpot) * 100 : null;

  const activeAccount = accounts.find(a => a.id === activeAccountId);
  const accountIsLive = activeAccount?.mode === 'live';
  const accountArmed = !!activeAccount?.live_enabled;

  return (
    <>
      {/* ── Control Panel ───────────────────────────── */}
      <div className="pt-control-panel">
        <div className="pt-control-section">
          <span className="pt-control-label">Market</span>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
            <label className="pt-field-label" style={{ marginBottom: 0 }}>Underlying</label>
            <div className="pt-seg" role="group" aria-label="Underlying">
              {UNDERLYINGS.map(u => (
                <button
                  key={u}
                  type="button"
                  className={`pt-seg-btn ${underlying === u ? 'on' : ''}`}
                  onClick={() => updateConfig('underlying', u)}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
            <label className="pt-field-label" style={{ marginBottom: 0 }}>Expiry</label>
            <CustomSelect
              value={selExpiry}
              onChange={val => updateConfig('expiry', val)}
              disabled={!filteredExpiries.length}
              options={!filteredExpiries.length ? [{ label: 'Loading...', value: selExpiry }] : filteredExpiries.map(e => ({ label: fmtExpiry(e), value: e }))}
              style={{ width: '160px' }}
            />
          </div>
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

        <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
          <div className="pt-filter-cluster">
            <span className="pt-cluster-head">Entry Filters</span>
            <div className="pt-cluster-fields">
              {[
                { label: 'Min IV Edge', key: 'minIvDiff', width: 100, step: '0.25', suffix: '%' },
                { label: 'Max Delta Deviation', key: 'maxRatioDeviation', width: 110, step: '0.01' },
                { label: 'Min Short Premium', key: 'minSellPremium', width: 110, prefix: '$' },
                { label: 'Max Short Ratio', key: 'maxSellQty', width: 110, step: '0.25', prefix: '1:' },
                { label: 'Min Days to Expiry', key: 'daysToExpiry', width: 100 }
              ].map(({ label, key, width, step, prefix, suffix }) => (
                <div key={key} className="form-group">
                  <label className="pt-field-label" style={{ marginBottom: 0 }}>{label}</label>
                  <CustomInput type="number" step={step} prefix={prefix} suffix={suffix} showStepper
                    width={width} value={draftConfig?.[key] ?? ''}
                    onChange={e => updateDraftConfig(key, e.target.value)} />
                </div>
              ))}
            </div>
          </div>

          <div className="pt-filter-cluster">
            <span className="pt-cluster-head">Exit Rules</span>
            <div className="pt-cluster-fields">
              <div className="form-group">
                <label className="pt-field-label" style={{ marginBottom: 0 }}>Short Exit Price</label>
                <CustomInput type="number" step="0.1" prefix="$" showStepper width={100}
                  value={draftConfig?.shortExitPrice ?? ''}
                  onChange={e => updateDraftConfig('shortExitPrice', e.target.value)} />
              </div>
              {draftConfig?.variableExitSlices && (
                <div key="longExitSlices" className="form-group">
                  <label className="pt-field-label" style={{ marginBottom: 0 }}>Long Exit Slices</label>
                  <CustomInput type="number" step="1" showStepper width={100} value={draftConfig.longExitSlices ?? 10}
                    onChange={e => updateDraftConfig('longExitSlices', e.target.value)} />
                </div>
              )}
              <div key="variableExitSlices" className="form-group">
                <label htmlFor="variableExitSlices" className="pt-field-label" style={{ marginBottom: 0, cursor: 'pointer' }}>Variable Exit Slices</label>
                <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                  <label className="pt-switch">
                    <input type="checkbox" id="variableExitSlices" checked={draftConfig?.variableExitSlices ?? false}
                      onChange={e => updateDraftConfig('variableExitSlices', e.target.checked)} />
                    <span className="pt-slider"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>

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
      {/* ── Time-based Schedules ─────────────────────────────── */}
      <div className="pt-schedules-panel">
        <SchedulePanel
          schedules={schedules}
          setSchedules={setSchedules}
          onApply={onApplySchedules}
          onCancel={onCancelSchedules}
          onReset={onResetSchedules}
          isDirty={isSchedulesDirty}
          isSaving={isSavingSchedules}
          positions={positions}
          tradeHistory={tradeHistory}
          currentUnderlying={underlying}
        />
      </div>
    </>
  );
}
