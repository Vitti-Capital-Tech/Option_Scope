import React from 'react';
import CustomInput from '../common/CustomInput';
import { TrendingUp, AlertCircle, Loader2 } from 'lucide-react';

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
          <TrendingUp size={48} color="#00d9a3" style={{ flexShrink: 0 }} />
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
            <CustomInput
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
                fontSize: 14,
                outline: 'none',
              }}
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
              <AlertCircle size={14} strokeWidth={2} />
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
                <Loader2 size={14} className="animate-spin" strokeWidth={3} />
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
