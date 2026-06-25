import React from 'react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';

export default function FirstAccountCard({
  onSubmit,
  register,
  errors,
  isCreatingAccount,
  watchAtmRatioScaling,
  watchCreateExitType,
  onCancel,
  setValue,
  watch
}) {
  return (
    <div className="first-account-wrapper">
      <div className="first-account-card">
        {/* Header Icon & Text */}
        <div className="first-account-header">
          <div className="first-account-icon-wrapper">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="8" y1="12" x2="16" y2="12"></line>
            </svg>
          </div>
          <h3 className="first-account-title">Create Your First Account</h3>
          <p className="first-account-desc">
            To start paper trading, you must create a trading account first. Set up your account name and default strategy filters below.
          </p>
        </div>

        {/* Form Container */}
        <form onSubmit={onSubmit} className="first-account-form">
          <div className="first-account-columns">
            {/* Left Column: Account Info */}
            <div className="first-account-col-left">
              <h4 className="first-account-section-title">Account Info</h4>

              <div className="first-account-form-group">
                <label className="first-account-label">ACCOUNT NAME</label>
                <CustomInput
                  type="text"
                  error={!!errors.name}
                  className="first-account-input"
                  {...register('name', {
                    required: 'Account name is required',
                    validate: value => value.trim() !== '' || 'Account name cannot be empty'
                  })}
                  placeholder="e.g. My First Account"
                />
                {errors.name && (
                  <span style={{ fontSize: 11, color: '#f85149', marginTop: 2 }}>
                    {errors.name.message}
                  </span>
                )}
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Underlying</label>
                  <CustomSelect
                    value={watch('underlying') || 'BTC'}
                    onChange={val => setValue('underlying', val)}
                    options={[
                      { label: 'BTC', value: 'BTC' },
                      { label: 'ETH', value: 'ETH' }
                    ]}
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Min Days to Expiry (DTE)</label>
                  <CustomInput
                    type="number"
                    {...register('daysToExpiry', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
              </div>

              <div className="first-account-checkbox-group">
                <input
                  type="checkbox"
                  id="atmRatioScaling"
                  {...register('atmRatioScaling')}
                  className="first-account-checkbox"
                />
                <label htmlFor="atmRatioScaling" className="first-account-checkbox-label">
                  Dynamic ATM Scaling
                </label>
              </div>

              {watchAtmRatioScaling && (
                <div className="first-account-row">
                  <div className="first-account-form-group">
                    <label className="first-account-label">Call Scaling (%)</label>
                    <CustomInput
                      type="number"
                      {...register('atmRatioPctCall', { valueAsNumber: true })}
                      className="first-account-input"
                    />
                  </div>
                  <div className="first-account-form-group">
                    <label className="first-account-label">Put Scaling (%)</label>
                    <CustomInput
                      type="number"
                      {...register('atmRatioPctPut', { valueAsNumber: true })}
                      className="first-account-input"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Right Column: Default Strategy Filters */}
            <div className="first-account-col-right">
              <h4 className="first-account-section-title">Default Strategy Filters</h4>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Min Spread Width ($)</label>
                  <CustomInput
                    type="number"
                    {...register('minStrikeDiff', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Min IV Edge (%)</label>
                  <CustomInput
                    type="number"
                    {...register('minIvDiff', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Max Delta Deviation</label>
                  <CustomInput
                    type="number"
                    step="0.01"
                    {...register('maxRatioDeviation', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Min Short Premium ($)</label>
                  <CustomInput
                    type="number"
                    {...register('minSellPremium', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Max Net Debit ($)</label>
                  <CustomInput
                    type="number"
                    {...register('maxNetPremium', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Min Spot Distance ($)</label>
                  <CustomInput
                    type="number"
                    {...register('minLongDist', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
              </div>

              <div className="first-account-form-group">
                <label className="first-account-label">Max Short Ratio (1:X)</label>
                <CustomInput
                  type="number"
                  step="0.25"
                  {...register('maxSellQty', { valueAsNumber: true })}
                  className="first-account-input"
                />
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Exit Type</label>
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
                  <div className="first-account-form-group">
                    <label className="first-account-label">Exit Points</label>
                    <CustomInput
                      type="number"
                      {...register('exitPoints', { valueAsNumber: true })}
                      className="first-account-input"
                    />
                  </div>
                )}
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Max Open Calls</label>
                  <CustomInput
                    type="number"
                    {...register('numberOfCalls', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Max Open Puts</label>
                  <CustomInput
                    type="number"
                    {...register('numberOfPuts', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Re-entry Spot Step (%)</label>
                  <CustomInput
                    type="number"
                    step="0.1"
                    {...register('spotDiff', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <label className="first-account-label">Leg Swap Net Premium ($)</label>
                  <CustomInput
                    type="number"
                    {...register('legSwapNetPremium', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Action Buttons: Cancel and Submit */}
          <div className="first-account-actions">
            <button
              type="button"
              onClick={onCancel}
              className="first-account-btn-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isCreatingAccount}
              className="first-account-btn-submit"
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
          </div>
        </form>
      </div>
    </div>
  );
}
