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
    <div className="account-selector-strip">
      {/* Account selection and actions group */}
      <div className="account-selector-group">
        <span className="account-selector-label">Account:</span>
        
        <select
          value={activeAccountId || ''}
          onChange={e => setActiveAccountId(e.target.value)}
          className="account-selector-select"
        >
          {accounts.map(acc => (
            <option key={acc.id} value={acc.id} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>
              {acc.name} (${acc.balance?.toLocaleString()})
            </option>
          ))}
        </select>

        <button
          onClick={triggerCreateAccount}
          className="account-selector-btn new-acc"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New Account
        </button>

        {accounts.length > 1 && (
          <button
            onClick={() => triggerDeleteAccount(activeAccountId)}
            className="account-selector-btn delete-acc"
            title="Delete Active Account"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Delete
          </button>
        )}
      </div>

      {/* User profile & Logout Button (Aligned to the Right) */}
      {userProfile && (
        <div className="account-selector-profile-section">
          <span className="account-selector-email">
            {session?.user?.email} 
            {userProfile.role === 'admin' && (
              <span className="account-selector-badge-admin">
                ADMIN
              </span>
            )}
          </span>
          <button
            onClick={handleLogout}
            className="account-selector-logout-btn"
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
