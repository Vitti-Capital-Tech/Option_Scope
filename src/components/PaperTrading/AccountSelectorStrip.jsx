import React from 'react';

export default function AccountSelectorStrip({
  accounts,
  activeAccountId,
  setActiveAccountId,
  triggerCreateAccount,
  triggerDeleteAccount,
  userProfile,
  session,
  handleLogout
}) {
  return (
    <div className="account-selector-strip" style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 20px',
      background: 'var(--bg2)',
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      whiteSpace: 'nowrap'
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account:</span>
      
      <select
        value={activeAccountId || ''}
        onChange={e => setActiveAccountId(e.target.value)}
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          background: 'var(--bg3)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          outline: 'none',
          width: '180px'
        }}
      >
        {accounts.map(acc => (
          <option key={acc.id} value={acc.id} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>
            {acc.name} (${acc.balance})
          </option>
        ))}
      </select>

      <button
        onClick={triggerCreateAccount}
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--text-dim)',
          border: '1px dashed var(--border)',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4
        }}
      >
        + New Account
      </button>

      {accounts.length > 1 && (
        <button
          onClick={() => triggerDeleteAccount(activeAccountId)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            background: 'transparent',
            color: '#f85149',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4
          }}
          title="Delete Active Account"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          Delete
        </button>
      )}

      {/* User profile & Logout Button (Aligned to the Right) */}
      {userProfile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          <span style={{ fontSize: 12, color: 'var(--text-dim)', opacity: 0.8, display: 'inline-flex', alignItems: 'center' }}>
            {session?.user?.email} 
            {userProfile.role === 'admin' && (
              <span style={{ 
                padding: '2px 6px', 
                borderRadius: '4px', 
                fontSize: '10px', 
                fontWeight: 600, 
                background: 'rgba(9, 105, 218, 0.15)', 
                color: '#0969da', 
                border: '1px solid rgba(9, 105, 218, 0.25)',
                marginLeft: 8 
              }}>
                ADMIN
              </span>
            )}
          </span>
          <button
            onClick={handleLogout}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-dim)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            Logout
          </button>
        </div>
      )}
    </div>
  );
}
