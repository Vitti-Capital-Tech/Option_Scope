import React from 'react';

export default function FirstAccountCard({
  onSubmit,
  register,
  errors,
  isCreatingAccount,
  watchAtmRatioScaling
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 120px)', width: '100%', background: 'var(--bg)', padding: '24px 0' }}>
      <div style={{
        width: '100%',
        maxWidth: 760,
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        padding: '40px 36px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 24
      }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'rgba(240, 185, 11, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)'
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
          </div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Create Your First Account</h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)', lineHeight: '1.5', maxWidth: 520 }}>
            To start paper trading, you must create a trading account first. Set up your account name and default strategy filters below.
          </p>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: '24px' }}>
            {/* Left Column: Account Info */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Account Info</h4>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>ACCOUNT NAME</label>
                <input
                  type="text"
                  {...register('name', {
                    required: 'Account name is required',
                    validate: value => value.trim() !== '' || 'Account name cannot be empty'
                  })}
                  placeholder="e.g. My First Account"
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
                      width: '100%'
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

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px' }}>
                <input
                  type="checkbox"
                  id="firstAtmRatioScaling"
                  {...register('atmRatioScaling')}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="firstAtmRatioScaling" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', marginBottom: 0 }}>
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
            <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '1px solid var(--border)', paddingLeft: '24px' }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Default Strategy Filters</h4>
              
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

          <button
            type="submit"
            disabled={isCreatingAccount}
            style={{
              padding: '12px 0',
              borderRadius: 8,
              border: 'none',
              background: 'var(--accent)',
              color: '#000',
              fontWeight: 700,
              fontSize: 14,
              cursor: isCreatingAccount ? 'not-allowed' : 'pointer',
              opacity: isCreatingAccount ? 0.75 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              marginTop: 8
            }}
          >
            {isCreatingAccount ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.2)" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
                Creating Account...
              </>
            ) : (
              'Create Trading Account'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
