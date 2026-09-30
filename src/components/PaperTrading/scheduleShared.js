// Helpers shared by the trading dashboard (PaperTrading / SchedulePanel) and the Ratio
// Spread Scanner's "Send to window".

// Order schedule windows by start time within the trading session, which begins at
// 17:30 IST (matches the timeline) — so 17:30 comes before 09:00. Stable sort keeps
// windows with the same start in their existing order. Display/persistence only: the
// engine picks the active window by time, not by sort_order. Labels are renumbered to
// match the new position so the timeline, list, history and engine logs all agree.
// Accepts UI windows (`startTime`) or raw DB rows (`start_time`).
export const sortSchedulesByStart = (list) => {
  const key = (s) => {
    const [h, m] = String(s.startTime ?? s.start_time ?? '00:00').split(':').map(Number);
    return (((h || 0) * 60 + (m || 0)) - 1050 + 1440) % 1440;
  };
  return [...list]
    .sort((a, b) => key(a) - key(b))
    .map((s, i) => ({ ...s, label: `Window ${i + 1}` }));
};

// Scanner filter values → the window fields they correspond to. Scanner-only filters
// (ratio deviation, min short premium, max short ratio, ATM P&L/ROI floors) have no
// per-window equivalent and are left out. Hedge fields are copied only where the window
// uses them (paper, strategy v2+).
export function scannerToWindowFields(v, allowHedge) {
  const fields = {
    minStrikeDiff: Number(v.minStrikeDiff),
    minLongDist: Number(v.minLongDist),
    minIvDiff: Number(v.minIvDiff),
    maxNetPremium: Number(v.maxNetPremium),
    atmRatioScaling: !!v.atmRatioScaling,
    atmRatioPctCall: Number(v.atmRatioPctCall),
    atmRatioPctPut: Number(v.atmRatioPctPut),
  };
  if (allowHedge) {
    Object.assign(fields, {
      hedgeEnabled: !!v.hedgeEnabled,
      hedgeLotPct: Number(v.hedgeLotPct),
      hedgeMaxPrice: Number(v.hedgeMaxPrice),
      hedgeIvDiffMin: Number(v.hedgeIvDiffMin),
      hedgeIvDiffMax: Number(v.hedgeIvDiffMax),
    });
  }
  return fields;
}
