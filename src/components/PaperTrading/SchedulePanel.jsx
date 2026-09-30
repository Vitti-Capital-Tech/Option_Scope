import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Plus, AlertTriangle, Lock, X, Trash2, Copy, ScanSearch, ChevronDown } from 'lucide-react';
import CustomInput from '../common/CustomInput';
import CustomSelect from '../common/CustomSelect';
import { loadScannerFilterSources } from '../scanner/scannerDefaults';
import { scannerToWindowFields } from './scheduleShared';

// A button that opens a small list of choices (reuses CustomSelect's menu styling).
// `getItems` runs on open, so the list is always current.
function PickerButton({ label, icon, title, getItems, emptyText, onPick, iconOnly = false }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setCoords({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    };
    place();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={() => { if (!open) setItems(getItems()); setOpen(o => !o); }}
        style={iconOnly ? {
          background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', padding: 8, borderRadius: 5, transition: 'all 0.15s',
        } : {
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: '1px solid var(--border)',
          color: 'var(--text-dim)', padding: '4px 10px', borderRadius: 5,
          fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
        }}
        onMouseOver={e => { e.currentTarget.style.color = '#3b82f6'; }}
        onMouseOut={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
      >
        {icon}
        {!iconOnly && <>{label}<ChevronDown size={11} strokeWidth={2.5} /></>}
      </button>
      {open && (
        <div className="custom-dropdown-menu" style={{ position: 'fixed', top: coords.top, left: coords.left, width: 240, zIndex: 10000 }}>
          <div className="custom-dropdown-list">
            {items.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>{emptyText}</div>
            )}
            {items.map(item => (
              <button
                key={item.key}
                type="button"
                className="custom-dropdown-item"
                onClick={() => { setOpen(false); onPick(item); }}
              >
                <div className="custom-dropdown-item-left" style={{ justifyContent: 'space-between', width: '100%' }}>
                  <span>{item.label}</span>
                  {item.sub && <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{item.sub}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const DEFAULT_WINDOW = {
  label: 'Window',
  startTime: '17:30',
  endTime: '17:29',
  maxCombinedPositions: 4,
  allSameType: false,
  sameType: 'call',
  combinedSplitPct: 70,
  minLongDist: 500,
  minStrikeDiff: 800,
  minIvDiff: 5,
  atmRatioScaling: true,
  atmRatioPctCall: 50,
  atmRatioPctPut: 25,
  maxNetPremium: 20,
  exitType: 'ATM',
  exitPoints: 0,
  slTpDecoyDiff: 0,
  shortExitPrice: 1.1,
  variableExitSlices: false,
  longExitSlices: 10,
  daysToExpiry: 0,
  hedgeEnabled: false,
  hedgeLotPct: 0,
  hedgeMaxPrice: 10,
  hedgeIvDiffMin: 0,
  hedgeIvDiffMax: 2,
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
  copySources = [],
  onImportSchedules,
  focus = null,
  positions = [],
  tradeHistory = [],
  historyFilterDate,
  now,
  currentUnderlying = 'BTC',
  strategyVersion = 1,
  isPaper = false,
  balanceAllocationPct = 90,
  initialBalance = 3000,
  walletBalance = null,
  totalRealizedPnl = 0,
  paperEquity = null,
}) {
  // Calculate allocated balance for margin utilization percentage
  const allocatedBalance = React.useMemo(() => {
    const allocPct = balanceAllocationPct ?? 90;
    if (!isPaper && walletBalance != null && walletBalance > 0) {
      return walletBalance * (allocPct / 100);
    }
    const equity = paperEquity != null ? paperEquity : ((initialBalance ?? 3000) + (totalRealizedPnl || 0));
    return equity * (allocPct / 100);
  }, [isPaper, walletBalance, paperEquity, initialBalance, totalRealizedPnl, balanceAllocationPct]);

  // Derived per-type cap:
  // If allSameType is true: all combined positions are allocated to the selected sameType ('call' -> combined/0, 'put' -> 0/combined).
  // Otherwise: ceil(split% × combined), same for calls and puts, clamped to the combined total.
  const derivePaperTypeCap = (s) => {
    const combined = Math.max(0, Math.floor(s.maxCombinedPositions ?? 4));
    if (s.allSameType) {
      const type = (s.sameType || 'call').toLowerCase();
      const call = type === 'call' ? combined : 0;
      const put = type === 'put' ? combined : 0;
      return { call, put, text: `${call}C / ${put}P` };
    }
    const pct = s.combinedSplitPct ?? 70;
    const val = Math.min(combined, Math.ceil((pct / 100) * combined));
    return { call: val, put: val, text: `${val}C / ${val}P` };
  };
  const avgUtilMap = React.useMemo(() => {
    if (!schedules || schedules.length === 0) return {};

    const result = {};
    const allocBal = allocatedBalance > 0 ? allocatedBalance : 2700;

    // Filter active open positions for the current underlying
    const activeList = (Array.isArray(positions) ? positions : []).filter(pos => {
      if (pos.underlying !== currentUnderlying) return false;
      if (pos.type !== 'call' && pos.type !== 'put') return false;
      return true;
    });

    // Get active day YYYY-MM-DD
    const activeDay = historyFilterDate || new Date(now + 12 * 3600 * 1000).toISOString().split('T')[0];
    const base = new Date(`${activeDay}T00:00:00.000Z`).getTime();
    const sessionStart = base - 12 * 3600 * 1000; // 17:30 IST of previous calendar day
    const sessionEnd = base + 12 * 3600 * 1000;   // 17:30 IST of activeDay

    // A position holds its FULL margin only while it is a full spread (both legs). Once the
    // SHORT leg closes it becomes long-only and its margin drops to ~the long premium — so the
    // long-only ladder / wind-down exits must NOT count toward the full-margin peak. Every
    // trade_history row carries sell_qty: it is > 0 while the short was still present (entry
    // state / short-exit / full-spread full exit) and 0 for every long-only exit (ladder -LE,
    // expiry-long). Filtering to sell_qty > 0 keeps EXACTLY the full-spread phase.
    //
    // Lifetimes for the peak sweep — reflects the instant the most FULL margin was deployed,
    // not just what's open right now (which under-states it once positions have wound down):
    //  • Open FULL spreads (sellQty > 0) → [entry, now] at their current (full) margin.
    //  • Every other position (open-but-long-only OR fully closed) → its full-spread phase
    //    [entry, short-close] at the full margin, rebuilt from its sellQty > 0 history rows
    //    (widest span, MAX margin = the full-spread entry margin). The long-only phase after
    //    the short closes is dropped. Ids still full-spread-open are skipped (counted above)
    //    so nothing is double-counted.
    const openFullIds = new Set(activeList.filter(p => (p.sellQty || 0) > 0).map(p => String(p.id)));
    const lifetimes = [];
    activeList.forEach(pos => {
      if ((pos.sellQty || 0) <= 0) return; // long-only open → full-spread phase comes from history
      lifetimes.push({
        entry: new Date(pos.entryTime).getTime(),
        exit: now,
        margin: Number(pos.margin) > 0 ? Number(pos.margin) : null,
      });
    });
    const histByPos = new Map();
    (Array.isArray(tradeHistory) ? tradeHistory : []).forEach(t => {
      if (t.underlying !== currentUnderlying) return;
      if (t.type !== 'call' && t.type !== 'put') return;
      if (Number(t.sellQty) <= 0) return; // long-only wind-down (ladder / expiry-long) — not full margin
      const baseId = String(t.id ?? '').split('-')[0];
      if (!baseId || openFullIds.has(baseId)) return; // still a full spread → counted above
      const entry = new Date(t.entryTime).getTime();
      const exit = new Date(t.exitTime).getTime();
      if (isNaN(entry) || isNaN(exit)) return;
      const m = Number(t.margin) > 0 ? Number(t.margin) : 0;
      const cur = histByPos.get(baseId);
      if (!cur) histByPos.set(baseId, { entry, exit, margin: m });
      else { cur.entry = Math.min(cur.entry, entry); cur.exit = Math.max(cur.exit, exit); cur.margin = Math.max(cur.margin, m); }
    });
    histByPos.forEach(v => lifetimes.push({ entry: v.entry, exit: v.exit, margin: v.margin > 0 ? v.margin : null }));

    schedules.forEach(s => {
      if (!s.isActive) return;

      // Combined-cap model for ALL accounts now (migration 027, promoted to live).
      const cap = Math.max(0, Math.floor(s.maxCombinedPositions ?? 4));

      // Each position slot carries 1 equal part of the allocated balance budget (allocBal / cap)
      const slotMargin = cap > 0 ? allocBal / cap : 0;

      const startMin = toMin(s.startTime);
      const endMin = toMin(s.endTime);
      const startShifted = (startMin - 1050 + 1440) % 1440;
      const endShifted = (endMin - 1050 + 1440) % 1440;

      const winIntervals = [];
      if (startShifted <= endShifted) {
        winIntervals.push({
          start: startShifted * 60 * 1000,
          end: endShifted * 60 * 1000
        });
      } else {
        winIntervals.push({ start: startShifted * 60 * 1000, end: 1440 * 60 * 1000 });
        winIntervals.push({ start: 0, end: endShifted * 60 * 1000 });
      }

      const events = [];

      lifetimes.forEach(life => {
        // Use each position's ACTUAL margin (both paper AND live) — the same stored value the
        // engine subtracts from the allocated budget (usedMargin = Σ pos.margin). slotMargin
        // (the even allocBal/cap split) is only a fallback when a row has no stored margin yet.
        // Paper previously ALWAYS used slotMargin, which over/under-stated utilisation vs the
        // real margins used (e.g. showed 3×450/2700 instead of (350+452+353)/2700).
        const posMargin = life.margin != null && life.margin > 0 ? life.margin : slotMargin;
        const entryMs = life.entry;
        if (isNaN(entryMs)) return;

        const exitMs = life.exit;

        const posStart = Math.max(entryMs, sessionStart);
        const posEnd = Math.min(exitMs, sessionEnd);

        if (posStart >= posEnd) return;

        const relStart = posStart - sessionStart;
        const relEnd = posEnd - sessionStart;

        winIntervals.forEach(win => {
          const intStart = Math.max(relStart, win.start);
          const intEnd = Math.min(relEnd, win.end);
          if (intStart < intEnd) {
            events.push({ time: intStart, marginDelta: posMargin });
            events.push({ time: intEnd, marginDelta: -posMargin });
          }
        });
      });

      if (events.length === 0) {
        result[s.id] = { peakMargin: 0, pctUtil: 0, allocatedBalance: allocBal };
        return;
      }

      // Sort events: time ascending, exit (-marginDelta) before entry (+marginDelta)
      events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        return a.marginDelta - b.marginDelta;
      });

      // Sweep events to track peak concurrent margin utilised at any single instant in this window
      let curMargin = 0;
      let peakMargin = 0;
      events.forEach(ev => {
        curMargin += ev.marginDelta;
        if (curMargin > peakMargin) peakMargin = curMargin;
      });

      const clampedPeak = Math.min(allocBal, peakMargin);
      const pctUtil = allocBal > 0 ? (clampedPeak / allocBal) * 100 : 0;

      result[s.id] = {
        peakMargin: Math.round(clampedPeak * 100) / 100,
        pctUtil: Math.round(pctUtil * 100) / 100,
        allocatedBalance: Math.round(allocBal * 100) / 100,
      };
    });

    return result;
  }, [positions, tradeHistory, schedules, currentUnderlying, historyFilterDate, now, allocatedBalance]);

  const [deletingId, setDeletingId] = useState(null); // id of schedule window pending deletion
  const [notice, setNotice] = useState(null);           // unsaved copy/load message shown above the list
  const [importedFrom, setImportedFrom] = useState(null); // source account name while an import is unsaved
  const [confirmApply, setConfirmApply] = useState(false);
  const [highlightId, setHighlightId] = useState(null);     // window filled from the scanner, until applied

  // Once the edits are saved or cancelled (dirty → clean) there's nothing pending to
  // describe. Adjust-state-during-render: the guard makes it run once per transition.
  const [wasDirty, setWasDirty] = useState(isDirty);
  if (wasDirty !== isDirty) {
    setWasDirty(isDirty);
    if (!isDirty) { setNotice(null); setImportedFrom(null); setHighlightId(null); }
  }

  // Scanner "Send to window" landed here: show its message and highlight + scroll to the
  // filled window until the edit is applied or cancelled.
  const [focusToken, setFocusToken] = useState(null);
  if (focus && focus.token !== focusToken) {
    setFocusToken(focus.token);
    setNotice(focus.text);
    setHighlightId(focus.windowId);
  }
  const itemRefs = useRef({});
  useEffect(() => {
    if (focusToken && highlightId) itemRefs.current[highlightId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusToken, highlightId]);

  const handleImport = useCallback(async (item) => {
    try {
      const ok = await onImportSchedules(item.key);
      if (!ok) { setNotice(`"${item.label}" has no schedule windows to copy.`); return; }
      setImportedFrom(item.label);
      setNotice(`Copied windows from "${item.label}". This account's windows are replaced only after you click Apply — Cancel restores them.`);
    } catch (e) {
      console.error('Import schedules error', e);
      setNotice(`Couldn't copy windows from "${item.label}": ${e.message}`);
    }
  }, [onImportSchedules]);

  const allowHedge = isPaper && strategyVersion >= 2;
  const handleLoadScanner = useCallback((id, windowNo, item) => {
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, ...scannerToWindowFields(item.values, allowHedge) } : s));
    setNotice(`Loaded "${item.label}" into Window ${windowNo}. Click Apply to save.`);
  }, [setSchedules, allowHedge]);

  // Applying an imported set swaps every window at once, which immediately changes caps and
  // exits for positions already open — so ask first in that case.
  const handleApplyClick = () => {
    if (importedFrom && positions.length > 0) setConfirmApply(true);
    else onApply();
  };

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

            const capInfo = derivePaperTypeCap(s);
            const capLine = s.allSameType
              ? `Combined: ${Math.max(0, Math.floor(s.maxCombinedPositions ?? 4))} (${capInfo.text} [All ${(s.sameType || 'call').toUpperCase()}])`
              : `Combined: ${Math.max(0, Math.floor(s.maxCombinedPositions ?? 4))} (${capInfo.text} @ ${s.combinedSplitPct ?? 70}%)`;
            const tooltip = `Window ${i + 1} (${cleanTime(s.startTime)} - ${cleanTime(s.endTime)})\n${capLine}\nStrike Diff: ${s.minStrikeDiff} | Long Dist: ${s.minLongDist} | Min IV: ${s.minIvDiff ?? 5}%\nScaling: ${(s.atmRatioScaling ?? true) ? 'ON' : 'OFF'} (C: ${s.atmRatioPctCall ?? 50}%, P: ${s.atmRatioPctPut ?? 25}%)`;

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
                      Window {i + 1} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
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
                      Window {i + 1} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
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
                  Window {i + 1} ({cleanTime(s.startTime)} - {cleanTime(s.endTime)})
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {onImportSchedules && (
          <PickerButton
            label="Copy from account"
            icon={<Copy size={11} strokeWidth={2.5} />}
            title="Replace these windows with a copy of another account's windows (saved only on Apply)"
            emptyText="No other accounts to copy from"
            getItems={() => copySources.map(a => ({ key: a.id, label: a.name, sub: a.mode }))}
            onPick={handleImport}
          />
        )}
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
      </div>

      {notice && (
        <div style={{
          fontSize: 11, color: '#3b82f6', background: 'rgba(59,130,246,0.08)',
          border: '1px solid rgba(59,130,246,0.3)', borderRadius: 5,
          padding: '6px 10px', marginBottom: 8,
        }}>
          {notice}
        </div>
      )}

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
            <div key={s.id} ref={el => { itemRefs.current[s.id] = el; }} className={`schedule-item ${s.isActive ? '' : 'inactive'}`} style={{
              border: `1.5px solid ${s.isActive ? color : 'var(--border)'}`,
              ...(s.id === highlightId ? { boxShadow: '0 0 0 3px rgba(59,130,246,0.45)' } : {}),
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

                {/* Combined-cap model (migration 027, promoted to LIVE) — Max Combined +
                    Split% govern entry caps for ALL accounts now (paper AND live); the old
                    per-type Calls/Puts inputs are retired. */}
                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Max Combined Positions</span>
                  <CustomInput type="number" min="0" max="40" value={s.maxCombinedPositions ?? 4} onChange={e => handleChange(s.id, 'maxCombinedPositions', Math.max(0, Number(e.target.value)))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label" title="Force all positions in this window to be of a single type (Call or Put), bypassing Split %">All Same Type</span>
                  <div style={{ height: '36px', display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch" title="Toggle single position type (Call or Put) for this window">
                      <input
                        type="checkbox"
                        checked={s.allSameType ?? false}
                        onChange={e => handleChange(s.id, 'allSameType', e.target.checked)}
                      />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>

                {s.allSameType && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label">Position Type</span>
                    <CustomSelect
                      value={s.sameType || 'call'}
                      onChange={val => handleChange(s.id, 'sameType', val)}
                      options={[
                        { label: 'Call', value: 'call' },
                        { label: 'Put', value: 'put' }
                      ]}
                      style={{ width: '100%' }}
                    />
                  </div>
                )}

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label" title={s.allSameType ? "Bypassed: All positions in this window are forced to single type" : "Split percentage for deriving per-type caps"}>Split %</span>
                  <CustomInput type="number" min="1" max="100" suffix="%" step="5" disabled={s.allSameType ?? false} value={s.combinedSplitPct ?? 70} onChange={e => handleChange(s.id, 'combinedSplitPct', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Derived Caps</span>
                  <div style={{
                    fontSize: '11px', fontWeight: 700, color: s.allSameType ? '#3b82f6' : 'var(--text-dim)', height: '36px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '5px',
                    padding: '0 10px', fontFamily: 'JetBrains Mono, monospace', boxSizing: 'border-box', whiteSpace: 'nowrap',
                  }} title={s.allSameType
                    ? `All positions forced to ${(s.sameType || 'call').toUpperCase()} (Max ${derivePaperTypeCap(s).call} calls, ${derivePaperTypeCap(s).put} puts, total combined cap ${Math.max(0, Math.floor(s.maxCombinedPositions ?? 4))}).`
                    : `Per-type cap = ceil(Split% × Max Combined). Max ${derivePaperTypeCap(s).call} calls and ${derivePaperTypeCap(s).put} puts, but no more than ${Math.max(0, Math.floor(s.maxCombinedPositions ?? 4))} open in total.`}>
                    {derivePaperTypeCap(s).text}
                  </div>
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
                  <span className="schedule-item-label" title="Minimum implied volatility difference (%) between buy and sell legs">Min IV Edge</span>
                  <CustomInput type="number" min="0" step="0.25" suffix="%" value={s.minIvDiff ?? 5} onChange={e => handleChange(s.id, 'minIvDiff', Number(e.target.value))} />
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

                {/* SL/TP decoy diff (migration 031) — points to shift the exchange (decoy)
                    SL/TP away from the real exit level, in the harder-to-trigger direction
                    (call: real + diff, put: real − diff). 0 = decoy == real (feature off).
                    Live drives the exchange bracket; paper records real/decoy for validation. */}
                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label" title="Shift the exchange (decoy) SL/TP this many points away from the real exit level (harder-to-trigger direction). 0 = off (decoy = real).">SL/TP Diff</span>
                  <CustomInput type="number" min="0" step="1" suffix="pts" value={s.slTpDecoyDiff ?? 0} onChange={e => handleChange(s.id, 'slTpDecoyDiff', Number(e.target.value))} />
                </div>

                {/* Per-window exit controls (migration 033) — moved here from the global
                    filter panel. Short buy-back threshold + the long-only ladder's Variable
                    mode (with its slice count, shown only when Variable is ON). */}
                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label" title="The short leg's live-ask threshold below which the short is bought back and the long is held.">Short Exit Price</span>
                  <CustomInput type="number" min="0" step="0.1" prefix="$" value={s.shortExitPrice ?? 1.1} onChange={e => handleChange(s.id, 'shortExitPrice', Number(e.target.value))} />
                </div>

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label" htmlFor={`variableExitSlices_${s.id}`} style={{ cursor: 'pointer' }} title="Long-only ladder Variable mode: scale the held long out over N equidistant bid levels up to the recent high, instead of the fixed 5-step ladder.">Variable Exit Slices</span>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <label className="pt-switch">
                      <input type="checkbox" id={`variableExitSlices_${s.id}`} checked={s.variableExitSlices ?? false} onChange={e => handleChange(s.id, 'variableExitSlices', e.target.checked)} />
                      <span className="pt-slider"></span>
                    </label>
                  </div>
                </div>

                {s.variableExitSlices && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label" title="Number of scale-out slices for the held long leg in Variable mode.">Long Exit Slices</span>
                    <CustomInput type="number" min="1" step="1" value={s.longExitSlices ?? 10} onChange={e => handleChange(s.id, 'longExitSlices', Number(e.target.value))} />
                  </div>
                )}

                {/* Per-window Min Days to Expiry (migration 019) — all accounts, paper AND
                    live. The traded expiry follows the active window's DTE. */}
                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Min Days to Expiry</span>
                  <CustomInput type="number" min="0" step="1" value={s.daysToExpiry ?? 0} onChange={e => handleChange(s.id, 'daysToExpiry', Number(e.target.value))} />
                </div>

                {/* Hedge leg — per-spread 3rd long (experimental / strategy_version >= 2).
                    When on, every entered spread (call or put) becomes a long/short/long
                    triplet: a 3rd long beyond the short (call: above, put: below), the strike
                    nearest the short whose price is below Max Hedge Price and whose
                    |IV − short IV| is inside the IV Diff range, sized as that spread's own
                    short qty × Hedge Lot %. It rides the triplet and exits with it (main-strike
                    ATM/ITM/OTM or expiry). Paper accounts only — never shown for live. */}
                {isPaper && strategyVersion >= 2 && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label" title="Add a 3rd long one strike-width beyond the short leg to every spread entered in this window.">Hedge Leg</span>
                    <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                      <label className="pt-switch">
                        <input type="checkbox" id={`hedgeEnabled_${s.id}`} checked={s.hedgeEnabled ?? false} onChange={e => handleChange(s.id, 'hedgeEnabled', e.target.checked)} />
                        <span className="pt-slider"></span>
                      </label>
                    </div>
                  </div>
                )}
                {isPaper && strategyVersion >= 2 && s.hedgeEnabled && (
                  <div className="schedule-item-block schedule-item-num-block">
                    <span className="schedule-item-label" title="Hedge leg quantity as a % of the spread's short-leg quantity.">Hedge Lot %</span>
                    <CustomInput type="number" min="0" max="100" step="1" suffix="%" value={s.hedgeLotPct ?? 0} onChange={e => handleChange(s.id, 'hedgeLotPct', Number(e.target.value))} />
                  </div>
                )}
                {isPaper && strategyVersion >= 2 && s.hedgeEnabled && (
                  <>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label" title="The hedge strike's price must be below this.">Max Hedge Price</span>
                      <CustomInput type="number" min="0" step="1" prefix="$" value={s.hedgeMaxPrice ?? 10} onChange={e => handleChange(s.id, 'hedgeMaxPrice', Number(e.target.value))} />
                    </div>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label" title="|hedge IV − short IV| must be at least this.">Hedge IV Diff Min</span>
                      <CustomInput type="number" min="0" step="0.5" suffix="%" value={s.hedgeIvDiffMin ?? 0} onChange={e => handleChange(s.id, 'hedgeIvDiffMin', Number(e.target.value))} />
                    </div>
                    <div className="schedule-item-block schedule-item-num-block">
                      <span className="schedule-item-label" title="|hedge IV − short IV| must be at most this.">Hedge IV Diff Max</span>
                      <CustomInput type="number" min="0" step="0.5" suffix="%" value={s.hedgeIvDiffMax ?? 2} onChange={e => handleChange(s.id, 'hedgeIvDiffMax', Number(e.target.value))} />
                    </div>
                  </>
                )}

                <div className="schedule-item-block schedule-item-num-block">
                  <span className="schedule-item-label">Max Margin Utilised</span>
                  <div style={{
                    fontSize: '13px', fontWeight: '700', color: '#3b82f6', height: '36px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '5px',
                    padding: '0 10px', fontFamily: 'JetBrains Mono, monospace', boxSizing: 'border-box', whiteSpace: 'nowrap',
                  }} title={avgUtilMap[s.id] !== undefined
                    ? `Peak margin utilised: $${avgUtilMap[s.id].peakMargin.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of $${avgUtilMap[s.id].allocatedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} allocated balance (${avgUtilMap[s.id].pctUtil.toFixed(2)}%)`
                    : 'Historical peak margin utilised in this window as % of allocated balance.'}>
                    {avgUtilMap[s.id] !== undefined
                      ? `${avgUtilMap[s.id].pctUtil.toFixed(2)}%`
                      : '—'}
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

                {/* Load scanner filters + lock (Window 1) or delete button inline */}
                <div className="schedule-item-block" style={{ flex: '0 0 84px', width: '84px', justifyContent: 'flex-end', height: '56px', boxSizing: 'border-box', paddingBottom: '8px', alignItems: 'center' }}>
                  <div style={{ height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                    <PickerButton
                      iconOnly
                      icon={<ScanSearch size={15} strokeWidth={2.5} />}
                      title="Load Ratio Spread Scanner filters into this window"
                      emptyText="No scanner filters found"
                      getItems={() => loadScannerFilterSources().map(src => ({ key: src.name, label: src.name, values: src.values }))}
                      onPick={item => handleLoadScanner(s.id, i + 1, item)}
                    />
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
            onClick={handleApplyClick}
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

      {/* Apply-imported-windows confirmation (only when positions are open) */}
      {confirmApply && (
        <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" style={{ maxWidth: 380, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#f0a020', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={16} strokeWidth={2.5} style={{ transform: 'translateY(-1px)' }} />
              Apply Copied Windows?
            </h3>
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              This account has <strong>{positions.length} open position{positions.length === 1 ? '' : 's'}</strong>. Applying the windows copied from <strong>"{importedFrom}"</strong> replaces all current windows, so caps and exit rules change for them straight away.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
              <button
                type="button"
                onClick={() => setConfirmApply(false)}
                style={{ padding: '7px 14px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => { setConfirmApply(false); onApply(); }}
                style={{ padding: '7px 14px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: '#ffffff', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
              >
                Apply Anyway
              </button>
            </div>
          </div>
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
              Are you sure you want to delete the schedule window <strong>"Window {schedules.findIndex(s => s.id === deletingId) + 1}"</strong>?
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
