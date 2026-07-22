import React, { useState } from 'react';
import { fmtExpiry } from '../../api';
import { ChevronDown } from 'lucide-react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import SchedulePanel from './SchedulePanel';

export default function ControlPanel({
  underlying,
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
  historyFilterDate,
  now,
  strategyVersion = 1,
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
                  className={`pt-seg-btn ${(draftConfig?.underlying ?? underlying) === u ? 'on' : ''}`}
                  onClick={() => updateDraftConfig('underlying', u)}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
            <label className="pt-field-label" style={{ marginBottom: 0 }}>Expiry</label>
            <CustomSelect
              value={draftConfig?.expiry ?? selExpiry}
              onChange={val => updateDraftConfig('expiry', val)}
              disabled={!filteredExpiries.length}
              options={!filteredExpiries.length ? [{ label: 'Loading...', value: draftConfig?.expiry ?? selExpiry }] : filteredExpiries.map(e => ({ label: fmtExpiry(e), value: e }))}
              style={{ width: '160px' }}
            />
          </div>

          {/* Trading Days — day-of-week ENTRY gate (promoted: paper AND live, all versions).
              A disabled day blocks NEW entries for that trading day (17:30 IST boundary);
              open positions are still managed. Default [0..6] = all days. Immediate-apply. */}
          {(
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
              <label className="pt-field-label" style={{ marginBottom: 0 }}>
                Trading Days <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(entries only)</span>
              </label>
              <div className="pt-seg" role="group" aria-label="Trading Days" style={{ flexWrap: 'wrap' }}>
                {[
                  { label: 'Mon', v: 1 }, { label: 'Tue', v: 2 }, { label: 'Wed', v: 3 },
                  { label: 'Thu', v: 4 }, { label: 'Fri', v: 5 }, { label: 'Sat', v: 6 }, { label: 'Sun', v: 0 },
                ].map(({ label, v }) => {
                  const days = Array.isArray(draftConfig?.tradeDays) ? draftConfig.tradeDays : [0, 1, 2, 3, 4, 5, 6];
                  const on = days.includes(v);
                  return (
                    <button
                      key={v}
                      type="button"
                      className={`pt-seg-btn ${on ? 'on' : ''}`}
                      title={on ? `${label}: trading enabled` : `${label}: no new entries`}
                      onClick={() => {
                        const set = new Set(days);
                        if (set.has(v)) set.delete(v); else set.add(v);
                        updateDraftConfig('tradeDays', [...set].sort((a, b) => a - b));
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <button
            className="pt-filters-toggle-btn"
            onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
          >
            <span>{isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}</span>
            <ChevronDown
              size={12}
              strokeWidth={2.5}
              style={{
                transition: 'transform 0.25s ease',
                transform: isFiltersCollapsed ? 'rotate(0deg)' : 'rotate(180deg)'
              }}
            />
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
                // Min Days to Expiry now lives per schedule window for ALL accounts (paper
                // AND live) — migration 019 — so it no longer appears in the Control Panel.
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

          {/* Full Deployment — PAPER ONLY. Once per IST day at the set time, concentrate
              the whole remaining allocated pool across the spreads openable then instead
              of reserving budget per free slot ("go all out / use all margin"). Live
              accounts size on the real wallet balance, so this is hidden for them. */}
          {!accountIsLive && (
            <div className="pt-filter-cluster">
              <span className="pt-cluster-head">Full Deployment</span>
              <div className="pt-cluster-fields">
                <div key="fullDeployEnabled" className="form-group">
                  <label htmlFor="fullDeployEnabled" className="pt-field-label" style={{ marginBottom: 0, cursor: 'pointer' }}>
                    Deploy All Margin
                  </label>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch">
                      <input type="checkbox" id="fullDeployEnabled" checked={draftConfig?.fullDeployEnabled ?? false}
                        onChange={e => updateDraftConfig('fullDeployEnabled', e.target.checked)} />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>
                {draftConfig?.fullDeployEnabled && (
                  <div key="fullDeployTime" className="form-group">
                    <label className="pt-field-label" style={{ marginBottom: 0 }}>Deploy Time (IST)</label>
                    <CustomInput type="time" width={110} value={draftConfig?.fullDeployTime ?? '04:30'}
                      onChange={e => updateDraftConfig('fullDeployTime', e.target.value)} />
                  </div>
                )}
              </div>
            </div>
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
          historyFilterDate={historyFilterDate}
          now={now}
          currentUnderlying={underlying}
          strategyVersion={strategyVersion}
          isPaper={!accountIsLive}
        />
      </div>
    </>
  );
}
