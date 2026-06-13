import React from 'react';

export default function EditAccountModal({
  isOpen,
  onClose,
  onSubmit,
  register,
  errors,
  isSaving
}) {
  if (!isOpen) return null;

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
      <form onSubmit={onSubmit} className="modal-form-edit">
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>Edit Account Details</h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Account Name</label>
          <input
            type="text"
            {...register('name', {
              required: 'Account name is required',
              validate: value => value.trim() !== '' || 'Account name cannot be empty'
            })}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: errors.name ? '1px solid #f85149' : '1px solid var(--border)',
              background: 'var(--bg3)',
              color: 'var(--text)',
              fontSize: '13px',
              outline: 'none'
            }}
          />
          {errors.name && (
            <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
              {errors.name.message}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Balance ($)</label>
          <input
            type="number"
            {...register('balance', {
              required: 'Balance is required',
              valueAsNumber: true,
              validate: value => (!isNaN(value) && value > 0) || 'Balance must be a positive number'
            })}
            style={{
              padding: '8px 12px',
              borderRadius: '6px',
              border: errors.balance ? '1px solid #f85149' : '1px solid var(--border)',
              background: 'var(--bg3)',
              color: 'var(--text)',
              fontSize: '13px',
              outline: 'none'
            }}
          />
          {errors.balance && (
            <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
              {errors.balance.message}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isSaving ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: '#0969da',
              color: '#ffffff',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isSaving ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isSaving ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                </svg>
                Saving...
              </>
            ) : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
