import React, { useEffect, useRef, useState } from 'react';
import {
  TrendingUp, Target, Columns, Radio, FileSpreadsheet, Gauge, CalendarRange, Activity, Orbit,
  BookOpen, Sun, Moon, ChevronDown, ScanSearch, LineChart, Check,
} from 'lucide-react';

// Pages grouped into four menus so the bar stays short as pages are added. A group button
// shows the page you are on ("Trading · Cosmic Paper"); a single-page group is a plain link.
const NAV_GROUPS = [
  {
    key: 'scanners', label: 'Scanners', icon: ScanSearch, items: [
      { page: 'scanner', label: 'Ratio Spread', icon: Target },
      { page: 'calendar', label: 'Calendar Spread', icon: CalendarRange },
    ],
  },
  {
    key: 'trading', label: 'Trading', icon: Columns, items: [
      { page: 'trading', label: 'Paper Trading', hint: 'Delta', icon: Columns },
      { page: 'cosmic', label: 'Cosmic Paper', hint: 'Cosmic Trade', icon: Orbit },
      { page: 'live', label: 'Live Trading', hint: 'Delta', icon: Radio },
    ],
  },
  {
    key: 'reports', label: 'Reports', icon: LineChart, items: [
      { page: 'report', label: 'Daily Report', icon: FileSpreadsheet },
      { page: 'slippage', label: 'Slippage', icon: Gauge },
      { page: 'iv', label: 'IV Analysis', icon: Activity },
    ],
  },
  { key: 'manual', label: 'Manual', icon: BookOpen, items: [{ page: 'manual', label: 'Manual', icon: BookOpen }] },
];

// One group: a plain button when it holds one page, otherwise a button + menu.
function NavGroup({ group, activeTab, onNavigate, mobile }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = group.items.find(i => i.page === activeTab);
  const single = group.items.length === 1;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (page) => { setOpen(false); onNavigate(page); };
  const Icon = (active && !mobile ? active.icon : group.icon);

  const button = mobile ? (
    <button type="button" className={`mobile-bottom-tab ${active ? 'active' : ''}`}
      onClick={() => (single ? go(group.items[0].page) : setOpen(o => !o))}
      aria-haspopup={single ? undefined : 'menu'} aria-expanded={single ? undefined : open}>
      <span className="mobile-bottom-icon"><Icon size={18} /></span>
      <span className="mobile-bottom-text">{group.label}</span>
    </button>
  ) : (
    <button type="button" className={`nav-tab ${active ? 'active' : ''}`}
      onClick={() => (single ? go(group.items[0].page) : setOpen(o => !o))}
      aria-haspopup={single ? undefined : 'menu'} aria-expanded={single ? undefined : open}
      title={active && !single ? `${group.label}: ${active.label}` : group.label}>
      <span className="nav-tab-icon" aria-hidden="true"><Icon size={14} /></span>
      <span className="nav-tab-text">
        {group.label}
        {active && !single && <span className="nav-group-current"> · {active.label}</span>}
      </span>
      {!single && <ChevronDown size={13} className={`nav-group-chevron${open ? ' open' : ''}`} aria-hidden="true" />}
    </button>
  );

  return (
    <div className={`nav-group${mobile ? ' mobile' : ''}`} ref={ref}>
      {button}
      {open && !single && (
        <div className={`nav-menu${mobile ? ' up' : ''}`} role="menu" aria-label={group.label}>
          {group.items.map(item => {
            const ItemIcon = item.icon;
            const on = item.page === activeTab;
            return (
              <button key={item.page} type="button" role="menuitem" className={`nav-menu-item${on ? ' on' : ''}`}
                aria-current={on ? 'page' : undefined} onClick={() => go(item.page)}>
                <ItemIcon size={15} aria-hidden="true" />
                <span className="nav-menu-label">{item.label}</span>
                {item.hint && <span className="nav-menu-hint">{item.hint}</span>}
                {on && <Check size={14} className="nav-menu-check" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  return (
    <>
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TrendingUp size={26} color="#00d9a3" style={{ flexShrink: 0 }} />
          <span className="logo-text">VITTI RATIO <span style={{ color: 'var(--accent)' }}>SPREAD</span></span>
        </div>

        <div className="nav-tabs-container">
          {NAV_GROUPS.map(g => <NavGroup key={g.key} group={g} activeTab={activeTab} onNavigate={onNavigate} />)}
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
        {NAV_GROUPS.map(g => <NavGroup key={g.key} group={g} activeTab={activeTab} onNavigate={onNavigate} mobile />)}
      </div>
    </>
  );
}
