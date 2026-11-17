import React, { useState } from 'react';
import { BookOpen, FileText, Printer } from 'lucide-react';
import Navbar from './components/PaperTrading/Navbar';
import { GUIDES, MANUAL_UPDATED, MANUAL_IMAGE_BASE } from './manualContent';
import { parseInline, exportGuidesDocx, printGuidesPdf } from './manualExport';

// Manual tab — step-by-step guides (Delta API key, Cosmic Trade, Telegram), covering what to
// do on the exchange's own site AND on this dashboard. Content: manualContent.js; DOCX / PDF
// exports render from the same data (manualExport.js).

function Inline({ text }) {
  return parseInline(text).map((r, i) => (r.code
    ? <code key={i} className="mn-code">{r.text}</code>
    : r.bold ? <strong key={i}>{r.text}</strong> : <React.Fragment key={i}>{r.text}</React.Fragment>));
}

// A screenshot from public/manual/. Missing file → renders nothing (guides ship before every
// picture exists). Click opens the full-size image.
function Shot({ src, caption }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  const url = MANUAL_IMAGE_BASE + src;
  return (
    <figure className="mn-shot">
      <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
        <img src={url} alt={caption} loading="lazy" onError={() => setMissing(true)} />
      </a>
      {/* "1 · …   2 · …" captions: one numbered point per line. */}
      <figcaption>{caption.split(/\s{3,}/).map((part, i) => <span key={i}>{part}</span>)}</figcaption>
    </figure>
  );
}

export default function Manual({ onNavigate, theme, toggleTheme }) {
  const [activeId, setActiveId] = useState(GUIDES[0].id);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const guide = GUIDES.find(g => g.id === activeId) ?? GUIDES[0];

  const docx = (list, name) => exportGuidesDocx(list, `${name}.docx`);
  const pdf = (list, title) => setPopupBlocked(!printGuidesPdf(list, title));

  return (
    <div className="app">
      <Navbar activeTab="manual" onNavigate={onNavigate} theme={theme} toggleTheme={toggleTheme} badgeLabel="Manual" />

      <div className="body dr-body">
        <div className="dr-toolbar">
          <span className="dr-title"><BookOpen size={15} /> Manual</span>
          <div className="dr-actions">
            <button type="button" className="dr-btn" onClick={() => pdf(GUIDES, 'OptionScope Manual')} title="Opens a print window — choose “Save as PDF”">
              <Printer size={13} /> All guides · PDF
            </button>
            <button type="button" className="dr-btn primary" onClick={() => docx(GUIDES, 'OptionScope-Manual')}>
              <FileText size={13} /> All guides · DOCX
            </button>
          </div>
        </div>

        {popupBlocked && (
          <div className="dr-error">The browser blocked the print window — allow pop-ups for this site and try again.</div>
        )}

        <div className="mn-layout">
          <nav className="mn-nav" aria-label="Guides">
            {GUIDES.map(g => (
              <button key={g.id} type="button" className={`mn-nav-item${g.id === activeId ? ' on' : ''}`}
                aria-current={g.id === activeId ? 'page' : undefined} onClick={() => setActiveId(g.id)}>
                {g.title}
              </button>
            ))}
            <span className="mn-updated">Updated {MANUAL_UPDATED}</span>
          </nav>

          <article className="dr-card mn-guide">
            <div className="mn-guide-head">
              <div>
                <h2 className="mn-title">{guide.title}</h2>
                <p className="mn-summary">{guide.summary}</p>
              </div>
              <div className="mn-guide-actions">
                <button type="button" className="dr-btn small" onClick={() => pdf([guide], guide.title)}>
                  <Printer size={12} /> PDF
                </button>
                <button type="button" className="dr-btn small" onClick={() => docx([guide], guide.id)}>
                  <FileText size={12} /> DOCX
                </button>
              </div>
            </div>

            {guide.sections.map(s => (
              <section key={s.heading} className="mn-section">
                <h3>{s.heading}</h3>
                {s.where && <p className="mn-where"><span>Where</span> <Inline text={s.where} /></p>}
                {s.steps && <ol>{s.steps.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ol>}
                {s.bullets && <ul>{s.bullets.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>}
                {s.images?.length > 0 && (
                  <div className="mn-shots">{s.images.map(im => <Shot key={im.src} {...im} />)}</div>
                )}
                {s.note && <p className="mn-note"><Inline text={s.note} /></p>}
              </section>
            ))}
          </article>
        </div>
      </div>
    </div>
  );
}
