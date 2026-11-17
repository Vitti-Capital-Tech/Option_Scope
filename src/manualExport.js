// Manual exports: DOCX (built in the browser — minimal WordprocessingML in a stored ZIP, no
// library) and PDF (a clean print window; the browser's "Save as PDF" makes the file).
// Both render from manualContent.js, the same source as the on-screen tab.

import { zip, download, xmlEsc } from './exportTable';
import { MANUAL_UPDATED, MANUAL_IMAGE_BASE } from './manualContent';

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

// Inline picture (DrawingML). `img` = { rid, id, name, cx, cy } in EMU.
const picture = (img) => `<w:p><w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${img.cx}" cy="${img.cy}"/><wp:docPr id="${img.id}" name="Picture ${img.id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${img.id}" name="${xmlEsc(img.name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

function guideXml(g, images) {
  const parts = [
    para(g.title, { bold: true, size: 36, after: 120, color: '1F4E79' }),
    para(g.summary, { italic: true, color: '555555', after: 240 }),
  ];
  for (const s of g.sections) {
    parts.push(para(s.heading, { bold: true, size: 28, before: 240, after: 100, color: '1F4E79' }));
    if (s.where) parts.push(para(`Where: ${s.where}`, { color: '444444', after: 120 }));
    (s.steps || []).forEach((t, i) => parts.push(para(`${i + 1}.  ${t}`, { indent: 540, hanging: 360, after: 80 })));
    (s.bullets || []).forEach(t => parts.push(para(`•  ${t}`, { indent: 540, hanging: 360, after: 80 })));
    for (const im of s.images || []) {
      const img = images.get(im.src);
      if (!img) continue; // screenshot not added yet
      parts.push(picture(img));
      parts.push(para(im.caption, { italic: true, color: '666666', size: 18, after: 160 }));
    }
    if (s.note) parts.push(para(`Note: ${s.note}`, { italic: true, color: '666666', before: 60, after: 160 }));
  }
  return parts.join('');
}

const MAX_IMG_EMU = 5760720; // 6.3 in — the A4 text width at these margins
const EMU_PER_PX = 9525;     // at 96 dpi

/**
 * Fetch the guides' screenshots → Map(src → { bytes, ext, w, h }). Missing files are skipped;
 * the content-type check matters because the hosting answers a missing path with index.html.
 */
export async function loadGuideImages(guides) {
  const srcs = [...new Set(guides.flatMap(g => g.sections.flatMap(s => (s.images || []).map(i => i.src))))];
  const out = new Map();
  await Promise.all(srcs.map(async (src) => {
    try {
      const res = await fetch(MANUAL_IMAGE_BASE + src);
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/^image\/(png|jpe?g)/i.test(type)) return;
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      out.set(src, { bytes: new Uint8Array(await blob.arrayBuffer()), ext: /png/i.test(type) ? 'png' : 'jpeg', w: bmp.width, h: bmp.height });
      bmp.close?.();
    } catch { /* skip unreadable image */ }
  }));
  return out;
}

/** The .docx file as a Blob (exportGuidesDocx downloads it). `loaded` = loadGuideImages(). */
export function buildGuidesDocx(guides, loaded = new Map()) {
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  // Number the pictures, size them to the text width, and give each a relationship id.
  const images = new Map();
  let n = 0;
  for (const [src, im] of loaded) {
    n++;
    const scale = Math.min(1, MAX_IMG_EMU / (im.w * EMU_PER_PX));
    images.set(src, {
      ...im, id: n, rid: `rIdImg${n}`, name: `image${n}.${im.ext === 'png' ? 'png' : 'jpg'}`,
      cx: Math.round(im.w * EMU_PER_PX * scale), cy: Math.round(im.h * EMU_PER_PX * scale),
    });
  }
  const body = guides.map(g => guideXml(g, images)).join(pageBreak)
    + para(`Updated ${MANUAL_UPDATED}`, { italic: true, color: '888888', before: 240, size: 18 });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${[...images.values()].map(i => `<Relationship Id="${i.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${i.name}"/>`).join('')}</Relationships>` },
    { name: 'word/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>' },
    { name: 'word/document.xml', data: doc },
    ...[...images.values()].map(i => ({ name: `word/media/${i.name}`, data: i.bytes })),
  ];
  return zip(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

export async function exportGuidesDocx(guides, filename) {
  download(buildGuidesDocx(guides, await loadGuideImages(guides)), filename);
}

// ── PDF (print window) ───────────────────────────────────────────────────────
const htmlEsc = (s) => String(s).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
const inlineHtml = (text) => parseInline(text).map(r => (r.code
  ? `<code>${htmlEsc(r.text)}</code>` : r.bold ? `<strong>${htmlEsc(r.text)}</strong>` : htmlEsc(r.text))).join('');

// Absolute URL: the print window is about:blank, so a relative path would not resolve.
const imageUrl = (src) => new URL(MANUAL_IMAGE_BASE + src, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').href;

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
        ${(s.images || []).map(im => `<figure><img src="${htmlEsc(imageUrl(im.src))}" alt="${htmlEsc(im.caption)}" onerror="this.parentNode.remove()"><figcaption>${htmlEsc(im.caption)}</figcaption></figure>`).join('')}
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
  figure { margin: 8px 0 12px; break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: 120mm; border: 1px solid #ccc; border-radius: 4px; }
  figcaption { color: #666; font-size: 9pt; font-style: italic; margin-top: 3px; }
  .guide + .guide { break-before: page; }
  .foot { color: #888; font-size: 9pt; margin-top: 24px; }
</style></head><body>${guidesHtml(guides)}<p class="foot">Updated ${htmlEsc(MANUAL_UPDATED)}</p>
<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
  w.document.close();
  return true;
}
