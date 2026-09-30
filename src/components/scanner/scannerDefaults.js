// Ratio Spread Scanner filter defaults. The scanner's config (localStorage
// `vitti_algo_config`) starts from SCANNER_DEFAULTS; Reset returns every field to it.
export const SCANNER_DEFAULTS = {
  minStrikeDiff: 800,
  minIvDiff: 5,
  maxRatioDeviation: 0.25,
  minSellPremium: 10,
  maxNetPremium: 20,
  minLongDist: 500,
  maxSellQty: 10,
  // ATM Edge (P&L) column floors — keep only spreads whose at-ATM P&L and ROI clear
  // these minimums. Applied live in ResultTable against the ATM-priced P&L/ROI.
  minAtmPnl: 0,
  minAtmRoi: 0,
  atmRatioScaling: false,
  atmRatioPctCall: 50,
  atmRatioPctPut: 50,
  // Hedge leg — each spread's 3rd long: beyond the short, the strike nearest it whose
  // price is below hedgeMaxPrice and whose |IV − short IV| is in [hedgeIvDiffMin,
  // hedgeIvDiffMax]; sized as short qty × hedgeLotPct. The same leg paper trading adds
  // when its window's Hedge toggle is on.
  hedgeEnabled: false,
  hedgeLotPct: 50,
  hedgeMaxPrice: 10,
  hedgeIvDiffMin: 0,
  hedgeIvDiffMax: 2,
};

// The scanner's live filter config, per browser.
export const SCANNER_CONFIG_KEY = 'vitti_algo_config';

// The user's saved filter settings (full snapshots of every SCANNER_DEFAULTS key), per browser.
export const SAVED_SETTINGS_KEY = 'vitti_scanner_presets_v1';

// Filter sets a schedule window can copy from: the scanner's current filters first,
// then each saved setting. Read fresh on each call so it reflects the scanner right now.
export function loadScannerFilterSources() {
  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  };
  const current = read(SCANNER_CONFIG_KEY);
  const saved = read(SAVED_SETTINGS_KEY);
  return [
    { name: 'Current scanner filters', values: { ...SCANNER_DEFAULTS, ...(current || {}) } },
    ...(Array.isArray(saved) ? saved : [])
      .filter(p => p && p.name && p.values)
      .map(p => ({ name: p.name, values: { ...SCANNER_DEFAULTS, ...p.values } })),
  ];
}
