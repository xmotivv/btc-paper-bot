'use strict';
// BTC/USD spot price from Coinbase's public API (works from the US, no key).
// Note: Polymarket settles Up/Down markets with the Chainlink BTC/USD feed, so
// Coinbase is a close proxy, not the exact settlement price.

const { getJson } = require('./polymarket');

const BASE = 'https://api.exchange.coinbase.com/products/BTC-USD';

async function fetchSpot(fetchImpl) {
  const t = await getJson(`${BASE}/ticker`, fetchImpl);
  const price = Number(t.price);
  if (!Number.isFinite(price)) throw new Error('Bad ticker response');
  return price;
}

/** Open price of the 1-minute candle starting at `startSec` (used for "price to beat"). */
async function fetchMinuteOpen(startSec, fetchImpl) {
  const s = new Date(startSec * 1000).toISOString();
  const e = new Date((startSec + 60) * 1000).toISOString();
  const rows = await getJson(`${BASE}/candles?granularity=60&start=${s}&end=${e}`, fetchImpl);
  // rows: [time, low, high, open, close, volume]
  const row = Array.isArray(rows) ? rows.find((r) => r[0] === startSec) || rows[rows.length - 1] : null;
  return row ? Number(row[3]) : null;
}

/** Close price of the 1-minute candle ending at `endSec`. */
async function fetchMinuteClose(endSec, fetchImpl) {
  const start = endSec - 60;
  const s = new Date(start * 1000).toISOString();
  const e = new Date(endSec * 1000).toISOString();
  const rows = await getJson(`${BASE}/candles?granularity=60&start=${s}&end=${e}`, fetchImpl);
  const row = Array.isArray(rows) ? rows.find((r) => r[0] === start) || rows[0] : null;
  return row ? Number(row[4]) : null;
}

module.exports = { fetchSpot, fetchMinuteOpen, fetchMinuteClose };
