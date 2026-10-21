'use strict';
// Pull a short, useful snippet out of a file so the model can tell what it is.
// Everything happens locally. Unknown or unreadable files simply return no snippet.
const fs = require('fs');
const path = require('path');

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.rtf', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.ini', '.toml', '.tex', '.srt', '.eml', '.sql', '.py', '.js', '.ts', '.java',
  '.c', '.h', '.cpp', '.go', '.rs', '.sh', '.rb', '.php', '.cs', '.swift', '.kt',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function clean(text, maxChars) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

function stripMarkup(text, ext) {
  if (ext === '.rtf') {
    return text.replace(/\\'[0-9a-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  }
  if (ext === '.html' || ext === '.htm' || ext === '.xml') {
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  return text;
}

/** Which pages to read: first three, the middle, last two (all of them for short documents). */
function samplePages(total) {
  if (total <= 7) return new Set([...Array(total).keys()]);
  return new Set([0, 1, 2, Math.floor(total / 2), total - 2, total - 1]);
}


// ---- PDFs -------------------------------------------------------------------------------------
const CAPS_STOP = /^(WARNING|CAUTION|NOTE|IMPORTANT|NOTICE|CONTENTS|TABLE OF CONTENTS|WARRANTY|DISCLAIMER|SAFETY|HEALTH|PAGE|INDEX|START|BACK|MENU|FAQ)\b/;
// Titles that PDF software fills in automatically and that say nothing about the content.
const JUNK_TITLE = /^(about:blank|untitled|document\d*|microsoft word\b|new document|scan|\w*\.(docx?|pdf|indd|tmp)$)|^\s*$/i;
const LEGALISH = /WARRANT|LIABLE|SHALL|DAMAGE|EXPRESS|IMPLIED|PURCHASE|CONSEQUENTIAL|MERCHANT|HEREBY|INCIDENTAL|REPAIR|APPLICABLE/;

/**
 * Cheap, model-free hints gathered from the WHOLE document: who owns it (trademark and copyright
 * lines) and product-style ALL-CAPS names. Manuals often hide the product name on page 7, not page 1.
 */
function pdfClues(pages) {
  const all = pages.join('\n').replace(/\s+/g, ' ');
  const legal = new Set();
  // Names are a few capitalised tokens in a row. Never a full stop in the middle, so a match can't
  // run on from one sentence into the next.
  const NAME = "[A-Z0-9][\\w&'\u00ae-]*(?:[ ,]+(?:[A-Z0-9][\\w&'\u00ae-]*|of|or|and|the|for)){0,5}";
  const OWNER = "[A-Z][\\w&'-]*(?:[ ,]+[A-Z][\\w&'-]*){0,3}";
  const tm = new RegExp(`(${NAME})\\s+(?:is|are)(?: either)?(?: a)?(?: registered)? trademarks?(?: or trademarks)? of (${OWNER})`, 'g');
  for (const m of all.matchAll(tm)) legal.add(`${m[1].trim()} is a trademark of ${m[2].trim()}`);
  const cr = new RegExp(`(?:\\u00a9|\\(c\\))\\s*(?:\\d{4}\\s*)?(${OWNER})|[Cc]opyright\\s*(?:\\u00a9\\s*)?\\d{4}\\s+(${OWNER})`, 'g');
  for (const m of all.matchAll(cr)) legal.add(`\u00a9 ${(m[1] || m[2]).trim()}`);

  const caps = {};
  for (const m of all.matchAll(/\b[A-Z][A-Z0-9'&-]+(?: (?:OR|AND|OF|THE|[A-Z][A-Z0-9'&-]+))+(?: [A-Z][a-z]+)?(?: \d+)?\b/g)) {
    const p = m[0].trim();
    if (p.length >= 8 && p.length <= 40 && !CAPS_STOP.test(p) && !LEGALISH.test(p)) caps[p] = (caps[p] || 0) + 1;
  }
  const names = Object.entries(caps).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);

  const lines = [];
  if (legal.size) lines.push(`Ownership lines: ${[...legal].slice(0, 3).map((x) => x.slice(0, 110)).join(' | ')}`);
  if (names.length) lines.push(`Product-style names: ${names.join(' | ')}`);
  return lines.join('\n');
}

async function extractPdf(file, { maxChars, wantImage, pdfRenderer }) {
  // Manuals and contracts often open with warnings or legal text, so sample several pages,
  // add clues from the whole document, and include the PDF's own title if it has one.
  const pdf = require('pdf-parse/lib/pdf-parse.js');
  const pages = [];
  const pagerender = (pageData) =>
    pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc) => {
      let lastY;
      let text = '';
      for (const item of tc.items) {
        text += lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      pages.push(text);
      return text;
    });
  const data = await pdf(fs.readFileSync(file), { max: 150, pagerender });
  const totalChars = pages.reduce((n, t) => n + t.trim().length, 0);

  if (totalChars < 40) {
    // A scan: there is no text layer at all. Only a model that can SEE can read it.
    if (wantImage && pdfRenderer) {
      const image = await pdfRenderer(file);
      if (image) return { kind: 'image', image, pageImage: true, pages: data.numpages };
    }
    return { kind: 'none', scanned: true, pages: data.numpages };
  }

  // Which pages to show the model: the start, the middle, and the END. Legal pages with trademark
  // and copyright lines (the best clue to what a manual is for) usually sit on the last page.
  const n = pages.length;
  const pick = [...new Set([1, 2, Math.floor(n / 2) + 1, n - 1, n].filter((i) => i >= 1 && i <= n))].sort((x, y) => x - y);
  const parts = [];
  const title = data.info && data.info.Title && String(data.info.Title).trim();
  if (title && !JUNK_TITLE.test(title)) parts.push(`(PDF title: ${title})`);
  for (const i of n <= 5 ? pages.map((_, k) => k + 1) : pick) {
    const c = clean(pages[i - 1], i === 1 ? 500 : 230);
    if (c) parts.push(`[page ${i}] ${c}`);
  }
  const sample = clean(parts.join('\n---\n'), 1200);
  const clues = pdfClues(pages);
  const text = clues ? `${sample}\n---\nClues from the whole document:\n${clues}` : sample;
  return { kind: 'text', text, pages: data.numpages };
}

/**
 * @returns {Promise<{kind:'text'|'image'|'none', text?:string, image?:string}>}
 * `imageEncoder(filePath)` is injected by the app (it shrinks the picture first).
 */
async function extract(file, { maxChars = 1800, imageEncoder, wantImage = false, pdfRenderer } = {}) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (TEXT_EXTS.has(ext)) {
      const head = readHead(file, 24 * 1024);
      if (head.includes(0)) return { kind: 'none' };
      const text = clean(stripMarkup(head.toString('utf8'), ext), maxChars);
      return text ? { kind: 'text', text } : { kind: 'none' };
    }
    if (ext === '.pdf') return await extractPdf(file, { maxChars, wantImage, pdfRenderer });
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: file });
      const text = clean(r.value || '', maxChars);
      return text ? { kind: 'text', text } : { kind: 'none' };
    }
    if (IMAGE_EXTS.has(ext) && wantImage && imageEncoder) {
      const image = await imageEncoder(file);
      return image ? { kind: 'image', image } : { kind: 'none' };
    }
  } catch (err) {
    /* unreadable, encrypted, corrupt... just skip the snippet (the reason is kept for debugging) */
    return { kind: 'none', error: String((err && err.stack) || err) };
  }
  return { kind: 'none' };
}

module.exports = { pdfClues, extract, TEXT_EXTS, IMAGE_EXTS };
