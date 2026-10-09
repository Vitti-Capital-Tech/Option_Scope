// In-app replacement for window.alert / window.confirm — the dialog store and API.
// Call from anywhere (no props or context needed):
//   showAlert('Saved.')                          → Promise<void>, resolves on OK
//   if (await showConfirm('Delete it?', { tone: 'danger', confirmLabel: 'Delete' })) …
// Options: title, tone ('danger' | 'warning' | 'info' | 'primary'), confirmLabel, cancelLabel.
// <AppDialogHost /> is mounted once at the app root (main.jsx); dialogs queue, one at a time.

let queue = [];
let nextId = 1;
const listeners = new Set();
const emit = () => { for (const l of listeners) l(); };
export const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const getSnapshot = () => queue[0] || null;

function open(dialog) {
  return new Promise((resolve) => {
    queue = [...queue, { ...dialog, id: nextId++, resolve }];
    emit();
  });
}

export function close(result) {
  const [current, ...rest] = queue;
  if (!current) return;
  queue = rest;
  emit();
  current.resolve(result);
}

// Alert tone from the message when not given: errors red, partial failures amber, else info.
const guessTone = (msg) => {
  const s = String(msg || '');
  if (/^(failed|error|an error)/i.test(s)) return 'danger';
  if (/fail|could not|couldn't|not be retrieved/i.test(s)) return 'warning';
  return 'info';
};

export function showAlert(message, opts = {}) {
  const tone = opts.tone || guessTone(message);
  const title = opts.title || (tone === 'danger' ? 'Something went wrong' : tone === 'warning' ? 'Heads up' : 'Notice');
  return open({ kind: 'alert', message, tone, title, confirmLabel: opts.confirmLabel || 'OK' });
}

export function showConfirm(message, opts = {}) {
  return open({
    kind: 'confirm',
    message,
    tone: opts.tone || 'primary',
    title: opts.title || 'Please confirm',
    confirmLabel: opts.confirmLabel || 'Confirm',
    cancelLabel: opts.cancelLabel || 'Cancel',
  });
}

