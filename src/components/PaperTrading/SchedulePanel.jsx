import React, { useState, useCallback } from 'react';
import { Plus, AlertTriangle, Lock, X, Trash2 } from 'lucide-react';
import CustomInput from '../common/CustomInput';
import CustomSelect from '../common/CustomSelect';

const DEFAULT_WINDOW = {
  label: 'Window',
  startTime: '17:30',
  endTime: '17:29',
  numberOfCalls: 3,
  numberOfPuts: 3,
  minLongDist: 500,
  minStrikeDiff: 800,
  atmRatioScaling: true,
  atmRatioPctCall: 50,
  atmRatioPctPut: 25,
  maxNetPremium: 20,
  exitType: 'ATM',
  exitPoints: 0,
  daysToExpiry: 0,
  hedgeStrikeType: 'none',
  hedgeCallPrice: 0,
  hedgeCallPct: 0,
  hedgePutPrice: 0,
  hedgePutPct: 0,
  isActive: true,
};

// Convert 'HH:MM' to total minutes for timeline
function toMin(t = '00:00') {
  const parts = t.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h * 60 + m;
}

// Convert minutes to 'HH:MM'
function formatMin(m) {
  const h = Math.floor(m / 60) % 24;
  const mins = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

// Get unoccupied time slots across the 24h cycle starting from 05:30 PM IST (1050 minutes)
function getUnoccupiedSlots(schedules, excludeId = null) {
  const mins = new Array(1440).fill(false);
  schedules.forEach(s => {
    if (!s.isActive || s.id === excludeId) return;
    const start = toMin(s.startTime);
    const end = toMin(s.endTime);
    if (start > end) {
      // Overnight
      for (let m = start; m < 1440; m++) mins[m] = true;
      for (let m = 0; m < end; m++) mins[m] = true;
    } else {
      for (let m = start; m < end; m++) mins[m] = true;
    }
  });

  const slots = [];
  let inSlot = false;
  let start = 0;

  // Traverse 1440 minutes starting at 1050 (05:30 PM IST)
  for (let i = 0; i < 1440; i++) {
    const m = (1050 + i) % 1440;
    if (!mins[m] && !inSlot) {
      start = m;
      inSlot = true;
    } else if (mins[m] && inSlot) {
      slots.push({ start, end: m });
      inSlot = false;
    }
  }

  if (inSlot) {
    slots.push({ start, end: 1050 });
  }

  // Handle wrap merge: if slot at end (ends at 1050) and slot at start (starts at 1050) exist, merge them
  if (slots.length > 1 && slots[0].start === 1050 && slots[slots.length - 1].end === 1050) {
    const mergedSlot = {
      start: slots[slots.length - 1].start,
      end: slots[0].end
    };
    slots.splice(0, 1);
    slots.splice(slots.length - 1, 1, mergedSlot);
  }

  return slots;
}

// Gaps surfaced in the UI drop trivial ≤1-min leftovers — chiefly the 1-minute
// 17:29–17:30 slot the default full-day window (17:30→17:29) leaves. At runtime that
// minute is covered by the previous window's config (see getActiveSchedule), so showing
// it as "available" only confuses; a 1-min tradeable window is meaningless anyway.
function getDisplaySlots(schedules, excludeId = null) {
  return getUnoccupiedSlots(schedules, excludeId).filter(
    s => ((s.end - s.start + 1440) % 1440) > 1
  );
}

// Check if current window overlaps with any other active window
function checkOverlap(schedules, current) {
  if (!current.isActive) return null;
  const curStart = toMin(current.startTime);
  const curEnd = toMin(current.endTime);
  const curIsOvernight = curStart > curEnd;

  for (const s of schedules) {
    if (s.id === current.id || !s.isActive) continue;
    const start = toMin(s.startTime);
    const end = toMin(s.endTime);
    const isOvernight = start > end;

    const overlaps = (s1, e1, s2, e2) => Math.max(s1, s2) < Math.min(e1, e2);

    if (curIsOvernight && isOvernight) {
      return s;
    } else if (curIsOvernight) {
      if (overlaps(curStart, 1440, start, end) || overlaps(0, curEnd, start, end)) {
        return s;
      }
    } else if (isOvernight) {
      if (overlaps(start, 1440, curStart, curEnd) || overlaps(0, end, curStart, curEnd)) {
        return s;
      }
    } else {
      if (overlaps(curStart, curEnd, start, end)) {
        return s;
      }
    }
  }
  return null;
}

// Clean time string to HH:MM format
function cleanTime(t) {
  if (!t) return '00:00';
  return t.substring(0, 5);
}

// Parse a color from a palette by index
const WINDOW_COLORS = [
  '#00d9a3', '#2f81f7', '#22d3ee', '#ff2ebd', '#f85149',
  '#a371f7', '#818cf8', '#3fb950', '#79c0ff', '#ff9a8b',
];

export default function SchedulePanel({
  schedules,
  setSchedules,
  onApply,
  onCancel,
  onReset,
  isDirty,
  isSaving,
  positions = [],
  tradeHistory = [],
  currentUnderlying = 'BTC',
  strategyVersion = 1,
}) {
  const avgUtilMap = React.useMemo(() => {
    if (!positions || !schedules || schedules.length === 0) return {};

    const result = {};

    schedules.forEach(s => {
      if (!s.isActive) return;
      const cap = (s.numberOfCalls || 0) + (s.numberOfPuts || 0);
      if (cap === 0) {
        result[s.id] = 0;
        return;
      }

      // Count currently active full spreads for this window
      let activeCalls = 0;
      let activePuts = 0;

      positions.forEach(pos => {
        if (pos.underlying !== currentUnderlying) return;
        if (pos.sellQty <= 0) return; // Only count full spreads, not long-only

        if (pos.type === 'call') activeCalls++;
        else if (pos.type === 'put') activePuts++;
      });

      // Utilization is (activeCalls + activePuts) / cap, capped at 100%
      const callsCount = Math.min(s.numberOfCalls, activeCalls);
      const putsCount = Math.min(s.numberOfPuts, activePuts);
      const util = ((callsCount + putsCount) / cap) * 100;

      result[s.id] = Math.round(util * 100) / 100;
    });

    return result;
  }, [positions, schedules, currentUnderlying]);

  const [deletingId, setDeletingId] = useState(null); // id of schedule window pending deletion

  const handleAdd = useCallback(() => {
    const slots = getUnoccupiedSlots(schedules);
    let startTime = '17:30';
    let endTime = '17:29';
    if (slots.length > 0) {
      startTime = formatMin(slots[0].start);
      const endVal = slots[0].end === 1050 ? 1049 : slots[0].end;
      endTime = formatMin(endVal);
    }
    const newWin = {
      ...DEFAULT_WINDOW,
      id: `new-${Date.now()}`,
      isNew: true,
      startTime,
      endTime,
      label: `Window ${schedules.length + 1}`,
      sort_order: schedules.length,
    };
    setSchedules(prev => [...prev, newWin]);
  }, [schedules, setSchedules]);

  const handleChange = useCallback((id, key, value) => {
    setSchedules(prev =>
      prev.map(s => s.id === id ? { ...s, [key]: value } : s)
    );
  }, [setSchedules]);

  const handleDelete = useCallback((id) => {
    setSchedules(prev => prev.filter(s => s.id !== id));
  }, [setSchedules]);

  // Check if there are any active overlaps across all schedules
  const hasOverlap = schedules.some(s => s.isActive && checkOverlap(schedules, s) !== null);

  // ── Timeline bar ────────────────────────────────────────────────────────
  const renderTimeline = () => {
    const TOTAL = 1440; // minutes in a day

    // Calculate current time percent in IST shifted relative to 05:30 PM IST
    const now = new Date();
    // UTC hours and minutes plus 330 minutes (5 hours 30 mins) to get IST
    const currentMinIST = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
    const currentMinShifted = (currentMinIST - 1050 + 1440) % 1440;
    const currentPercent = (currentMinShifted / TOTAL) * 100;

    return (
      <div className="schedule-timeline-container">
        <div className="schedule-timeline-bar">
          {/* Current Time Indicator line */}
          <div
            className="timeline-current-time-indicator"
            style={{ left: `${currentPercent}%` }}
            title={`Current Time: ${formatMin(currentMinIST)} IST`}
          />

          {/* Schedule blocks */}
          {schedules.map((s, i) => {
            if (!s.isActive) return null;
            const startMin = toMin(s.startTime);
            const endMin = toMin(s.endTime);
            const color = WINDOW_COLORS[i % WINDOW_COLORS.length];

            // Shift minutes relative to 05:30 PM start
            const startShifted = (startMin - 1050 + 1440) % 1440;
            const endShifted = (endMin - 1050 + 1440) % 1440;
            const isSplit = startShifted > endShifted;

            const tooltip = `${s.label || 'Window'} (${cleanTime(s.startTime)} - ${cleanTime(s.endTime)})\nCalls: ${s.numberOfCalls} | Puts: ${s.numberOfPuts}\nStrike Diff: ${s.minStrikeDiff} | Long Dist: ${s.minLongDist}\nScaling: ${(s.atmRatioScaling ?? true) ? 'ON' : 'OFF'} (C: ${s.atmRatioPctCall ?? 50}%, P: ${s.atmRatioPctPut ?? 25}%)`;

            if (isSplit) {
              return (
                <React.Fragment key={s.id}>
                  <div
                    title={tooltip}
                    style={{
                      position: 'absolute',
                      left: `${(startShifted / TOTAL) * 100}%`,
                      width: `${((TOTAL - startShifted) / TOTAL) * 100}%`,
                      top: 0, bottom: 0,
                      background: color, opacity: 0.75,
                      display: 'flex', alignItems: 'center',
                      paddingLeft: 6, overflow: 'hidden',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 9, fontWeight: 800, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.label} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
                    </span>
                  </div>
                  <div
                    title={tooltip}
                    style={{
                      position: 'absolute',
                      left: '0%',
                      width: `${(endShifted / TOTAL) * 100}%`,
                      top: 0, bottom: 0,
                      background: color, opacity: 0.75,
                      display: 'flex', alignItems: 'center',
                      paddingLeft: 6, overflow: 'hidden',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 9, fontWeight: 800, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.label} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
                    </span>
                  </div>
                </React.Fragment>
              );
            }

            return (
              <div
                key={s.id}
                title={tooltip}
                style={{
                  position: 'absolute',
                  left: `${(startShifted / TOTAL) * 100}%`,
                  width: `${((endShifted - startShifted) / TOTAL) * 100}%`,
                  top: 0, bottom: 0,
                  background: color, opacity: 0.75,
                  display: 'flex', alignItems: 'center',
                  paddingLeft: 6, overflow: 'hidden',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 9, fontWeight: 800, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.label} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
                </span>
              </div>
            );
          })}
        </div>

        {/* Time Axis (ticks & labels) rendered cleanly below the bar */}
        <div className="schedule-timeline-axis">
          {[
            { label: '5:30pm', hour: 0 },
            { label: '8:30pm', hour: 3 },
            { label: '11:30pm', hour: 6 },
            { label: '2:30am', hour: 9 },
            { label: '5:30am', hour: 12 },
            { label: '8:30am', hour: 15 },
            { label: '11:30am', hour: 18 },
            { label: '2:30pm', hour: 21 },
            { label: '5:30pm', hour: 24 }
          ].map(tick => {
            const leftPercent = ((tick.hour * 60) / TOTAL) * 100;
            return (
              <React.Fragment key={tick.label + '-' + tick.hour}>
                <div
                  className="schedule-timeline-tick"
                  style={{ left: `${leftPercent}%` }}
                />
                <span
                  className="schedule-timeline-label"
                  style={{
                    left: `${leftPercent}%`,
                    // Anchor the edge labels inside the bar so they don't spill past
                    // the border: first is left-aligned, last is right-aligned.
                    transform: leftPercent === 0 ? 'translateX(0)'
                      : leftPercent === 100 ? 'translateX(-100%)'
                      : 'translateX(-50%)',
                  }}
                >
                  {tick.label}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="schedule-panel">
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1 }}>
          Time Schedules <span style={{ color: '#3b82f6', fontWeight: 600 }}>(IST)</span>
        </span>
        <button
          type="button"
          onClick={handleAdd}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.35)',
            color: '#3b82f6', padding: '4px 12px', borderRadius: 5,
            fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(59,130,246,0.2)'}
          onMouseOut={e => e.currentTarget.style.background = 'rgba(59,130,246,0.12)'}
        >
          <Plus size={11} strokeWidth={3} />
          Add Window
        </button>
      </div>

      {/* 24h Timeline */}
      {schedules.length > 0 && renderTimeline()}

      {/* Available Slots Info */}
      {schedules.length > 0 && (
        <div style={{
          fontSize: 10, color: 'var(--text-dim)', marginTop: 2, marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'
        }}>
          <span style={{ fontWeight: 600 }}>Available slots (IST):</span>
          {getDisplaySlots(schedules).map((slot, idx) => (
            <span key={idx} style={{
              color: 'var(--accent)', background: 'rgba(0,217,163,0.08)',
              padding: '2px 6px', borderRadius: 4, fontWeight: 500
            }}>
              {formatMin(slot.start)} – {formatMin(slot.end === 1440 ? 0 : slot.end)}
            </span>
          ))}
          {getDisplaySlots(schedules).length === 0 && (
            <span style={{ color: '#f85149', fontWeight: 600 }}>All times occupied</span>
          )}
        </div>
      )}

      {/* No schedules state */}
      {schedules.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '24px 0', fontSize: 12,
          color: 'var(--text-dim)', opacity: 0.6,
          border: '1px dashed var(--border)', borderRadius: 8,
          background: 'var(--bg3)',
        }}>
          No schedules — fallback to base configuration 24/7
        </div>
      )}

      {/* Schedule Items List */}
      <div className="schedule-list">
        {schedules.map((s, i) => {
          const color = WINDOW_COLORS[i % WINDOW_COLORS.length];
          const overlapWindow = checkOverlap(schedules, s);

          return (
            <div key={s.id} className={`schedule-item ${s.isActive ? '' : 'inactive'}`} style={{
              border: `1.5px solid ${s.isActive ? color : 'var(--border)'}`,
            }}>


              {/* Fields row — everything else in one row (wraps only if the screen is narrow) */}
              <div className="schedule-item-fields">
                <div className="schedule-item-block" style={{ flex: '0 0 85px', width: '85px', justifyContent: 'flex-end', height: '56px', boxSizing: 'border-box', paddingBottom: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
                    Window {i + 1}
                  </span>
                </div>

                <div className="schedule-item-block schedule-item-time-block">
                  <span className="schedule-item-label">Start Time (IST)</span>
                  <CustomInput type="time" className="schedule-inline-input" value={cleanTime(s.startTime)} onChange={e => handleChange(s.id, 'startTime', e.target.value)} />
                </div>

                <div className="schedule-item-block schedule-item-time-block">
                  <span className="schedule-item-label">End Time (IST)</span>
                  <CustomInput type="time" className="schedule-inline-input" value={cleanTime(s.endTime)} onChange={e => handleChange(s.id, 'endTime', e.target.value)} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Max Open Calls</span>
                  <CustomInput type="number" min="0" max="20" value={s.numberOfCalls} onChange={e => handleChange(s.id, 'numberOfCalls', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Max Open Puts</span>
                  <CustomInput type="number" min="0" max="20" value={s.numberOfPuts} onChange={e => handleChange(s.id, 'numberOfPuts', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Min Spread Width</span>
                  <CustomInput type="number" min="0" prefix="$" step="50" value={s.minStrikeDiff} onChange={e => handleChange(s.id, 'minStrikeDiff', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Min Spot Distance</span>
                  <CustomInput type="number" min="0" prefix="$" step="50" value={s.minLongDist} onChange={e => handleChange(s.id, 'minLongDist', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">ATM Scaling</span>
                  <div style={{ height: '36px', display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch" title="Toggle dynamic scaling of short leg based on ATM ratio">
                      <input
                        type="checkbox"
                        checked={s.atmRatioScaling ?? true}
                        onChange={e => handleChange(s.id, 'atmRatioScaling', e.target.checked)}
                      />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Call Scaling</span>
                  <CustomInput type="number" min="0" max="100" suffix="%" step="5" value={s.atmRatioPctCall ?? 50} disabled={!(s.atmRatioScaling ?? true)} onChange={e => handleChange(s.id, 'atmRatioPctCall', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Put Scaling</span>
                  <CustomInput type="number" min="0" max="100" suffix="%" step="5" value={s.atmRatioPctPut ?? 25} disabled={!(s.atmRatioScaling ?? true)} onChange={e => handleChange(s.id, 'atmRatioPctPut', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Max Net Debit</span>
                  <CustomInput type="number" prefix="$" value={s.maxNetPremium ?? 20} onChange={e => handleChange(s.id, 'maxNetPremium', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Exit Type</span>
                  <CustomSelect
                    value={s.exitType ?? 'ATM'}
                    onChange={val => handleChange(s.id, 'exitType', val)}
                    options={[{ label: 'ATM', value: 'ATM' }, { label: 'ITM', value: 'ITM' }, { label: 'OTM', value: 'OTM' }]}
                    style={{ width: '100%' }}
                  />
                </div>

                {(s.exitType === 'ITM' || s.exitType === 'OTM') && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label">Exit Points</span>
                    <CustomInput type="number" min="0" step="1" value={s.exitPoints ?? 0} onChange={e => handleChange(s.id, 'exitPoints', Number(e.target.value))} />
                  </div>
                )}

                {/* Per-window Min Days to Expiry (migration 019) — all accounts, paper AND
                    live. The traded expiry follows the active window's DTE. */}
                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Min Days to Expiry</span>
                  <CustomInput type="number" min="0" step="1" value={s.daysToExpiry ?? 0} onChange={e => handleChange(s.id, 'daysToExpiry', Number(e.target.value))} />
                </div>

                {/* Hedge leg — per-spread 3rd long (experimental / strategy_version >= 2).
                    Each entered spread of the chosen type(s) becomes a long/short/long
                    triplet: a 3rd long-only leg bought at the OTM strike whose ask is the
                    highest ≤ Price (budget), sized as (that spread's own short qty) × Pct.
                    It rides the triplet and exits with it (main-strike ATM/ITM/OTM or expiry). */}
                {strategyVersion >= 2 && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label">Hedge Leg Type</span>
                    <CustomSelect
                      value={s.hedgeStrikeType ?? 'none'}
                      onChange={val => handleChange(s.id, 'hedgeStrikeType', val)}
                      options={[
                        { label: 'None', value: 'none' },
                        { label: 'Call only', value: 'call' },
                        { label: 'Put only', value: 'put' },
                        { label: 'Call & Put', value: 'both' },
                      ]}
                      style={{ width: '100%' }}
                    />
                  </div>
                )}
                {strategyVersion >= 2 && (s.hedgeStrikeType === 'call' || s.hedgeStrikeType === 'both') && (
                  <>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label">Hedge Call Price</span>
                      <CustomInput type="number" min="0" step="1" prefix="$" value={s.hedgeCallPrice ?? 0} onChange={e => handleChange(s.id, 'hedgeCallPrice', Number(e.target.value))} />
                    </div>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label">Hedge Call %</span>
                      <CustomInput type="number" min="0" max="100" step="1" suffix="%" value={s.hedgeCallPct ?? 0} onChange={e => handleChange(s.id, 'hedgeCallPct', Number(e.target.value))} />
                    </div>
                  </>
                )}
                {strategyVersion >= 2 && (s.hedgeStrikeType === 'put' || s.hedgeStrikeType === 'both') && (
                  <>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label">Hedge Put Price</span>
                      <CustomInput type="number" min="0" step="1" prefix="$" value={s.hedgePutPrice ?? 0} onChange={e => handleChange(s.id, 'hedgePutPrice', Number(e.target.value))} />
                    </div>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label">Hedge Put %</span>
                      <CustomInput type="number" min="0" max="100" step="1" suffix="%" value={s.hedgePutPct ?? 0} onChange={e => handleChange(s.id, 'hedgePutPct', Number(e.target.value))} />
                    </div>
                  </>
                )}

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Live Utilized</span>
                  <div style={{
                    fontSize: '13px', fontWeight: '700', color: '#3b82f6', height: '36px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '5px',
                    padding: '0 10px', fontFamily: 'JetBrains Mono, monospace', boxSizing: 'border-box',
                  }} title="Current live utilization of active full-spread positions (calls + puts) divided by the window's total cap. Long-only positions are excluded.">
                    {avgUtilMap[s.id] !== undefined ? `${avgUtilMap[s.id]}%` : '—'}
                  </div>
                </div>

                {/* Overlap badge inline */}
                {overlapWindow && (
                  <div className="schedule-item-block" style={{ justifyContent: 'flex-end', height: '56px', boxSizing: 'border-box', paddingBottom: '8px' }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', padding: '0 12px', borderRadius: 5, fontSize: 9, fontWeight: 700, color: '#f85149', cursor: 'help', height: '36px', boxSizing: 'border-box' }}
                      title={`Time overlaps with "Window ${schedules.findIndex(x => x.id === overlapWindow.id) + 1}" (${cleanTime(overlapWindow.startTime)} – ${cleanTime(overlapWindow.endTime)})`}
                    >
                      <AlertTriangle size={10} strokeWidth={3} />
                      OVERLAP
                    </div>
                  </div>
                )}

                {/* Lock (Window 1) or delete button inline */}
                <div className="schedule-item-block" style={{ flex: '0 0 50px', width: '50px', justifyContent: 'flex-end', height: '56px', boxSizing: 'border-box', paddingBottom: '8px', alignItems: 'center' }}>
                  <div style={{ height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {i === 0 ? (
                      <div
                        title="Window 1 is permanent and cannot be deleted (it holds the account's default filters). You can still edit its time and values."
                        style={{ display: 'flex', alignItems: 'center', color: 'var(--border)', cursor: 'not-allowed' }}
                      >
                        <Lock size={15} strokeWidth={2.5} />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="watch-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (s.isNew) { handleDelete(s.id); } else { setDeletingId(s.id); }
                        }}
                        style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 8, borderRadius: 5, transition: 'all 0.15s' }}
                        onMouseOver={e => { e.currentTarget.style.color = '#f85149'; e.currentTarget.style.background = 'rgba(248,81,73,0.1)'; }}
                        onMouseOut={e => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.background = 'none'; }}
                        title={s.isNew ? "Cancel window" : "Delete schedule window"}
                      >
                        {s.isNew ? (
                          <X size={15} strokeWidth={2.5} />
                        ) : (
                          <Trash2 size={15} strokeWidth={2.5} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Schedules manual actions: Apply, Cancel, and Reset */}
      {schedules.length > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
          borderTop: '1px solid var(--border)',
          paddingTop: 12,
          marginTop: 12,
          flexWrap: 'wrap'
        }}>
          {hasOverlap && (
            <span style={{ fontSize: 10, color: '#f85149', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginRight: 'auto' }}>
              <AlertTriangle size={12} strokeWidth={2.5} style={{ transform: 'translateY(-1px)' }} />
              Time overlap detected between active windows.
            </span>
          )}

          <button
            type="button"
            className={`pt-btn-filter pt-btn-apply ${isDirty && !hasOverlap ? 'active' : ''}`}
            onClick={onApply}
            disabled={!isDirty || hasOverlap || isSaving}
            style={{ minWidth: 100 }}
          >
            {isSaving ? 'Syncing...' : 'Apply'}
          </button>

          <button
            type="button"
            className="pt-btn-filter pt-btn-cancel"
            onClick={onCancel}
            disabled={!isDirty || isSaving}
            style={{ minWidth: 80 }}
          >
            Cancel
          </button>

          <button
            type="button"
            className="pt-btn-filter pt-btn-reset"
            onClick={onReset}
            disabled={isSaving}
            style={{ minWidth: 80 }}
          >
            Reset
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal Overlay */}
      {deletingId !== null && (
        <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" style={{ maxWidth: 360, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={16} strokeWidth={2.5} style={{ transform: 'translateY(-1px)' }} />
              Delete Schedule Window
            </h3>
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              Are you sure you want to delete the schedule window <strong>"{schedules.find(s => s.id === deletingId)?.label || 'this window'}"</strong>?
            </p>
            <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-dim)', lineHeight: '1.4' }}>
              This action will discard the window locally. Note that changes are permanent only after you click <strong>"Save Schedules"</strong>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                style={{
                  padding: '7px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  transition: 'background 0.15s',
                }}
                onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleDelete(deletingId);
                  setDeletingId(null);
                }}
                style={{
                  padding: '7px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#f85149',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  transition: 'opacity 0.15s',
                }}
                onMouseOver={e => e.currentTarget.style.opacity = '0.85'}
                onMouseOut={e => e.currentTarget.style.opacity = '1'}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
