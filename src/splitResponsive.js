// Split view: make each pane use the app's responsive (tablet / mobile) layout for ITS OWN width.
//
// The stylesheets are written with viewport media queries (`@media (max-width: 900px)`), which
// look at the whole screen — a half-screen pane on a 1920px monitor would keep the desktop
// layout. This mirrors every max-width media block as the same rules scoped to a pane class
// (`.split-pane.sr-900-0 …`), and a ResizeObserver puts that class on a pane while the PANE is
// that narrow. Built at runtime from the loaded CSS, so it can never drift from index.css.
//
// Why classes and not CSS container queries: `container-type` gives the pane layout
// containment, which turns it into the containing block for `position: fixed` descendants —
// dropdowns / tooltips / modals placed from viewport coordinates would land offset in the
// right pane.
//
// Left out: phone-only chrome that must not live inside a pane — the fixed bottom tab bar
// (each pane keeps its own top bar), the padding reserved for it, the split button itself, and
// any rule that pins an element to the viewport (position: fixed).

const STYLE_ID = 'split-responsive';
const SKIP_SELECTOR = /mobile-bottom|nav-tabs-container|nav-split-btn/;
const ROOT_ONLY = /^\s*(html|body|#root|:root)\s*$/;
// Leading `body.light-theme` / `html` compound: the pane class goes after it, not before.
const ROOT_PREFIX = /^\s*((?:html|body)(?:[.#:[][^\s>+~]*)?)\s+(.+)$/;

let conditions = []; // [{ cls, max, min }]

function parseCondition(mediaText) {
  const t = String(mediaText || '').trim();
  if (/prefers-|print|hover|pointer|orientation|height|aspect|resolution/.test(t)) return null;
  const max = t.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
  if (!max) return null;
  const min = t.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
  return { max: Number(max[1]), min: min ? Number(min[1]) : 0 };
}

function keepRule(rule) {
  if (!rule.selectorText || !rule.style) return false;
  if (SKIP_SELECTOR.test(rule.selectorText)) return false;
  if (rule.style.position === 'fixed') return false;
  // Space kept free for the phone bottom bar, which panes don't have.
  if (rule.style.paddingBottom === '56px' && /scanner-body|trading-body/.test(rule.selectorText)) return false;
  return true;
}

function scope(selectorText, cls) {
  const parts = [];
  for (const sel of selectorText.split(',')) {
    if (ROOT_ONLY.test(sel)) continue;
    const m = sel.match(ROOT_PREFIX);
    parts.push(m ? `${m[1]} .split-pane.${cls} ${m[2]}` : `.split-pane.${cls} ${sel.trim()}`);
  }
  return parts.join(', ');
}

// (Re)build the mirror — called when split view turns on, so it reflects the CSS loaded now.
export function installSplitResponsive() {
  if (typeof document === 'undefined') return;
  const out = [];
  const seen = new Map();
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode?.id === STYLE_ID) continue;
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin (fonts) — not ours
    for (const rule of Array.from(rules || [])) {
      if (rule.type !== CSSRule.MEDIA_RULE) continue;
      const c = parseCondition(rule.media?.mediaText);
      if (!c) continue;
      const cls = `sr-${c.max}-${c.min}`.replace(/\./g, '_');
      if (!seen.has(cls)) seen.set(cls, { cls, ...c });
      for (const inner of Array.from(rule.cssRules)) {
        if (inner.type !== CSSRule.STYLE_RULE || !keepRule(inner)) continue;
        const sel = scope(inner.selectorText, cls);
        if (sel) out.push(`${sel} { ${inner.style.cssText} }`);
      }
    }
  }
  conditions = [...seen.values()];
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = out.join('\n');
}

// Put the matching width classes on a pane (and `split-narrow` ≤ 900px for the trimmed top bar).
export function applyPaneWidth(el, width) {
  if (!el) return;
  for (const c of conditions) el.classList.toggle(c.cls, width <= c.max && width >= c.min);
  el.classList.toggle('split-narrow', width <= 900);
}

// Observe the visible panes; returns a cleanup.
export function watchPanes(panes) {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(entries => {
    for (const e of entries) applyPaneWidth(e.target, e.contentRect.width);
  });
  panes.forEach(p => { applyPaneWidth(p, p.getBoundingClientRect().width); ro.observe(p); });
  return () => ro.disconnect();
}
