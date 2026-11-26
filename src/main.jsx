import { createRoot } from 'react-dom/client'
import { useState, useEffect, useRef } from 'react'
import './index.css'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'
import CalendarSpreadScanner from './CalendarSpreadScanner.jsx'
import PaperTrading from './PaperTrading.jsx'
import DailyReport from './DailyReport.jsx'
import SlippageReport from './SlippageReport.jsx'
import IvAnalysis from './IvAnalysis.jsx'
import Manual from './Manual.jsx'
import { useTabSync } from './useTabSync.js'
import { AppDialogHost } from './components/common/AppDialog.jsx'
import { SplitContext, readSplit, writeSplit, SPLIT_MIN_WIDTH, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX } from './splitView.js'
import { installSplitResponsive, watchPanes } from './splitResponsive.js'

const PAGES = ['scanner', 'calendar', 'trading', 'live', 'report', 'slippage', 'iv', 'manual'];
// Second dashboard to open when split is turned on and none was remembered.
const SPLIT_DEFAULT_RIGHT = ['live', 'trading', 'scanner'];

function Root() {
  const [page, setPage] = useState(() => {
    const path = window.location.pathname.replace(/^\//, '') || 'scanner';
    return PAGES.includes(path) ? path : 'scanner';
  });
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  // Cross-tab sync: theme stays in sync across tabs
  const { broadcast } = useTabSync({ page, setPage, theme, setTheme });

  // Sync URL path with active page state
  useEffect(() => {
    const currentPath = window.location.pathname.replace(/^\//, '');
    if (currentPath !== page) {
      window.history.pushState(null, '', '/' + page);
    }
  }, [page]);

  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.replace(/^\//, '') || 'scanner';
      if (PAGES.includes(path)) {
        setPage(path);
      } else {
        setPage('scanner');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  // ── Split view (desktop): `page` is the left pane, `split.right` the right pane ──
  const [split, setSplitState] = useState(() => readSplit(PAGES));
  const setSplit = (fn) => setSplitState(prev => { const next = typeof fn === 'function' ? fn(prev) : fn; writeSplit(next); return next; });
  const [wide, setWide] = useState(() => window.matchMedia?.(`(min-width: ${SPLIT_MIN_WIDTH}px)`).matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
    if (!mq) return undefined;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const splitActive = wide && split.on && !!split.right && split.right !== page;
  // Each pane follows the app's tablet / mobile layout for its own width (see splitResponsive.js).
  useEffect(() => { if (splitActive) installSplitResponsive(); }, [splitActive]);
  useEffect(() => {
    if (!splitActive) return undefined;
    return watchPanes(Array.from(document.querySelectorAll('.split-pane')));
  }, [splitActive, page, split.right]);
  const sideOf = (key) => (key === page ? 'left' : splitActive && key === split.right ? 'right' : null);
  const visible = (key) => key === page || (splitActive && key === split.right);

  // Navigation from a page's own navbar changes the pane that page sits in. Opening the
  // dashboard already shown in the other pane swaps the two.
  const navigateFrom = (fromKey) => (to) => {
    if (!splitActive) { setPage(to); return; }
    if (fromKey === split.right) {
      if (to === page) { setPage(split.right); setSplit(s => ({ ...s, right: page })); }
      else setSplit(s => ({ ...s, right: to }));
    } else if (to === split.right) {
      setSplit(s => ({ ...s, right: page }));
      setPage(to);
    } else {
      setPage(to);
    }
  };
  // Turning split off from the right pane keeps that pane's dashboard.
  const toggleSplit = (fromKey) => {
    if (splitActive) {
      if (fromKey === split.right) setPage(split.right);
      setSplit(s => ({ ...s, on: false }));
      return;
    }
    const right = split.right && split.right !== page ? split.right : SPLIT_DEFAULT_RIGHT.find(k => k !== page);
    setSplit(s => ({ ...s, on: true, right }));
  };

  // Divider drag (double-click → 50 / 50).
  const splitRef = useRef(null);
  const startDrag = (e) => {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    document.body.classList.add('split-dragging');
    const move = (ev) => {
      const pct = ((ev.clientX - box.left) / box.width) * 100;
      const ratio = Math.round(Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, pct)) * 10) / 10;
      setSplitState(s => ({ ...s, ratio }));
    };
    const up = () => {
      document.body.classList.remove('split-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSplit(s => ({ ...s })); // persist the final ratio
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const paneStyle = (key) => {
    if (!visible(key)) return { display: 'none', height: '100%', width: '100%' };
    if (!splitActive) return { display: 'block', height: '100%', width: '100%' };
    const left = key === page;
    return { display: 'block', height: '100%', minWidth: 0, flex: `0 0 calc(${left ? split.ratio : 100 - split.ratio}% - 3px)`, order: left ? 0 : 2 };
  };
  const paneClass = (key) => (splitActive && visible(key) ? `split-pane split-pane-${key === page ? 'left' : 'right'}` : undefined);

  // Scanner "Send to window": hand the filters to the matching trading dashboard, which
  // opens that account and fills the window as an unsaved edit (saved only on Apply).
  // `token` makes each send distinct, so the dashboard applies it exactly once.
  const [scannerFill, setScannerFill] = useState(null);
  const sendToWindow = (fill) => {
    setScannerFill({ ...fill, token: Date.now() });
    const target = fill.mode === 'live' ? 'live' : 'trading';
    if (!(splitActive && split.right === target)) navigateFrom(page)(target);
  };

  return (
    <SplitContext.Provider value={{ available: wide, active: splitActive, sideOf, toggle: toggleSplit }}>
      <div ref={splitRef} className={splitActive ? 'split-root' : undefined} style={splitActive ? { display: 'flex', height: '100%', width: '100%' } : { display: 'contents' }}>
      <div className={paneClass('scanner')} style={paneStyle('scanner')}>
        <RatioSpreadScanner onNavigate={navigateFrom('scanner')} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} onSendToWindow={sendToWindow} />
      </div>
      <div className={paneClass('calendar')} style={paneStyle('calendar')}>
        <CalendarSpreadScanner onNavigate={navigateFrom('calendar')} theme={theme} toggleTheme={toggleTheme} />
      </div>
      <div className={paneClass('trading')} style={paneStyle('trading')}>
        <PaperTrading mode="paper" onNavigate={navigateFrom('trading')} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} scannerFill={scannerFill?.mode === 'paper' ? scannerFill : null} />
      </div>
      <div className={paneClass('live')} style={paneStyle('live')}>
        <PaperTrading mode="live" onNavigate={navigateFrom('live')} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} scannerFill={scannerFill?.mode === 'live' ? scannerFill : null} />
      </div>
      <div className={paneClass('report')} style={paneStyle('report')}>
        <DailyReport onNavigate={navigateFrom('report')} theme={theme} toggleTheme={toggleTheme} active={visible('report')} />
      </div>
      <div className={paneClass('slippage')} style={paneStyle('slippage')}>
        <SlippageReport onNavigate={navigateFrom('slippage')} theme={theme} toggleTheme={toggleTheme} active={visible('slippage')} />
      </div>
      <div className={paneClass('iv')} style={paneStyle('iv')}>
        <IvAnalysis onNavigate={navigateFrom('iv')} theme={theme} toggleTheme={toggleTheme} active={visible('iv')} />
      </div>
      <div className={paneClass('manual')} style={paneStyle('manual')}>
        <Manual onNavigate={navigateFrom('manual')} theme={theme} toggleTheme={toggleTheme} />
      </div>
      {splitActive && (
        <div className="split-divider" style={{ order: 1 }} onPointerDown={startDrag}
          onDoubleClick={() => setSplit(s => ({ ...s, ratio: 50 }))}
          role="separator" aria-orientation="vertical" title="Drag to resize · double-click for 50 / 50" />
      )}
      </div>
      {/* In-app alert / confirm dialogs (replace window.alert / window.confirm) */}
      <AppDialogHost />
    </SplitContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<Root />)
