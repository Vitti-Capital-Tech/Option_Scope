import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import './index.css'
import App from './App.jsx'
import RatioSpreadScanner from './RatioSpreadScanner.jsx'

function Root() {
  const [page, setPage] = useState('charts');

  if (page === 'scanner') {
    return <RatioSpreadScanner onNavigate={setPage} />;
  }
  return <App onNavigate={setPage} />;
}

createRoot(document.getElementById('root')).render(<Root />)
