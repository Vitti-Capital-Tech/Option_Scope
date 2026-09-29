// Ratio Spread Scanner filter defaults and presets. The scanner's config (localStorage
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

// Built-in presets set the core entry filters only; the ATM-scaling and hedge toggles are
// left as they are. They are starting points to tune from, not recommendations.
export const BUILTIN_PRESETS = [
  {
    id: 'conservative',
    name: 'Conservative',
    values: {
      minStrikeDiff: 1000, minLongDist: 1000, maxSellQty: 6, maxRatioDeviation: 0.15,
      minIvDiff: 6, minSellPremium: 15, maxNetPremium: -10, minAtmPnl: 10, minAtmRoi: 3,
    },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    values: {
      minStrikeDiff: 800, minLongDist: 500, maxSellQty: 10, maxRatioDeviation: 0.25,
      minIvDiff: 5, minSellPremium: 10, maxNetPremium: 0, minAtmPnl: 5, minAtmRoi: 2,
    },
  },
  {
    id: 'aggressive',
    name: 'Aggressive',
    values: {
      minStrikeDiff: 600, minLongDist: 300, maxSellQty: 12, maxRatioDeviation: 0.35,
      minIvDiff: 3, minSellPremium: 5, maxNetPremium: 20, minAtmPnl: 0, minAtmRoi: 0,
    },
  },
];

// User-saved presets (full snapshot of every SCANNER_DEFAULTS key), per browser.
export const CUSTOM_PRESETS_KEY = 'vitti_scanner_presets_v1';
