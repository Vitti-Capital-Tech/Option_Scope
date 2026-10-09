import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react';

// Renders the in-app alert / confirm dialogs queued via showAlert / showConfirm (dialogService.js).
// Mounted once at the app root (main.jsx).
import { subscribe, getSnapshot, close } from './dialogService';

const TONE = {
  danger: { color: '#f85149', Icon: AlertTriangle },
  warning: { color: '#d29922', Icon: AlertTriangle },
  info: { color: '#3b82f6', Icon: Info },
  primary: { color: '#3b82f6', Icon: CheckCircle2 },
};

export function AppDialogHost() {
  const d = useSyncExternalStore(subscribe, getSnapshot);
  const okRef = useRef(null);

  useEffect(() => {
    if (!d) return undefined;
    okRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(d.kind === 'confirm' ? false : undefined); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d]);

  if (!d) return null;
  const { color, Icon } = TONE[d.tone] || TONE.info;
  const cancel = () => close(d.kind === 'confirm' ? false : undefined);
  const ok = () => close(d.kind === 'confirm' ? true : undefined);

  return (
    <div className="modal-overlay-wrapper app-dialog-overlay" onClick={cancel} style={{ animation: 'fadeIn 0.15s ease-out' }}>
      <div className="modal-container-delete app-dialog" role={d.kind === 'confirm' ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={`app-dialog-title-${d.id}`} onClick={(e) => e.stopPropagation()}>
        <h3 id={`app-dialog-title-${d.id}`} className="app-dialog-title" style={{ color }}>
          <Icon size={18} strokeWidth={2.5} />
          {d.title}
        </h3>
        <p className="app-dialog-message">{d.message}</p>
        <div className="app-dialog-actions">
          {d.kind === 'confirm' && (
            <button type="button" className="app-dialog-btn" onClick={cancel}>{d.cancelLabel}</button>
          )}
          <button type="button" ref={okRef} className="app-dialog-btn primary" style={{ background: color, borderColor: color }} onClick={ok}>
            {d.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
