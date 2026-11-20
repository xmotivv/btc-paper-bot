'use strict';
// Tiny JSON persistence + daily tick recorder (JSONL) under the app's data folder.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.ticksDir = path.join(dir, 'ticks');
    fs.mkdirSync(this.ticksDir, { recursive: true });
    this._timer = null;
    this._pending = null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Debounced atomic save. */
  save(obj) {
    this._pending = obj;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._pending) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._pending));
    fs.renameSync(tmp, this.file);
    this._pending = null;
  }

  /** Append one market snapshot to today's tick log for later analysis. */
  recordTick(row) {
    const day = new Date(row.t).toISOString().slice(0, 10);
    fs.appendFile(path.join(this.ticksDir, `${day}.jsonl`), JSON.stringify(row) + '\n', () => {});
  }
}

module.exports = { Store };
