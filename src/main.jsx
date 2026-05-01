import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import './index.css'
import App from './App.jsx'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'

function Root() {
  const [page, setPage] = useState('charts');
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  return (
    <>
      <div style={{ display: page === 'charts' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <App onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} />
      </div>
      <div style={{ display: page === 'scanner' ? 'block' : 'none', height: '100%', width: '100%' }}>
        <RatioSpreadScanner onNavigate={setPage} theme={theme} toggleTheme={toggleTheme} />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Root />)
