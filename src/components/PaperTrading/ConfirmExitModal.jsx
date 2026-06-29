import React from 'react';
import { fmtExpiry } from '../../api';

export default function ConfirmExitModal({
  isOpen,
  onClose,
  onConfirm,
  isExiting,
  position,
  includeFees
}) {
  if (!isOpen || !position) return null;

  const p = position;
  const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
  const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
  const isLongOnly = (p.sellQty || 0) === 0;

  return (
    <div className="modal-overlay-wrapper" style={{ animation: 'fadeIn 0.15s ease-out' }}>
      <div className="modal-container-delete" style={{ maxWidth: 450 }}>
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Confirm Manual Exit
        </h3>
        
        <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
          You are initiating a manual liquidation of this position. This action closes the active option contracts at current market prices and records the realized P&L to trade history.
        </p>

        {/* Position Details Card */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          fontSize: '12px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', paddingBottom: '6px' }}>
            <span style={{ fontWeight: 600 }}>Position Type:</span>
            <span className={`pt-type-badge ${p.type}`} style={{ textTransform: 'uppercase', fontWeight: 700 }}>{p.type}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-dim)' }}>Underlying:</span>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{p.underlying}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-dim)' }}>Expiry:</span>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{fmtExpiry(p.expiry)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-dim)' }}>Strikes (Long/Short):</span>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>
              {p.buyLeg.strike.toLocaleString()} / {isLongOnly ? <span style={{ color: 'var(--accent)' }}>Long only</span> : p.sellLeg.strike.toLocaleString()}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-dim)' }}>Ratio:</span>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>{isLongOnly ? `${p.buyLeg.lotSize.toFixed(2)} long` : `${p.buyLeg.lotSize.toFixed(2)} : ${p.sellQty.toFixed(2)}`}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
            <span style={{ color: 'var(--text-dim)' }}>Current Long Price (Bid):</span>
            <span style={{ color: '#3fb950', fontWeight: 600 }}>${p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
          </div>
          {!isLongOnly && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-dim)' }}>Current Short Price (Ask):</span>
              <span style={{ color: '#f85149', fontWeight: 600 }}>${p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—'}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '6px' }}>
            <span style={{ color: 'var(--text-dim)' }}>Unrealized Gross P&L:</span>
            <span className={`pt-pnl ${p.unrealizedGrossPnl > 0 ? 'positive' : p.unrealizedGrossPnl < 0 ? 'negative' : 'zero'}`} style={{ fontWeight: 600 }}>
              {p.unrealizedGrossPnl > 0 ? '+' : ''}{p.unrealizedGrossPnl.toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-dim)' }}>Estimated Exit Fee:</span>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>${p.currentExitFee.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: '6px', fontSize: '13px' }}>
            <span style={{ fontWeight: 700 }}>Realized Net P&L:</span>
            <span className={`pt-pnl ${pnlClass}`} style={{ fontWeight: 700 }}>
              {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
          <button
            disabled={isExiting}
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: isExiting ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isExiting ? 0.6 : 1
            }}
          >
            Cancel
          </button>
          <button
            disabled={isExiting}
            onClick={() => onConfirm(p)}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: '#f85149',
              color: '#ffffff',
              cursor: isExiting ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              opacity: isExiting ? 0.8 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isExiting ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                </svg>
                Executing Exit...
              </>
            ) : 'Confirm Exit'}
          </button>
        </div>
      </div>
    </div>
  );
}
