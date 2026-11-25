import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp, Target, Columns, Radio, FileSpreadsheet, Gauge, CalendarRange, Activity, BookOpen, Sun, Moon, Menu, X, MoreHorizontal, LayoutGrid, RotateCcw } from 'lucide-react';

// Every dashboard, in display order. The user picks which ones sit in the top bar (desktop) /
// bottom bar (mobile, first 4); the rest live in the sidebar opened from the menu button (top
// left) or "More" (mobile). The pick is stored in this browser (localStorage).
const ALL_TABS = [
  { key: 'scanner', label: 'Ratio Spread', short: 'Ratio', desc: 'Ratio spread scanner', Icon: Target },
  { key: 'calendar', label: 'Calendar Spread', short: 'Calendar', desc: 'Calendar spread scanner', Icon: CalendarRange },
  { key: 'trading', label: 'Paper Trading', short: 'Paper', desc: 'Paper accounts', Icon: Columns },
  { key: 'live', label: 'Live Trading', short: 'Live', desc: 'Live accounts on Delta', Icon: Radio },
  { key: 'report', label: 'Daily Report', short: 'Report', desc: 'Daily P&L per account', Icon: FileSpreadsheet },
  { key: 'slippage', label: 'Slippage', short: 'Slippage', desc: 'Live fills vs expected prices', Icon: Gauge },
  { key: 'iv', label: 'IV Analysis', short: 'IV', desc: 'ATM IV charts and history', Icon: Activity },
  { key: 'manual', label: 'Manual', short: 'Manual', desc: 'Step-by-step guides', Icon: BookOpen },
];
const DEFAULT_TOP = ['scanner', 'calendar', 'trading', 'live'];
const TOP_KEY = 'vitti_nav_top_tabs';
const MOBILE_MAX = 4; // bottom bar slots besides "More"

function readTop() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TOP_KEY) || 'null');
    if (Array.isArray(raw)) {
      const keys = raw.filter(k => ALL_TABS.some(t => t.key === k));
      if (keys.length) return keys;
    }
  } catch { /* storage blocked / bad JSON → default */ }
  return DEFAULT_TOP;
}
function writeTop(keys) {
  try { window.localStorage.setItem(TOP_KEY, JSON.stringify(keys)); } catch { /* not saved; still applies now */ }
}

export default function Navbar({
  activeTab,
  onNavigate,
  theme,
  toggleTheme,
  badgeLabel,
  badgeColor,
  badgeDotClassName,
  extraHeaderContent
}) {
  const [sideOpen, setSideOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [topKeys, setTopKeys] = useState(readTop);
  const pickRef = useRef(null);

  const topTabs = useMemo(() => ALL_TABS.filter(t => topKeys.includes(t.key)), [topKeys]);
  const sideTabs = useMemo(() => ALL_TABS.filter(t => !topKeys.includes(t.key)), [topKeys]);
  const mobileTabs = topTabs.slice(0, MOBILE_MAX);
  // Mobile "More" also holds top-bar picks beyond the 4 bottom slots.
  const mobileMore = ALL_TABS.filter(t => !mobileTabs.includes(t));
  const sideActive = sideTabs.find(t => t.key === activeTab) || null;
  const mobileMoreActive = mobileMore.find(t => t.key === activeTab) || null;

  const toggleTop = (key) => {
    setTopKeys(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      if (!next.length) return prev; // keep at least one dashboard in the top bar
      writeTop(next);
      return next;
    });
  };
  const resetTop = () => { writeTop(DEFAULT_TOP); setTopKeys(DEFAULT_TOP); };

  // Other tabs / pages of the app (each page mounts its own Navbar) pick up a change.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === TOP_KEY) setTopKeys(readTop()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Esc closes the sidebar / picker; a click outside closes the picker.
  useEffect(() => {
    if (!sideOpen && !pickOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setSideOpen(false); setPickOpen(false); } };
    const onDown = (e) => { if (pickOpen && pickRef.current && !pickRef.current.contains(e.target)) setPickOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [sideOpen, pickOpen]);

  const go = (key) => { setSideOpen(false); setPickOpen(false); onNavigate(key); };

  const picker = (
    <div className="nav-pick-panel" role="dialog" aria-label="Choose top bar dashboards">
      <div className="nav-pick-head">
        <span>Top bar dashboards</span>
        <button type="button" className="nav-pick-reset" onClick={resetTop} title="Back to the default four">
          <RotateCcw size={12} /> Reset
        </button>
      </div>
      <div className="nav-pick-hint">Ticked → top bar. The rest → sidebar (☰).</div>
      {ALL_TABS.map(({ key, label, Icon: TabIcon }) => {
        const Icon = TabIcon;
        const on = topKeys.includes(key);
        const last = on && topKeys.length === 1;
        return (
          <label key={key} className={`nav-pick-item ${on ? 'on' : ''}`} title={last ? 'At least one dashboard stays in the top bar' : undefined}>
            <input type="checkbox" checked={on} disabled={last} onChange={() => toggleTop(key)} />
            <Icon size={14} />
            <span>{label}</span>
          </label>
        );
      })}
    </div>
  );

  const sideList = (list, mobileOnly) => list.map(({ key, label, desc, Icon: TabIcon }) => {
    const Icon = TabIcon;
    return (
      <button key={key} type="button" className={`side-nav-item ${activeTab === key ? 'active' : ''} ${mobileOnly ? 'side-nav-mobile-only' : ''}`} onClick={() => go(key)}>
        <span className="side-nav-icon"><Icon size={18} /></span>
        <span className="side-nav-text">
          <span className="side-nav-label">{label}</span>
          <span className="side-nav-desc">{desc}</span>
        </span>
      </button>
    );
  });

  return (
    <>
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className={`nav-menu-btn ${sideActive ? 'active' : ''}`}
            onClick={() => setSideOpen(true)}
            title="More pages"
            aria-label="Open menu"
            aria-expanded={sideOpen}
          >
            <Menu size={18} />
          </button>
          <TrendingUp size={26} color="#00d9a3" style={{ flexShrink: 0 }} />
          <span className="logo-text">VITTI RATIO <span style={{ color: 'var(--accent)' }}>SPREAD</span></span>
        </div>

        <div className="nav-tabs-container">
          {topTabs.map(({ key, label, Icon: TabIcon }) => { const Icon = TabIcon; return (
            <button key={key} className={`nav-tab ${activeTab === key ? 'active' : ''}`} onClick={() => go(key)}>
              <span className="nav-tab-icon" aria-hidden="true">
                <Icon size={14} />
              </span> <span className="nav-tab-text">{label}</span>
            </button>
          ); })}
          {/* A sidebar page is open: show it here too, so the top bar says where you are. */}
          {sideActive && (
            <button className="nav-tab active" onClick={() => setSideOpen(true)} title="More pages">
              <span className="nav-tab-icon" aria-hidden="true">
                <sideActive.Icon size={14} />
              </span> <span className="nav-tab-text">{sideActive.label}</span>
            </button>
          )}
        </div>

        <div className="nav-actions-container">
          {extraHeaderContent}
          <div className="nav-pick" ref={pickRef}>
            <button
              type="button"
              className={`nav-tab ${pickOpen ? 'active' : ''}`}
              onClick={() => setPickOpen(o => !o)}
              title="Choose which dashboards show in the top bar"
              aria-expanded={pickOpen}
              style={{ padding: '6px' }}
            >
              <LayoutGrid size={16} />
            </button>
            {pickOpen && picker}
          </div>
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <Sun size={16} />
            ) : (
              <Moon size={16} />
            )}
          </button>
          <div className="ws-badge">
            <div className={`ws-dot ${badgeDotClassName || ''}`} style={badgeColor ? { background: badgeColor } : undefined} />
            <span>{badgeLabel}</span>
          </div>
        </div>
      </nav>

      <div className="mobile-bottom-nav">
        {mobileTabs.map(({ key, short, Icon: TabIcon }) => { const Icon = TabIcon; return (
          <button key={key} className={`mobile-bottom-tab ${activeTab === key ? 'active' : ''}`} onClick={() => go(key)}>
            <span className="mobile-bottom-icon">
              <Icon size={18} />
            </span>
            <span className="mobile-bottom-text">{short}</span>
          </button>
        ); })}
        <button className={`mobile-bottom-tab ${mobileMoreActive ? 'active' : ''}`} onClick={() => setSideOpen(true)}>
          <span className="mobile-bottom-icon">
            {mobileMoreActive ? <mobileMoreActive.Icon size={18} /> : <MoreHorizontal size={18} />}
          </span>
          <span className="mobile-bottom-text">{mobileMoreActive ? mobileMoreActive.short : 'More'}</span>
        </button>
      </div>

      {sideOpen && (
        <div className="side-nav-backdrop" onClick={() => setSideOpen(false)}>
          <aside className="side-nav" role="dialog" aria-label="More pages" onClick={e => e.stopPropagation()}>
            <div className="side-nav-head">
              <span className="logo-text">VITTI RATIO <span style={{ color: 'var(--accent)' }}>SPREAD</span></span>
              <button type="button" className="nav-menu-btn" onClick={() => setSideOpen(false)} aria-label="Close menu">
                <X size={18} />
              </button>
            </div>
            <div className="side-nav-section">More</div>
            {sideList(sideTabs, false)}
            {/* Mobile: top-bar picks beyond the 4 bottom slots are reached from here. */}
            {sideList(mobileMore.filter(t => !sideTabs.includes(t)), true)}
            {sideTabs.length === 0 && <div className="side-nav-empty">Every dashboard is in the top bar.</div>}
            <button type="button" className="side-nav-customize" onClick={() => { setSideOpen(false); setPickOpen(true); }}>
              <LayoutGrid size={14} /> Customize top bar
            </button>
          </aside>
        </div>
      )}
    </>
  );
}
