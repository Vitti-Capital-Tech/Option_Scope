import React, { useState } from 'react';
import { fmtExpiry } from '../../api';
import { ChevronDown } from 'lucide-react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import SchedulePanel from './SchedulePanel';
import ExcludedStrikesFilter from './ExcludedStrikesFilter';
import { defaultOiCapM } from '../../scannerUtils';

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
  chainStrikes = [],
  schedules,
  setSchedules,
  isSavingSchedules,
  isSchedulesDirty,
  onApplySchedules,
  onCancelSchedules,
  onResetSchedules,
  copySources = [],
  onImportSchedules,
  scheduleFocus,
  positions,
  tradeHistory,
  historyFilterDate,
  now,
  strategyVersion = 1,
  balanceAllocationPct,
  initialBalance,
  walletBalance,
  totalRealizedPnl,
  paperEquity,
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
                // Min IV Edge now lives per schedule window for ALL accounts (paper
                // AND live) — migration 037 — so it no longer appears in the Control Panel.
                { label: 'Max Delta Deviation', key: 'maxRatioDeviation', width: 110, step: '0.01' },
                { label: 'Min Short Premium', key: 'minSellPremium', width: 110, prefix: '$' },
                { label: 'Max Short Ratio', key: 'maxSellQty', width: 110, step: '0.25', prefix: '1:' },
                // Min Days to Expiry now lives per schedule window for ALL accounts (paper
                // AND live) — migration 019 — so it no longer appears in the Control Panel.
                //
                // ATM edge floors (migration 039) — PAPER ONLY, and global rather than
                // per-window. Same pair the Ratio Spread scanner exposes. A dollar-only floor
                // is calibrated to whatever scale the candidate is measured on, and that
                // differs by underlying: the $195k short-notional cap that scales a BTC
                // candidate down to a ~$1,000-margin unit can never bind at ETH's notional,
                // so ETH candidates stay on their raw 1-unit basis and a 35%-ROI spread can
                // read as $9.50. The ROI floor is the one that travels across underlyings.
                ...(accountIsLive ? [] : [
                  { label: 'Min ATM P&L', key: 'minAtmPnl', width: 110, step: '10', prefix: '$' },
                  { label: 'Min ATM ROI', key: 'minAtmRoi', width: 110, step: '1', suffix: '%' },
                ]),
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

          {/* Excluded Strikes (migration 040) — paper AND live, global (not per window).
              Strike prices the engine never enters a leg on, for calls and puts alike. Pick
              them from the current expiry's chain or type them in; both build the same list.
              Goes through Apply/Cancel like the other filters. Open positions are unaffected. */}
          <div className="pt-filter-cluster">
            <span className="pt-cluster-head">
              Excluded Strikes <span style={{ color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.04em' }}>(calls &amp; puts, new entries only)</span>
            </span>
            <ExcludedStrikesFilter
              value={draftConfig?.excludedStrikes ?? []}
              onChange={list => updateDraftConfig('excludedStrikes', list)}
              chainStrikes={chainStrikes}
              spotPrice={spotPrice}
            />
          </div>

          {/* Exit Rules (Short Exit Price, Variable Exit Slices, Long Exit Slices) moved to
              per-schedule-window controls (migration 033) — edit them in the Schedule Panel,
              per window. The account-level values remain only as the schedule-gap fallback. */}

          {/* Full Deployment — paper AND live (migration 030, promoted to live). Once per IST
              day at the set time, concentrate the whole remaining allocated pool across the
              spreads openable then instead of reserving budget per free slot ("go all out /
              use all margin"). Live concentrates the real wallet allocation; paper its equity. */}
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

          {/* Closer-to-ATM replacement (migration 059) — PAPER ONLY. When slots / margin are
              full, a better spread nearer ATM replaces a farther open pair (call or put) whose
              cashflow is positive and below the account's total unrealized P&L. */}
          {!accountIsLive && (
            <div className="pt-filter-cluster">
              <span className="pt-cluster-head">Replace Closer to ATM</span>
              <div className="pt-cluster-fields">
                <div key="replaceCloserAtm" className="form-group">
                  <label htmlFor="replaceCloserAtm" className="pt-field-label" style={{ marginBottom: 0, cursor: 'pointer' }}
                    title="When slots or margin are full and a spread closer to ATM is available, exit an open pair (call or put) whose long is farther from spot and enter the closer one — only if that pair's cashflow (short premium − long − hedge premium) is positive and the account's total unrealized P&L is positive and larger than it. Paper accounts only.">
                    Replace Farther Pair
                  </label>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch">
                      <input type="checkbox" id="replaceCloserAtm" checked={draftConfig?.replaceCloserAtm ?? false}
                        onChange={e => updateDraftConfig('replaceCloserAtm', e.target.checked)} />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Account max SL (migration 066) — PAPER ONLY. When the account's total unrealized
              P&L reaches −(balance × Max SL %), the engine closes every open position. */}
          {!accountIsLive && (
            <div className="pt-filter-cluster">
              <span className="pt-cluster-head">Account Stop Loss</span>
              <div className="pt-cluster-fields">
                <div key="maxSlPct" className="form-group">
                  <label className="pt-field-label" style={{ marginBottom: 0 }}
                    title="Close ALL positions of this account once its total unrealized P&L reaches −(balance × this %). E.g. balance $2,000 at 20% → close all at −$400 unrealized. 0 = off. Paper accounts only.">
                    Max SL
                  </label>
                  <CustomInput type="number" step="1" min="0" max="100" suffix="%" showStepper width={90}
                    value={draftConfig?.maxSlPct ?? 20}
                    onChange={e => updateDraftConfig('maxSlPct', e.target.value)} />
                </div>
                {paperEquity != null && Number(draftConfig?.maxSlPct) > 0 && (
                  <div className="form-group">
                    <label className="pt-field-label" style={{ marginBottom: 0 }}>Closes At</label>
                    <div style={{ height: 34, display: 'flex', alignItems: 'center', fontWeight: 600, color: 'var(--text-dim)' }}>
                      −${(Number(paperEquity) * Number(draftConfig.maxSlPct) / 100).toFixed(2)} unrl.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Partial scale-down (migration 063) — paper AND live (promoted to live 2026-10-23).
              The ATM-ratio scale-down sells part of a full spread's long as the live ATM ratio
              rises; defaults ON / 10% / 10% / 50%. */}
            <div className="pt-filter-cluster">
              <span className="pt-cluster-head">Partial Scale-Down</span>
              <div className="pt-cluster-fields">
                <div key="partialScaleEnabled" className="form-group">
                  <label htmlFor="partialScaleEnabled" className="pt-field-label" style={{ marginBottom: 0, cursor: 'pointer' }}
                    title="When the live ATM ratio rises and the spread's gross P&L clears the step, sell part of the long (full spreads only). Off: no partial scale-down. Defaults: on, 10% / 10% / max 50%.">
                    Scale Down
                  </label>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch">
                      <input type="checkbox" id="partialScaleEnabled" checked={draftConfig?.partialScaleEnabled ?? true}
                        onChange={e => updateDraftConfig('partialScaleEnabled', e.target.checked)} />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>
                {(draftConfig?.partialScaleEnabled ?? true) && (
                  <>
                    <div key="partialScaleLotPct" className="form-group">
                      <label className="pt-field-label" style={{ marginBottom: 0 }} title="Each scale-down step sells this % of the initial long.">Lot Step</label>
                      <CustomInput type="number" step="1" min="1" max="100" suffix="%" showStepper width={90}
                        value={draftConfig?.partialScaleLotPct ?? 10}
                        onChange={e => updateDraftConfig('partialScaleLotPct', e.target.value)} />
                    </div>
                    <div key="partialScaleThresholdPct" className="form-group">
                      <label className="pt-field-label" style={{ marginBottom: 0 }} title="The next step needs the spread's gross P&L to rise by this % of the checkpoint ATM P&L.">P&amp;L Step</label>
                      <CustomInput type="number" step="1" min="0" suffix="%" showStepper width={90}
                        value={draftConfig?.partialScaleThresholdPct ?? 10}
                        onChange={e => updateDraftConfig('partialScaleThresholdPct', e.target.value)} />
                    </div>
                    <div key="partialScaleMaxPct" className="form-group">
                      <label className="pt-field-label" style={{ marginBottom: 0 }} title="Never scale the long down by more than this % of the initial long (50 = keep at least half).">Max of Long</label>
                      <CustomInput type="number" step="5" min="1" max="99" suffix="%" showStepper width={90}
                        value={draftConfig?.partialScaleMaxPct ?? 50}
                        onChange={e => updateDraftConfig('partialScaleMaxPct', e.target.value)} />
                    </div>
                  </>
                )}
              </div>
            </div>

          {/* Delta OI limit (migration 062) — paper AND live. Delta makes a strike reduce-only
              once its market-wide open interest reaches the cap; with this on, the engine skips
              strikes that are locked or at/over the cap (long, short and hedge). */}
          {(
            <div className="pt-filter-cluster">
              <span className="pt-cluster-head">Open Interest</span>
              <div className="pt-cluster-fields">
                <div key="oiFilterEnabled" className="form-group">
                  <label htmlFor="oiFilterEnabled" className="pt-field-label" style={{ marginBottom: 0, cursor: 'pointer' }}
                    title="Delta's contract-level OI limit: once a strike's total open interest reaches the cap, Delta allows only reduce-only orders there. On: no new leg (long, short or hedge) on a strike that Delta has locked (or, in Manual mode, whose OI (USD) is at/over Max OI). New entries only.">
                    OI Limit
                  </label>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch">
                      <input type="checkbox" id="oiFilterEnabled" checked={draftConfig?.oiFilterEnabled ?? false}
                        onChange={e => updateDraftConfig('oiFilterEnabled', e.target.checked)} />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>
                {draftConfig?.oiFilterEnabled && (
                  <div key="oiFilterMode" className="form-group">
                    <label className="pt-field-label" style={{ marginBottom: 0 }}
                      title="Delta Lock: skip only the strikes Delta has locked (reduce-only). Manual: also skip strikes whose OI (USD) is at/over the Max OI you set.">
                      Block By
                    </label>
                    <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                      <div className="pt-seg" role="group" aria-label="OI filter mode">
                        {[['lock', 'Delta Lock'], ['cap', 'Manual']].map(([m, label]) => (
                          <button key={m} type="button"
                            className={`pt-seg-btn ${(draftConfig?.oiFilterMode ?? 'lock') === m ? 'on' : ''}`}
                            onClick={() => updateDraftConfig('oiFilterMode', m)}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {draftConfig?.oiFilterEnabled && draftConfig?.oiFilterMode === 'cap' && (
                  <div key="oiMaxCapM" className="form-group">
                    <label className="pt-field-label" style={{ marginBottom: 0 }}
                      title={`Max open interest per strike, in millions of USD. Default for ${underlying || 'BTC'}: $${defaultOiCapM(underlying)}M (Delta's cap).`}>
                      Max OI
                    </label>
                    <CustomInput type="number" step="1" min="1" prefix="$" suffix="M" showStepper width={100}
                      value={draftConfig?.oiMaxCapM ?? defaultOiCapM(underlying)}
                      onChange={e => {
                        const n = Number(e.target.value);
                        updateDraftConfig('oiMaxCapM', e.target.value === '' || !(n > 0) ? null : n);
                      }} />
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Apply, Cancel & Reset — outside the collapsible filters so they stay visible on
            mobile even when the filters are hidden (an edit made before collapsing can still
            be applied or cancelled). */}
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
      {/* ── Time-based Schedules ─────────────────────────────── */}
      <div className="pt-schedules-panel">
        <SchedulePanel
          schedules={schedules}
          setSchedules={setSchedules}
          onApply={onApplySchedules}
          onCancel={onCancelSchedules}
          onReset={onResetSchedules}
          copySources={copySources}
          onImportSchedules={onImportSchedules}
          focus={scheduleFocus}
          isDirty={isSchedulesDirty}
          isSaving={isSavingSchedules}
          positions={positions}
          tradeHistory={tradeHistory}
          historyFilterDate={historyFilterDate}
          now={now}
          currentUnderlying={underlying}
          strategyVersion={strategyVersion}
          isPaper={!accountIsLive}
          balanceAllocationPct={balanceAllocationPct}
          initialBalance={initialBalance}
          walletBalance={walletBalance}
          totalRealizedPnl={totalRealizedPnl}
          paperEquity={paperEquity}
        />
      </div>
    </>
  );
}
