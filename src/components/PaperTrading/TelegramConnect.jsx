import React from 'react';
import { Send, CheckCircle2, Loader2, ExternalLink } from 'lucide-react';

/**
 * Per-account Telegram connect control (live accounts only).
 *
 * Telegram bots can't message a user by @username — they need the numeric chat id,
 * learned only after the user starts the bot. So we auto-capture it via a `/start`
 * deep link: "Connect" writes a random `telegram_link_code` on the account and reveals
 * `t.me/<bot>?start=<code>`. When the user presses Start, the engine's bot listener
 * matches the code, stores `telegram_chat_id`, and this view flips to Connected (the
 * account row updates via Supabase Realtime → the parent refetches).
 *
 * Props:
 *   account      — the account row (reads telegram_chat_id / telegram_link_code)
 *   botUsername  — Telegram bot username for the deep link (VITE_TELEGRAM_BOT_USERNAME)
 *   onConnect    — () => generate a fresh link code on this account
 *   onDisconnect — () => clear this account's chat id (+ code)
 *   busy         — disables the buttons while a write is in flight
 */
export default function TelegramConnect({ account, botUsername = '', onConnect, onDisconnect, busy = false }) {
  const chatId = account?.telegram_chat_id || null;
  const code = account?.telegram_link_code || null;
  const link = code && botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(code)}` : null;

  const boxStyle = {
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '12px', borderRadius: 8,
    border: '1px solid var(--border)', background: 'var(--bg3)',
  };
  const btn = (bg, color) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)',
    background: bg, color, fontSize: 12, fontWeight: 600,
    cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, textDecoration: 'none',
  });

  return (
    <div style={boxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
        <Send size={13} strokeWidth={2.5} style={{ color: '#3b82f6' }} />
        Telegram Alerts
      </div>

      {chatId ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#3fb950', fontWeight: 600 }}>
            <CheckCircle2 size={14} strokeWidth={2.5} />
            Connected — this account's live logs go to chat <code style={{ color: 'var(--text)' }}>{chatId}</code>.
          </div>
          <button type="button" onClick={onDisconnect} disabled={busy} style={btn('transparent', '#f85149')}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : null} Disconnect
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)' }}>
            Connect this account to a Telegram chat to receive its <em>own</em> live trade &amp; failure alerts.
            {!botUsername && (
              <span style={{ color: '#f0883e' }}> (Set <code>VITE_TELEGRAM_BOT_USERNAME</code> to enable the link.)</span>
            )}
          </div>

          {link ? (
            <>
              <a href={link} target="_blank" rel="noopener noreferrer" style={btn('rgba(59,130,246,0.12)', '#3b82f6')}>
                <ExternalLink size={13} strokeWidth={2.5} /> Open Telegram &amp; press Start
              </a>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Waiting for you to press <b>Start</b> in Telegram… this updates automatically once linked.
              </div>
              <button type="button" onClick={onConnect} disabled={busy} style={{ ...btn('transparent', 'var(--text-dim)'), alignSelf: 'flex-start', fontSize: 11 }}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : null} Regenerate link
              </button>
            </>
          ) : (
            <button type="button" onClick={onConnect} disabled={busy || !botUsername} style={btn('rgba(59,130,246,0.12)', '#3b82f6')}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} strokeWidth={2.5} />} Connect Telegram
            </button>
          )}
        </>
      )}
    </div>
  );
}
