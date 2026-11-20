'use strict';
// Push feeds. Instead of polling REST every couple of seconds, the engine
// listens to three public WebSockets (no keys) and reacts within milliseconds:
//   BtcStream       Coinbase BTC-USD ticker (the fast signal)
//   BookStream      Polymarket order books, kept current from deltas
//   ChainlinkStream the Chainlink BTC/USD feed Polymarket settles with
// Every stream reconnects on its own; while one is down the engine falls back
// to REST polling, so nothing here is required for the bot to work.

const { EventEmitter } = require('events');

const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
const POLYMARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RTDS_WS = 'wss://ws-live-data.polymarket.com';

/** A WebSocket that reconnects with backoff and restarts itself if it goes quiet. */
class Socket extends EventEmitter {
  constructor({ url, WebSocketImpl, pingMs = 0, pingText = 'PING', stallMs = 15000, connectArgs = null }) {
    super();
    this.url = url;
    this.connectArgs = connectArgs; // () => extra constructor arguments, e.g. [{ headers }] for a signed handshake
    this.WS = WebSocketImpl;
    this.pingMs = pingMs;
    this.pingText = pingText;
    this.stallMs = stallMs;
    this.ws = null;
    this.open = false;
    this.wanted = false;
    this.lastMessageAt = 0;
    this._backoff = 500;
    this._retry = null;
    this._beat = null;
  }

  start() {
    if (this.wanted || !this.WS) return;
    this.wanted = true;
    this._connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this._retry);
    this._drop();
  }

  send(text) {
    if (!this.open) return false;
    try { this.ws.send(text); return true; } catch { return false; }
  }

  _connect() {
    if (!this.wanted) return;
    let ws;
    try { ws = this.connectArgs ? new this.WS(this.url, ...this.connectArgs()) : new this.WS(this.url); } catch { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.open = true;
      this._backoff = 500;
      this.lastMessageAt = Date.now();
      const every = Math.min(this.pingMs || this.stallMs, this.stallMs) / 2;
      this._beat = setInterval(() => this._heartbeat(), Math.max(1000, every));
      this._lastPing = 0;
      this.emit('open');
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = Date.now();
      this.emit('message', typeof e.data === 'string' ? e.data : String(e.data));
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this._drop();
      this._scheduleRetry();
    };
  }

  _heartbeat() {
    const now = Date.now();
    if (now - this.lastMessageAt > this.stallMs) {
      this._drop();
      this._scheduleRetry();
      return;
    }
    if (this.pingMs && now - this._lastPing >= this.pingMs) {
      this._lastPing = now;
      this.send(this.pingText);
    }
  }

  _drop() {
    clearInterval(this._beat);
    this._beat = null;
    const ws = this.ws;
    this.ws = null;
    const wasOpen = this.open;
    this.open = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => {};
      try { ws.close(); } catch { /* already closed */ }
    }
    if (wasOpen) this.emit('down');
  }

  _scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, 10000);
  }
}

// ------------------------------------------------------------------ BTC price
class BtcStream extends EventEmitter {
  constructor({ WebSocketImpl, product = 'BTC-USD' } = {}) {
    super();
    this.price = null;
    this.lastAt = 0;
    this.sock = new Socket({ url: COINBASE_WS, WebSocketImpl, stallMs: 10000 });
    this.sock.on('open', () => {
      this.sock.send(JSON.stringify({ type: 'subscribe', product_ids: [product], channels: ['ticker'] }));
    });
    this.sock.on('message', (s) => {
      if (s.charCodeAt(0) !== 123 || !s.includes('"ticker"')) return;
      let j;
      try { j = JSON.parse(s); } catch { return; }
      const p = Number(j.price);
      if (j.type !== 'ticker' || !(p > 0)) return;
      this.price = p;
      this.lastAt = Date.now();
      this.emit('price', p);
    });
  }

  start() { this.sock.start(); }
  stop() { this.sock.stop(); }
  /** True while prices are arriving (a quiet socket is treated as down). */
  get live() { return this.sock.open && Date.now() - this.lastAt < 5000; }
}

// ---------------------------------------------------------------- order books
/** One side-by-side book kept current from snapshots + deltas. Same shape as normaliseBook(). */
class LiveBook {
  constructor() {
    this._b = new Map();
    this._a = new Map();
    this._bids = null;
    this._asks = null;
    this.ready = false;
  }

  snapshot(bids, asks) {
    this._b.clear();
    this._a.clear();
    for (const l of bids || []) this._put(this._b, Number(l.price), Number(l.size));
    for (const l of asks || []) this._put(this._a, Number(l.price), Number(l.size));
    this._bids = this._asks = null;
    this.ready = true;
  }

  update(side, price, size) {
    if (side === 'BUY') { this._put(this._b, price, size); this._bids = null; } else { this._put(this._a, price, size); this._asks = null; }
  }

  _put(map, price, size) {
    if (!(price > 0)) return;
    if (size > 0) map.set(price, size);
    else map.delete(price);
  }

  get bids() {
    if (!this._bids) this._bids = [...this._b].map(([price, size]) => ({ price, size })).sort((x, y) => y.price - x.price);
    return this._bids;
  }

  get asks() {
    if (!this._asks) this._asks = [...this._a].map(([price, size]) => ({ price, size })).sort((x, y) => x.price - y.price);
    return this._asks;
  }

  get bid() { const l = this.bids[0]; return l ? l.price : null; }
  get ask() { const l = this.asks[0]; return l ? l.price : null; }
}

class BookStream extends EventEmitter {
  constructor({ WebSocketImpl } = {}) {
    super();
    this.WS = WebSocketImpl;
    this.tracked = new Map(); // slug -> { sock, books: {outcome: LiveBook}, byToken: Map }
  }

  /** Start streaming a market's two books (no-op if already tracked). */
  track(slug, tokenByOutcome) {
    if (this.tracked.has(slug) || !this.WS) return;
    const books = {};
    const byToken = new Map();
    for (const [outcome, token] of Object.entries(tokenByOutcome)) {
      books[outcome] = new LiveBook();
      byToken.set(String(token), books[outcome]);
    }
    const sock = new Socket({ url: POLYMARKET_WS, WebSocketImpl: this.WS, pingMs: 5000, stallMs: 15000 });
    sock.on('open', () => sock.send(JSON.stringify({ assets_ids: [...byToken.keys()], type: 'market' })));
    const entry = { sock, books, byToken, waitingSince: Date.now() };
    sock.on('down', () => {
      for (const b of Object.values(books)) b.ready = false;
      entry.waitingSince = Date.now();
    });
    sock.on('message', (s) => { if (this._apply(s, byToken)) this.emit('change', slug); });
    this.tracked.set(slug, entry);
    sock.start();
  }

  untrack(slug) {
    const t = this.tracked.get(slug);
    if (!t) return;
    t.sock.stop();
    t.sock.removeAllListeners();
    this.tracked.delete(slug);
  }

  /** Keep only these slugs. */
  keep(slugs) {
    for (const slug of [...this.tracked.keys()]) if (!slugs.includes(slug)) this.untrack(slug);
  }

  stop() { this.keep([]); }

  /** Live books for a market, or null until both snapshots have arrived. */
  books(slug) {
    const t = this.tracked.get(slug);
    if (!t || !t.sock.open) return null;
    for (const b of Object.values(t.books)) if (!b.ready) return null;
    return t.books;
  }

  /**
   * True while a market's stream is still (re)connecting and has been for less
   * than `graceMs`. Callers should wait rather than trade on a REST snapshot:
   * REST books can be a second or two old, and filling against a stale quote
   * just before the live book arrives produces profits that never existed.
   */
  connecting(slug, graceMs) {
    const t = this.tracked.get(slug);
    return !!t && !this.books(slug) && Date.now() - t.waitingSince < graceMs;
  }

  _apply(s, byToken) {
    const c = s.charCodeAt(0);
    if (c !== 123 && c !== 91) return false; // PONG and friends
    let j;
    try { j = JSON.parse(s); } catch { return false; }
    let changed = false;
    for (const m of Array.isArray(j) ? j : [j]) {
      if (m.event_type === 'price_change') {
        for (const ch of m.price_changes || []) {
          const book = byToken.get(ch.asset_id);
          if (!book || !book.ready) continue;
          book.update(ch.side, Number(ch.price), Number(ch.size));
          changed = true;
        }
      } else if (m.event_type === 'book') {
        const book = byToken.get(m.asset_id);
        if (!book) continue;
        book.snapshot(m.bids, m.asks);
        changed = true;
      }
    }
    return changed;
  }
}

// ------------------------------------------------------- settlement reference
/** Chainlink BTC/USD (one value per second) relayed by Polymarket's real-time data service. */
class ChainlinkStream extends EventEmitter {
  constructor({ WebSocketImpl, symbol = 'btc/usd' } = {}) {
    super();
    this.samples = new Map(); // unix second -> price
    this.lastSec = 0;
    this.price = null;
    this.lastAt = 0;
    this.sock = new Socket({ url: RTDS_WS, WebSocketImpl, pingMs: 5000, stallMs: 15000 });
    this.sock.on('open', () => {
      this.sock.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol }) }],
      }));
    });
    this.sock.on('message', (s) => {
      if (s.charCodeAt(0) !== 123) return;
      let j;
      try { j = JSON.parse(s); } catch { return; }
      const p = j.payload;
      if (!p) return;
      if (Array.isArray(p.data)) { // backfill sent on subscribe
        for (const d of p.data) this._add(d.timestamp, d.value);
      } else if (p.symbol === symbol || p.symbol == null) {
        this._add(p.timestamp, p.value);
      } else return;
      this.lastAt = Date.now();
      this.emit('price', this.price, this.lastSec);
    });
  }

  start() { this.sock.start(); }
  stop() { this.sock.stop(); }
  get live() { return this.sock.open && Date.now() - this.lastAt < 6000; }

  _add(tsMs, value) {
    const v = Number(value);
    const sec = Math.round(Number(tsMs) / 1000);
    if (!(v > 0) || !(sec > 0)) return;
    this.samples.set(sec, v);
    if (sec >= this.lastSec) { this.lastSec = sec; this.price = v; }
    if (this.samples.size > 2400) { // keep ~30 minutes
      const cut = this.lastSec - 1800;
      for (const k of this.samples.keys()) if (k < cut) this.samples.delete(k);
    }
  }

  /** Mean of the samples in (fromSec, toSec]. Returns { mean, count }. */
  mean(fromSec, toSec) {
    let sum = 0;
    let count = 0;
    for (let t = Math.floor(fromSec) + 1; t <= toSec; t++) {
      const v = this.samples.get(t);
      if (v != null) { sum += v; count++; }
    }
    return { mean: count ? sum / count : null, count };
  }
}

module.exports = { Socket, BtcStream, BookStream, LiveBook, ChainlinkStream, COINBASE_WS, POLYMARKET_WS, RTDS_WS };
