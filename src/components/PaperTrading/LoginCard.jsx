import React from 'react';

export default function LoginCard({ authEmail, setAuthEmail, authError, isAuthenticating, handleAuthSubmit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 120px)', width: '100%', background: 'var(--bg)' }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '40px 36px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 28
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <svg width="48" height="48" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="#0d1117" />
            <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
            <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
            <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
            <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
            <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
            <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
            <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
            <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
            <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
            <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
          </svg>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.04em', color: 'var(--text)' }}>
              VITTI OPTION<span style={{ color: 'var(--accent)' }}>SCOPE</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Paper Trading Workstation</div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>EMAIL ADDRESS</label>
            <input
              id="auth-email"
              type="email"
              value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg3)',
                color: 'var(--text)',
                fontSize: 14,
                outline: 'none',
                transition: 'border-color 0.2s'
              }}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'}
            />
          </div>

          {authError && (
            <div style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: 'rgba(248, 81, 73, 0.1)',
              border: '1px solid rgba(248, 81, 73, 0.3)',
              color: '#f85149',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {authError}
            </div>
          )}

          <button
            id="auth-submit-btn"
            type="submit"
            disabled={isAuthenticating}
            style={{
              padding: '12px 0',
              borderRadius: 8,
              border: 'none',
              background: 'var(--accent)',
              color: '#000',
              fontWeight: 700,
              fontSize: 14,
              cursor: isAuthenticating ? 'not-allowed' : 'pointer',
              opacity: isAuthenticating ? 0.75 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'opacity 0.2s'
            }}
          >
            {isAuthenticating ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.2)" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
                Logging In...
              </>
            ) : (
              'Log In'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
