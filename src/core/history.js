'use strict';
const fs = require('fs');
const path = require('path');

/** A small JSON file that remembers every tidy-up so each one can be undone. */
class HistoryStore {
  constructor(file, limit = 60) {
    this.file = file;
    this.limit = limit;
    this.data = { batches: [] };
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.data.batches)) this.data = { batches: [] };
    } catch {
      /* first run */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  add({ folder, moves, auto = false }) {
    const batch = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      folder,
      auto,
      undone: false,
      moves,
    };
    this.data.batches.unshift(batch);
    this.data.batches = this.data.batches.slice(0, this.limit);
    this._save();
    return batch;
  }

  list() {
    return this.data.batches.map((b) => ({
      id: b.id,
      at: b.at,
      folder: b.folder,
      auto: b.auto,
      undone: b.undone,
      count: b.moves.length,
      sample: b.moves.slice(0, 4).map((m) => ({ from: path.basename(m.from), to: path.basename(m.to) })),
    }));
  }

  get(id) {
    return this.data.batches.find((b) => b.id === id);
  }

  markUndone(id) {
    const b = this.get(id);
    if (b) {
      b.undone = true;
      this._save();
    }
  }
}

module.exports = { HistoryStore };
