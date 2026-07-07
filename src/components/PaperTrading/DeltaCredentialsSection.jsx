import React, { useState } from 'react';
import CustomSelect from '../common/CustomSelect';
import CustomInput from '../common/CustomInput';
import { verifyDeltaCredentials } from '../../deltaAuth';

const fieldStyle = {
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  outline: 'none',
  width: '100%'
};
const labelStyle = { fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' };

/**
 * Paper/Live mode selector plus (when Live) the Delta Exchange API key + secret
 * inputs and a Verify button. Verification signs a test request in-browser using
 * the just-entered secret and records the outcome into the form field
 * `credVerified` via setValue, so the submit handler can persist status.
 *
 * The secret is never displayed back: in edit mode `existingMeta` shows only the
 * last-4 and current status; re-entering a secret replaces it.
 */
export default function DeltaCredentialsSection({ register, watch, setValue, existingMeta = null }) {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState(null); // { ok, error }

  const mode = watch('mode') || 'paper';

  const handleVerify = async () => {
    setVerifying(true);
    setResult(null);
    const apiKey = watch('apiKey');
    const apiSecret = watch('apiSecret');
    const res = await verifyDeltaCredentials(apiKey, apiSecret);
    setResult(res);
    setValue('credVerified', res.ok, { shouldDirty: true });
    setVerifying(false);
  };

  const onModeChange = (val) => {
    setValue('mode', val);
    setValue('credVerified', false);
    setResult(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={labelStyle}>Account Mode</label>
        <CustomSelect
          value={mode}
          onChange={onModeChange}
          options={[
            { label: 'Paper (simulated)', value: 'paper' },
            { label: 'Live — Delta Exchange', value: 'live' }
          ]}
        />
      </div>

      {mode === 'live' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg3)'
          }}
        >
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)' }}>
            <strong style={{ color: '#e3b341' }}>⚠ Live account.</strong> Credentials are
            encrypted at rest and used by the engine to place <em>real</em> orders once you
            arm the account. Real orders stay off until the kill-switch is enabled.
          </div>

          {existingMeta && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text)',
                background: 'var(--bg2)',
                borderRadius: 6,
                padding: '8px 10px'
              }}
            >
              Linked key ••••{existingMeta.key_last4 || '????'} —{' '}
              <span
                style={{
                  color:
                    existingMeta.status === 'verified'
                      ? '#3fb950'
                      : existingMeta.status === 'invalid'
                        ? '#f85149'
                        : 'var(--text-dim)',
                  fontWeight: 600
                }}
              >
                {existingMeta.status}
              </span>
              . Leave the fields blank to keep it, or enter a new key/secret to replace it.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>API Key</label>
            <CustomInput
              type="text"
              autoComplete="off"
              {...register('apiKey', {
                onChange: () => setValue('credVerified', false)
              })}
              placeholder="Delta Exchange API key"
              style={fieldStyle}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle}>API Secret</label>
            <CustomInput
              type="password"
              autoComplete="new-password"
              {...register('apiSecret', {
                onChange: () => setValue('credVerified', false)
              })}
              placeholder="Delta Exchange API secret"
              style={fieldStyle}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={handleVerify}
              disabled={verifying}
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text)',
                cursor: verifying ? 'not-allowed' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                opacity: verifying ? 0.6 : 1
              }}
            >
              {verifying ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                    <circle cx="12" cy="12" r="10" stroke="rgba(128,128,128,0.35)" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  Verifying…
                </>
              ) : 'Verify Connection'}
            </button>

            {result && (
              <span style={{ fontSize: 12, fontWeight: 600, color: result.ok ? '#3fb950' : '#f85149' }}>
                {result.ok ? '✓ Verified' : `✕ ${result.error}`}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
            <label style={labelStyle}>Balance Allocation (%)</label>
            <CustomInput
              type="number"
              step="1"
              min="1"
              max="100"
              {...register('balanceAllocationPct', { valueAsNumber: true })}
              placeholder="90"
              style={fieldStyle}
            />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              % of live wallet balance used for trading (rest is buffer). Split equally
              across max positions — each position uses up to 1 part of margin.
            </span>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Buy Offset (+$)</label>
              <CustomInput
                type="number" step="0.5"
                {...register('entryBuyOffset', { valueAsNumber: true })}
                placeholder="5"
                style={fieldStyle}
              />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={labelStyle}>Sell Offset (−$)</label>
              <CustomInput
                type="number" step="0.5"
                {...register('entrySellOffset', { valueAsNumber: true })}
                placeholder="2"
                style={fieldStyle}
              />
            </div>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Live entry limit prices: buy at ask +offset, sell at bid −offset (premium $),
            so marketable entries fill.
          </span>
        </div>
      )}
    </div>
  );
}
