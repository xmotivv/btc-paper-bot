'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const pm = require('../src/core/polymarket');
const model = require('../src/core/model');
const { PaperBroker, stats, statsByStrategy } = require('../src/core/broker');
const momentum = require('../src/core/strategies/momentum');
const fairValue = require('../src/core/strategies/fairValue');
const lateSniper = require('../src/core/strategies/lateSniper');
const pairArb = require('../src/core/strategies/pairArb');
const registry = require('../src/core/strategies');
const { Engine } = require('../src/core/engine');
const { Store } = require('../src/core/store');
const { LiveBook, BookStream, BtcStream, ChainlinkStream } = require('../src/core/streams');

const book = (bids, asks) => pm.normaliseBook({
  bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
  asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
});
const market = { slug: 'btc-updown-15m-900', title: 'T', start: 900, end: 1800 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ------------------------------------------------------------------ polymarket
test('windowFor builds 15m and 5m slugs', () => {
  const w = pm.windowFor(1763615123, '15m');
  assert.strictEqual(w.start % 900, 0);
  assert.strictEqual(w.slug, `btc-updown-15m-${w.start}`);
  assert.ok(w.start <= 1763615123 && w.end > 1763615123);
  assert.strictEqual(pm.windowFor(601, '5m').slug, 'btc-updown-5m-600');
});

test('normaliseEvent parses stringified arrays, resolution, fee schedule and TWAP rule', () => {
  const ev = { title: 'BTC Up or Down', markets: [{
    outcomes: '["Up","Down"]', clobTokenIds: '["a","b"]', outcomePrices: '["0","1"]', closed: true,
    feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true },
    cryptoMarketConfig: { twapEnabled: true, twapLookbackSeconds: 60 },
  }] };
  const m = pm.normaliseEvent(ev, { slug: 's', start: 0, end: 900 });
  assert.deepStrictEqual(m.tokenByOutcome, { Up: 'a', Down: 'b' });
  assert.strictEqual(m.resolved, 'Down');
  assert.strictEqual(m.feeRate, 0.07);
  assert.strictEqual(m.twapSec, 60);
  const plain = pm.normaliseEvent({ markets: [{ outcomes: '["Up","Down"]', clobTokenIds: '["a","b"]' }] }, { slug: 's', start: 0, end: 900 });
  assert.strictEqual(plain.feeRate, null);
  assert.strictEqual(plain.twapSec, 0);
});

test('normaliseBook sorts best levels first', () => {
  const b = book([[0.4, 10], [0.45, 5]], [[0.6, 10], [0.5, 5]]);
  assert.strictEqual(b.bid, 0.45);
  assert.strictEqual(b.ask, 0.5);
});

// ---------------------------------------------------------------------- broker
test('broker buy walks the book and charges fees', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0.01, maxSlippage: 0.05 });
  const pos = br.buy({ market, outcome: 'Up', usd: 10, book: book([[0.48, 100]], [[0.5, 10], [0.52, 100]]) });
  // 10 shares @0.50 = $5, then $5 / 0.52 = 9.615 shares
  near(pos.shares, 19.615385, 1e-4);
  near(br.cash, 100 - 10 - 0.1);
});

test('broker respects slippage limit', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0, maxSlippage: 0.01 });
  const pos = br.buy({ market, outcome: 'Up', usd: 50, book: book([], [[0.5, 10], [0.9, 1000]]) });
  assert.strictEqual(pos.shares, 10);
  assert.strictEqual(br.cash, 95);
});

test('broker settles winners at $1 and losers at $0', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0 });
  br.buy({ market, outcome: 'Up', usd: 10, book: book([], [[0.5, 100]]) });
  br.buy({ market, outcome: 'Down', usd: 10, book: book([], [[0.5, 100]]) });
  const closed = br.settle({ slug: market.slug, winner: 'Up' });
  assert.strictEqual(closed.length, 2);
  assert.strictEqual(br.cash, 100); // +20 shares*$1 back, -20 spent
  const s = stats(br.trades);
  assert.strictEqual(s.trades, 2);
  assert.strictEqual(s.winRate, 0.5);
  assert.strictEqual(s.pnl, 0);
});

test('broker sell closes into bids', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0 });
  const pos = br.buy({ market, outcome: 'Up', usd: 10, book: book([], [[0.5, 100]]) });
  const t = br.sell({ positionId: pos.id, book: book([[0.7, 100]], []) });
  near(t.pnl, 4);
  assert.strictEqual(t.exitType, 'sell');
  assert.strictEqual(br.positions.length, 0);
});

test('broker charges Polymarket\'s fee curve when the market publishes a rate', () => {
  const br = new PaperBroker({ cash: 1000 }, { feeModel: 'market', feeRate: 0.01 });
  const m = { ...market, feeRate: 0.07 };
  // Polymarket's own table: 100 shares at 50¢ costs $1.75, at 90¢ costs $0.63
  const a = br.buy({ market: m, outcome: 'Up', shares: 100, book: book([], [[0.5, 500]]) });
  near(a.fees, 1.75);
  const b = br.buy({ market: m, outcome: 'Up', shares: 100, book: book([], [[0.9, 500]]) });
  near(b.fees, 0.63);
  // sells pay the curve too, at the exit price
  const t = br.sell({ positionId: a.id, book: book([[0.9, 500]], []) });
  near(t.fees, 1.75 + 0.63);
  // no published rate → flat fallback
  const c = br.buy({ market, outcome: 'Up', shares: 100, book: book([], [[0.5, 500]]) });
  near(c.fees, 0.5);
});

test('broker buys an exact share count and honours a limit price', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0, maxSlippage: 0.01 });
  const asks = [[0.4, 10], [0.45, 10], [0.5, 100]];
  const pos = br.buy({ market, outcome: 'Up', shares: 25, maxPrice: 0.45, book: book([], asks) });
  assert.strictEqual(pos.shares, 20); // the 0.50 level is above the limit
  near(br.cash, 100 - 4 - 4.5);
  assert.ok(br.buy({ market, outcome: 'Up', book: book([], asks) }).error);
});

test('broker never spends more cash than it has, fees included', () => {
  const br = new PaperBroker({ cash: 10 }, { feeRate: 0.1 });
  const pos = br.buy({ market, outcome: 'Up', usd: 50, book: book([], [[0.5, 1000]]) });
  near(pos.cost, 10);
  near(br.cash, 0);
});

test('statsByStrategy groups trades', () => {
  const by = statsByStrategy([{ strategy: 'a', pnl: 2, fees: 0 }, { strategy: 'a', pnl: -1, fees: 0 }, { strategy: 'b', pnl: 5, fees: 0 }]);
  assert.strictEqual(by.a.trades, 2);
  assert.strictEqual(by.a.pnl, 1);
  assert.strictEqual(by.b.winRate, 1);
});

// ----------------------------------------------------------------------- model
test('priceAt finds the last sample at or before a time', () => {
  const h = [{ t: 10, p: 1 }, { t: 20, p: 2 }, { t: 30, p: 3 }];
  assert.strictEqual(model.priceAt(h, 5), null);
  assert.strictEqual(model.priceAt(h, 10), 1);
  assert.strictEqual(model.priceAt(h, 29), 2);
  assert.strictEqual(model.priceAt(h, 99), 3);
  assert.strictEqual(model.priceAt([], 99), null);
});

test('realisedVol recovers the volatility of a synthetic series', () => {
  const h = [];
  let p = 100000;
  for (let i = 0; i <= 300; i += 5) { h.push({ t: i * 1000, p }); p *= i % 10 === 0 ? 1.0002 : 0.9998; }
  // every 5s step is a ±2bp move → sigma = 0.0002 / sqrt(5)
  near(model.realisedVol(h, 300000), 0.0002 / Math.sqrt(5), 1e-6);
  assert.strictEqual(model.realisedVol(h.slice(0, 5), 20000), null);
});

test('probUp behaves like a probability', () => {
  const base = { strike: 100000, sigma: 1e-4, secLeft: 300 };
  near(model.probUp({ ...base, price: 100000 }), 0.5, 1e-6);
  const above = model.probUp({ ...base, price: 100100 });
  assert.ok(above > 0.5 && above < 1);
  near(above + model.probUp({ ...base, price: 100000 * 100000 / 100100 }), 1, 1e-6);
  // less time left → more certain
  assert.ok(model.probUp({ ...base, price: 100100, secLeft: 30 }) > above);
  // TWAP settlement is less uncertain than spot settlement
  assert.ok(model.probUp({ ...base, price: 100100, twapSec: 60 }) > above);
  assert.strictEqual(model.probUp({ ...base, price: 100100, sigma: 0 }), null);
});

test('probUp accounts for the part of a TWAP window that is already locked in', () => {
  const base = { strike: 100000, sigma: 1e-4, twapSec: 60, secLeft: 10 };
  // spot is above the strike, but 50s of the average were well below it
  const dragged = model.probUp({ ...base, price: 100050, realisedMean: 99900, realisedSec: 50 });
  assert.ok(dragged < 0.05);
  const clean = model.probUp({ ...base, price: 100050, realisedMean: 100050, realisedSec: 50 });
  assert.ok(clean > 0.95);
});

// ------------------------------------------------------------------ strategies
function ctx(over = {}) {
  const now = 1500 * 1000; // 600s into window 900–1800
  return {
    now,
    market,
    btc: { price: 100100, history: [{ t: now - 90000, p: 100000 }, { t: now - 60000, p: 100050 }, { t: now, p: 100100 }] },
    priceToBeat: 100000,
    quotes: { Up: { bid: 0.6, ask: 0.62 }, Down: { bid: 0.37, ask: 0.39 } },
    positions: [],
    balance: 1000,
    vol: 1e-4,
    settle: { basis: 0, twapSec: 0 },
    fee: (p) => 0.07 * p * (1 - p),
    p: registry.defaultParams(momentum),
    state: momentum.initState(),
    ...over,
  };
}
const withStrategy = (s, over = {}, p = {}) => ctx({ p: { ...registry.defaultParams(s), ...p }, state: s.initState(), ...over });

test('momentum buys Up on confirmed up-move', () => {
  const a = momentum.onTick(ctx());
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].type, 'buy');
  assert.strictEqual(a[0].outcome, 'Up');
});

test('momentum skips when market already priced in', () => {
  const a = momentum.onTick(ctx({ quotes: { Up: { bid: 0.9, ask: 0.92 }, Down: { bid: 0.07, ask: 0.09 } } }));
  assert.strictEqual(a.length, 0);
});

test('momentum skips too early in window and limits entries', () => {
  assert.strictEqual(momentum.onTick(ctx({ now: 960 * 1000 })).length, 0);
  const c = ctx();
  momentum.onTick(c);
  assert.strictEqual(momentum.onTick(c).length, 0);
});

test('momentum buys Down on confirmed down-move', () => {
  const now = 1500 * 1000;
  const a = momentum.onTick(ctx({ btc: { price: 99880, history: [{ t: now - 60000, p: 99950 }, { t: now, p: 99880 }] } }));
  assert.strictEqual(a[0].outcome, 'Down');
});

test('momentum stop loss', () => {
  const pos = { id: 'p1', slug: market.slug, outcome: 'Up' };
  const a = momentum.onTick(ctx({ positions: [pos], quotes: { Up: { bid: 0.1, ask: 0.12 }, Down: { bid: 0.87, ask: 0.9 } } }));
  assert.ok(a.some((x) => x.type === 'sell' && x.positionId === 'p1'));
});

test('fair-value buys the side quoted well under its modelled value', () => {
  // BTC +30bp with 300s left at 1bp/√s → Up is worth roughly 0.93; the market asks 0.62
  const c = withStrategy(fairValue, { btc: { price: 100300, history: [] } });
  const fair = model.fairUp(c, c.p.volMult);
  assert.ok(fair > 0.9);
  const a = fairValue.onTick(c);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].outcome, 'Up');
  assert.ok(a[0].maxPrice > 0.62 && a[0].maxPrice < fair);
  // cooldown / one entry at a time
  assert.strictEqual(fairValue.onTick(c).length, 0);
});

test('fair-value stays out when the market is fairly priced, and sells when it overpays', () => {
  const fairQuotes = { Up: { bid: 0.5, ask: 0.52 }, Down: { bid: 0.48, ask: 0.5 } };
  const flat = withStrategy(fairValue, { btc: { price: 100000, history: [] }, quotes: fairQuotes });
  assert.strictEqual(fairValue.onTick(flat).length, 0);
  // holding Up while the model says 50/50 and the bid is 0.80 → take the money
  const pos = { id: 'p1', slug: market.slug, outcome: 'Up' };
  const rich = withStrategy(fairValue, { btc: { price: 100000, history: [] }, positions: [pos], quotes: { Up: { bid: 0.8, ask: 0.82 }, Down: { bid: 0.18, ask: 0.2 } } });
  const a = fairValue.onTick(rich);
  assert.ok(a.some((x) => x.type === 'sell' && x.positionId === 'p1'));
  assert.ok(!a.some((x) => x.type === 'buy' && x.outcome === 'Down'), 'never holds both sides');
});

test('fair-value needs a price to beat and a volatility estimate', () => {
  assert.strictEqual(fairValue.onTick(withStrategy(fairValue, { priceToBeat: null })).length, 0);
  assert.strictEqual(fairValue.onTick(withStrategy(fairValue, { vol: null })).length, 0);
});

test('model-based strategies sit out when the price to beat is only an estimate', () => {
  const up = { btc: { price: 100300, history: [] } };
  assert.strictEqual(fairValue.onTick(withStrategy(fairValue, up)).length, 1);
  const estimated = { ...up, settle: { basis: 0, twapSec: 0, strikeExact: false } };
  assert.strictEqual(model.fairUp(withStrategy(fairValue, estimated)), null);
  assert.strictEqual(fairValue.onTick(withStrategy(fairValue, estimated)).length, 0);
  const late = { now: 1760 * 1000, btc: { price: 100400, history: [] }, quotes: { Up: { bid: 0.93, ask: 0.94 }, Down: { bid: 0.05, ask: 0.07 } } };
  assert.strictEqual(lateSniper.onTick(withStrategy(lateSniper, { ...late, settle: { basis: 0, twapSec: 0, strikeExact: false } })).length, 0);
});

test('late-sniper only buys a near-certain favourite in the closing seconds', () => {
  const quotes = { Up: { bid: 0.93, ask: 0.94 }, Down: { bid: 0.05, ask: 0.07 } };
  const far = { price: 100400, history: [] }; // +40bp
  // too early
  assert.strictEqual(lateSniper.onTick(withStrategy(lateSniper, { btc: far, quotes })).length, 0);
  // 40s left: buys Up
  const late = withStrategy(lateSniper, { now: 1760 * 1000, btc: far, quotes });
  const a = lateSniper.onTick(late);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].outcome, 'Up');
  assert.ok(a[0].maxPrice <= late.p.maxEntryPrice);
  assert.strictEqual(lateSniper.onTick(late).length, 0, 'one entry per window');
  // 40s left but BTC is barely above the line: not certain enough
  const close = withStrategy(lateSniper, { now: 1760 * 1000, btc: { price: 100003, history: [] }, quotes });
  assert.strictEqual(lateSniper.onTick(close).length, 0);
  // favourite already priced at 99¢: no edge left
  const priced = withStrategy(lateSniper, { now: 1760 * 1000, btc: far, quotes: { Up: { bid: 0.98, ask: 0.99 }, Down: { bid: 0.01, ask: 0.02 } } });
  assert.strictEqual(lateSniper.onTick(priced).length, 0);
});

test('late-sniper bails out if the model turns against the position', () => {
  const pos = { id: 'p1', slug: market.slug, outcome: 'Up' };
  const c = withStrategy(lateSniper, { now: 1790 * 1000, btc: { price: 99990, history: [] }, positions: [pos] });
  assert.ok(lateSniper.onTick(c).some((x) => x.type === 'sell' && x.positionId === 'p1'));
});

test('pair-arb buys equal shares of both sides only when the pair costs under $1 after fees', () => {
  const books = (up, down) => ({ Up: book([], up), Down: book([], down) });
  // 0.46 + 0.50 = 0.96, fees ≈ 0.035 → locks about half a cent... below the 1¢ minimum
  const thin = withStrategy(pairArb, { books: books([[0.46, 100]], [[0.5, 100]]) });
  assert.strictEqual(pairArb.onTick(thin).length, 0);
  // 0.44 + 0.48 = 0.92, fees ≈ 0.035 → locks ≈ 4.5¢ a pair
  const c = withStrategy(pairArb, { books: books([[0.44, 40], [0.6, 500]], [[0.48, 500]]) });
  const a = pairArb.onTick(c);
  assert.strictEqual(a.length, 2);
  assert.deepStrictEqual(a.map((x) => x.outcome), ['Up', 'Down']);
  assert.strictEqual(a[0].shares, a[1].shares);
  assert.strictEqual(a[0].shares, 40, 'stops at the depth that is still profitable');
  assert.strictEqual(a[0].maxPrice, 0.44);
  assert.strictEqual(pairArb.onTick(c).length, 0, 'cooldown');
  // normal book: asks sum to more than $1
  const normal = withStrategy(pairArb, { books: books([[0.62, 100]], [[0.39, 100]]) });
  assert.strictEqual(pairArb.onTick(normal).length, 0);
});

test('pair-arb respects the stake cap', () => {
  const size = pairArb.sizePair([{ price: 0.4, size: 1000 }], [{ price: 0.4, size: 1000 }], () => 0, { maxUsd: 80, minProfit: 0.01 });
  near(size.shares, 100);
  near(size.cost, 80);
});

test('sanitiseParams clamps input', () => {
  const p = registry.sanitiseParams(momentum, { stakeUsd: 99999, maxEntryPrice: 'abc', lookbackSec: '' });
  assert.strictEqual(p.stakeUsd, 1000);
  assert.strictEqual(p.maxEntryPrice, 0.75);
  assert.strictEqual(p.lookbackSec, 60);
});

test('every registered strategy has a unique id and a usable schema', () => {
  const ids = registry.strategies.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 4);
  for (const s of registry.strategies) {
    assert.ok(s.name && s.description && typeof s.onTick === 'function' && typeof s.initState === 'function');
    for (const p of s.params) assert.ok(p.default >= p.min && p.default <= p.max, `${s.id}.${p.key} default within range`);
  }
});

// --------------------------------------------------------------------- streams
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeSocket.last = this;
    FakeSocket.all.push(this);
    setImmediate(() => this.onopen && this.onopen());
  }

  send(s) { this.sent.push(s); }
  close() { this.closed = true; }
  push(obj) { this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
}
FakeSocket.all = [];
const nextTurn = () => new Promise((r) => setImmediate(r));
const pause = (ms = 25) => new Promise((r) => setTimeout(r, ms)); // lets the engine's coalesced strategy pass run

test('LiveBook applies snapshots and deltas', () => {
  const b = new LiveBook();
  b.snapshot([{ price: '0.40', size: '10' }, { price: '0.45', size: '5' }], [{ price: '0.50', size: '7' }, { price: '0.60', size: '9' }]);
  assert.strictEqual(b.bid, 0.45);
  assert.strictEqual(b.ask, 0.5);
  b.update('SELL', 0.5, 0); // level removed
  b.update('BUY', 0.47, 3); // new best bid
  b.update('BUY', 0.4, 20); // size change
  assert.strictEqual(b.ask, 0.6);
  assert.strictEqual(b.bid, 0.47);
  assert.deepStrictEqual(b.bids, [{ price: 0.47, size: 3 }, { price: 0.45, size: 5 }, { price: 0.4, size: 20 }]);
});

test('BookStream subscribes, builds both books and reports changes', async () => {
  const bs = new BookStream({ WebSocketImpl: FakeSocket });
  let changes = 0;
  bs.on('change', () => { changes++; });
  bs.track('slug-1', { Up: 'U', Down: 'D' });
  await nextTurn();
  const ws = FakeSocket.last;
  assert.deepStrictEqual(JSON.parse(ws.sent[0]), { assets_ids: ['U', 'D'], type: 'market' });
  assert.strictEqual(bs.books('slug-1'), null, 'not ready before snapshots');
  ws.push([
    { event_type: 'book', asset_id: 'U', bids: [{ price: '0.60', size: '100' }], asks: [{ price: '0.62', size: '100' }] },
    { event_type: 'book', asset_id: 'D', bids: [{ price: '0.37', size: '100' }], asks: [{ price: '0.39', size: '100' }] },
  ]);
  ws.push('PONG');
  ws.push({ event_type: 'price_change', price_changes: [
    { asset_id: 'U', price: '0.61', size: '50', side: 'BUY' },
    { asset_id: 'D', price: '0.39', size: '0', side: 'SELL' },
    { asset_id: 'other', price: '0.1', size: '1', side: 'BUY' },
  ] });
  const books = bs.books('slug-1');
  assert.strictEqual(books.Up.bid, 0.61);
  assert.strictEqual(books.Down.ask, null);
  assert.strictEqual(changes, 2);
  bs.stop();
  assert.ok(ws.closed);
  assert.strictEqual(bs.books('slug-1'), null);
});

test('BtcStream and ChainlinkStream parse their feeds', async () => {
  const btc = new BtcStream({ WebSocketImpl: FakeSocket });
  const prices = [];
  btc.on('price', (p) => prices.push(p));
  btc.start();
  await nextTurn();
  assert.match(FakeSocket.last.sent[0], /"ticker"/);
  FakeSocket.last.push({ type: 'subscriptions', channels: [] });
  FakeSocket.last.push({ type: 'ticker', product_id: 'BTC-USD', price: '61891.99' });
  assert.deepStrictEqual(prices, [61891.99]);
  assert.ok(btc.live);
  btc.stop();
  assert.ok(!btc.live);

  const cl = new ChainlinkStream({ WebSocketImpl: FakeSocket });
  cl.start();
  await nextTurn();
  const ws = FakeSocket.last;
  ws.push('');
  ws.push({ payload: { data: [{ timestamp: 1000000, value: 100 }, { timestamp: 1001000, value: 102 }] } });
  ws.push({ topic: 'crypto_prices_chainlink', payload: { symbol: 'btc/usd', timestamp: 1002000, value: 104 } });
  assert.strictEqual(cl.price, 104);
  assert.strictEqual(cl.samples.get(1001), 102);
  assert.deepStrictEqual(cl.mean(1000, 1002), { mean: 103, count: 2 });
  cl.stop();
});

// ---------------------------------------------------------------- engine e2e
function fakeFetch(world) {
  return async (url) => {
    const body = (() => {
      if (url.includes('/ticker')) return { price: String(world.btc) };
      if (url.includes('/candles')) {
        const start = Math.floor(new Date(new URL(url).searchParams.get('start')).getTime() / 1000);
        return [[start, 0, 0, world.open, world.close ?? world.btc, 1]];
      }
      if (url.includes('clob.polymarket.com/markets/')) {
        return { closed: !!world.clobWinner, tokens: ['Up', 'Down'].map((outcome) => ({ outcome, winner: outcome === world.clobWinner })) };
      }
      if (url.includes('gamma-api') && url.includes('events?slug=')) {
        return [{ title: 'Bitcoin Up or Down', markets: [{ conditionId: world.conditionId, outcomes: '["Up","Down"]', clobTokenIds: '["UP","DOWN"]', outcomePrices: world.resolved ? world.resolved : '["0.5","0.5"]', closed: !!world.resolved, feeSchedule: world.feeSchedule, cryptoMarketConfig: world.twap ? { twapEnabled: true, twapLookbackSeconds: world.twap } : undefined }] }];
      }
      const up = world.up || { bid: 0.6, ask: 0.62 };
      const down = world.down || { bid: 0.37, ask: 0.39 };
      const lvl = (q) => ({ bids: [{ price: String(q.bid), size: '500' }], asks: [{ price: String(q.ask), size: '500' }] });
      if (url.includes('/book?token_id=UP')) return lvl(up);
      if (url.includes('/book?token_id=DOWN')) return lvl(down);
      throw new Error('unexpected ' + url);
    })();
    return { ok: true, status: 200, json: async () => body };
  };
}
const T0 = 1763614800; // start of a 15m window

test('engine trades, settles from official result, and persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbot-'));
  const store = new Store(dir);
  let t = T0 * 1000 + 30 * 1000; // 30s into the window
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ store, fetchImpl: fakeFetch(world), now: () => t });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });

  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); } // trend up
  assert.strictEqual(eng.broker.positions.length, 1, 'opened a position');
  assert.strictEqual(eng.broker.positions[0].outcome, 'Up');
  assert.strictEqual(eng.broker.positions[0].strategy, 'momentum');

  // jump past window end; Polymarket reports Up won
  t = (T0 + 900 + 20) * 1000;
  world.resolved = '["1","0"]';
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0, 'settled');
  assert.ok(eng.broker.trades[0].pnl > 0);
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled');

  store.close();
  const reloaded = new Engine({ store: new Store(dir), fetchImpl: fakeFetch(world), now: () => t });
  assert.strictEqual(reloaded.broker.trades.length, 1);
  assert.strictEqual(reloaded.params.momentum.minElapsedSec, 60);
  assert.deepStrictEqual(reloaded.settings.activeStrategies, ['momentum']);
  assert.ok(reloaded.tradesCsv().split('\n').length === 2);
  assert.ok(fs.readdirSync(path.join(dir, 'ticks')).length >= 1);
});

test('engine falls back to estimated settlement', async () => {
  let t = T0 * 1000 + 300 * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });
  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 1);
  world.close = 99000; // ended below price to beat
  t = (T0 + 900 + eng.settings.officialWaitSec + 60) * 1000;
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0);
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled (estimated)');
  assert.ok(eng.broker.trades[0].pnl < 0);
});

test('engine runs several strategies at once, each with its own positions and results', async () => {
  let t = T0 * 1000 + 30 * 1000;
  // Up and Down both on offer at 0.48: a pair costs 0.96 — an arbitrage — and momentum can still buy Up
  const world = { btc: 100000, open: 100000, up: { bid: 0.46, ask: 0.48 }, down: { bid: 0.46, ask: 0.48 } };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });
  eng.setStrategyParams('pair-arb', { maxPairsPerWindow: 1, maxStakeUsd: 96 });
  eng.setStrategyEnabled('pair-arb', true);
  assert.deepStrictEqual(eng.settings.activeStrategies, ['momentum', 'pair-arb']);

  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  const by = (id) => eng.broker.positions.filter((p) => p.strategy === id);
  assert.strictEqual(by('momentum').length, 1);
  assert.strictEqual(by('pair-arb').length, 2);
  assert.deepStrictEqual(by('pair-arb').map((p) => p.outcome).sort(), ['Down', 'Up']);
  near(by('pair-arb')[0].shares, by('pair-arb')[1].shares);

  const live = eng.view().strategyStats;
  assert.strictEqual(live.find((s) => s.id === 'pair-arb').open, 2);
  assert.strictEqual(live.find((s) => s.id === 'fair-value').enabled, false);

  // disabling strategies stops new entries, but their positions still settle
  eng.setStrategyEnabled('momentum', false);
  eng.setStrategyEnabled('pair-arb', false);
  t = (T0 + 900 + 20) * 1000;
  world.resolved = '["0","1"]'; // Down wins
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0);
  const done = eng.view().strategyStats;
  const arb = done.find((s) => s.id === 'pair-arb');
  const mom = done.find((s) => s.id === 'momentum');
  assert.strictEqual(arb.trades, 2);
  assert.ok(arb.pnl > 0, 'the pair locks in a profit whichever side wins');
  assert.strictEqual(mom.trades, 1);
  assert.ok(mom.pnl < 0, 'momentum was long Up and lost');
  near(eng.view().stats.pnl, arb.pnl + mom.pnl, 0.011);
});

test('a strategy only ever sees and sells its own positions', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, takeProfit: 0, stopLoss: 0 });
  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  const pos = eng.broker.positions[0];
  const seen = [];
  const spy = { id: 'spy', name: 'Spy', description: '', params: [], initState: () => ({}), onTick: (c) => { seen.push(c.positions.length); return [{ type: 'sell', positionId: pos.id, reason: 'not mine' }]; } };
  eng._active = [...eng._active, spy];
  eng.params.spy = {};
  eng.strategyState.spy = {};
  t += 15000;
  await eng.tick();
  assert.deepStrictEqual(seen, [0]);
  assert.strictEqual(eng.broker.positions.length, 1, 'another strategy cannot close it');
});

test('manual close sells at the live bid and keeps the strategy out for the rest of the window', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.updateSettings({ feeModel: 'flat', feeRate: 0 });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, maxEntriesPerWindow: 5 });
  for (let i = 0; i < 6 && !eng.broker.positions.length; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 1);
  const pos = eng.broker.positions[0];
  assert.ok(eng.view().positions[0].canClose);

  assert.ok(eng.closePosition('nope').error);
  const cashBefore = eng.broker.cash;
  const r = eng.closePosition(pos.id);
  assert.ok(r.ok);
  assert.strictEqual(r.trade.exitType, 'manual');
  near(r.trade.exitPrice, 0.6);
  near(eng.broker.cash, cashBefore + pos.shares * 0.6);
  assert.strictEqual(eng.broker.positions.length, 0);
  assert.ok(eng.log.some((l) => l.msg.includes('MANUAL CLOSE')));

  // signal still fires and entries remain, but the bot stays out after a manual close
  for (let i = 0; i < 3; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 0);
});

test('manual close refuses once the window has ended; close-all reports both outcomes', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000, up: { bid: 0.46, ask: 0.48 }, down: { bid: 0.46, ask: 0.48 } };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.setStrategyEnabled('momentum', false);
  eng.setStrategyEnabled('pair-arb', true);
  t += 15000;
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 2);
  assert.deepStrictEqual(eng.closeAllPositions(), { closed: 2, failed: 0 });

  eng.manualHold.clear();
  eng.strategyState['pair-arb'] = pairArb.initState();
  t += 15000;
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 2);
  t = (T0 + 900 + 1) * 1000; // window over, not yet settled
  const id = eng.broker.positions[0].id;
  assert.match(eng.closePosition(id).error, /window has ended/);
  assert.deepStrictEqual(eng.closeAllPositions(), { closed: 0, failed: 2 });
  assert.strictEqual(eng.view().positions[0].canClose, false);
});

test('engine uses the market\'s published fee rate', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000, feeSchedule: { rate: 0.07 } };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, stakeUsd: 62 });
  for (let i = 0; i < 4; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  const pos = eng.broker.positions[0];
  near(pos.shares, 100);
  near(pos.fees, 100 * 0.07 * 0.62 * 0.38, 1e-4);
});

test('engine upgrades a single-strategy save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbot-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    settings: { windowKey: '5m', pollMs: 2000, strategyId: 'momentum', feeRate: 0.02 },
    params: { momentum: { stakeUsd: 40 } },
    strategyState: { entries: { 'btc-updown-5m-1': 1 } },
    broker: { cash: 900, positions: [], trades: [{ strategy: 'momentum', pnl: -100, fees: 1 }] },
  }));
  const store = new Store(dir);
  const eng = new Engine({ store, fetchImpl: fakeFetch({}), WebSocketImpl: null });
  assert.deepStrictEqual(eng.settings.activeStrategies, ['momentum']);
  assert.strictEqual(eng.settings.strategyId, undefined);
  assert.strictEqual(eng.settings.windowKey, '5m');
  assert.strictEqual(eng.params.momentum.stakeUsd, 40);
  assert.deepStrictEqual(eng.strategyState.momentum, { entries: { 'btc-updown-5m-1': 1 } });
  assert.deepStrictEqual(eng.strategyState['pair-arb'], pairArb.initState());
  assert.strictEqual(eng.broker.cash, 900);
  assert.strictEqual(eng.view().strategyStats.find((s) => s.id === 'momentum').pnl, -100);
  store.close();
});

test('view sends bulky sections only when they change', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  const full = eng.view();
  for (const k of ['strategies', 'trades', 'equityCurve', 'log', 'btcSpark', 'positions', 'strategyStats']) assert.ok(k in full, k);
  const first = eng.view(false);
  assert.ok('trades' in first && 'strategies' in first);
  const second = eng.view(false);
  for (const k of ['strategies', 'trades', 'equityCurve', 'log', 'btcSpark']) assert.ok(!(k in second), `${k} not resent`);
  assert.ok('positions' in second && 'quotes' in second);
  eng.setStrategyParams('momentum', { stakeUsd: 30 });
  const third = eng.view(false);
  assert.ok('strategies' in third && 'log' in third && !('trades' in third));
  assert.strictEqual(third.strategies.find((s) => s.id === 'momentum').values.stakeUsd, 30);
});

test('engine reacts to streamed prices and books without polling', async () => {
  FakeSocket.all.length = 0;
  let t = (T0 + 120) * 1000;
  const world = { btc: 100000, open: 100000, feeSchedule: { rate: 0.07 } };
  const calls = [];
  const inner = fakeFetch(world);
  const eng = new Engine({ fetchImpl: (u) => { calls.push(u); return inner(u); }, now: () => t, WebSocketImpl: FakeSocket });
  eng.updateSettings({ evalMs: 0, pollMs: 60000 });
  eng.setStrategyEnabled('momentum', false);
  eng.setStrategyEnabled('pair-arb', true);
  eng.start();
  try {
    for (let i = 0; i < 20 && !eng.market; i++) await nextTurn(); // first tick loads the market over REST
    assert.ok(eng.market);
    await nextTurn();
    const sock = (part) => FakeSocket.all.find((s) => s.url.includes(part));
    sock('coinbase').push({ type: 'ticker', product_id: 'BTC-USD', price: '100010' });
    const pmSock = sock('ws-subscriptions-clob');
    assert.ok(pmSock, 'subscribed to the market\'s books');
    pmSock.push([
      { event_type: 'book', asset_id: 'UP', bids: [{ price: '0.60', size: '500' }], asks: [{ price: '0.62', size: '500' }] },
      { event_type: 'book', asset_id: 'DOWN', bids: [{ price: '0.37', size: '500' }], asks: [{ price: '0.39', size: '500' }] },
    ]);
    await pause();
    assert.strictEqual(eng.btcPrice, 100010);
    assert.strictEqual(eng.view().feeds.books, 'stream');
    assert.strictEqual(eng.broker.positions.length, 0, 'no arbitrage in a normal book');

    // someone dumps Up: the ask falls to 0.50 while Down is still 0.39 → pair costs 0.89
    const before = calls.length;
    pmSock.push({ event_type: 'price_change', price_changes: [{ asset_id: 'UP', price: '0.50', size: '200', side: 'SELL' }] });
    await pause();
    assert.strictEqual(eng.broker.positions.length, 2, 'bought both legs straight off the stream');
    assert.strictEqual(calls.length, before, 'without any REST request');
    assert.ok(eng.broker.positions.every((p) => p.strategy === 'pair-arb' && Math.abs(p.shares - eng.broker.positions[0].shares) < 1e-9));
  } finally {
    eng.stop();
  }
  assert.ok(FakeSocket.all.every((s) => s.closed), 'stop() closes every socket');
});

test('price to beat is the settlement feed\'s 60-second average at the open, replacing the Coinbase estimate', async () => {
  FakeSocket.all.length = 0;
  let t = (T0 + 30) * 1000;
  const world = { btc: 100000, open: 100000, twap: 60 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: FakeSocket });
  eng.updateSettings({ pollMs: 60000 });
  eng.start();
  try {
    for (let i = 0; i < 20 && !eng.market; i++) await nextTurn();
    const slug = eng.market.slug;
    assert.strictEqual(eng.market.twapSec, 60);
    // the app started mid-window with no Chainlink history: an estimate, flagged as such
    await eng.tick();
    assert.strictEqual(eng.ptbSource[slug], 'coinbase');
    assert.strictEqual(eng.view().ptbSource, 'coinbase');
    assert.strictEqual(eng._settleInfo(eng.market, t / 1000).strikeExact, false);
    assert.ok(eng.log.some((l) => l.level === 'warn' && /estimate/.test(l.msg)));

    // Chainlink history arrives: one reading per second, rising $1 a second up to the open
    const rt = FakeSocket.all.find((s) => s.url.includes('ws-live-data'));
    rt.push({ payload: { data: Array.from({ length: 61 }, (_, i) => ({ timestamp: (T0 - 60 + i) * 1000, value: 100000 + i })) } });
    await eng.tick();
    // spot at the open is 100060; the 60s average ending there (T0-59 … T0) is 100030.5
    near(eng.priceToBeat[slug], 100030.5);
    assert.strictEqual(eng.ptbSource[slug], 'chainlink');
    assert.strictEqual(eng._settleInfo(eng.market, t / 1000).strikeExact, true);
  } finally {
    eng.stop();
  }
});

test('estimated settlement on a TWAP market uses the average of the final minute', async () => {
  FakeSocket.all.length = 0;
  let t = (T0 + 120) * 1000;
  const world = { btc: 100000, open: 100000, twap: 60, up: { bid: 0.46, ask: 0.48 }, down: { bid: 0.46, ask: 0.48 } };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: FakeSocket });
  eng.updateSettings({ pollMs: 60000, evalMs: 0 });
  eng.setStrategyEnabled('momentum', false);
  eng.start();
  try {
    for (let i = 0; i < 20 && !eng.market; i++) await nextTurn();
    const slug = eng.market.slug;
    const rt = FakeSocket.all.find((s) => s.url.includes('ws-live-data'));
    const feedCl = (from, to, value) => rt.push({ payload: { data: Array.from({ length: to - from + 1 }, (_, i) => ({ timestamp: (from + i) * 1000, value: typeof value === 'function' ? value(from + i) : value })) } });
    feedCl(T0 - 60, T0, 100000); // price to beat = 100000
    await eng.tick();
    near(eng.priceToBeat[slug], 100000);
    // open one Up position by hand
    eng.restBooks = { slug, books: { Up: book([[0.46, 500]], [[0.48, 500]]), Down: book([[0.46, 500]], [[0.48, 500]]) } };
    eng.bookStream.stop();
    eng.bookStream = null;
    eng.broker.buy({ market: eng.market, outcome: 'Up', usd: 48, book: eng.restBooks.books.Up, strategy: 'momentum', now: t });
    await eng.tick();
    assert.strictEqual(eng.pendingSettle[slug].twapSec, 60);
    // final minute: mostly below the line, but spikes far above it in the very last second
    feedCl(T0 + 841, T0 + 899, 99990);
    feedCl(T0 + 900, T0 + 900, 100200);
    world.close = 100200; // a spot-at-close rule would call this Up
    t = (T0 + 900 + eng.settings.officialWaitSec + 60) * 1000;
    feedCl(T0 + 901, T0 + 900 + eng.settings.officialWaitSec + 60, 100200);
    await eng.tick();
    const trade = eng.broker.trades.find((x) => x.slug === slug);
    assert.strictEqual(trade.exitType, 'settled (estimated)');
    assert.strictEqual(trade.exitReason, 'Down won', 'the 60s average (≈99993.5) is below the price to beat');
  } finally {
    eng.stop();
  }
});

test('settles from the order-book API as soon as it names a winner, before Gamma catches up', async () => {
  let t = T0 * 1000 + 30 * 1000;
  const world = { btc: 100000, open: 100000, conditionId: '0xabc' };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });
  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 1);
  assert.strictEqual(eng.pendingSettle[eng.broker.positions[0].slug].conditionId, '0xabc');
  eng.setStrategyEnabled('momentum', false);

  t = (T0 + 900 + 20) * 1000; // window over, nobody has a result yet
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 1, 'still waiting');

  world.clobWinner = 'Down'; // Gamma still shows the market open
  t += 15000;
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0);
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled');
  assert.strictEqual(eng.broker.trades[0].exitReason, 'Down won');
});

test('moves to the next window the instant the current one ends, if its market is already loaded', async () => {
  let t = (T0 + 880) * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t, WebSocketImpl: null });
  await eng.tick();
  const first = eng.market.slug;
  const next = pm.windowFor(T0 + 900, '15m');
  await eng._loadMarket(next); // what the 30-second-ahead prefetch does
  t = (T0 + 899.9) * 1000;
  eng._evaluate(t);
  assert.strictEqual(eng.market.slug, first);
  t = (T0 + 900) * 1000;
  eng._evaluate(t); // a streamed update arriving right on the boundary, before any tick
  assert.strictEqual(eng.market.slug, next.slug);
  assert.deepStrictEqual(eng.quotes, {}, 'old quotes are not carried into the new window');
});
