import { createContext, useContext } from 'react';

// Split view (desktop only): two dashboards side by side. Root (main.jsx) owns the state and
// provides it here; each page's Navbar reads it to show the split toggle and to know which
// pane it sits in. The choice is kept in this browser (localStorage).
export const SPLIT_KEY = 'vitti_split_view';
export const SPLIT_MIN_WIDTH = 1100; // px — narrower screens always show one dashboard
export const SPLIT_RATIO_MIN = 25;
export const SPLIT_RATIO_MAX = 75;

export function readSplit(validPages) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SPLIT_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const ratio = Number(raw.ratio);
      return {
        on: !!raw.on,
        right: validPages.includes(raw.right) ? raw.right : null,
        ratio: Number.isFinite(ratio) ? Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)) : 50,
      };
    }
  } catch { /* storage blocked / bad JSON → default */ }
  return { on: false, right: null, ratio: 50 };
}

export function writeSplit(state) {
  try { window.localStorage.setItem(SPLIT_KEY, JSON.stringify(state)); } catch { /* not saved; still applies now */ }
}

// { available, active, sideOf(key) → 'left' | 'right' | null, toggle(fromKey) }
export const SplitContext = createContext({ available: false, active: false, sideOf: () => null, toggle: () => {} });
export const useSplit = () => useContext(SplitContext);
