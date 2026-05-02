import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import './index.css'
import App from './App.jsx'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'
import PaperTrading from './PaperTrading.jsx'
import { useTabSync } from './useTabSync.js'

function Root() {
  const [page, setPage] = useState('charts');
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  // Cross-tab sync: page navigation + theme stay in sync across tabs
  const { broadcast } = useTabSync({ page, setPage, theme, setTheme });

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
      <div style={{ display: page === 'charts' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <App onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
      <div style={{ display: page === 'scanner' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <RatioSpreadScanner onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
      <div style={{ display: page === 'trading' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <PaperTrading onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} broadcast={broadcast} />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Root />)
