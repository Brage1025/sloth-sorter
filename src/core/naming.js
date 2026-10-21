'use strict';
// Making sure names suggested by a model are safe, tidy and valid on Windows, macOS and Linux.
const path = require('path');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Remove characters that are illegal somewhere, collapse spaces, keep it reasonably short. */
function sanitizeBase(name, maxLen = 90) {
  let s = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/\s+\S*$/, '').trim() || s.slice(0, maxLen);
  if (WINDOWS_RESERVED.test(s)) s = `${s}_`;
  return s;
}

// Words that say nothing about what a file contains.
const GENERIC = new Set([
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'download', 'downloads',
  'scan', 'scanned', 'doc', 'docs', 'document', 'untitled', 'new', 'file', 'files', 'copy', 'final', 'test',
  'temp', 'tmp', 'screenshot', 'screen', 'shot', 'video', 'vid', 'dsc', 'dscn', 'pxl', 'mvimg', 'text', 'unnamed',
  'export', 'output', 'data', 'misc', 'stuff', 'page', 'pages', 'asdf', 'qwerty', 'foo', 'bar', 'baz', 'draft',
  'version', 'backup', 'old', 'noname', 'attachment',
]);
const HOME_ROW = new Set('asdfghjkl'.split(''));

/** Is this chunk of letters real-looking, or keyboard mash / random characters? */
function looksRandom(letters) {
  if (letters.length < 5) return false;
  const vowels = (letters.match(/[aeiouyæøåäöü]/gi) || []).length;
  if (vowels / letters.length < 0.2) return true; // "rtyrghf"
  const home = [...letters.toLowerCase()].filter((c) => HOME_ROW.has(c)).length;
  return letters.length >= 8 && home / letters.length > 0.7; // "asdgawgwagasdf"
}

/** Does this name look like a camera/scanner/download default that nobody can recognise later? */
function looksMessy(baseName) {
  const b = baseName.trim();
  if (!b) return true;
  if (/^[\d\s_.\-()]+$/.test(b)) return true; // only digits and separators
  if (/^[0-9a-f]{8,}([-_][0-9a-f-]+)*$/i.test(b)) return true; // hash / uuid
  // Break into word-ish pieces (also splitting "453754rtyrghf" into digits + letters).
  const pieces = b.split(/[^\p{L}]+/u).filter(Boolean);
  const meaningful = pieces.filter((w) => {
    const lw = w.toLowerCase();
    return w.length >= 3 && !GENERIC.has(lw) && !looksRandom(w);
  });
  return meaningful.length < 2; // a single word such as "manual" or "report" is not descriptive enough
}

const TITLE_FILLER = new Set(['pdf', 'manual', 'guide', 'user', 'game', 'instructions', 'unknown', 'miscellaneous', 'untitled', 'document', 'documents', 'file', 'text', 'notes', 'the', 'a', 'of', 'and']);
/** "PDF Manual" or "Document" tells you nothing; a title needs at least one specific word. */
function isGenericTitle(title) {
  const words = String(title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.every((w) => TITLE_FILLER.has(w) || GENERIC.has(w));
}

function validDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7);
  const day = +d.slice(8, 10);
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && day >= 1 && day <= 31;
}

/** Build the final file name from the model's title (+ optional date) and the original extension. */
function buildName({ title, date, original }) {
  const ext = path.extname(original);
  const origBase = path.basename(original, ext);
  let base = sanitizeBase(title);
  if (!base || isGenericTitle(base)) return original;
  if (validDate(date) && !base.includes(date.slice(0, 4))) base = `${date} ${base}`;
  // Don't repeat the extension if the model included it.
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length).trim();
  if (!base || base === origBase) return original;
  return base + ext;
}

module.exports = { isGenericTitle, sanitizeBase, looksMessy, validDate, buildName };
