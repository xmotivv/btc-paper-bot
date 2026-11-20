'use strict';
// Tiny JSON persistence + daily tick recorder (JSONL) under the app's data folder.
// Saves are debounced and written off the main thread's critical path: the
// engine can call save() as often as it likes without slowing trading down.

const fs = require('fs');
const path = require('path');

const SAVE_MS = 5000; // routine saves
const SOON_MS = 300; // after a trade or a settings change

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.ticksDir = path.join(dir, 'ticks');
    fs.mkdirSync(this.ticksDir, { recursive: true });
    this._timer = null;
    this._due = 0;
    this._pending = null;
    this._writing = false;
    this._tickDay = null;
    this._tickStream = null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Debounced atomic save. `soon` shortens the wait (use it after anything worth not losing). */
  save(obj, soon = false) {
    this._pending = obj;
    const due = Date.now() + (soon ? SOON_MS : SAVE_MS);
    if (this._timer && due >= this._due) return;
    clearTimeout(this._timer);
    this._due = due;
    this._timer = setTimeout(() => this._writeAsync(), due - Date.now());
  }

  async _writeAsync() {
    this._timer = null;
    if (!this._pending) return;
    if (this._writing) { this.save(this._pending, true); return; }
    const data = JSON.stringify(this._pending);
    this._pending = null;
    this._writing = true;
    const tmp = `${this.file}.tmp-async`;
    try {
      await fs.promises.writeFile(tmp, data);
      // If flush() wrote newer state while this was in flight, don't overwrite it.
      if (this._superseded) await fs.promises.rm(tmp, { force: true });
      else await fs.promises.rename(tmp, this.file);
    } catch {
      /* a later save will retry */
    } finally {
      this._writing = false;
      this._superseded = false;
    }
  }

  /** Write any pending state right now, synchronously (used on quit). */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._pending) return;
    if (this._writing) this._superseded = true;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._pending));
    fs.renameSync(tmp, this.file);
    this._pending = null;
  }

  /** Append one market snapshot to today's tick log for later analysis. */
  recordTick(row) {
    const day = new Date(row.t).toISOString().slice(0, 10);
    if (day !== this._tickDay) {
      if (this._tickStream) this._tickStream.end();
      this._tickDay = day;
      const fd = fs.openSync(path.join(this.ticksDir, `${day}.jsonl`), 'a');
      this._tickStream = fs.createWriteStream(null, { fd });
      this._tickStream.on('error', () => {});
    }
    this._tickStream.write(JSON.stringify(row) + '\n');
  }

  close() {
    this.flush();
    if (this._tickStream) this._tickStream.end();
    this._tickStream = null;
    this._tickDay = null;
  }
}

module.exports = { Store };
