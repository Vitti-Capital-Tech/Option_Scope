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
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
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

  const handleAdd = useCallback(() => {
    const newWin = {
      ...DEFAULT_WINDOW,
      id: `new-${Date.now()}`,
      isNew: true,
      label: `Window ${schedules.length + 1}`,
      sort_order: schedules.length,
    };
    setSchedules(prev => [...prev, newWin]);
    setExpanded(newWin.id);
  }, [schedules.length, setSchedules]);

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
      <div style={{
        position: 'relative', height: 28, borderRadius: 6,
        background: 'var(--bg3)', border: '1px solid var(--border)',
        overflow: 'hidden', margin: '12px 0',
      }}>
        {/* Hour ticks */}
        {[0,3,6,9,12,15,18,21,24].map(h => (
          <div key={h} style={{
            position: 'absolute', left: `${(h * 60 / TOTAL) * 100}%`,
            top: 0, bottom: 0, width: 1, background: 'var(--border)', opacity: 0.5,
          }} />
        ))}
        {/* Schedule blocks */}
        {schedules.map((s, i) => {
          if (!s.isActive) return null;
          const startMin = toMin(s.startTime);
          const endMin = toMin(s.endTime);
          const color = WINDOW_COLORS[i % WINDOW_COLORS.length];
          const isOvernight = startMin > endMin;

          if (isOvernight) {
            // Two blocks: start→midnight and midnight→end
            return (
              <React.Fragment key={s.id}>
                <div style={{
                  position: 'absolute',
                  left: `${(startMin / TOTAL) * 100}%`,
                  width: `${((TOTAL - startMin) / TOTAL) * 100}%`,
                  top: 2, bottom: 2, borderRadius: 3,
                  background: color, opacity: 0.75,
                  display: 'flex', alignItems: 'center',
                  paddingLeft: 4, overflow: 'hidden',
                }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.label}
                  </span>
                </div>
                <div style={{
                  position: 'absolute',
                  left: '0%',
                  width: `${(endMin / TOTAL) * 100}%`,
                  top: 2, bottom: 2, borderRadius: 3,
                  background: color, opacity: 0.75,
                }} />
              </React.Fragment>
            );
          }

          return (
            <div key={s.id} style={{
              position: 'absolute',
              left: `${(startMin / TOTAL) * 100}%`,
              width: `${((endMin - startMin) / TOTAL) * 100}%`,
              top: 2, bottom: 2, borderRadius: 3,
              background: color, opacity: 0.75,
              display: 'flex', alignItems: 'center',
              paddingLeft: 4, overflow: 'hidden',
            }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.label}
              </span>
            </div>
          );
        })}
        {/* Time labels */}
        {['12am','3am','6am','9am','12pm','3pm','6pm','9pm'].map((label, i) => (
          <span key={label} style={{
            position: 'absolute',
            left: `${((i * 3 * 60) / TOTAL) * 100}%`,
            bottom: 1, fontSize: 7, color: 'var(--text-dim)', transform: 'translateX(-50%)',
            pointerEvents: 'none', userSelect: 'none'
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
            color: 'var(--accent)', padding: '3px 10px', borderRadius: 5,
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

      {/* No schedules state */}
      {schedules.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '20px 0', fontSize: 12,
          color: 'var(--text-dim)', opacity: 0.6,
        }}>
          No schedules — using base config 24/7
        </div>
      )}

      {/* Schedule Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {schedules.map((s, i) => {
          const color = WINDOW_COLORS[i % WINDOW_COLORS.length];
          const isOpen = expanded === s.id;

          return (
            <div key={s.id} style={{
              border: `1px solid ${isOpen ? color + '60' : 'var(--border)'}`,
              borderRadius: 8, overflow: 'hidden',
              background: 'var(--bg2)',
              transition: 'border-color 0.2s',
            }}>
              {/* Card Header */}
              <div
                onClick={() => setExpanded(isOpen ? null : s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 12px', cursor: 'pointer',
                  background: isOpen ? `${color}10` : 'transparent',
                  transition: 'background 0.2s',
                }}
              >
                <div style={{ width: 10, height: 10, borderRadius: 3, background: s.isActive ? color : 'var(--border)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                  {s.label || 'Unnamed Window'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                  {s.startTime} – {s.endTime}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                  {s.numberOfCalls}C / {s.numberOfPuts}P
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  style={{ transition: 'transform 0.2s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', color: 'var(--text-dim)', flexShrink: 0 }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>

              {/* Card Body */}
              {isOpen && (
                <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
                  {/* Label */}
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Label</label>
                    <input
                      type="text"
                      value={s.label}
                      onChange={e => handleChange(s.id, 'label', e.target.value)}
                      style={{
                        width: '100%', padding: '5px 8px', borderRadius: 5,
                        border: '1px solid var(--border)', background: 'var(--bg3)',
                        color: 'var(--text)', fontSize: 12, outline: 'none',
                        boxSizing: 'border-box',
                      }}
                      placeholder="e.g. Night Window"
                    />
                  </div>

                  {/* Time Range */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Start (IST)</label>
                      <input
                        type="time"
                        value={s.startTime}
                        onChange={e => handleChange(s.id, 'startTime', e.target.value)}
                        style={{
                          width: '100%', padding: '5px 8px', borderRadius: 5,
                          border: '1px solid var(--border)', background: 'var(--bg3)',
                          color: 'var(--text)', fontSize: 12, outline: 'none',
                          colorScheme: 'dark', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>End (IST)</label>
                      <input
                        type="time"
                        value={s.endTime}
                        onChange={e => handleChange(s.id, 'endTime', e.target.value)}
                        style={{
                          width: '100%', padding: '5px 8px', borderRadius: 5,
                          border: '1px solid var(--border)', background: 'var(--bg3)',
                          color: 'var(--text)', fontSize: 12, outline: 'none',
                          colorScheme: 'dark', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>

                  {/* Calls / Puts */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Max Calls (#)</label>
                      <input type="number" min="0" max="20"
                        value={s.numberOfCalls}
                        onChange={e => handleChange(s.id, 'numberOfCalls', Number(e.target.value))}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Max Puts (#)</label>
                      <input type="number" min="0" max="20"
                        value={s.numberOfPuts}
                        onChange={e => handleChange(s.id, 'numberOfPuts', Number(e.target.value))}
                        style={inputStyle}
                      />
                    </div>
                  </div>

                  {/* Strike Diff / Long Dist */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Min Strike Diff ($)</label>
                      <input type="number" min="0"
                        value={s.minStrikeDiff}
                        onChange={e => handleChange(s.id, 'minStrikeDiff', Number(e.target.value))}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 3 }}>Min Long Dist</label>
                      <input type="number" min="0"
                        value={s.minLongDist}
                        onChange={e => handleChange(s.id, 'minLongDist', Number(e.target.value))}
                        style={inputStyle}
                      />
                    </div>
                  </div>

                  {/* Active toggle + Delete */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>
                      <input
                        type="checkbox"
                        checked={s.isActive}
                        onChange={() => toggleActive(s.id)}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      Active
                    </label>
                    <button
                      type="button"
                      onClick={() => handleDelete(s.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.3)',
                        color: '#f85149', padding: '4px 10px', borderRadius: 5,
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save Button */}
      {schedules.length > 0 && (
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving}
          style={{
            marginTop: 10, width: '100%',
            padding: '8px 0', borderRadius: 6,
            background: 'var(--accent)', border: 'none',
            color: '#000', fontSize: 12, fontWeight: 700,
            cursor: isSaving ? 'not-allowed' : 'pointer',
            opacity: isSaving ? 0.6 : 1, transition: 'opacity 0.2s',
          }}
        >
          {isSaving ? 'Saving...' : 'Save Schedules'}
        </button>
      )}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '5px 8px', borderRadius: 5,
  border: '1px solid var(--border)', background: 'var(--bg3)',
  color: 'var(--text)', fontSize: 12, outline: 'none',
  boxSizing: 'border-box',
};
