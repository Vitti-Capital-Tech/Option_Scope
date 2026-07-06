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
  onSaveSchedules,
  isSavingSchedules,
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
          {spotPrice && (
            <div className="pt-spot-display pt-spot-inline">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
              {spotChangePct != null && (
                <span className={`pt-spot-chg ${spotChangePct >= 0 ? 'up' : 'down'}`}>
                  {spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%
                </span>
              )}
            </div>
          )}
          {activeAccountId && (
            <div className="pt-account-chip">
              <svg className="pt-account-avatar" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span className="pt-account-name">{activeAccount?.name ?? ''}</span>
              {accountIsLive && (
                <span className={`pt-live-tag ${accountArmed ? 'armed' : ''}`}
                  title={accountArmed ? 'Live — real orders armed' : 'Live — credentials linked, orders disarmed'}>
                  {accountArmed ? 'LIVE ●' : 'LIVE'}
                </span>
              )}
              <button
                onClick={triggerEditAccount}
                className="pt-account-edit"
                title="Edit Account Details"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            </div>
          )}
          <div className="pt-status-badge live pt-algo-inline">
            <span className="pt-pulse"></span>
            LIVE ALGO
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

        <div className="hide-mobile pt-control-divider"></div>

        <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
          <div className="pt-filter-cluster">
            <span className="pt-cluster-head">Entry Filters</span>
            <div className="pt-cluster-fields">
              {[
                { label: 'Min IV Edge', key: 'minIvDiff', width: 100, step: '0.25', suffix: '%' },
                { label: 'Max Delta Deviation', key: 'maxRatioDeviation', width: 110, step: '0.01' },
                { label: 'Min Short Premium', key: 'minSellPremium', width: 110, prefix: '$' },
                { label: 'Max Net Debit', key: 'maxNetPremium', width: 110, prefix: '$' },
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
              <div key="exitType" className="form-group">
                <label className="pt-field-label" style={{ marginBottom: 0 }}>Exit Type</label>
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
                  <label className="pt-field-label" style={{ marginBottom: 0 }}>Exit Points</label>
                  <CustomInput type="number" step="1" showStepper width={100} value={draftConfig.exitPoints ?? 0}
                    onChange={e => updateDraftConfig('exitPoints', e.target.value)} />
                </div>
              )}
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
          onSave={onSaveSchedules}
          isSaving={isSavingSchedules}
          positions={positions}
          tradeHistory={tradeHistory}
          currentUnderlying={underlying}
        />
      </div>
    </>
  );
}
