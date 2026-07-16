import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import './index.css'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'
import PaperTrading from './PaperTrading.jsx'
import { useTabSync } from './useTabSync.js'

function Root() {
  const [page, setPage] = useState(() => {
    const path = window.location.pathname.replace(/^\//, '') || 'scanner';
    return ['scanner', 'trading', 'live'].includes(path) ? path : 'scanner';
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
      const validPages = ['scanner', 'trading', 'live'];
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

  return (
    <>
      <div style={{ display: page === 'scanner' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <RatioSpreadScanner onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
      <div style={{ display: page === 'trading' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <PaperTrading mode="paper" onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
      <div style={{ display: page === 'live' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <PaperTrading mode="live" onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Root />)
