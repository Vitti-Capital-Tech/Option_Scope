import React, { useState, useCallback } from 'react';

const DEFAULT_WINDOW = {
  label: 'Window',
  startTime: '00:00',
  endTime: '23:59',
  numberOfCalls: 3,
  numberOfPuts: 3,
  minLongDist: 500,
  minStrikeDiff: 800,
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

// Get unoccupied time slots across the 24h cycle
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
  for (let m = 0; m < 1440; m++) {
    if (!mins[m] && !inSlot) {
      start = m;
      inSlot = true;
    } else if (mins[m] && inSlot) {
      slots.push({ start, end: m });
      inSlot = false;
    }
  }
  if (inSlot) {
    slots.push({ start, end: 1440 });
  }

  // Handle overnight merge: if slot at end (ends at 1440) and slot at start (starts at 0) exist, merge them
  if (slots.length > 1 && slots[0].start === 0 && slots[slots.length - 1].end === 1440) {
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
}) {
  const [expanded, setExpanded] = useState(null); // id of expanded card
  const [deletingId, setDeletingId] = useState(null); // id of schedule window pending deletion

  const handleAdd = useCallback(() => {
    const slots = getUnoccupiedSlots(schedules);
    let startTime = '00:00';
    let endTime = '23:59';
    if (slots.length > 0) {
      startTime = formatMin(slots[0].start);
      const endVal = slots[0].end === 1440 ? 1439 : slots[0].end;
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
    setExpanded(newWin.id);
  }, [schedules, setSchedules]);

  const handleChange = useCallback((id, key, value) => {
    setSchedules(prev =>
      prev.map(s => s.id === id ? { ...s, [key]: value } : s)
    );
  }, [setSchedules]);

  const handleDelete = useCallback((id) => {
    setSchedules(prev => prev.filter(s => s.id !== id));
    setExpanded(e => e === id ? null : e);
  }, [setSchedules]);

  const toggleActive = useCallback((id) => {
    setSchedules(prev =>
      prev.map(s => s.id === id ? { ...s, isActive: !s.isActive } : s)
    );
  }, [setSchedules]);

  // ── Timeline bar ────────────────────────────────────────────────────────
  const renderTimeline = () => {
    const TOTAL = 1440; // minutes in a day
    return (
      <div className="schedule-timeline-bar">
        {/* Hour ticks */}
        {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
          <div key={h} style={{
            position: 'absolute', left: `${(h * 60 / TOTAL) * 100}%`,
            top: 0, bottom: 0, width: 1, background: 'var(--border)', opacity: 0.3,
          }} />
        ))}
        {/* Schedule blocks */}
        {schedules.map((s, i) => {
          if (!s.isActive) return null;
          const startMin = toMin(s.startTime);
          const endMin = toMin(s.endTime);
          const color = WINDOW_COLORS[i % WINDOW_COLORS.length];
          const isOvernight = startMin > endMin;
          const tooltip = `${s.label || 'Window'} (${cleanTime(s.startTime)} - ${cleanTime(s.endTime)})\nCalls: ${s.numberOfCalls} | Puts: ${s.numberOfPuts}\nStrike Diff: ${s.minStrikeDiff} | Long Dist: ${s.minLongDist}`;

          if (isOvernight) {
            return (
              <React.Fragment key={s.id}>
                <div 
                  title={tooltip}
                  style={{
                    position: 'absolute',
                    left: `${(startMin / TOTAL) * 100}%`,
                    width: `${((TOTAL - startMin) / TOTAL) * 100}%`,
                    top: 2, bottom: 2, borderRadius: 3,
                    background: color, opacity: 0.75,
                    display: 'flex', alignItems: 'center',
                    paddingLeft: 4, overflow: 'hidden',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.label}
                  </span>
                </div>
                <div 
                  title={tooltip}
                  style={{
                    position: 'absolute',
                    left: '0%',
                    width: `${(endMin / TOTAL) * 100}%`,
                    top: 2, bottom: 2, borderRadius: 3,
                    background: color, opacity: 0.75,
                    cursor: 'pointer',
                  }}
                />
              </React.Fragment>
            );
          }

          return (
            <div 
              key={s.id} 
              title={tooltip}
              style={{
                position: 'absolute',
                left: `${(startMin / TOTAL) * 100}%`,
                width: `${((endMin - startMin) / TOTAL) * 100}%`,
                top: 2, bottom: 2, borderRadius: 3,
                background: color, opacity: 0.75,
                display: 'flex', alignItems: 'center',
                paddingLeft: 4, overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 700, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.label}
              </span>
            </div>
          );
        })}
        {/* Time labels */}
        {['12am', '3am', '6am', '9am', '12pm', '3pm', '6pm', '9pm'].map((label, i) => (
          <span key={label} style={{
            position: 'absolute',
            left: `${((i * 3 * 60) / TOTAL) * 100}%`,
            bottom: 1, fontSize: 8, color: 'var(--text-dim)', transform: 'translateX(-50%)',
            pointerEvents: 'none', userSelect: 'none', fontWeight: 500,
          }}>{label}</span>
        ))}
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
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Window
        </button>
      </div>

      {/* 24h Timeline */}
      {schedules.length > 0 && renderTimeline()}

      {/* Available Slots Info */}
      {schedules.length > 0 && (
        <div style={{
          fontSize: 10, color: 'var(--text-dim)', marginTop: -6, marginBottom: 12,
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

      {/* Schedule Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {schedules.map((s, i) => {
          const color = WINDOW_COLORS[i % WINDOW_COLORS.length];
          const isOpen = expanded === s.id;
          const overlapWindow = checkOverlap(schedules, s);

          return (
            <div key={s.id} className={`schedule-card ${isOpen ? 'expanded' : ''}`} style={{
              borderColor: isOpen ? `${color}70` : 'var(--border)',
            }}>
              {/* Card Header */}
              <div
                className="schedule-card-header"
                onClick={() => setExpanded(isOpen ? null : s.id)}
                style={{
                  background: isOpen ? `${color}08` : 'transparent',
                }}
              >
                {/* Active Indicator Color Pill */}
                <div style={{ width: 10, height: 10, borderRadius: 3, background: s.isActive ? color : 'var(--border)', flexShrink: 0 }} />
                
                {/* Window Name Label */}
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: s.isActive ? 'var(--text)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.label || 'Unnamed Window'}
                </span>
                
                {/* Active/Inactive quick toggler */}
                <input
                  type="checkbox"
                  checked={s.isActive}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggleActive(s.id);
                  }}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer', marginRight: 4 }}
                  title="Enable/disable schedule window"
                />

                {/* Quick Info Summary */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4, fontWeight: 500 }}>
                    {cleanTime(s.startTime)} – {cleanTime(s.endTime)}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)', background: 'var(--bg3)', padding: '2px 6px', borderRadius: 4, fontWeight: 500 }}>
                    {s.numberOfCalls}C / {s.numberOfPuts}P
                  </span>
                </div>

                {/* Quick Delete Trash Button / Cancel Button */}
                <button
                  type="button"
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
                    padding: 4, borderRadius: 4, transition: 'all 0.15s'
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
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                  )}
                </button>

                {/* Chevron */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  style={{ transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', color: 'var(--text-dim)', flexShrink: 0, marginLeft: 2 }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>

              {/* Card Body */}
              {isOpen && (
                <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
                  {/* Row 1: Label */}
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4, fontWeight: 600 }}>Label</label>
                    <input
                      type="text"
                      className="schedule-input"
                      value={s.label}
                      onChange={e => handleChange(s.id, 'label', e.target.value)}
                      placeholder="e.g. Night Window"
                    />
                  </div>

                  {/* Row 2: Times (2 cols) */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4, fontWeight: 600 }}>Start Time (IST)</label>
                      <input
                        type="time"
                        className="schedule-input"
                        value={cleanTime(s.startTime)}
                        onChange={e => handleChange(s.id, 'startTime', e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4, fontWeight: 600 }}>End Time (IST)</label>
                      <input
                        type="time"
                        className="schedule-input"
                        value={cleanTime(s.endTime)}
                        onChange={e => handleChange(s.id, 'endTime', e.target.value)}
                      />
                    </div>
                  </div>
                  {overlapWindow && (
                    <div style={{ fontSize: 10, color: '#f85149', marginTop: -6, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: 'translateY(-1px)' }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      Overlaps with "{overlapWindow.label || 'another window'}" ({cleanTime(overlapWindow.startTime)} – {cleanTime(overlapWindow.endTime)})
                    </div>
                  )}

                  {/* Row 3: Strategy Filters - Max Calls, Max Puts, Min Strike Diff, Min Long Dist (4 cols) */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
                    <div>
                      <label style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'block', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Max Calls">Max Calls</label>
                      <input type="number" min="0" max="20"
                        className="schedule-input"
                        value={s.numberOfCalls}
                        onChange={e => handleChange(s.id, 'numberOfCalls', Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'block', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Max Puts">Max Puts</label>
                      <input type="number" min="0" max="20"
                        className="schedule-input"
                        value={s.numberOfPuts}
                        onChange={e => handleChange(s.id, 'numberOfPuts', Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'block', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Min Strike Diff">Min Strike Diff</label>
                      <input type="number" min="0"
                        className="schedule-input"
                        value={s.minStrikeDiff}
                        onChange={e => handleChange(s.id, 'minStrikeDiff', Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'block', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Min Long Dist">Min Long Dist</label>
                      <input type="number" min="0"
                        className="schedule-input"
                        value={s.minLongDist}
                        onChange={e => handleChange(s.id, 'minLongDist', Number(e.target.value))}
                      />
                    </div>
                  </div>

                  {/* Row 4: Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: 'var(--text)', fontWeight: 500 }}>
                      <input
                        type="checkbox"
                        checked={s.isActive}
                        onChange={() => toggleActive(s.id)}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                      Enable Schedule Window
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {s.isNew ? (
                        <button
                          type="button"
                          onClick={() => handleDelete(s.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)',
                            color: 'var(--text)', padding: '4px 12px', borderRadius: 5,
                            fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                          }}
                          onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                          onMouseOut={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDeletingId(s.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.2)',
                            color: '#f85149', padding: '4px 10px', borderRadius: 5,
                            fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                          }}
                          onMouseOver={e => e.currentTarget.style.background = 'rgba(248,81,73,0.15)'}
                          onMouseOut={e => e.currentTarget.style.background = 'rgba(248,81,73,0.08)'}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                          Delete Window
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={onSave}
                        disabled={isSaving || overlapWindow !== null}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          background: overlapWindow ? 'var(--border)' : 'var(--accent)', border: 'none',
                          color: overlapWindow ? 'var(--text-dim)' : '#000', padding: '4px 14px', borderRadius: 5,
                          fontSize: 11, fontWeight: 700, cursor: (isSaving || overlapWindow !== null) ? 'not-allowed' : 'pointer',
                          opacity: (isSaving || overlapWindow !== null) ? 0.6 : 1, transition: 'all 0.15s',
                        }}
                        title={overlapWindow ? "Cannot save: Time overlap detected with another active window" : "Save all schedules"}
                      >
                        {isSaving ? (
                          <>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}><circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.2)" /><path d="M12 2a10 10 0 0 1 10 10" stroke="#000" /></svg>
                            Saving...
                          </>
                        ) : (
                          <>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                            Save Schedules
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>



      {/* Delete Confirmation Modal Overlay */}
      {deletingId !== null && (
        <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" style={{ maxWidth: 360, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: 'translateY(-1px)' }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
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
