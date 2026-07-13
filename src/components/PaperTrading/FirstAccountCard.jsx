import React from 'react';
import { PlusSquare, Loader2 } from 'lucide-react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import DeltaCredentialsSection from './DeltaCredentialsSection';

export default function FirstAccountCard({
  onSubmit,
  register,
  errors,
  isCreatingAccount,
  watchAtmRatioScaling,
  watchCreateExitType,
  onCancel,
  setValue,
  watch,
  mode = 'paper'
}) {
  const watchVariableExitSlices = watch('variableExitSlices');
  const isLive = mode === 'live';

  return (
    <div className="first-account-wrapper">
      <div className="first-account-card">
        {/* Header Icon & Text */}
        <div className="first-account-header">
          <div className="first-account-icon-wrapper">
            <PlusSquare size={28} strokeWidth={2.5} />
          </div>
          <h3 className="first-account-title">
            {isLive ? 'Create Your First Live Account' : 'Create Your First Account'}
          </h3>
          <p className="first-account-desc">
            {isLive
              ? 'To start live trading on Delta Exchange, create a live trading account first. Add your account name, Delta API credentials and default strategy filters below.'
              : 'To start paper trading, you must create a trading account first. Set up your account name and default strategy filters below.'}
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

              <DeltaCredentialsSection
                register={register}
                watch={watch}
                setValue={setValue}
                lockedMode={mode}
              />

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
              </div>

              <div className="first-account-row">
                <div className="first-account-form-group">
                  <label className="first-account-label">Short Exit Price ($)</label>
                  <CustomInput
                    type="number"
                    step="0.1"
                    {...register('shortExitPrice', { valueAsNumber: true })}
                    className="first-account-input"
                  />
                </div>
                <div className="first-account-form-group">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '100%', marginTop: '24px' }}>
                    <input
                      type="checkbox"
                      id="variableExitSlices_first"
                      {...register('variableExitSlices')}
                    />
                    <label htmlFor="variableExitSlices_first" className="first-account-label" style={{ cursor: 'pointer', marginBottom: 0 }}>
                      Variable Exit Slices
                    </label>
                  </div>
                </div>
              </div>

              {watchVariableExitSlices && (
                <div className="first-account-row">
                  <div className="first-account-form-group">
                    <label className="first-account-label">Long Exit Slices</label>
                    <CustomInput
                      type="number"
                      step="1"
                      {...register('longExitSlices', { valueAsNumber: true })}
                      className="first-account-input"
                    />
                  </div>
                  <div className="first-account-form-group" />
                </div>
              )}
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
                  <Loader2 size={14} className="animate-spin" strokeWidth={3} />
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
