import React, { useEffect, useState } from 'react';
import { TrendingUp, Target, Columns, Radio, FileSpreadsheet, Gauge, CalendarRange, Activity, BookOpen, Sun, Moon, Menu, X, MoreHorizontal } from 'lucide-react';

// Main tabs stay in the top bar (desktop) and the bottom bar (mobile); the rest live in the
// sidebar opened from the menu button (top left) or "More" (mobile bottom bar).
const MAIN_TABS = [
  { key: 'scanner', label: 'Ratio Spread', short: 'Ratio', Icon: Target },
  { key: 'calendar', label: 'Calendar Spread', short: 'Calendar', Icon: CalendarRange },
  { key: 'trading', label: 'Paper Trading', short: 'Paper', Icon: Columns },
  { key: 'live', label: 'Live Trading', short: 'Live', Icon: Radio },
];
const SIDE_TABS = [
  { key: 'report', label: 'Daily Report', desc: 'Daily P&L per account', Icon: FileSpreadsheet },
  { key: 'slippage', label: 'Slippage', desc: 'Live fills vs expected prices', Icon: Gauge },
  { key: 'iv', label: 'IV Analysis', desc: 'ATM IV charts and history', Icon: Activity },
  { key: 'manual', label: 'Manual', desc: 'Step-by-step guides', Icon: BookOpen },
];

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
  const sideActive = SIDE_TABS.find(t => t.key === activeTab) || null;

  // Esc closes the sidebar.
  useEffect(() => {
    if (!sideOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSideOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sideOpen]);

  const go = (key) => { setSideOpen(false); onNavigate(key); };

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
          {MAIN_TABS.map(({ key, label, Icon: TabIcon }) => { const Icon = TabIcon; return (
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
        {MAIN_TABS.map(({ key, short, Icon: TabIcon }) => { const Icon = TabIcon; return (
          <button key={key} className={`mobile-bottom-tab ${activeTab === key ? 'active' : ''}`} onClick={() => go(key)}>
            <span className="mobile-bottom-icon">
              <Icon size={18} />
            </span>
            <span className="mobile-bottom-text">{short}</span>
          </button>
        ); })}
        <button className={`mobile-bottom-tab ${sideActive ? 'active' : ''}`} onClick={() => setSideOpen(true)}>
          <span className="mobile-bottom-icon">
            {sideActive ? <sideActive.Icon size={18} /> : <MoreHorizontal size={18} />}
          </span>
          <span className="mobile-bottom-text">{sideActive ? sideActive.label : 'More'}</span>
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
            {SIDE_TABS.map(({ key, label, desc, Icon: TabIcon }) => { const Icon = TabIcon; return (
              <button key={key} type="button" className={`side-nav-item ${activeTab === key ? 'active' : ''}`} onClick={() => go(key)}>
                <span className="side-nav-icon"><Icon size={18} /></span>
                <span className="side-nav-text">
                  <span className="side-nav-label">{label}</span>
                  <span className="side-nav-desc">{desc}</span>
                </span>
              </button>
            ); })}
          </aside>
        </div>
      )}
    </>
  );
}
