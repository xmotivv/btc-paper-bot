'use strict';
// A minimal Discord bot client: just enough to post messages with buttons,
// edit them, and hear about button clicks.
//
// Why a bot and not the webhook: a webhook can only send. For a click to do
// anything, Discord has to deliver it somewhere, and it delivers to a bot. The
// bot connects OUT to Discord's gateway over a WebSocket, so nothing needs to
// be opened or forwarded on this PC — but the app has to be running.
//
// The bot token is a secret (it lets its holder act as the bot). It is given
// to configure() at runtime and never appears in status(), logs or saved state.

const { EventEmitter } = require('events');

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // reconnecting cannot fix these
const SNOWFLAKE = /^\d{15,25}$/;
const TOKEN = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;
const PERMISSIONS = 1024 + 2048 + 16384; // View Channel + Send Messages + Embed Links
const REST_GAP_MS = 400;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class DiscordBot extends EventEmitter {
  constructor({ fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, restGapMs = REST_GAP_MS } = {}) {
    super();
    this.fetch = fetchImpl;
    this.WS = WebSocketImpl || null;
    this.restGapMs = restGapMs;
    this.token = null;
    this.channelId = null;
    this.userId = null; // the only Discord user whose clicks are obeyed
    this.appId = null;
    this.botName = null;
    this.ready = false;
    this.lastError = null;
    this.rev = 0;
    this._wanted = false;
    this._ws = null;
    this._seq = null;
    this._beat = null;
    this._first = null;
    this._retry = null;
    this._acked = true;
    this._backoff = 1000;
    this._chain = Promise.resolve();
    this._lastRestAt = 0;
  }

  get configured() { return !!(this.token && this.channelId && this.userId); }

  /** Set the bot's credentials. Returns { ok } or { error }. Does not connect. */
  configure({ token, channelId, userId } = {}) {
    const t = String(token || '').trim();
    const c = String(channelId || '').trim();
    const u = String(userId || '').trim();
    if (!TOKEN.test(t)) return { error: 'That does not look like a Discord bot token (Developer Portal → your application → Bot → Reset Token).' };
    if (!SNOWFLAKE.test(u)) return { error: 'Your Discord user ID should be a long number (enable Developer Mode in Discord, then right-click yourself → Copy User ID).' };
    if (!SNOWFLAKE.test(c)) return { error: 'The channel ID should be a long number (right-click the channel → Copy Channel ID).' };
    this.stop();
    this.token = t;
    this.channelId = c;
    this.userId = u;
    this.lastError = null;
    this.rev++;
    return { ok: true };
  }

  clear() {
    this.stop();
    this.token = this.channelId = this.userId = this.appId = this.botName = null;
    this.lastError = null;
    this.rev++;
  }

  inviteUrl() {
    return this.appId ? `https://discord.com/oauth2/authorize?client_id=${this.appId}&scope=bot&permissions=${PERMISSIONS}` : null;
  }

  status() {
    return {
      configured: this.configured,
      connected: this.ready,
      botName: this.botName,
      inviteUrl: this.inviteUrl(),
      lastError: this.lastError,
    };
  }

  // --------------------------------------------------------------------- REST
  /** One REST call. Calls are spaced out and a rate-limit reply is waited out once. */
  api(method, path, body, { queued = true, auth = true } = {}) {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (queued) {
          const gap = this._lastRestAt + this.restGapMs - Date.now();
          if (gap > 0) await wait(gap);
          this._lastRestAt = Date.now();
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        let res;
        try {
          res = await this.fetch(`${API}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bot ${this.token}` } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
          });
        } catch (e) {
          throw new Error(e.name === 'AbortError' ? 'Discord did not answer in time' : `Could not reach Discord (${e.message})`);
        } finally {
          clearTimeout(timer);
        }
        let data = {};
        try { data = await res.json(); } catch { /* empty body (204) */ }
        if (res.ok) return data || {};
        if (res.status === 429 && attempt === 0) {
          await wait(Math.min(15000, Math.max(500, (Number(data && data.retry_after) || 2) * 1000)));
          continue;
        }
        const err = new Error(this._explain(res.status, data));
        err.status = res.status;
        throw err;
      }
      throw new Error('Discord is rate limiting the bot');
    };
    if (!queued) return run();
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  _explain(status, data) {
    if (status === 401) return 'Discord rejected the bot token.';
    if (status === 403) return 'The bot is not allowed to do that in this channel. Invite it to the server and give it View Channel, Send Messages and Embed Links.';
    if (status === 404) return 'Discord could not find that channel or message. Check the channel ID and that the bot is in the server.';
    return (data && data.message) || `Discord replied HTTP ${status}`;
  }

  /** Check the token and channel by asking Discord who the bot is and whether it can see the channel. */
  async verify() {
    const me = await this.api('GET', '/users/@me'); // throws if the token is wrong
    this.botName = me.username || 'bot';
    this.appId = me.id;
    this.rev++;
    // Not being able to see the channel yet is normal: the bot has to be invited first.
    try {
      await this.api('GET', `/channels/${this.channelId}`);
      return { ok: true, botName: this.botName, channelOk: true };
    } catch (e) {
      return { ok: true, botName: this.botName, channelOk: false, channelError: e.message };
    }
  }

  async send(payload) {
    const m = await this.api('POST', `/channels/${this.channelId}/messages`, payload);
    return m.id;
  }

  edit(messageId, payload) {
    return this.api('PATCH', `/channels/${this.channelId}/messages/${messageId}`, payload);
  }

  /** Answer a button click. Discord wants this within 3 seconds, so it skips the queue. */
  respond(interaction, body) {
    return this.api('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, body, { queued: false, auth: false });
  }

  /** A private follow-up to the person who clicked. */
  followup(interaction, data) {
    return this.api('POST', `/webhooks/${interaction.application_id || this.appId}/${interaction.token}`, data, { queued: false, auth: false });
  }

  // ------------------------------------------------------------------ gateway
  start() {
    if (this._wanted || !this.configured || !this.WS) return;
    this._wanted = true;
    this._connect();
  }

  stop() {
    this._wanted = false;
    clearTimeout(this._retry);
    this._drop();
  }

  _connect() {
    if (!this._wanted) return;
    let ws;
    try { ws = new this.WS(GATEWAY); } catch { this._reconnect(); return; }
    this._ws = ws;
    ws.onmessage = (e) => {
      if (ws !== this._ws) return;
      let p;
      try { p = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      this._onPayload(p);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (ws !== this._ws) return;
      this._drop();
      const code = e && e.code;
      if (FATAL_CLOSE.has(code)) {
        this._wanted = false;
        this.lastError = code === 4004 ? 'Discord rejected the bot token. Paste a fresh one in Settings.' : `Discord refused the connection (code ${code}).`;
        this.rev++;
        this.emit('problem', this.lastError);
        return;
      }
      this._reconnect();
    };
  }

  _onPayload(p) {
    if (p.s != null) this._seq = p.s;
    switch (p.op) {
      case 10: { // Hello: start heartbeating, then say who we are
        const every = Math.max(1000, Number(p.d && p.d.heartbeat_interval) || 41250);
        this._acked = true;
        clearTimeout(this._first);
        clearInterval(this._beat);
        this._first = setTimeout(() => {
          this._heartbeat();
          this._beat = setInterval(() => this._heartbeat(), every);
          if (this._beat.unref) this._beat.unref();
        }, Math.floor(every * Math.random()));
        if (this._first.unref) this._first.unref();
        // intents 0: button clicks are delivered without subscribing to any other events
        this._send({ op: 2, d: { token: this.token, intents: 0, properties: { os: 'windows', browser: 'btc-paper-bot', device: 'btc-paper-bot' } } });
        break;
      }
      case 11: this._acked = true; break;
      case 1: this._send({ op: 1, d: this._seq }); break;
      case 7: // Reconnect
      case 9: // Invalid session
        this._drop();
        this._reconnect(p.op === 9 ? 1000 + Math.floor(Math.random() * 4000) : 500);
        break;
      case 0:
        if (p.t === 'READY') {
          this.ready = true;
          this._backoff = 1000;
          this.lastError = null;
          if (p.d && p.d.user) this.botName = p.d.user.username || this.botName;
          if (p.d && p.d.application && p.d.application.id) this.appId = p.d.application.id;
          this.rev++;
          this.emit('ready');
        } else if (p.t === 'INTERACTION_CREATE') {
          this.emit('interaction', p.d);
        }
        break;
      default:
    }
  }

  _heartbeat() {
    if (!this._acked) { // no acknowledgement since the last beat: the connection is dead
      this._drop();
      this._reconnect(500);
      return;
    }
    this._acked = false;
    this._send({ op: 1, d: this._seq });
  }

  _send(obj) {
    try { if (this._ws) this._ws.send(JSON.stringify(obj)); } catch { /* reconnect will follow */ }
  }

  _drop() {
    clearTimeout(this._first);
    clearInterval(this._beat);
    this._first = this._beat = null;
    const ws = this._ws;
    this._ws = null;
    this._seq = null;
    if (this.ready) { this.ready = false; this.rev++; }
    if (ws) {
      ws.onmessage = ws.onclose = null;
      ws.onerror = () => {};
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  _reconnect(delay) {
    if (!this._wanted) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect(), delay ?? this._backoff);
    if (this._retry.unref) this._retry.unref();
    if (delay == null) this._backoff = Math.min(this._backoff * 2, 30000);
  }
}

module.exports = { DiscordBot, API, GATEWAY, PERMISSIONS };
