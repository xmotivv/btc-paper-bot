'use strict';
// Polymarket US (the CFTC-regulated exchange at polymarket.us) — public market
// data. No keys needed for anything in this file.
//
// It is a separate exchange from polymarket.com: its own order books, fees and
// settlement index. The differences that matter here:
//   • One instrument per market. "Up" is the long (YES) side; "Down" is the
//     short side of the same book, so Down's ask is 1 − Up's bid.
//   • Markets settle on CF Benchmarks' Bitcoin Real-Time Index (BRTI), averaged
//     over 60 seconds. The exchange publishes that average once a second.

const { EventEmitter } = require('events');
const { getJson } = require('./polymarket');
const { Socket } = require('./streams');

const GATEWAY = 'https://gateway.polymarket.us';
const MARKETS_WS = 'wss://api.polymarket.us/v1/ws/markets';

const WINDOWS = {
  '5m': { seconds: 300, series: 'btc-updown-5m' },
  '15m': { seconds: 900, series: 'btc-updown-15m' },
};

/** 2026-11-20T17:45:00Z → "2026-11-20-1745z" */
function stamp(sec) {
  const iso = new Date(sec * 1000).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}z`;
}

/** Start/end (unix seconds) and slugs of the window containing `nowSec`. */
function windowFor(nowSec, windowKey = '15m') {
  const w = WINDOWS[windowKey];
  if (!w) throw new Error(`Unknown window ${windowKey}`);
  const start = Math.floor(nowSec / w.seconds) * w.seconds;
  const eventSlug = `${w.series}-${stamp(start)}`;
  // The market slug is what the engine keys everything on, and what orders are sent against.
  return { start, end: start + w.seconds, seconds: w.seconds, eventSlug, slug: `cpc-${eventSlug}` };
}

const eventSlugOf = (marketSlug) => marketSlug.replace(/^cpc-/, '');
const amount = (a) => (a && a.value != null && a.value !== '' ? Number(a.value) : null);

/** Normalise an event (as returned by /v1/events/slug/…) into the shape the engine uses. */
function normaliseEvent(event, win) {
  const m = event && Array.isArray(event.markets) ? event.markets[0] : null;
  if (!m || !m.slug) return null;
  const terms = m.assetPriceTerms || {};
  if (terms.marketType && terms.marketType !== 'ASSET_PRICE_MARKET_TYPE_UP_DOWN') return null;
  const start = terms.windowStart ? Date.parse(terms.windowStart) / 1000 : win.start;
  const end = terms.windowEnd ? Date.parse(terms.windowEnd) / 1000 : win.end;
  const priceToBeat = amount(terms.priceToBeat);
  const settlementPrice = amount(terms.settlementPrice);
  let resolved = null;
  if (m.status === 'MARKET_STATUS_RESOLVED' || (m.closed && settlementPrice != null)) {
    // Ties settle Up. Prefer the exchange's own published prices when they are decisive.
    let prices = [];
    try { prices = JSON.parse(m.outcomePrices || '[]').map(Number); } catch { /* fall through */ }
    if (prices.length === 2 && prices[0] !== prices[1]) resolved = prices[0] > prices[1] ? 'Up' : 'Down';
    else if (priceToBeat != null && settlementPrice != null) resolved = settlementPrice >= priceToBeat ? 'Up' : 'Down';
  }
  const tick = Number(m.orderPriceMinTickSize) > 0 ? Number(m.orderPriceMinTickSize) : 0.01;
  return {
    venue: 'us',
    slug: m.slug,
    eventSlug: event.slug || win.eventSlug,
    title: `${m.title || event.title || 'BTC Up or Down'}${m.subtitle ? ` · ${m.subtitle}` : ''}`,
    start,
    end,
    outcomes: ['Up', 'Down'],
    closed: !!m.closed,
    tradable: m.status === 'MARKET_STATUS_OPEN',
    resolved, // 'Up' | 'Down' | null
    feeRate: Number.isFinite(Number(m.feeCoefficient)) ? Number(m.feeCoefficient) : null, // fee = contracts × rate × p × (1 − p)
    twapSec: 60,
    tick,
    minQty: Number(m.minimumTradeQty) > 0 ? Number(m.minimumTradeQty) : 1,
    priceToBeat, // official figure, published shortly after the window opens
    settlementPrice,
    url: `https://polymarket.us/event/${event.slug || win.eventSlug}`,
  };
}

async function fetchMarket(win, fetchImpl) {
  const data = await getJson(`${GATEWAY}/v1/events/slug/${encodeURIComponent(win.eventSlug || eventSlugOf(win.slug))}`, fetchImpl);
  return data && data.event ? normaliseEvent(data.event, win) : null;
}

/** Winning outcome once the exchange has resolved the market, else null. */
async function fetchWinner(marketSlug, fetchImpl) {
  const m = await fetchMarket({ slug: marketSlug }, fetchImpl);
  return m ? m.resolved : null;
}

/**
 * The exchange has one book, for the Up (long) side. Turn it into the two
 * books the engine works with: Up as published, and Down as its mirror image
 * (someone bidding 0.39 for Up is offering Down at 0.61).
 */
function normaliseBook(marketData) {
  const lvl = (x) => ({ price: Number(x.px && x.px.value), size: Number(x.qty) });
  const ok = (l) => l.size > 0 && l.price > 0 && l.price < 1;
  const bids = ((marketData && marketData.bids) || []).map(lvl).filter(ok).sort((a, z) => z.price - a.price);
  const asks = ((marketData && marketData.offers) || []).map(lvl).filter(ok).sort((a, z) => a.price - z.price);
  const flip = (l) => ({ price: Math.round((1 - l.price) * 1e6) / 1e6, size: l.size });
  const book = (b, a) => ({ bids: b, asks: a, bid: b[0] ? b[0].price : null, ask: a[0] ? a[0].price : null });
  return {
    open: !marketData || !marketData.state || marketData.state === 'MARKET_STATE_OPEN',
    at: marketData && marketData.transactTime ? Date.parse(marketData.transactTime) : NaN, // when the exchange took this snapshot
    Up: book(bids, asks),
    Down: book(asks.map(flip), bids.map(flip)),
  };
}

/**
 * Order book snapshot for a market over REST. Two things make the public
 * gateway unsuitable for trading decisions (both measured): it allows only
 * about one book read every two seconds per IP, and it answers from a cache
 * that can be up to 30 seconds old. The snapshot's own `at` timestamp says how
 * old it really is. Pass a connected `client` to read through the
 * authenticated API instead; the real-time source is UsBookStream below.
 */
async function fetchBooks(marketSlug, fetchImpl, client) {
  const path = `/v1/markets/${encodeURIComponent(marketSlug)}/book`;
  const data = client ? await client.request('GET', path, { timeoutMs: 4000 }) : await getJson(`${GATEWAY}${path}`, fetchImpl, 4000);
  const md = data && data.marketData;
  if (!md || !Array.isArray(md.bids) || !Array.isArray(md.offers)) throw new Error('order book reply was not in the expected form');
  return normaliseBook(md);
}

/**
 * The settlement index as the exchange publishes it: one value per second,
 * each already the average of the 60 index prices ending at that second. So
 * the value stamped T − 1 is exactly what a window opening or closing at T
 * settles on. Returns [{ sec, value }] oldest→newest.
 */
async function fetchIndex(fromSec, fetchImpl) {
  const url = `${GATEWAY}/v1/asset-prices/history?assets=crypto:btc&from=${Math.floor(fromSec)}&to=0&bucket=ASSET_PRICE_BUCKET_1S`;
  const data = await getJson(url, fetchImpl, 4000);
  const series = data && Array.isArray(data.series) ? data.series[0] : null;
  const out = [];
  for (const c of (series && series.candles) || []) {
    const value = Number(c.close);
    if (value > 0 && c.tickCount !== 0) out.push({ sec: Number(c.timestamp), value });
  }
  return out;
}

/**
 * The exchange's real-time order book feed. It is only available to a
 * connected API key: the WebSocket handshake carries the same signed headers
 * as a REST request. Every message is a complete book, so there are no deltas
 * to get out of step with.
 */
class UsBookStream extends EventEmitter {
  constructor({ client, WebSocketImpl }) {
    super();
    this.slugs = [];
    this.bySlug = new Map(); // market slug -> { Up, Down, open, at }
    this.lastAt = 0;
    this._n = 0;
    this._sub = null;
    this.sock = new Socket({
      url: MARKETS_WS,
      WebSocketImpl,
      stallMs: 30000,
      connectArgs: () => [{ headers: client.headers('GET', '/v1/ws/markets') }],
    });
    this.sock.on('open', () => { this._sub = null; this._subscribe(); });
    this.sock.on('down', () => this.bySlug.clear());
    this.sock.on('message', (s) => this._onMessage(s));
  }

  start() { this.sock.start(); }
  stop() { this.sock.stop(); this.bySlug.clear(); }

  /** Subscribe to exactly these markets. */
  setMarkets(slugs) {
    const next = [...new Set(slugs)].sort();
    if (next.join() === this.slugs.join()) return;
    this.slugs = next;
    for (const k of [...this.bySlug.keys()]) if (!next.includes(k)) this.bySlug.delete(k);
    if (this.sock.open) this._subscribe();
  }

  _subscribe() {
    if (this._sub) this.sock.send(JSON.stringify({ unsubscribe: { requestId: this._sub } }));
    this._sub = null;
    if (!this.slugs.length) return;
    this._sub = `books-${++this._n}`;
    this.sock.send(JSON.stringify({ subscribe: { requestId: this._sub, subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA', marketSlugs: this.slugs } }));
  }

  _onMessage(s) {
    if (s.charCodeAt(0) !== 123) return;
    let j;
    try { j = JSON.parse(s); } catch { return; }
    this.lastAt = Date.now();
    if (j.error) { this.emit('problem', String(j.error.message || j.error)); return; }
    const md = j.marketData;
    if (!md || !Array.isArray(md.bids) || !Array.isArray(md.offers) || !this.slugs.includes(md.marketSlug)) return;
    this.bySlug.set(md.marketSlug, { ...normaliseBook(md), at: Date.now() });
    this.emit('book', md.marketSlug);
  }

  /** True while the connection is up and the server has been heard from recently. */
  get live() { return this.sock.open && Date.now() - this.lastAt < 15000; }

  /** Current book for a market, or null if the stream can't vouch for one right now. */
  books(slug) {
    return this.live ? this.bySlug.get(slug) || null : null;
  }
}

/** Rolling store of the index series, with the same reading interface as the Chainlink stream. */
class IndexSeries {
  constructor() {
    this.samples = new Map(); // unix second -> 60s average ending at that second
    this.lastSec = 0;
    this.price = null;
    this.lastAt = 0;
  }

  add(rows) {
    for (const r of rows) {
      this.samples.set(r.sec, r.value);
      if (r.sec >= this.lastSec) { this.lastSec = r.sec; this.price = r.value; }
    }
    if (rows.length) this.lastAt = Date.now();
    if (this.samples.size > 2400) {
      const cut = this.lastSec - 1800;
      for (const k of this.samples.keys()) if (k < cut) this.samples.delete(k);
    }
  }

  get live() { return Date.now() - this.lastAt < 6000; }

  /** What a window opening or closing at `sec` settles on, or null if that reading hasn't been seen. */
  settlementAt(sec) {
    return this.samples.get(sec - 1) ?? null;
  }
}

module.exports = { GATEWAY, WINDOWS, windowFor, eventSlugOf, stamp, normaliseEvent, normaliseBook, fetchMarket, fetchWinner, fetchBooks, fetchIndex, IndexSeries, UsBookStream, MARKETS_WS };
