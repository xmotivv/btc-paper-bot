'use strict';
// Posts trade activity to a Discord channel through a webhook.
//
// A webhook address lets anyone who has it post to that channel, so it is
// treated as a secret: it is supplied at runtime, never written to the saved
// state or the logs, and only ever shown masked.
//
// Sending is fire-and-forget and can never slow down or break trading: lines
// are queued, batched into one message every couple of seconds (Discord allows
// about five posts per two seconds per webhook), and dropped rather than
// retried forever if Discord is unreachable.

const HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{5,25})\/([\w-]{20,})\/?$/;
const MAX_CONTENT = 1900; // Discord's limit is 2000 characters per message
const MAX_QUEUE = 200;
const MAX_FAILURES = 5;

class DiscordNotifier {
  constructor({ fetchImpl = fetch, minGapMs = 2000, firstDelayMs = 400, username = 'BTC Paper Bot' } = {}) {
    this.fetch = fetchImpl;
    this.minGapMs = minGapMs;
    this.firstDelayMs = firstDelayMs;
    this.username = username;
    this.url = null;
    this.queue = [];
    this.sent = 0;
    this.dropped = 0;
    this.failures = 0;
    this.lastError = null;
    this.rev = 0;
    this._timer = null;
    this._sending = false;
    this._lastPostAt = 0;
    this._pausedUntil = 0;
  }

  get enabled() { return !!this.url; }

  /** Set (or with an empty value, remove) the webhook. Returns { ok, enabled } or { error }. */
  setUrl(url) {
    const u = String(url || '').trim();
    this.rev++;
    if (!u) {
      this.url = null;
      this.queue = [];
      clearTimeout(this._timer);
      this._timer = null;
      return { ok: true, enabled: false };
    }
    if (!HOOK.test(u)) return { error: 'That does not look like a Discord webhook address (it should start with https://discord.com/api/webhooks/…).' };
    this.url = u;
    this.failures = 0;
    this.lastError = null;
    this._pausedUntil = 0;
    return { ok: true, enabled: true };
  }

  /** The webhook with its secret part hidden, for display. */
  masked() {
    const m = this.url && HOOK.exec(this.url);
    return m ? `discord.com/api/webhooks/${m[1].slice(0, 4)}…/••••` : null;
  }

  status() {
    return { enabled: this.enabled, where: this.masked(), sent: this.sent, waiting: this.queue.length, dropped: this.dropped, lastError: this.lastError };
  }

  /** Queue one line of activity. Returns immediately. */
  push(line) {
    if (!this.url) return;
    this.queue.push(String(line).slice(0, 900));
    if (this.queue.length > MAX_QUEUE) { this.queue.shift(); this.dropped++; }
    this._schedule();
  }

  _schedule() {
    if (this._timer || this._sending || !this.url || !this.queue.length) return;
    const now = Date.now();
    const wait = Math.max(this.firstDelayMs, this._lastPostAt + this.minGapMs - now, this._pausedUntil - now);
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, wait);
    if (this._timer.unref) this._timer.unref(); // never keeps the app alive on its own
  }

  async _flush() {
    if (!this.url || !this.queue.length || this._sending) return;
    const lines = [];
    let size = 0;
    while (this.queue.length && size + this.queue[0].length + 1 <= MAX_CONTENT) {
      const l = this.queue.shift();
      lines.push(l);
      size += l.length + 1;
    }
    this._sending = true;
    const r = await this._post(lines.join('\n'));
    this._sending = false;
    this.rev++;
    if (r.ok) {
      this.sent += lines.length;
      this.failures = 0;
      this.lastError = null;
    } else if (r.gone) {
      // The webhook was deleted in Discord: stop until a new one is set.
      this.lastError = 'Discord says this webhook no longer exists. Set a new one in Settings.';
      this.url = null;
      this.queue = [];
      return;
    } else {
      this.lastError = r.error;
      if (r.retryMs) this._pausedUntil = Date.now() + r.retryMs;
      else this.failures++;
      if (this.failures >= MAX_FAILURES) { this.dropped += lines.length + this.queue.length; this.queue = []; this.failures = 0; } else this.queue.unshift(...lines);
    }
    this._schedule();
  }

  async _post(content) {
    this._lastPostAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // allowed_mentions: nothing in a trade line may ping anyone
        body: JSON.stringify({ username: this.username, content, allowed_mentions: { parse: [] } }),
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true };
      if (res.status === 404 || res.status === 401) return { gone: true };
      if (res.status === 429) {
        let retry = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (!(retry > 0)) { try { retry = Number((await res.json()).retry_after); } catch { retry = 0; } }
        return { error: 'Discord asked us to slow down', retryMs: Math.min(60000, Math.max(1000, (retry > 0 ? retry : 5) * 1000)) };
      }
      return { error: `Discord replied HTTP ${res.status}` };
    } catch (e) {
      return { error: e.name === 'AbortError' ? 'Discord did not answer in time' : `Could not reach Discord (${e.message})` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Post a test message right now. Returns { ok } or { error }. */
  async test() {
    if (!this.url) return { error: 'Set a webhook first.' };
    const r = await this._post('✅ BTC Paper Bot is connected to this channel. Trade activity will appear here.');
    this.rev++;
    if (r.ok) { this.lastError = null; return { ok: true }; }
    if (r.gone) { this.lastError = 'Discord says this webhook no longer exists.'; return { error: this.lastError }; }
    this.lastError = r.error;
    return { error: r.error };
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }
}

/** One activity-log line as it should appear in Discord, or null if it isn't trade activity. */
function formatActivity(level, msg, { includePaper = true } = {}) {
  const live = /^\[LIVE\b/.test(msg) || /^LIVE TRADING\b/.test(msg) || /real-money trading/.test(msg);
  if (level === 'trade') {
    if (!live && !includePaper) return null;
    return `${live ? '🔴 **LIVE**' : '📄 paper'}  ${msg}`;
  }
  // problems with real orders are worth knowing about straight away
  if (level === 'error' && live) return `⚠️ **LIVE**  ${msg}`;
  return null;
}

module.exports = { DiscordNotifier, formatActivity, HOOK };
