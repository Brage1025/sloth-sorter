'use strict';
// Remembers what the AI decided for each file (path + size + modified time + settings),
// so re-scans and Sleep mode never pay twice for the same file.
const fs = require('fs');
const path = require('path');

class ResultCache {
  constructor(file, limit = 5000) {
    this.file = file;
    this.limit = limit;
    this.map = new Map();
    this.timer = null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j)) this.map.set(k, v);
    } catch {
      /* first run */
    }
  }

  static key(file, settings) {
    const s = [settings.model, settings.rename, settings.keepGoodNames, settings.useVision, settings.categories];
    return `${file.path}|${file.size}|${Math.round(file.mtime)}|${JSON.stringify(s)}`;
  }

  get(k) {
    return this.map.get(k);
  }

  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
    if (this.timer.unref) this.timer.unref();
  }

  /** Forget everything. Returns how many results were dropped. */
  clear() {
    const n = this.map.size;
    this.map.clear();
    clearTimeout(this.timer);
    this.flush();
    return n;
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      fs.renameSync(tmp, this.file);
    } catch {
      /* cache is only an optimisation */
    }
  }
}

module.exports = { ResultCache };
