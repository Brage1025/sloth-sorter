'use strict';
// Scan a folder, build a reviewable plan, apply it safely, undo it.
// Safety rules: never delete, never overwrite, never touch subfolders or hidden/partial files.
const fs = require('fs');
const path = require('path');
const { sanitizeBase } = require('./naming');

const SKIP_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);
const SKIP_EXTS = new Set([
  // browsers/apps still writing the file
  '.crdownload', '.part', '.partial', '.tmp', '.temp', '.download', '.opdownload',
  // shortcuts: moving them breaks nothing but surprises people
  '.lnk', '.url', '.webloc', '.alias',
]);

function scanFolder(dir, { minAgeMs = 0, now = Date.now() } = {}) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Can't open that folder (${e.code || e.message}).`);
  }
  for (const e of entries) {
    if (!e.isFile()) continue; // folders, symlinks, sockets
    const name = e.name;
    if (name.startsWith('.') || name.startsWith('~$') || SKIP_NAMES.has(name.toLowerCase())) continue;
    if (SKIP_EXTS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < minAgeMs) continue; // probably still in use
    out.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Pick a destination that doesn't exist yet and isn't already promised to another file. */
function uniquePath(dest, taken = new Set()) {
  const ext = path.extname(dest);
  const stem = dest.slice(0, dest.length - ext.length);
  let cand = dest;
  let n = 2;
  while (fs.existsSync(cand) || taken.has(cand.toLowerCase())) cand = `${stem} (${n++})${ext}`;
  return cand;
}

function destinationFor(settings, category, fileName, taken) {
  const catDir = sanitizeBase(category, 40) || 'Other';
  const root = path.join(settings.folder, sanitizeBase(settings.sortedFolder, 40) || 'Sorted');
  return uniquePath(path.join(root, catDir, fileName), taken);
}

/**
 * Look at every file and decide where it goes. Moves nothing.
 * @returns items [{id,name,from,to,size,category,newName,reason,source}]
 */
async function buildPlan(settings, classify, { onProgress, signal, minAgeMs = 0 } = {}) {
  const files = scanFolder(settings.folder, { minAgeMs });
  const taken = new Set();
  const items = [];
  for (let i = 0; i < files.length; i++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const f = files[i];
    onProgress && onProgress({ done: i, total: files.length, current: f.name });
    const r = await classify(f);
    const to = destinationFor(settings, r.category, r.newName, taken);
    taken.add(to.toLowerCase());
    items.push({
      id: i,
      name: f.name,
      from: f.path,
      to,
      size: f.size,
      category: r.category,
      newName: path.basename(to),
      reason: r.reason,
      source: r.source,
      basis: r.basis,
    });
  }
  onProgress && onProgress({ done: files.length, total: files.length, current: '' });
  return items;
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

/**
 * Do the moves. `choices` come from the review screen: [{from, category, newName}].
 * The renderer never sends destinations, they are rebuilt here from validated pieces.
 */
function applyPlan(settings, choices) {
  const root = path.resolve(settings.folder);
  const taken = new Set();
  const moves = [];
  const failed = [];
  for (const c of choices) {
    try {
      const from = path.resolve(c.from);
      if (path.dirname(from) !== root) throw new Error('File is not in the chosen folder');
      if (!fs.statSync(from).isFile()) throw new Error('Not a file');
      const ext = path.extname(from);
      let base = c.newName ? String(c.newName) : path.basename(from);
      if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
      const fileName = (sanitizeBase(base) || path.basename(from, ext)) + ext; // extension is never changed
      const to = destinationFor(settings, c.category || 'Other', fileName, taken);
      taken.add(to.toLowerCase());
      moveFile(from, to);
      moves.push({ from, to });
    } catch (e) {
      failed.push({ from: c.from, error: e.message });
    }
  }
  return { moves, failed };
}

function removeIfEmpty(dir) {
  try {
    fs.rmdirSync(dir); // only succeeds when empty
    return true;
  } catch {
    return false;
  }
}

/** Put every file of a batch back where it came from. */
function undoMoves(moves) {
  let restored = 0;
  const missing = [];
  const dirs = new Set();
  for (const m of [...moves].reverse()) {
    try {
      if (!fs.existsSync(m.to)) {
        missing.push(m.to);
        continue;
      }
      const dest = fs.existsSync(m.from) ? uniquePath(m.from) : m.from;
      moveFile(m.to, dest);
      dirs.add(path.dirname(m.to));
      restored++;
    } catch (e) {
      missing.push(`${m.to} (${e.message})`);
    }
  }
  // Tidy up folders we created and that are now empty (category folders, then "Sorted").
  for (const d of dirs) {
    if (removeIfEmpty(d)) removeIfEmpty(path.dirname(d));
  }
  return { restored, missing };
}

module.exports = { scanFolder, buildPlan, applyPlan, undoMoves, uniquePath, moveFile };
