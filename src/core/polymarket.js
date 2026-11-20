'use strict';
// Read-only Polymarket clients (no keys needed). Paper trading never sends orders.

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const WINDOWS = {
  '5m': { seconds: 300, prefix: 'btc-updown-5m' },
  '15m': { seconds: 900, prefix: 'btc-updown-15m' },
};

async function getJson(url, fetchImpl = fetch, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Start/end (unix seconds) and slug of the window containing `nowSec`. */
function windowFor(nowSec, windowKey = '15m') {
  const w = WINDOWS[windowKey];
  if (!w) throw new Error(`Unknown window ${windowKey}`);
  const start = Math.floor(nowSec / w.seconds) * w.seconds;
  return { start, end: start + w.seconds, seconds: w.seconds, slug: `${w.prefix}-${start}` };
}

function parseMaybeJson(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

/** Normalise a Gamma event into the shape the engine uses. Returns null if unusable. */
function normaliseEvent(event, win) {
  const m = event && Array.isArray(event.markets) ? event.markets[0] : null;
  if (!m) return null;
  const outcomes = parseMaybeJson(m.outcomes);
  const tokens = parseMaybeJson(m.clobTokenIds);
  const prices = parseMaybeJson(m.outcomePrices).map(Number);
  if (outcomes.length !== 2 || tokens.length !== 2) return null;
  const tokenByOutcome = {};
  outcomes.forEach((o, i) => { tokenByOutcome[o] = tokens[i]; });
  let resolved = null;
  if (m.closed && prices.length === 2) {
    const winIdx = prices.findIndex((p) => p >= 0.99);
    if (winIdx >= 0) resolved = outcomes[winIdx];
  }
  return {
    slug: win.slug,
    title: event.title || m.question || win.slug,
    start: win.start,
    end: win.end,
    outcomes,
    tokenByOutcome,
    closed: !!m.closed,
    resolved, // 'Up' | 'Down' | null
    url: `https://polymarket.com/event/${win.slug}`,
  };
}

async function fetchMarket(win, fetchImpl) {
  const data = await getJson(`${GAMMA}/events?slug=${encodeURIComponent(win.slug)}`, fetchImpl);
  const event = Array.isArray(data) ? data[0] : data;
  return event ? normaliseEvent(event, win) : null;
}

/** Order book for one outcome token. Sorted: bids high→low, asks low→high. */
async function fetchBook(tokenId, fetchImpl) {
  const b = await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, fetchImpl);
  return normaliseBook(b);
}

function normaliseBook(b) {
  const lvl = (x) => ({ price: Number(x.price), size: Number(x.size) });
  const bids = (b && b.bids ? b.bids.map(lvl) : []).filter((l) => l.size > 0).sort((a, z) => z.price - a.price);
  const asks = (b && b.asks ? b.asks.map(lvl) : []).filter((l) => l.size > 0).sort((a, z) => a.price - z.price);
  return {
    bids,
    asks,
    bid: bids[0] ? bids[0].price : null,
    ask: asks[0] ? asks[0].price : null,
  };
}

module.exports = { WINDOWS, windowFor, fetchMarket, fetchBook, normaliseEvent, normaliseBook, getJson };
