'use strict';
// The no-AI fallback: sorts by file type. Used when the model is off, still downloading,
// or fails on a particular file, so the app is never useless.
const path = require('path');

const SCREENSHOT_RE = /^(screenshot|screen shot|skjermbilde|bildschirmfoto|captura de pantalla|capture d.écran|schermafbeelding)/i;

const BY_EXT = {
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.md', '.odt', '.rtf', '.pages', '.epub'],
  Work: ['.ppt', '.pptx', '.key', '.odp'],
  Photos: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp', '.tiff', '.raw', '.svg'],
  'Music & Video': ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.mkv', '.avi', '.webm'],
  Installers: ['.dmg', '.pkg', '.exe', '.msi', '.deb', '.rpm', '.appimage'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'],
  'Code & Data': [
    '.csv', '.json', '.xlsx', '.xls', '.numbers', '.ods', '.sqlite', '.py', '.js', '.ts', '.html',
    '.css', '.java', '.c', '.cpp', '.go', '.rs', '.sh', '.ipynb', '.sql', '.xml', '.yaml', '.yml',
  ],
};
const EXT_TO_CAT = {};
for (const [cat, exts] of Object.entries(BY_EXT)) for (const e of exts) EXT_TO_CAT[e] = cat;

const BILL_WORDS = /(invoice|receipt|faktura|kvittering|rechnung|factura|bill|statement|tax|skatt|order)/i;

/** Map a wanted category onto the user's category list, falling back gracefully. */
function fit(category, categories) {
  if (categories.includes(category)) return category;
  if (categories.includes('Other')) return 'Other';
  return categories[categories.length - 1] || 'Other';
}

function categoryByRules(fileName, categories) {
  const ext = path.extname(fileName).toLowerCase();
  const base = path.basename(fileName, ext);
  if (SCREENSHOT_RE.test(base)) return fit('Screenshots', categories);
  if (BILL_WORDS.test(base) && ['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.txt'].includes(ext)) {
    return fit('Bills & Receipts', categories);
  }
  return fit(EXT_TO_CAT[ext] || 'Other', categories);
}

module.exports = { categoryByRules, fit, SCREENSHOT_RE };
