import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import './index.css'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'
import PaperTrading from './PaperTrading.jsx'
import DailyReport from './DailyReport.jsx'
import { useTabSync } from './useTabSync.js'
import { AppDialogHost } from './components/common/AppDialog.jsx'

function Root() {
  const [page, setPage] = useState(() => {
    const path = window.location.pathname.replace(/^\//, '') || 'scanner';
    return ['scanner', 'trading', 'live', 'report'].includes(path) ? path : 'scanner';
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
      const validPages = ['scanner', 'trading', 'live', 'report'];
      if (validPages.includes(path)) {
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

  // Scanner "Send to window": hand the filters to the matching trading dashboard, which
  // opens that account and fills the window as an unsaved edit (saved only on Apply).
  // `token` makes each send distinct, so the dashboard applies it exactly once.
  const [scannerFill, setScannerFill] = useState(null);
  const sendToWindow = (fill) => {
    setScannerFill({ ...fill, token: Date.now() });
    setPage(fill.mode === 'live' ? 'live' : 'trading');
  };

  return (
    <>
      <div style={{ display: page === 'scanner' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <RatioSpreadScanner onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} onSendToWindow={sendToWindow} />
      </div>
      <div style={{ display: page === 'trading' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <PaperTrading mode="paper" onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} scannerFill={scannerFill?.mode === 'paper' ? scannerFill : null} />
      </div>
      <div style={{ display: page === 'live' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <PaperTrading mode="live" onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} scannerFill={scannerFill?.mode === 'live' ? scannerFill : null} />
      </div>
      <div style={{ display: page === 'report' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <DailyReport onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} active={page === 'report'} />
      </div>
      {/* In-app alert / confirm dialogs (replace window.alert / window.confirm) */}
      <AppDialogHost />
    </>
  );
}

createRoot(document.getElementById('root')).render(<Root />)
