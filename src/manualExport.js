// Manual exports: DOCX (built in the browser — minimal WordprocessingML in a stored ZIP, no
// library) and PDF (a clean print window; the browser's "Save as PDF" makes the file).
// Both render from manualContent.js, the same source as the on-screen tab.

import { zip, download, xmlEsc } from './exportTable';
import { MANUAL_UPDATED } from './manualContent';

// "**bold** and `code`" → [{ text, bold, code }]
export function parseInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('**')) out.push({ text: t.slice(2, -2), bold: true });
    else out.push({ text: t.slice(1, -1), code: true });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────
const run = ({ text, bold, code, italic }, base = {}) => {
  const b = bold || base.bold, i = italic || base.italic;
  // Element order inside <w:rPr> is fixed by the schema (rFonts, b, i, color, sz, szCs, shd);
  // Word reports "unreadable content" when it is out of order.
  const props = [
    code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '',
    b ? '<w:b/>' : '',
    i ? '<w:i/>' : '',
    base.color ? `<w:color w:val="${base.color}"/>` : '',
    base.size ? `<w:sz w:val="${base.size}"/><w:szCs w:val="${base.size}"/>` : '',
    code ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
};
const para = (text, { before = 0, after = 120, indent = 0, hanging = 0, ...base } = {}) => {
  const ppr = `<w:pPr><w:spacing w:before="${before}" w:after="${after}"/>${indent ? `<w:ind w:left="${indent}" w:hanging="${hanging}"/>` : ''}</w:pPr>`;
  return `<w:p>${ppr}${parseInline(text).map(r => run(r, base)).join('')}</w:p>`;
};

function guideXml(g) {
  const parts = [
    para(g.title, { bold: true, size: 36, after: 120, color: '1F4E79' }),
    para(g.summary, { italic: true, color: '555555', after: 240 }),
  ];
  for (const s of g.sections) {
    parts.push(para(s.heading, { bold: true, size: 28, before: 240, after: 100, color: '1F4E79' }));
    if (s.where) parts.push(para(`Where: ${s.where}`, { color: '444444', after: 120 }));
    (s.steps || []).forEach((t, i) => parts.push(para(`${i + 1}.  ${t}`, { indent: 540, hanging: 360, after: 80 })));
    (s.bullets || []).forEach(t => parts.push(para(`•  ${t}`, { indent: 540, hanging: 360, after: 80 })));
    if (s.note) parts.push(para(`Note: ${s.note}`, { italic: true, color: '666666', before: 60, after: 160 }));
  }
  return parts.join('');
}

/** The .docx file as a Blob (exportGuidesDocx downloads it). */
export function buildGuidesDocx(guides) {
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const body = guides.map(guideXml).join(pageBreak)
    + para(`Updated ${MANUAL_UPDATED}`, { italic: true, color: '888888', before: 240, size: 18 });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>' },
    { name: 'word/document.xml', data: doc },
  ];
  return zip(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

export function exportGuidesDocx(guides, filename) {
  download(buildGuidesDocx(guides), filename);
}

// ── PDF (print window) ───────────────────────────────────────────────────────
const htmlEsc = (s) => String(s).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
const inlineHtml = (text) => parseInline(text).map(r => (r.code
  ? `<code>${htmlEsc(r.text)}</code>` : r.bold ? `<strong>${htmlEsc(r.text)}</strong>` : htmlEsc(r.text))).join('');

export function guidesHtml(guides) {
  return guides.map(g => `
    <section class="guide">
      <h1>${htmlEsc(g.title)}</h1>
      <p class="summary">${htmlEsc(g.summary)}</p>
      ${g.sections.map(s => `
        <h2>${htmlEsc(s.heading)}</h2>
        ${s.where ? `<p class="where"><span>Where</span> ${inlineHtml(s.where)}</p>` : ''}
        ${s.steps ? `<ol>${s.steps.map(t => `<li>${inlineHtml(t)}</li>`).join('')}</ol>` : ''}
        ${s.bullets ? `<ul>${s.bullets.map(t => `<li>${inlineHtml(t)}</li>`).join('')}</ul>` : ''}
        ${s.note ? `<p class="note">${inlineHtml(s.note)}</p>` : ''}`).join('')}
    </section>`).join('');
}

/** Opens a print-ready window; the user picks "Save as PDF". Returns false if blocked. */
export function printGuidesPdf(guides, title) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${htmlEsc(title)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font: 11pt/1.5 Calibri, 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 780px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 19pt; color: #1F4E79; margin: 0 0 6px; }
  h2 { font-size: 13.5pt; color: #1F4E79; margin: 20px 0 6px; break-after: avoid; }
  .summary { color: #555; font-style: italic; margin: 0 0 12px; }
  .where { background: #f2f6fb; border-left: 3px solid #1F4E79; padding: 6px 10px; margin: 6px 0 8px; }
  .where span { font-weight: 700; text-transform: uppercase; font-size: 8.5pt; letter-spacing: .06em; color: #1F4E79; margin-right: 6px; }
  ol, ul { margin: 6px 0 8px; padding-left: 22px; } li { margin: 3px 0; break-inside: avoid; }
  .note { color: #555; font-style: italic; border-left: 3px solid #bbb; padding-left: 10px; }
  code { font-family: Consolas, monospace; background: #eee; padding: 0 4px; border-radius: 3px; font-size: 9.5pt; word-break: break-all; }
  .guide + .guide { break-before: page; }
  .foot { color: #888; font-size: 9pt; margin-top: 24px; }
</style></head><body>${guidesHtml(guides)}<p class="foot">Updated ${htmlEsc(MANUAL_UPDATED)}</p>
<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
  w.document.close();
  return true;
}
