import React, { useState, useCallback } from 'react';
import CustomInput from '../common/CustomInput';

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
  spotDiff: 0.5,
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
  '#00d9a3', '#2f81f7', '#e3b341', '#ff2ebd', '#f85149',
  '#a371f7', '#ffa657', '#3fb950', '#79c0ff', '#ff9a8b',
];

export default function SchedulePanel({
  schedules,
  setSchedules,
  onSave,
  isSaving,
  positions = [],
  tradeHistory = [],
  currentUnderlying = 'BTC',
}) {
  const avgUtilMap = React.useMemo(() => {
    if (!positions || !tradeHistory || !schedules || schedules.length === 0) return {};

    // Helper to get IST date string
    const getIstDateStr = (ms) => {
      const d = new Date(ms + 5.5 * 60 * 60 * 1000);
      return d.toISOString().split('T')[0];
    };

    // Helper to get next day
    const getNextDayStr = (dStr) => {
      const nextD = new Date(dStr + 'T12:00:00+05:30');
      nextD.setDate(nextD.getDate() + 1);
      return nextD.toISOString().split('T')[0];
    };

    // Pre-calculate which original position IDs have a short exit record in history
    const shortExitIds = new Set();
    tradeHistory.forEach(r => {
      if (r.trade_id?.includes('-SE-') || r.exit_reason?.toLowerCase().includes('short leg exit')) {
        const rOrigId = r.trade_id ? (r.trade_id.length >= 36 ? r.trade_id.substring(0, 36) : r.trade_id) : r.id;
        shortExitIds.add(rOrigId);
      }
    });

    const intervals = {};

    // 1. Process active positions
    positions.forEach(pos => {
      const entry = new Date(pos.entryTime || pos.entry_time).getTime();
      if (isNaN(entry)) return;
      const hasShort = pos.sellQty > 0;
      intervals[pos.id] = {
        id: pos.id,
        type: pos.type,
        underlying: pos.underlying,
        entryTime: entry,
        exitTime: null,
        isCurrentlyActiveFull: hasShort
      };
    });

    // 2. Process trade history rows
    tradeHistory.forEach(row => {
      const origId = row.trade_id ? (row.trade_id.length >= 36 ? row.trade_id.substring(0, 36) : row.trade_id) : row.id;
      const entry = new Date(row.entry_time || row.entryTime).getTime();
      const exit = new Date(row.exit_time || row.exitTime).getTime();
      if (isNaN(entry) || isNaN(exit)) return;

      const isShortExit = row.trade_id?.includes('-SE-') || 
                          row.exit_reason?.toLowerCase().includes('short leg exit') || 
                          row.exit_reason?.toLowerCase().includes('short exit');

      if (!intervals[origId]) {
        intervals[origId] = {
          id: origId,
          type: row.type,
          underlying: row.underlying,
          entryTime: entry,
          exitTime: exit,
          isCurrentlyActiveFull: false
        };
      } else {
        if (entry < intervals[origId].entryTime) {
          intervals[origId].entryTime = entry;
        }

        const currentActive = intervals[origId].isCurrentlyActiveFull;
        if (!currentActive) {
          if (isShortExit) {
            intervals[origId].exitTime = exit;
          } else {
            const hasShortExit = shortExitIds.has(origId);
            if (!hasShortExit) {
              if (!intervals[origId].exitTime || exit > intervals[origId].exitTime) {
                intervals[origId].exitTime = exit;
              }
            }
          }
        }
      }
    });

    const intervalsList = Object.values(intervals);
    if (intervalsList.length === 0) return {};

    const entryTimes = intervalsList.map(p => p.entryTime).filter(t => !isNaN(t));
    if (entryTimes.length === 0) return {};

    let earliestMs = Math.min(...entryTimes);
    const latestMs = Date.now();
    // Cap to past 180 days to avoid performance lag with very large histories
    const maxHistoryRange = 180 * 24 * 60 * 60 * 1000;
    if (latestMs - earliestMs > maxHistoryRange) {
      earliestMs = latestMs - maxHistoryRange;
    }

    const startIstDateStr = getIstDateStr(earliestMs);
    const endIstDateStr = getIstDateStr(latestMs);

    const dates = [];
    let curr = new Date(startIstDateStr + 'T12:00:00+05:30');
    const end = new Date(endIstDateStr + 'T12:00:00+05:30');
    while (curr <= end) {
      dates.push(curr.toISOString().split('T')[0]);
      curr.setDate(curr.getDate() + 1);
    }

    const nextDayMap = {};
    dates.forEach((dStr, idx) => {
      if (idx < dates.length - 1) {
        nextDayMap[dStr] = dates[idx + 1];
      } else {
        nextDayMap[dStr] = getNextDayStr(dStr);
      }
    });

    const result = {};

    schedules.forEach(s => {
      if (!s.isActive) return;
      const cap = (s.numberOfCalls || 0) + (s.numberOfPuts || 0);
      if (cap === 0) {
        result[s.id] = 0;
        return;
      }

      let totalDurationAllDays = 0;
      let weightedUtilSumAllDays = 0;
      const isOvernight = toMin(s.startTime) > toMin(s.endTime);

      dates.forEach(dStr => {
        let W_start, W_end;
        try {
          W_start = new Date(`${dStr}T${s.startTime}:00+05:30`).getTime();
          if (isOvernight) {
            const nextDayStr = nextDayMap[dStr] || dStr;
            W_end = new Date(`${nextDayStr}T${s.endTime}:00+05:30`).getTime();
          } else {
            W_end = new Date(`${dStr}T${s.endTime}:00+05:30`).getTime();
          }
        } catch (e) {
          return;
        }

        if (isNaN(W_start) || isNaN(W_end) || W_start >= W_end) return;

        const windowEvents = [];
        let initialCalls = 0;
        let initialPuts = 0;

        intervalsList.forEach(p => {
          if (p.underlying !== currentUnderlying) return;

          const entry = p.entryTime;
          const exit = p.exitTime;

          if (entry <= W_start && (exit === null || exit > W_start)) {
            if (p.type === 'call') initialCalls++;
            else if (p.type === 'put') initialPuts++;
          }

          if (entry > W_start && entry < W_end) {
            windowEvents.push({ time: entry, type: p.type, change: 1 });
          }

          if (exit !== null && exit > W_start && exit < W_end) {
            windowEvents.push({ time: exit, type: p.type, change: -1 });
          }
        });

        windowEvents.sort((a, b) => a.time - b.time);

        let currentCalls = initialCalls;
        let currentPuts = initialPuts;
        let lastTime = W_start;
        const subIntervals = [];

        windowEvents.forEach(ev => {
          const duration = ev.time - lastTime;
          if (duration > 0) {
            subIntervals.push({
              calls: currentCalls,
              puts: currentPuts,
              duration
            });
          }
          if (ev.type === 'call') currentCalls += ev.change;
          else if (ev.type === 'put') currentPuts += ev.change;
          currentCalls = Math.max(0, currentCalls);
          currentPuts = Math.max(0, currentPuts);
          lastTime = ev.time;
        });

        const finalDuration = W_end - lastTime;
        if (finalDuration > 0) {
          subIntervals.push({
            calls: currentCalls,
            puts: currentPuts,
            duration: finalDuration
          });
        }

        subIntervals.forEach(sub => {
          const callsCount = Math.min(s.numberOfCalls, sub.calls);
          const putsCount = Math.min(s.numberOfPuts, sub.puts);
          const util = (callsCount + putsCount) / cap;

          totalDurationAllDays += sub.duration;
          weightedUtilSumAllDays += sub.duration * util;
        });
      });

      if (totalDurationAllDays > 0) {
        const avg = (weightedUtilSumAllDays / totalDurationAllDays) * 100;
        result[s.id] = Math.round(avg * 100) / 100;
      } else {
        result[s.id] = 0;
      }
    });

    return result;
  }, [positions, tradeHistory, schedules, currentUnderlying]);

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

            const tooltip = `${s.label || 'Window'} (${cleanTime(s.startTime)} - ${cleanTime(s.endTime)})\nCalls: ${s.numberOfCalls} | Puts: ${s.numberOfPuts}\nStrike Diff: ${s.minStrikeDiff} | Long Dist: ${s.minLongDist}\nScaling: ${(s.atmRatioScaling ?? true) ? 'ON' : 'OFF'} (C: ${s.atmRatioPctCall ?? 50}%, P: ${s.atmRatioPctPut ?? 25}%)\nSpot Diff: ${s.spotDiff ?? 0.5}%`;

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
                  style={{ left: `${leftPercent}%` }}
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
          Time Schedules <span style={{ color: 'var(--accent)', fontWeight: 600 }}>(IST)</span>
        </span>
        <button
          type="button"
          onClick={handleAdd}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgba(0,217,163,0.12)', border: '1px solid rgba(0,217,163,0.3)',
            color: 'var(--accent)', padding: '4px 12px', borderRadius: 5,
            fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseOver={e => e.currentTarget.style.background = 'rgba(0,217,163,0.2)'}
          onMouseOut={e => e.currentTarget.style.background = 'rgba(0,217,163,0.12)'}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
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
          {getUnoccupiedSlots(schedules).map((slot, idx) => (
            <span key={idx} style={{
              color: 'var(--accent)', background: 'rgba(0,217,163,0.08)',
              padding: '2px 6px', borderRadius: 4, fontWeight: 500
            }}>
              {formatMin(slot.start)} – {formatMin(slot.end === 1440 ? 0 : slot.end)}
            </span>
          ))}
          {getUnoccupiedSlots(schedules).length === 0 && (
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
              borderLeft: `4px solid ${s.isActive ? color : 'var(--border)'}`,
            }}>
              {/* Window Label */}
              <div className="schedule-item-block schedule-item-name-block">
                <span className="schedule-item-label">Window Name</span>
                <CustomInput
                  type="text"
                  className="schedule-inline-input"
                  value={s.label}
                  onChange={e => handleChange(s.id, 'label', e.target.value)}
                  placeholder="e.g. Night Window"
                />
              </div>

              {/* Start Time */}
              <div className="schedule-item-block schedule-item-time-block">
                <span className="schedule-item-label">Start Time (IST)</span>
                <CustomInput
                  type="time"
                  className="schedule-inline-input"
                  value={cleanTime(s.startTime)}
                  onChange={e => handleChange(s.id, 'startTime', e.target.value)}
                />
              </div>

              {/* End Time */}
              <div className="schedule-item-block schedule-item-time-block">
                <span className="schedule-item-label">End Time (IST)</span>
                <CustomInput
                  type="time"
                  className="schedule-inline-input"
                  value={cleanTime(s.endTime)}
                  onChange={e => handleChange(s.id, 'endTime', e.target.value)}
                />
              </div>

              {/* Max Calls */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Max Open Calls</span>
                <CustomInput
                  type="number"
                  min="0"
                  max="20"
                  showStepper
                  value={s.numberOfCalls}
                  onChange={e => handleChange(s.id, 'numberOfCalls', Number(e.target.value))}
                />
              </div>

              {/* Max Puts */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Max Open Puts</span>
                <CustomInput
                  type="number"
                  min="0"
                  max="20"
                  showStepper
                  value={s.numberOfPuts}
                  onChange={e => handleChange(s.id, 'numberOfPuts', Number(e.target.value))}
                />
              </div>

              {/* Min Strike Diff */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Min Spread Width</span>
                <CustomInput
                  type="number"
                  min="0"
                  prefix="$"
                  showStepper
                  step="50"
                  value={s.minStrikeDiff}
                  onChange={e => handleChange(s.id, 'minStrikeDiff', Number(e.target.value))}
                />
              </div>

              {/* Min Long Dist */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Min Spot Distance</span>
                <CustomInput
                  type="number"
                  min="0"
                  prefix="$"
                  showStepper
                  step="50"
                  value={s.minLongDist}
                  onChange={e => handleChange(s.id, 'minLongDist', Number(e.target.value))}
                />
              </div>

              {/* ATM Ratio Scaling Toggle */}
              <div className="schedule-item-block schedule-item-checkbox-block" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', marginTop: 14 }}>
                <input
                  type="checkbox"
                  id={`atmRatioScaling-${s.id}`}
                  checked={s.atmRatioScaling ?? true}
                  onChange={e => handleChange(s.id, 'atmRatioScaling', e.target.checked)}
                  style={{ cursor: 'pointer', width: 14, height: 14 }}
                />
                <label htmlFor={`atmRatioScaling-${s.id}`} style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, cursor: 'pointer', userSelect: 'none' }}>
                  Dynamic ATM Scaling
                </label>
              </div>

              {/* ATM Ratio % Call */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Call Scaling</span>
                <CustomInput
                  type="number"
                  min="0"
                  max="100"
                  suffix="%"
                  showStepper
                  step="5"
                  value={s.atmRatioPctCall ?? 50}
                  disabled={!(s.atmRatioScaling ?? true)}
                  onChange={e => handleChange(s.id, 'atmRatioPctCall', Number(e.target.value))}
                />
              </div>

              {/* ATM Ratio % Put */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Put Scaling</span>
                <CustomInput
                  type="number"
                  min="0"
                  max="100"
                  suffix="%"
                  showStepper
                  step="5"
                  value={s.atmRatioPctPut ?? 25}
                  disabled={!(s.atmRatioScaling ?? true)}
                  onChange={e => handleChange(s.id, 'atmRatioPctPut', Number(e.target.value))}
                />
              </div>

              {/* Spot Diff % */}
              <div className="schedule-item-block schedule-item-num-block">
                <span className="schedule-item-label">Re-entry Spot Step</span>
                <CustomInput
                  type="number"
                  min="0"
                  step="0.1"
                  suffix="%"
                  showStepper
                  value={s.spotDiff ?? 0.5}
                  onChange={e => handleChange(s.id, 'spotDiff', Number(e.target.value))}
                />
              </div>

              {/* Avg Utilization */}
              <div className="schedule-item-block schedule-item-num-block" style={{ minWidth: 80 }}>
                <span className="schedule-item-label">Avg Utilized</span>
                <div style={{
                  fontSize: '12px',
                  fontWeight: '700',
                  color: 'var(--accent)',
                  height: '30px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: '5px',
                  padding: '0 10px',
                  fontFamily: 'JetBrains Mono, monospace',
                  boxSizing: 'border-box'
                }} title="Time-weighted average utilization of calls + puts caps during this window (only counts full spreads, not long-only legs).">
                  {avgUtilMap[s.id] !== undefined ? `${avgUtilMap[s.id]}%` : '—'}
                </div>
              </div>

              {/* Overlap Indicator Badge inside the row */}
              {overlapWindow ? (
                <div
                  className="schedule-item-block schedule-item-status-block"
                  style={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#f85149',
                    cursor: 'help'
                  }}
                  title={`Time overlaps with "${overlapWindow.label || 'another window'}" (${cleanTime(overlapWindow.startTime)} – ${cleanTime(overlapWindow.endTime)})`}
                >
                  <span className="schedule-item-label" style={{ color: '#f85149' }}>Status</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)', padding: '4px 8px', borderRadius: 4, fontSize: 9, fontWeight: 700 }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                    OVERLAP
                  </div>
                </div>
              ) : (
                <div className="schedule-item-block schedule-item-status-block" style={{ opacity: 0, pointerEvents: 'none' }}>
                  <span className="schedule-item-label">Status</span>
                  <div style={{ padding: '4px 8px', fontSize: 9 }}>OK</div>
                </div>
              )}

              {/* Quick Delete Trash Button */}
              <div className="schedule-item-block schedule-item-delete-block" style={{ justifyContent: 'center' }}>
                <span className="schedule-item-label" style={{ opacity: 0 }}>Delete</span>
                <button
                  type="button"
                  className="watch-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (s.isNew) {
                      handleDelete(s.id);
                    } else {
                      setDeletingId(s.id);
                    }
                  }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-dim)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                    padding: 5, borderRadius: 5, transition: 'all 0.15s',
                    marginTop: 3
                  }}
                  onMouseOver={e => {
                    e.currentTarget.style.color = '#f85149';
                    e.currentTarget.style.background = 'rgba(248,81,73,0.1)';
                  }}
                  onMouseOut={e => {
                    e.currentTarget.style.color = 'var(--text-dim)';
                    e.currentTarget.style.background = 'none';
                  }}
                  title={s.isNew ? "Cancel window" : "Delete schedule window"}
                >
                  {s.isNew ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer controls with global Save button */}
      {schedules.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 12, borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12
        }}>
          {hasOverlap && (
            <span style={{ fontSize: 10, color: '#f85149', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: 'translateY(-1px)' }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              Cannot save: Time overlap detected between active windows.
            </span>
          )}

          <button
            type="button"
            onClick={onSave}
            disabled={isSaving || hasOverlap}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: hasOverlap 
                ? 'rgba(248, 81, 73, 0.1)' 
                : isSaving 
                  ? 'rgba(240, 185, 11, 0.1)' 
                  : 'rgba(63, 185, 80, 0.15)',
              border: hasOverlap
                ? '1px solid rgba(248, 81, 73, 0.3)'
                : isSaving
                  ? '1px solid rgba(240, 185, 11, 0.3)'
                  : '1px solid rgba(63, 185, 80, 0.3)',
              color: hasOverlap 
                ? '#f85149' 
                : isSaving 
                  ? 'var(--accent)' 
                  : '#3fb950',
              padding: '6px 16px', borderRadius: 5,
              fontSize: 11, fontWeight: 700, cursor: (isSaving || hasOverlap) ? 'not-allowed' : 'pointer',
              opacity: 1, transition: 'all 0.15s',
            }}
            title={hasOverlap ? "Cannot save: Time overlap detected with another active window" : "Schedules are live-synced to server"}
          >
            {isSaving ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}><circle cx="12" cy="12" r="10" stroke="rgba(240,185,11,0.2)" /><path d="M12 2a10 10 0 0 1 10 10" stroke="var(--accent)" /></svg>
                Syncing...
              </>
            ) : hasOverlap ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                Overlap Detected
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                ✓ Live Synced
              </>
            )}
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal Overlay */}
      {deletingId !== null && (
        <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" style={{ maxWidth: 360, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: 'translateY(-1px)' }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
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
