import React from 'react';
import { Loader2 } from 'lucide-react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import DeltaCredentialsSection from './DeltaCredentialsSection';

export default function CreateAccountModal({
  isOpen,
  onClose,
  onSubmit,
  register,
  errors,
  isCreating,
  watchAtmRatioScaling,
  watchCreateExitType,
  profiles,
  userRole,
  setValue,
  watch,
  mode = 'paper'
}) {
  if (!isOpen) return null;

  const watchVariableExitSlices = watch('variableExitSlices');

  return (
    <div className="modal-overlay-wrapper">
      <form onSubmit={onSubmit} className="modal-form-create">
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: 'var(--text)', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
          {mode === 'live' ? 'Create New Live Trading Account' : 'Create New Paper Trading Account'}
        </h3>

        <div className="modal-columns-create">
          {/* Left Column: Account Details */}
          <div className="modal-col-left-create">
            <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Account Info</h4>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>ACCOUNT NAME</label>
              <CustomInput
                type="text"
                error={!!errors.name}
                {...register('name', {
                  required: 'Account name is required',
                  validate: value => value.trim() !== '' || 'Account name cannot be empty'
                })}
                placeholder="e.g. My Paper Account"
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
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

            <DeltaCredentialsSection register={register} watch={watch} setValue={setValue} lockedMode={mode} />

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Underlying</label>
                <CustomSelect
                  value={watch('underlying') || 'BTC'}
                  onChange={val => setValue('underlying', val)}
                  options={[
                    { label: 'BTC', value: 'BTC' },
                    { label: 'ETH', value: 'ETH' }
                  ]}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Days to Expiry (DTE)</label>
                <CustomInput
                  type="number"
                  {...register('daysToExpiry', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
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
                <CustomSelect
                  value={watch('ownerId') || ''}
                  onChange={val => setValue('ownerId', val)}
                  options={[
                    { label: 'Default (Self)', value: '' },
                    ...profiles.map(p => ({ label: p.email, value: p.id }))
                  ]}
                />
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
                Dynamic ATM Scaling
              </label>
            </div>

            {watchAtmRatioScaling && (
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Call Scaling (%)</label>
                  <CustomInput
                    type="number"
                    {...register('atmRatioPctCall', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      outline: 'none'
                    }}
                  />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Put Scaling (%)</label>
                  <CustomInput
                    type="number"
                    {...register('atmRatioPctPut', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
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
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Spread Width ($)</label>
                <CustomInput
                  type="number"
                  {...register('minStrikeDiff', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min IV Edge (%)</label>
                <CustomInput
                  type="number"
                  {...register('minIvDiff', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Delta Deviation</label>
                <CustomInput
                  type="number"
                  step="0.01"
                  {...register('maxRatioDeviation', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Short Premium ($)</label>
                <CustomInput
                  type="number"
                  {...register('minSellPremium', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Net Debit ($)</label>
                <CustomInput
                  type="number"
                  {...register('maxNetPremium', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Spot Distance ($)</label>
                <CustomInput
                  type="number"
                  {...register('minLongDist', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Short Ratio (1:X)</label>
              <CustomInput
                type="number"
                step="0.25"
                {...register('maxSellQty', { valueAsNumber: true })}
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  fontSize: 13,
                  outline: 'none',
                  width: '100%'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Exit Type</label>
                <CustomSelect
                  value={watch('exitType') || 'ATM'}
                  onChange={val => setValue('exitType', val)}
                  options={[
                    { label: 'ATM', value: 'ATM' },
                    { label: 'ITM', value: 'ITM' },
                    { label: 'OTM', value: 'OTM' }
                  ]}
                />
              </div>
              {watchCreateExitType && watchCreateExitType !== 'ATM' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Exit Points</label>
                  <CustomInput
                    type="number"
                    {...register('exitPoints', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      outline: 'none',
                      width: '100%'
                    }}
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '16px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Open Calls</label>
                <CustomInput
                  type="number"
                  {...register('numberOfCalls', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Open Puts</label>
                <CustomInput
                  type="number"
                  {...register('numberOfPuts', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Short Exit Price ($)</label>
                <CustomInput
                  type="number"
                  step="0.1"
                  {...register('shortExitPrice', { valueAsNumber: true })}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 13,
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '100%', marginTop: '20px' }}>
                  <input
                    type="checkbox"
                    id="variableExitSlices"
                    {...register('variableExitSlices')}
                  />
                  <label htmlFor="variableExitSlices" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', cursor: 'pointer', marginBottom: 0 }}>
                    Variable Exit Slices
                  </label>
                </div>
              </div>
            </div>

            {watchVariableExitSlices && (
              <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Long Exit Slices</label>
                  <CustomInput
                    type="number"
                    step="1"
                    {...register('longExitSlices', { valueAsNumber: true })}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      outline: 'none'
                    }}
                  />
                </div>
                <div style={{ flex: 1 }} />
              </div>
            )}
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
                <Loader2 size={14} className="animate-spin" strokeWidth={3} />
                Creating...
              </>
            ) : 'Create Account'}
          </button>
        </div>
      </form>
    </div>
  );
}
