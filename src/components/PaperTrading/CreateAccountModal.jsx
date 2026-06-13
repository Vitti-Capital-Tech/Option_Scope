import React from 'react';

export default function CreateAccountModal({
  isOpen,
  onClose,
  onSubmit,
  register,
  errors,
  isCreating,
  watchAtmRatioScaling,
  profiles,
  userRole
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
      <form onSubmit={onSubmit} className="modal-form-create">
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text)', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>Create New Trading Account</h3>
        
        <div className="modal-columns-create">
          {/* Left Column: Account Details */}
          <div className="modal-col-left-create">
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Account Info</h4>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>ACCOUNT NAME</label>
              <input
                type="text"
                {...register('name', {
                  required: 'Account name is required',
                  validate: value => value.trim() !== '' || 'Account name cannot be empty'
                })}
                placeholder="e.g. My Paper Account"
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: errors.name ? '1px solid #f85149' : '1px solid var(--border)',
                  background: 'var(--bg3)',
                  color: 'var(--text)',
                  fontSize: 13,
                  outline: 'none'
                }}
              />
              {errors.name && (
                <span style={{ fontSize: 11, color: '#f85149', marginTop: 2 }}>
                  {errors.name.message}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Underlying</label>
                <select
                  {...register('underlying')}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none',
                    width: '100%',
                    cursor: 'pointer'
                  }}
                >
                  <option value="BTC">BTC</option>
                  <option value="ETH">ETH</option>
                </select>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Days to Expiry</label>
                <input
                  type="number"
                  {...register('daysToExpiry', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            {/* Admin Only Owner selector */}
            {userRole === 'admin' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Owner (Admin Only)</label>
                <select
                  {...register('ownerId')}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none',
                    width: '100%',
                    cursor: 'pointer'
                  }}
                >
                  <option value="">Default (Self)</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.email}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px' }}>
              <input
                type="checkbox"
                id="modalAtmRatioScaling"
                {...register('atmRatioScaling')}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="modalAtmRatioScaling" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', marginBottom: 0 }}>
                ATM Ratio Entry
              </label>
            </div>

            {watchAtmRatioScaling && (
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Call ATM Pct (%)</label>
                  <input
                    type="number"
                    {...register('atmRatioPctCall', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 13,
                      outline: 'none'
                    }}
                  />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Put ATM Pct (%)</label>
                  <input
                    type="number"
                    {...register('atmRatioPctPut', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 13,
                      outline: 'none'
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Default Strategy Filters */}
          <div className="modal-col-right-create">
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Default Strategy Filters</h4>
            
            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Strike Diff ($)</label>
                <input
                  type="number"
                  {...register('minStrikeDiff', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min IV Diff (%)</label>
                <input
                  type="number"
                  {...register('minIvDiff', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio Dev</label>
                <input
                  type="number"
                  step="0.01"
                  {...register('maxRatioDeviation', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Sell Premium ($)</label>
                <input
                  type="number"
                  {...register('minSellPremium', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Debit ($)</label>
                <input
                  type="number"
                  {...register('maxNetPremium', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Long Dist</label>
                <input
                  type="number"
                  {...register('minLongDist', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio (1:X)</label>
              <input
                type="number"
                step="0.25"
                {...register('maxSellQty', { valueAsNumber: true })}
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg3)',
                  color: 'var(--text)',
                  fontSize: 13,
                  outline: 'none',
                  width: '100%'
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '8px' }}>
          <button
            type="button"
            disabled={isCreating}
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: isCreating ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isCreating ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isCreating}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: 'var(--accent)',
              color: '#000',
              cursor: isCreating ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 700,
              opacity: isCreating ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isCreating ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.25)" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="#000" />
                </svg>
                Creating...
              </>
            ) : 'Create Account'}
          </button>
        </div>
      </form>
    </div>
  );
}
