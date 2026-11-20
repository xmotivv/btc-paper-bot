'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const pm = require('../src/core/polymarket');
const { PaperBroker, stats } = require('../src/core/broker');
const momentum = require('../src/core/strategies/momentum');
const registry = require('../src/core/strategies');
const { Engine } = require('../src/core/engine');
const { Store } = require('../src/core/store');

const book = (bids, asks) => pm.normaliseBook({
  bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
  asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
});
const market = { slug: 'btc-updown-15m-900', title: 'T', start: 900, end: 1800 };

test('windowFor builds 15m and 5m slugs', () => {
  const w = pm.windowFor(1763615123, '15m');
  assert.strictEqual(w.start % 900, 0);
  assert.strictEqual(w.slug, `btc-updown-15m-${w.start}`);
  assert.ok(w.start <= 1763615123 && w.end > 1763615123);
  assert.strictEqual(pm.windowFor(601, '5m').slug, 'btc-updown-5m-600');
});

test('normaliseEvent parses stringified arrays and resolution', () => {
  const ev = { title: 'BTC Up or Down', markets: [{ outcomes: '["Up","Down"]', clobTokenIds: '["a","b"]', outcomePrices: '["0","1"]', closed: true }] };
  const m = pm.normaliseEvent(ev, { slug: 's', start: 0, end: 900 });
  assert.deepStrictEqual(m.tokenByOutcome, { Up: 'a', Down: 'b' });
  assert.strictEqual(m.resolved, 'Down');
});

test('normaliseBook sorts best levels first', () => {
  const b = book([[0.4, 10], [0.45, 5]], [[0.6, 10], [0.5, 5]]);
  assert.strictEqual(b.bid, 0.45);
  assert.strictEqual(b.ask, 0.5);
});

test('broker buy walks the book and charges fees', () => {
  const br = new PaperBroker({ cash: 100 }, { feeRate: 0.01, maxSlippage: 0.05 });
  const pos = br.buy({ market, outcome: 'Up', usd: 10, book: book([[0.48, 100]], [[0.5, 10], [0.52, 100]]) });
  // 10 shares @0.50 = $5, then $5 / 0.52 = 9.615 shares
  assert.ok(Math.abs(pos.shares - 19.615385) < 1e-4);
  assert.ok(Math.abs(br.cash - (100 - 10 - 0.1)) < 1e-6);
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
  assert.ok(Math.abs(t.pnl - 4) < 1e-6);
  assert.strictEqual(br.positions.length, 0);
});

function ctx(over = {}) {
  const now = 1500 * 1000; // 600s into window 900–1800
  return {
    now,
    market,
    btc: { price: 100100, history: [{ t: now - 90000, p: 100000 }, { t: now - 60000, p: 100050 }, { t: now, p: 100100 }] },
    priceToBeat: 100000,
    quotes: { Up: { bid: 0.6, ask: 0.62 }, Down: { bid: 0.37, ask: 0.39 } },
    positions: [],
    p: registry.defaultParams(momentum),
    state: momentum.initState(),
    ...over,
  };
}

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

test('sanitiseParams clamps input', () => {
  const p = registry.sanitiseParams(momentum, { stakeUsd: 99999, maxEntryPrice: 'abc' });
  assert.strictEqual(p.stakeUsd, 1000);
  assert.strictEqual(p.maxEntryPrice, 0.75);
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
      if (url.includes('gamma-api') && url.includes('events?slug=')) {
        return [{ title: 'Bitcoin Up or Down', markets: [{ outcomes: '["Up","Down"]', clobTokenIds: '["UP","DOWN"]', outcomePrices: world.resolved ? world.resolved : '["0.5","0.5"]', closed: !!world.resolved }] }];
      }
      if (url.includes('/book?token_id=UP')) return { bids: [{ price: '0.60', size: '500' }], asks: [{ price: '0.62', size: '500' }] };
      if (url.includes('/book?token_id=DOWN')) return { bids: [{ price: '0.37', size: '500' }], asks: [{ price: '0.39', size: '500' }] };
      throw new Error('unexpected ' + url);
    })();
    return { ok: true, status: 200, json: async () => body };
  };
}

test('engine trades, settles from official result, and persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbot-'));
  const store = new Store(dir);
  let t = 1763614800 * 1000 + 30 * 1000; // 30s into a 15m window (start divisible by 900)
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ store, fetchImpl: fakeFetch(world), now: () => t });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });

  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); } // trend up
  assert.strictEqual(eng.broker.positions.length, 1, 'opened a position');
  assert.strictEqual(eng.broker.positions[0].outcome, 'Up');

  // jump past window end; Polymarket reports Up won
  t = (1763614800 + 900 + 20) * 1000;
  world.resolved = '["1","0"]';
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0, 'settled');
  assert.ok(eng.broker.trades[0].pnl > 0);
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled');

  store.flush();
  const reloaded = new Engine({ store: new Store(dir), fetchImpl: fakeFetch(world), now: () => t });
  assert.strictEqual(reloaded.broker.trades.length, 1);
  assert.strictEqual(reloaded.params.minElapsedSec, 60);
  assert.ok(reloaded.tradesCsv().split('\n').length === 2);
  assert.ok(fs.readdirSync(path.join(dir, 'ticks')).length >= 1);
});

test('engine falls back to estimated settlement', async () => {
  let t = 1763614800 * 1000 + 300 * 1000;
  const world = { btc: 100000, open: 100000 };
  const eng = new Engine({ fetchImpl: fakeFetch(world), now: () => t });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });
  for (let i = 0; i < 6; i++) { world.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 1);
  world.close = 99000; // ended below price to beat
  t = (1763614800 + 900 + eng.settings.officialWaitSec + 60) * 1000;
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0);
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled (estimated)');
  assert.ok(eng.broker.trades[0].pnl < 0);
});
