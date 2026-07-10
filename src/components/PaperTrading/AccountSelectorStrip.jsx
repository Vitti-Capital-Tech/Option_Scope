import React, { useState, useEffect, useRef } from 'react';

function LiveBadge({ account }) {
  if (!account || account.mode !== 'live') return null;
  const armed = !!account.live_enabled;
  return (
    <span
      title={armed ? 'Live — real orders armed' : 'Live — credentials linked, orders disarmed'}
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.06em',
        padding: '1px 5px',
        borderRadius: 4,
        marginLeft: 6,
        color: armed ? '#0d1117' : '#3b82f6',
        background: armed ? '#3fb950' : 'transparent',
        border: armed ? 'none' : '1px solid #3b82f6'
      }}
    >
      {armed ? 'LIVE ●' : 'LIVE'}
    </span>
  );
}

function PausedBadge({ account }) {
  if (!account?.paused) return null;
  return (
    <span
      title="Paused — no new positions; open ones still managed"
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
        padding: '1px 5px', borderRadius: 4, marginLeft: 6,
        color: '#3b82f6', background: 'transparent', border: '1px solid #3b82f6',
      }}
    >
      PAUSED
    </span>
  );
}

const ctrlBtn = (bg, color) => ({
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: bg, color, cursor: 'pointer', fontSize: 11, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 4,
});

export default function AccountSelectorStrip({
  accounts,
  activeAccountId,
  setActiveAccountId,
  triggerCreateAccount,
  triggerDeleteAccount,
  triggerStartLive,
  triggerDisarmLive,
  triggerPauseAccount,
  triggerResumeAccount,
  engineDryRun,
  userProfile,
  session,
  handleLogout
}) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const activeAccount = accounts.find(acc => acc.id === activeAccountId);

  return (

    <div className="account-selector-strip">
      {/* Account selection and actions group */}
      <div className="account-selector-group">
        <span className="account-selector-label">Account:</span>
        
        <div className="account-dropdown-container" ref={dropdownRef}>
          <button 
            type="button"
            className="account-dropdown-trigger" 
            onClick={() => setIsOpen(!isOpen)}
          >
            <div className="account-dropdown-trigger-content">
              <svg className="account-icon-avatar" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span className="account-dropdown-name">{activeAccount?.name || 'Select Account'}</span>
              {/* One status badge only. PAUSED takes precedence over LIVE — a paused
                  account is not actively trading, so showing "LIVE" too would be
                  misleading. (Real-money status stays visible via the REAL ORDERS /
                  Disarm controls and the market-row badge.) */}
              {activeAccount?.paused
                ? <PausedBadge account={activeAccount} />
                : <LiveBadge account={activeAccount} />}
            </div>
            <svg 
              className="account-chevron-icon" 
              width="12" 
              height="12" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2.5"
              style={{
                transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease'
              }}
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>

          {isOpen && (
            <div className="account-dropdown-menu">
              <div className="account-dropdown-menu-header">Select Trading Account</div>
              <div className="account-dropdown-list">
                {accounts.map(acc => {
                  const isSelected = acc.id === activeAccountId;
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      className={`account-dropdown-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveAccountId(acc.id);
                        setIsOpen(false);
                      }}
                    >
                      <div className="account-dropdown-item-left">
                        <svg className="account-dropdown-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <line x1="9" y1="3" x2="9" y2="21"></line>
                        </svg>
                        <span>{acc.name}</span>
                        {acc.paused
                          ? <PausedBadge account={acc} />
                          : <LiveBadge account={acc} />}
                      </div>
                      {isSelected && (
                        <svg className="account-selected-checkmark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

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

        {/* Live account controls (arm / pause) — live accounts only */}
        {activeAccount?.mode === 'live' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
            {/* Execution mode: only meaningful once armed */}
            {activeAccount.live_enabled && (
              engineDryRun === false ? (
                <span title="Engine is placing REAL orders on Delta" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '3px 7px', borderRadius: 5, color: '#fff', background: '#f85149' }}>
                  ● REAL ORDERS
                </span>
              ) : engineDryRun === true ? (
                <span title="Armed, but engine is in DRY-RUN — orders are simulated, nothing hits Delta" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '3px 7px', borderRadius: 5, color: '#3b82f6', background: 'transparent', border: '1px solid #3b82f6' }}>
                  DRY-RUN
                </span>
              ) : (
                <span title="Engine offline or unknown — can't confirm execution mode" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '3px 7px', borderRadius: 5, color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border)' }}>
                  MODE ?
                </span>
              )
            )}
            {!activeAccount.live_enabled ? (
              <button type="button" style={ctrlBtn('#238636', '#fff')} title="Arm real order execution for this account"
                onClick={() => triggerStartLive(activeAccountId)}>
                ▶ Start Live
              </button>
            ) : (
              <button type="button" style={ctrlBtn('transparent', '#f85149')} title="Stop arming — no more real orders"
                onClick={() => triggerDisarmLive(activeAccountId)}>
                ■ Disarm
              </button>
            )}
            {!activeAccount.paused ? (
              <button type="button" style={ctrlBtn('transparent', 'var(--text)')} title="Stop new entries; keep managing open positions"
                onClick={() => triggerPauseAccount(activeAccountId)}>
                ⏸ Pause
              </button>
            ) : (
              <button type="button" style={ctrlBtn('#238636', '#fff')} title="Resume opening new positions"
                onClick={() => triggerResumeAccount(activeAccountId)}>
                ▶ Resume
              </button>
            )}
          </div>
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
            onClick={() => setShowLogoutConfirm(true)}
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

      {showLogoutConfirm && (
        <div className="modal-overlay-wrapper" onClick={() => setShowLogoutConfirm(false)}>
          <div className="modal-container-delete" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '380px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
              Confirm Logout
            </h3>
            
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              Are you sure you want to sign out of your account?
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                onClick={() => setShowLogoutConfirm(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLogoutConfirm(false);
                  handleLogout();
                }}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#f85149',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500
                }}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
