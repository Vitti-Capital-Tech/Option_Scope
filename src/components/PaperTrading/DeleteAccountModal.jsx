import React from 'react';

export default function DeleteAccountModal({
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  positions = [],
  activeAccountId,
  accountToDeleteId,
  accounts = []
}) {
  if (!isOpen) return null;

  const accountToDeleteName = accounts.find(a => a.id === accountToDeleteId)?.name || 'this account';
  const hasActivePositions = positions.length > 0 && activeAccountId === accountToDeleteId;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999
    }}>
      <div style={{
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '24px',
        width: '400px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px'
      }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
          Delete Account
        </h3>
        
        <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
          {hasActivePositions ? (
            <span style={{ color: '#f85149', fontWeight: 600 }}>
              ⚠️ WARNING: "{accountToDeleteName}" has active open positions. Deleting this account will permanently delete all open positions for this account. Trade history will be preserved.
            </span>
          ) : (
            `Are you sure you want to delete "${accountToDeleteName}"?`
          )}
        </p>

        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)' }}>
          This action is irreversible. All associated strategy configurations will also be deleted.
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
          <button
            disabled={isDeleting}
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: isDeleting ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isDeleting ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            disabled={isDeleting}
            onClick={onConfirm}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: '#f85149',
              color: '#ffffff',
              cursor: isDeleting ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isDeleting ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isDeleting ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                </svg>
                Deleting...
              </>
            ) : 'Delete Account'}
          </button>
        </div>
      </div>
    </div>
  );
}
