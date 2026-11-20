'use strict';
// Polymarket US market data and real-money trading. Everything here runs
// against a simulated exchange: no network, no real orders.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const us = require('../src/core/us');
const { UsClient, loadSecret } = require('../src/core/usClient');
const { LiveTrader, buildOrder, readFills, DEFAULT_LIMITS } = require('../src/core/live');
const { Engine } = require('../src/core/engine');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const T0 = 1795196700; // 2026-11-20T17:45:00Z, the start of a 15-minute window

// A throwaway key pair in the same form the developer portal hands out.
const pair = crypto.generateKeyPairSync('ed25519');
const SECRET = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
const KEY_ID = '11111111-2222-3333-4444-555555555555';

const usMarket = (over = {}) => ({ venue: 'us', slug: 'cpc-btc-updown-15m-2026-11-20-1745z', title: 'BTC Up or Down 15m', start: T0, end: T0 + 900, feeRate: 0.095, tick: 0.01, minQty: 0.01, ...over });
const levels = (rows) => rows.map(([price, size]) => ({ price, size }));
const book = (bids, asks) => ({ bids: levels(bids), asks: levels(asks), bid: bids[0] ? bids[0][0] : null, ask: asks[0] ? asks[0][0] : null });

// ------------------------------------------------------------- market data
test('US window slugs follow the exchange\'s naming', () => {
  const w = us.windowFor(T0 + 30, '15m');
  assert.strictEqual(w.start, T0);
  assert.strictEqual(w.eventSlug, 'btc-updown-15m-2026-11-20-1745z');
  assert.strictEqual(w.slug, 'cpc-btc-updown-15m-2026-11-20-1745z');
  assert.strictEqual(us.windowFor(T0 + 301, '5m').eventSlug, 'btc-updown-5m-2026-11-20-1750z');
  assert.strictEqual(us.eventSlugOf(w.slug), w.eventSlug);
});

function usEvent(over = {}, terms = {}) {
  return {
    slug: 'btc-updown-15m-2026-11-20-1745z',
    title: 'BTC Up or Down 15m',
    markets: [{
      slug: 'cpc-btc-updown-15m-2026-11-20-1745z',
      title: 'BTC Up or Down 15m',
      subtitle: 'Nov 20, 12:45PM - 1:00PM',
      closed: false,
      status: 'MARKET_STATUS_OPEN',
      orderPriceMinTickSize: 0.01,
      minimumTradeQty: 0.01,
      feeCoefficient: 0.095,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.39","0.61"]',
      assetPriceTerms: {
        marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN',
        windowStart: '2026-11-20T17:45:00Z',
        windowEnd: '2026-11-20T18:00:00Z',
        priceToBeat: null,
        settlementPrice: null,
        ...terms,
      },
      ...over,
    }],
  };
}

test('US markets are normalised: fee, tick, window, price to beat and result', () => {
  const win = us.windowFor(T0 + 5, '15m');
  const open = us.normaliseEvent(usEvent(), win);
  assert.strictEqual(open.venue, 'us');
  assert.strictEqual(open.slug, win.slug);
  assert.deepStrictEqual([open.start, open.end], [T0, T0 + 900]);
  assert.deepStrictEqual(open.outcomes, ['Up', 'Down']);
  assert.strictEqual(open.feeRate, 0.095);
  assert.strictEqual(open.tick, 0.01);
  assert.strictEqual(open.minQty, 0.01);
  assert.strictEqual(open.twapSec, 60);
  assert.strictEqual(open.priceToBeat, null);
  assert.strictEqual(open.resolved, null);

  const stamped = us.normaliseEvent(usEvent({}, { priceToBeat: { value: '58989.44', currency: 'USD' } }), win);
  assert.strictEqual(stamped.priceToBeat, 58989.44);

  const done = { closed: true, status: 'MARKET_STATUS_RESOLVED' };
  const terms = { priceToBeat: { value: '59203.38' }, settlementPrice: { value: '58989.44' } };
  assert.strictEqual(us.normaliseEvent(usEvent({ ...done, outcomePrices: '["0","1"]' }, terms), win).resolved, 'Down');
  assert.strictEqual(us.normaliseEvent(usEvent({ ...done, outcomePrices: '["1","0"]' }, terms), win).resolved, 'Up');
  // no decisive prices published: fall back to the settlement rule, where a tie is Up
  const tie = { priceToBeat: { value: '59000.00' }, settlementPrice: { value: '59000.00' } };
  assert.strictEqual(us.normaliseEvent(usEvent({ ...done, outcomePrices: '[]' }, tie), win).resolved, 'Up');
  // other crypto market families are not Up/Down windows
  assert.strictEqual(us.normaliseEvent(usEvent({}, { marketType: 'ASSET_PRICE_MARKET_TYPE_ONE_TOUCH' }), win), null);
});

test('the single US book becomes an Up book and its mirror-image Down book', () => {
  const lvl = (px, qty) => ({ px: { value: px, currency: 'USD' }, qty });
  const b = us.normaliseBook({ state: 'MARKET_STATE_OPEN', bids: [lvl('0.3800', '10'), lvl('0.3900', '400')], offers: [lvl('0.4100', '50'), lvl('0.4000', '428')] });
  assert.ok(b.open);
  assert.deepStrictEqual([b.Up.bid, b.Up.ask], [0.39, 0.4]);
  // someone bidding 0.39 for Up is offering Down at 0.61; the Up offer at 0.40 is a Down bid at 0.60
  assert.deepStrictEqual([b.Down.bid, b.Down.ask], [0.6, 0.61]);
  assert.deepStrictEqual(b.Down.asks[0], { price: 0.61, size: 400 });
  assert.deepStrictEqual(b.Down.bids[0], { price: 0.6, size: 428 });
  near(b.Up.ask + b.Down.ask, 1.01); // Up + Down always costs $1 plus the spread: no pair arbitrage here
  assert.strictEqual(us.normaliseBook({ state: 'MARKET_STATE_SUSPENDED', bids: [], offers: [] }).open, false);
});

test('the index series gives the settlement value for a window boundary', () => {
  const idx = new us.IndexSeries();
  idx.add([{ sec: T0 - 2, value: 59203.78 }, { sec: T0 - 1, value: 59203.38 }, { sec: T0, value: 59203.1 }]);
  assert.strictEqual(idx.settlementAt(T0), 59203.38); // the reading stamped one second before
  assert.strictEqual(idx.settlementAt(T0 + 900), null);
  assert.strictEqual(idx.price, 59203.1);
  assert.ok(idx.live);
});

// ------------------------------------------------------------------ signing
test('requests are signed the way Polymarket US expects', async () => {
  const calls = [];
  const client = new UsClient({ keyId: KEY_ID, secretKey: SECRET, now: () => 1795196700123, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"balances":[]}' }; } });
  await client.request('GET', '/v1/portfolio/positions', { query: { market: 'abc' } });
  const { url, init } = calls[0];
  assert.strictEqual(url, 'https://api.polymarket.us/v1/portfolio/positions?market=abc');
  assert.strictEqual(init.headers['X-PM-Access-Key'], KEY_ID);
  assert.strictEqual(init.headers['X-PM-Timestamp'], '1795196700123');
  // signature covers timestamp + method + path, without the query string
  const ok = crypto.verify(null, Buffer.from('1795196700123GET/v1/portfolio/positions'), pair.publicKey, Buffer.from(init.headers['X-PM-Signature'], 'base64'));
  assert.ok(ok, 'signature verifies against the public key');

  await client.createOrder({ marketSlug: 'm' });
  assert.strictEqual(calls[1].init.method, 'POST');
  assert.strictEqual(calls[1].init.body, '{"marketSlug":"m"}');
  assert.ok(crypto.verify(null, Buffer.from('1795196700123POST/v1/orders'), pair.publicKey, Buffer.from(calls[1].init.headers['X-PM-Signature'], 'base64')));
});

test('a 64-byte secret works too, and junk is refused with a clear message', () => {
  const seed = Buffer.from(SECRET, 'base64');
  const long = Buffer.concat([seed, Buffer.alloc(32, 7)]).toString('base64');
  const a = crypto.sign(null, Buffer.from('x'), loadSecret(SECRET));
  const b = crypto.sign(null, Buffer.from('x'), loadSecret(long));
  assert.ok(a.equals(b));
  assert.throws(() => loadSecret('not-a-key'), /does not look like/);
  assert.throws(() => new UsClient({ keyId: '', secretKey: SECRET }), /Key ID/);
});

test('API errors carry the exchange\'s message and status', async () => {
  const client = new UsClient({ keyId: KEY_ID, secretKey: SECRET, fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"invalid signature"}' }) });
  await assert.rejects(client.balances(), (e) => e.status === 401 && /invalid signature/.test(e.message));
});

// ------------------------------------------------------------ order building
test('orders are built in the exchange\'s terms: Down is sent as the Up-side price', () => {
  const m = usMarket();
  const o = (outcome, action, limit) => buildOrder({ market: m, outcome, action, qty: 12.345, limit });
  const buyUp = o('Up', 'buy', 0.62);
  assert.deepStrictEqual([buyUp.intent, buyUp.price.value, buyUp.quantity], ['ORDER_INTENT_BUY_LONG', '0.62', 12.35]);
  assert.strictEqual(buyUp.type, 'ORDER_TYPE_LIMIT');
  assert.strictEqual(buyUp.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
  assert.strictEqual(buyUp.marketSlug, m.slug);
  assert.strictEqual(buyUp.manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_AUTOMATIC');
  assert.ok(buyUp.synchronousExecution);
  // buying Down at 0.40 means selling Up exposure at 0.60
  assert.deepStrictEqual([o('Down', 'buy', 0.4).intent, o('Down', 'buy', 0.4).price.value], ['ORDER_INTENT_BUY_SHORT', '0.60']);
  assert.deepStrictEqual([o('Up', 'sell', 0.55).intent, o('Up', 'sell', 0.55).price.value], ['ORDER_INTENT_SELL_LONG', '0.55']);
  assert.deepStrictEqual([o('Down', 'sell', 0.37).intent, o('Down', 'sell', 0.37).price.value], ['ORDER_INTENT_SELL_SHORT', '0.63']);
  assert.strictEqual(buildOrder({ market: m, outcome: 'Up', action: 'sell', qty: 1, limit: 0.5, manual: true }).manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_MANUAL');
});

test('fills are read from the order response', () => {
  const fillEx = (shares, px, fee, type = 'EXECUTION_TYPE_FILL') => ({ type, lastShares: String(shares), lastPx: { value: String(px) }, commissionNotionalCollected: { value: String(fee) } });
  const up = readFills({ id: 'o1', executions: [fillEx(4, 0.6, 0.09, 'EXECUTION_TYPE_PARTIAL_FILL'), fillEx(6, 0.62, 0.13)] }, 'Up');
  near(up.qty, 10);
  near(up.avgPrice, 0.612);
  near(up.fee, 0.22);
  assert.ok(up.known);
  // a Down fill reports the Up-side price; one Down share cost 1 − 0.60
  near(readFills({ executions: [fillEx(10, 0.6, 0.2)] }, 'Down').avgPrice, 0.4);
  // immediate-or-cancel with nothing to hit: cancelled, nothing filled, outcome known
  const none = readFills({ id: 'o2', executions: [{ type: 'EXECUTION_TYPE_CANCELED', order: { state: 'ORDER_STATE_CANCELED', cumQuantity: 0 } }] }, 'Up');
  assert.deepStrictEqual([none.qty, none.known], [0, true]);
  const rej = readFills({ executions: [{ type: 'EXECUTION_TYPE_REJECTED', text: 'insufficient buying power' }] }, 'Up');
  assert.strictEqual(rej.rejected, 'insufficient buying power');
  // totals on the order itself are used when individual fills are missing
  const totals = readFills({ executions: [{ type: 'EXECUTION_TYPE_NEW', order: { state: 'ORDER_STATE_FILLED', cumQuantity: 5, avgPx: { value: '0.5' }, commissionNotionalTotalCollected: { value: '0.12' } } }] }, 'Up');
  assert.deepStrictEqual([totals.qty, totals.avgPrice, totals.fee], [5, 0.5, 0.12]);
  // an empty reply says nothing about the order's fate
  assert.strictEqual(readFills({ id: 'o3' }, 'Up').known, false);
});

// ------------------------------------------------------- simulated exchange
function exchange(over = {}) {
  const x = {
    orders: [],
    cancels: 0,
    balance: { currentBalance: 100, buyingPower: 100, currency: 'USD' },
    positions: {},
    nowMs: () => Date.now(), // exchange clock, used to timestamp order books
    fillRatio: 1, // share of each order that fills
    reply: null, // override the order response
    status: 200,
    ...over,
  };
  x.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (u.hostname !== 'api.polymarket.us') throw new Error('unexpected host ' + u.hostname);
    for (const h of ['X-PM-Access-Key', 'X-PM-Timestamp', 'X-PM-Signature']) assert.ok(init.headers[h], `${h} present`);
    const msg = `${init.headers['X-PM-Timestamp']}${init.method}${u.pathname}`;
    assert.ok(crypto.verify(null, Buffer.from(msg), pair.publicKey, Buffer.from(init.headers['X-PM-Signature'], 'base64')), 'request signature is valid');
    if (x.status !== 200) return json({ message: x.status === 401 ? 'unauthorized' : 'exchange error' }, x.status);
    if (u.pathname === '/v1/account/balances') return json({ balances: [x.balance] });
    if (u.pathname === '/v1/portfolio/positions') return json({ positions: x.positions });
    if (u.pathname === '/v1/orders/open/cancel') { x.cancels++; return json({}); }
    if (u.pathname === '/v1/orders' && init.method === 'POST') {
      const o = JSON.parse(init.body);
      x.orders.push(o);
      if (x.reply) return json(typeof x.reply === 'function' ? x.reply(o) : x.reply);
      const qty = Math.round(o.quantity * x.fillRatio * 100) / 100;
      const px = Number(o.price.value);
      const long = o.intent.endsWith('LONG');
      const buy = o.intent.includes('BUY');
      const signed = (long ? 1 : -1) * (buy ? 1 : -1) * qty;
      const cur = Number((x.positions[o.marketSlug] || {}).netPositionDecimal || 0);
      x.positions[o.marketSlug] = { netPositionDecimal: String(Math.round((cur + signed) * 100) / 100), marketMetadata: { title: 'BTC Up or Down 15m' } };
      const executions = qty > 0
        ? [{ type: 'EXECUTION_TYPE_FILL', lastShares: String(qty), lastPx: { value: String(px) }, commissionNotionalCollected: { value: String(Math.round(0.095 * qty * px * (1 - px) * 10000) / 10000) }, order: { state: 'ORDER_STATE_FILLED' } }]
        : [{ type: 'EXECUTION_TYPE_CANCELED', order: { state: 'ORDER_STATE_CANCELED', cumQuantity: 0 } }];
      return json({ id: `ord${x.orders.length}`, executions });
    }
    if (u.pathname.startsWith('/v1/order/')) return json({ order: { state: 'ORDER_STATE_NEW', cumQuantity: 0 } });
    if (u.pathname.endsWith('/book')) return json(x.book || { marketData: { state: 'MARKET_STATE_OPEN', transactTime: new Date(x.nowMs()).toISOString(), bids: [{ px: { value: '0.50' }, qty: '100' }], offers: [{ px: { value: '0.52' }, qty: '100' }] } });
    throw new Error('unexpected ' + init.method + ' ' + u.pathname);
  };
  return x;
}

async function trader(x, { arm = true, limits, state } = {}) {
  const logs = [];
  let t = (T0 + 100) * 1000;
  const tr = new LiveTrader({ fetchImpl: x.fetch, log: (level, msg) => logs.push(`${level} ${msg}`), now: () => t, state: state || (limits ? { limits } : {}) });
  tr.logs = logs;
  tr.tick = (ms = 1500) => { t += ms; };
  await tr.connect({ keyId: KEY_ID, secretKey: SECRET });
  if (arm) tr.arm();
  return tr;
}
const upBook = () => book([[0.6, 500]], [[0.62, 500], [0.63, 500]]);

// --------------------------------------------------------------- live trader
test('connecting reads the real account and never arms trading by itself', async () => {
  const x = exchange();
  const tr = await trader(x, { arm: false });
  assert.ok(tr.connected);
  assert.strictEqual(tr.armed, false);
  assert.deepStrictEqual([tr.account.cash, tr.account.buyingPower], [100, 100]);
  assert.match(tr.maskedKey(), /^1111….{4}$/);
  const r = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  assert.strictEqual(r.skipped, 'live trading is off');
  assert.strictEqual(x.orders.length, 0);
});

test('a bad key is refused and nothing is left connected', async () => {
  const x = exchange({ status: 401 });
  const tr = new LiveTrader({ fetchImpl: x.fetch });
  await assert.rejects(tr.connect({ keyId: KEY_ID, secretKey: SECRET }), /rejected that key/);
  assert.strictEqual(tr.connected, false);
  assert.ok(tr.arm().error);
  await assert.rejects(tr.connect({ keyId: KEY_ID, secretKey: 'nonsense' }), /does not look like/);
});

test('armed state is never restored from disk; limits and positions are', async () => {
  const x = exchange();
  const first = await trader(x, { limits: { maxOrderUsd: 7 } });
  await first.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  const saved = JSON.parse(JSON.stringify(first.snapshot()));
  assert.ok(!JSON.stringify(saved).includes(SECRET), 'the secret is not part of saved state');
  assert.ok(!('armed' in saved));
  const again = new LiveTrader({ fetchImpl: x.fetch, state: saved });
  assert.strictEqual(again.armed, false);
  assert.strictEqual(again.connected, false);
  assert.strictEqual(again.limits.maxOrderUsd, 7);
  assert.strictEqual(again.positions.length, 1);
});

test('a live buy is sized so the worst possible fill stays inside the per-order limit', async () => {
  const x = exchange();
  const tr = await trader(x); // default limit: $5 per order
  const pos = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 25, book: upBook(), slippage: 0.03, strategy: 'momentum', reason: 'test' });
  const o = x.orders[0];
  assert.strictEqual(o.intent, 'ORDER_INTENT_BUY_LONG');
  assert.strictEqual(o.price.value, '0.65'); // best ask 0.62 + 3¢ slippage
  const worst = o.quantity * (0.65 + 0.095 * 0.65 * 0.35);
  assert.ok(worst <= DEFAULT_LIMITS.maxOrderUsd + 1e-9, `worst case $${worst.toFixed(4)} ≤ $5`);
  assert.ok(worst > DEFAULT_LIMITS.maxOrderUsd - 0.01, 'and it uses the allowance');
  assert.ok(pos.live);
  assert.strictEqual(pos.strategy, 'momentum');
  near(pos.shares, o.quantity);
  near(pos.avgPrice, 0.65); // the simulated exchange fills at the limit
  assert.ok(pos.cost <= 5 + 1e-9);
  assert.strictEqual(tr.positions.length, 1);
});

test('a limit price from the strategy is respected and rounded down to the tick', async () => {
  const x = exchange();
  const tr = await trader(x);
  await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, maxPrice: 0.6289, book: upBook() });
  assert.strictEqual(x.orders[0].price.value, '0.62');
  tr.tick();
  const r = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, maxPrice: 0.615, book: upBook() });
  assert.match(r.skipped, /above the limit/);
  assert.strictEqual(x.orders.length, 1);
});

test('buying Down sends the mirrored Up-side price and records the Down cost', async () => {
  const x = exchange();
  const tr = await trader(x);
  const down = book([[0.37, 500]], [[0.39, 500]]);
  const pos = await tr.buy({ market: usMarket(), outcome: 'Down', usd: 5, maxPrice: 0.4, book: down });
  assert.deepStrictEqual([x.orders[0].intent, x.orders[0].price.value], ['ORDER_INTENT_BUY_SHORT', '0.60']);
  near(pos.avgPrice, 0.4);
  assert.ok(pos.cost <= 5 + 1e-9);
});

test('limits: total open exposure, the other side of a held market, and order pacing', async () => {
  const x = exchange();
  const tr = await trader(x, { limits: { maxOrderUsd: 5, maxOpenUsd: 8 } });
  const m = usMarket();
  await tr.buy({ market: m, outcome: 'Up', usd: 5, book: upBook() });
  // straight away again: paced to one entry a second
  assert.match((await tr.buy({ market: m, outcome: 'Up', usd: 5, book: upBook() })).skipped, /too soon/);
  tr.tick();
  // $8 cap with ~$5 open leaves ~$3
  const second = await tr.buy({ market: m, outcome: 'Up', usd: 5, book: upBook() });
  assert.ok(second.cost <= 3.01 && second.cost > 2.5, `second order shrank to $${second.cost}`);
  assert.ok(tr.openUsd() <= 8 + 1e-9);
  tr.tick();
  assert.match((await tr.buy({ market: m, outcome: 'Up', usd: 5, book: upBook() })).skipped, /no room|too small/);
  tr.tick();
  // the exchange nets Up against Down, so the bot refuses to hold both
  assert.match((await tr.buy({ market: m, outcome: 'Down', usd: 1, book: book([[0.37, 500]], [[0.39, 500]]) })).skipped, /other side/);
  assert.strictEqual(x.orders.length, 2);
});

test('buying power on the account caps the order', async () => {
  const x = exchange({ balance: { currentBalance: 2, buyingPower: 2, currency: 'USD' } });
  const tr = await trader(x);
  const pos = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  assert.ok(pos.cost <= 2, `spent $${pos.cost} of $2 buying power`);
});

test('only Polymarket US markets can be traded live', async () => {
  const x = exchange();
  const tr = await trader(x);
  const r = await tr.buy({ market: { slug: 'btc-updown-15m-1', tick: 0.01, minQty: 5 }, outcome: 'Up', usd: 5, book: upBook() });
  assert.match(r.skipped, /only works on Polymarket US/);
  assert.strictEqual(x.orders.length, 0);
});

test('an order that does not fill opens nothing', async () => {
  const x = exchange({ fillRatio: 0 });
  const tr = await trader(x);
  const r = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  assert.match(r.skipped, /no fill/);
  assert.strictEqual(tr.positions.length, 0);
  assert.ok(tr.armed, 'a clean miss is not a failure');
});

test('selling checks the exchange first, sells into the bid and records the result', async () => {
  const x = exchange();
  const tr = await trader(x);
  const pos = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, maxPrice: 0.62, book: upBook() });
  tr.tick();
  const t = await tr.sell({ positionId: pos.id, book: book([[0.7, 500]], [[0.72, 500]]), slippage: 0.03, reason: 'take profit' });
  const o = x.orders[1];
  assert.deepStrictEqual([o.intent, o.price.value, o.quantity], ['ORDER_INTENT_SELL_LONG', '0.67', pos.shares]);
  assert.ok(t.live);
  assert.strictEqual(t.exitType, 'sell');
  near(t.exitPrice, 0.67);
  assert.ok(t.pnl > 0 && t.pnl < pos.shares * 0.05, 'profit of ~5¢ a share less fees');
  assert.strictEqual(tr.positions.length, 0);
  near(tr.dayPnl(), t.pnl);
});

test('a position closed in the Polymarket app is not sold again from here', async () => {
  const x = exchange();
  const tr = await trader(x);
  const pos = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  x.positions = {}; // you sold it in the app
  tr.tick();
  const r = await tr.sell({ positionId: pos.id, book: book([[0.7, 500]], []) });
  assert.match(r.error, /closed outside the bot/);
  assert.strictEqual(x.orders.length, 1, 'no sell order was sent');
  assert.strictEqual(tr.positions.length, 0);
});

test('a manual close works even when live trading is switched off', async () => {
  const x = exchange();
  const tr = await trader(x);
  const pos = await tr.buy({ market: usMarket(), outcome: 'Down', usd: 5, maxPrice: 0.4, book: book([[0.37, 500]], [[0.39, 500]]) });
  tr.disarm('test');
  tr.tick();
  const bids = book([[0.45, 500]], [[0.47, 500]]);
  assert.match((await tr.sell({ positionId: pos.id, book: bids })).skipped, /live trading is off/);
  const t = await tr.sell({ positionId: pos.id, book: bids, slippage: 0.03, manual: true, reason: 'closed manually' });
  const o = x.orders[1];
  assert.deepStrictEqual([o.intent, o.price.value, o.manualOrderIndicator], ['ORDER_INTENT_SELL_SHORT', '0.58', 'MANUAL_ORDER_INDICATOR_MANUAL']);
  assert.strictEqual(t.exitType, 'manual');
  near(t.exitPrice, 0.42);
});

test('the daily loss stop switches live trading off', async () => {
  const x = exchange();
  const tr = await trader(x, { limits: { maxOrderUsd: 5, maxOpenUsd: 50, maxDailyLossUsd: 4 } });
  const m = usMarket();
  await tr.buy({ market: m, outcome: 'Up', usd: 5, book: upBook() });
  tr.settle({ slug: m.slug, winner: 'Down' }); // lost about $5
  assert.ok(tr.dayPnl() < -4);
  tr.tick();
  const r = await tr.buy({ market: usMarket({ slug: 'cpc-next' }), outcome: 'Up', usd: 5, book: upBook() });
  assert.strictEqual(r.skipped, 'daily loss stop');
  assert.strictEqual(tr.armed, false);
  assert.ok(tr.logs.some((l) => /daily loss stop hit/.test(l)));
  assert.strictEqual(x.orders.length, 1);
});

test('if the bot cannot tell what happened to an order, it stops trading', async () => {
  const x = exchange({ reply: { id: 'mystery' } }); // no executions, and the order lookup says "new"
  const tr = await trader(x);
  const r = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  assert.match(r.error, /outcome unknown/);
  assert.strictEqual(tr.armed, false);
  assert.strictEqual(tr.positions.length, 0);
  assert.ok(tr.logs.some((l) => /could not confirm what happened to order mystery/.test(l)));
});

test('repeated order errors, or a rejected key, switch live trading off; nothing is retried', async () => {
  const x = exchange();
  const tr = await trader(x);
  x.status = 500;
  for (let i = 0; i < 3; i++) {
    const r = await tr.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
    assert.match(r.error || r.skipped, /failed|live trading is off/);
    tr.tick();
  }
  assert.strictEqual(tr.armed, false);
  assert.ok(tr.logs.some((l) => /3 orders in a row failed/.test(l)));

  const y = exchange();
  const tr2 = await trader(y);
  y.status = 401;
  await tr2.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() });
  assert.strictEqual(tr2.armed, false);

  const z = exchange({ reply: { id: 'r1', executions: [{ type: 'EXECUTION_TYPE_REJECTED', text: 'insufficient buying power' }] } });
  const tr3 = await trader(z);
  assert.match((await tr3.buy({ market: usMarket(), outcome: 'Up', usd: 5, book: upBook() })).error, /insufficient buying power/);
  assert.strictEqual(z.orders.length, 1);
});

test('the stop button disarms and cancels anything resting on the exchange', async () => {
  const x = exchange();
  const tr = await trader(x);
  await tr.kill();
  assert.strictEqual(tr.armed, false);
  assert.strictEqual(x.cancels, 1);
});

test('settlement is recorded against the bot\'s own live lots', async () => {
  const x = exchange();
  const tr = await trader(x);
  const m = usMarket();
  const pos = await tr.buy({ market: m, outcome: 'Up', usd: 5, maxPrice: 0.62, book: upBook() });
  const [t] = tr.settle({ slug: m.slug, winner: 'Up' });
  near(t.proceeds, pos.shares);
  near(t.pnl, pos.shares - pos.cost);
  assert.strictEqual(t.exitType, 'settled');
  assert.strictEqual(tr.positions.length, 0);
});

// ------------------------------------------------------------ engine on US
function usWorld(over = {}) {
  const w = {
    btc: 59000,
    ptb: null, // official price to beat, once published
    index: {}, // sec -> value
    up: { bid: 0.6, ask: 0.62 },
    resolved: null,
    calls: [],
    clock: null, // set by usEngine: the shared test clock
    bookLagMs: 0, // how old the public book snapshot is (the real gateway caches for up to 30s)
    ...over,
  };
  const x = exchange(over.exchange || {});
  x.nowMs = () => (w.clock ? w.clock.t : Date.now());
  w.exchange = x;
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    w.calls.push(`${init.method || 'GET'} ${u.hostname}${u.pathname}`);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.hostname === 'api.polymarket.us') return x.fetch(url, init);
    if (u.hostname === 'api.exchange.coinbase.com') {
      if (u.pathname.endsWith('/ticker')) return json({ price: String(w.btc) });
      return json([]);
    }
    if (u.hostname !== 'gateway.polymarket.us') throw new Error('unexpected host ' + u.hostname);
    if (u.pathname.startsWith('/v1/events/slug/')) {
      const slug = u.pathname.split('/').pop();
      const start = Date.parse(`${slug.slice(-16, -6)}T${slug.slice(-5, -3)}:${slug.slice(-3, -1)}:00Z`) / 1000;
      const len = slug.includes('-5m-') ? 300 : 900;
      const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
      const done = w.resolved && w.resolved.slug === `cpc-${slug}`;
      const ev = usEvent(
        done ? { closed: true, status: 'MARKET_STATUS_RESOLVED', outcomePrices: w.resolved.winner === 'Up' ? '["1","0"]' : '["0","1"]' } : {},
        { windowStart: iso(start), windowEnd: iso(start + len), priceToBeat: w.ptb != null ? { value: String(w.ptb) } : null },
      );
      ev.slug = slug;
      ev.markets[0].slug = `cpc-${slug}`;
      return json({ event: ev });
    }
    if (u.pathname.endsWith('/book')) {
      const lvl = (px, qty) => ({ px: { value: String(px) }, qty: String(qty) });
      return json({ marketData: { state: 'MARKET_STATE_OPEN', transactTime: new Date(x.nowMs() - w.bookLagMs).toISOString(), bids: [lvl(w.up.bid, 500)], offers: [lvl(w.up.ask, 500)] } });
    }
    if (u.pathname === '/v1/asset-prices/history') {
      const from = Number(u.searchParams.get('from'));
      const candles = Object.entries(w.index).filter(([s]) => Number(s) >= from).map(([s, v]) => ({ timestamp: Number(s), close: String(v), tickCount: 60 }));
      return json({ series: [{ candles }] });
    }
    throw new Error('unexpected ' + u.pathname);
  };
  return w;
}

async function usEngine(w, t0 = T0 + 30, WebSocketImpl = null) {
  const clock = { t: t0 * 1000 };
  w.clock = clock;
  const eng = new Engine({ fetchImpl: w.fetch, now: () => clock.t, WebSocketImpl });
  eng.updateSettings({ venue: 'us' });
  return { eng, clock };
}
const rampUp = async (eng, clock, w, n = 6) => { for (let i = 0; i < n; i++) { w.btc += 30; clock.t += 15000; await eng.tick(); } };

test('engine on Polymarket US: market, mirrored quotes, price to beat from the index then the official figure', async () => {
  const w = usWorld({ index: { [T0 - 2]: 58989.98, [T0 - 1]: 58989.44, [T0]: 58988.91 } });
  const { eng, clock } = await usEngine(w);
  await eng.tick();
  assert.strictEqual(eng.market.slug, 'cpc-btc-updown-15m-2026-11-20-1745z');
  assert.strictEqual(eng.market.venue, 'us');
  assert.deepStrictEqual(eng.quotes.Up, { bid: 0.6, ask: 0.62 });
  near(eng.quotes.Down.bid, 0.38);
  near(eng.quotes.Down.ask, 0.4);
  // not yet published by the exchange: taken from the index reading one second before the open
  assert.strictEqual(eng.priceToBeat[eng.market.slug], 58989.44);
  assert.strictEqual(eng.ptbSource[eng.market.slug], 'index');
  assert.strictEqual(eng._settleInfo(eng.market, clock.t / 1000).strikeExact, true);
  const v = eng.view();
  assert.strictEqual(v.venue, 'us');
  assert.strictEqual(v.ptbSource, 'index');
  assert.strictEqual(v.live.connected, false);

  w.ptb = 58989.5; // the exchange publishes its own figure: that one wins
  clock.t += 4000;
  await eng.tick();
  assert.strictEqual(eng.priceToBeat[eng.market.slug], 58989.5);
  assert.strictEqual(eng.ptbSource[eng.market.slug], 'official');
  assert.ok(w.calls.every((c) => !c.includes('api.polymarket.us')), 'no authenticated calls without a key');
});

test('engine on Polymarket US: paper trades use the exchange\'s fee and settle on its published result', async () => {
  const w = usWorld({ ptb: 59000, btc: 59000 });
  const { eng, clock } = await usEngine(w);
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, stakeUsd: 62 });
  await rampUp(eng, clock, w);
  assert.strictEqual(eng.broker.positions.length, 1);
  const pos = eng.broker.positions[0];
  assert.strictEqual(pos.outcome, 'Up');
  near(pos.shares, 100);
  near(pos.fees, 100 * 0.095 * 0.62 * 0.38, 1e-4);
  assert.strictEqual(eng.live.positions.length, 0);

  clock.t = (T0 + 900 + 10) * 1000;
  w.resolved = { slug: pos.slug, winner: 'Down' };
  eng.setStrategyEnabled('momentum', false);
  await eng.tick();
  assert.strictEqual(eng.broker.positions.length, 0);
  assert.strictEqual(eng.broker.trades[0].exitReason, 'Down won');
  assert.strictEqual(eng.broker.trades[0].exitType, 'settled');
});

test('a stale or halted US order book is never traded on', async () => {
  const w = usWorld({ ptb: 59000 });
  const { eng, clock } = await usEngine(w);
  await eng.tick();
  assert.ok(eng._booksFor(eng.market));
  clock.t += 4500; // no refresh for 4.5 seconds
  assert.strictEqual(eng._booksFor(eng.market), null);
  eng.restBooks.at = clock.t;
  eng.restBooks.open = false; // trading halted on the exchange
  assert.strictEqual(eng._booksFor(eng.market), null);
});

test('routing: a strategy trades real money only when connected, armed and allowed — otherwise paper', async () => {
  const w = usWorld({ ptb: 59000, btc: 59000 });
  const { eng, clock } = await usEngine(w);
  eng.running = true; // as if started (no timers in this test)
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, stakeUsd: 25, takeProfit: 0, stopLoss: 0 });

  // connected but not armed → still paper
  assert.deepStrictEqual(await eng.connectLive({ keyId: KEY_ID, secretKey: SECRET }), { ok: true });
  eng.setStrategyLive('momentum', true);
  assert.strictEqual(eng._isLive('momentum'), false);
  assert.ok(eng.view().strategyStats.find((s) => s.id === 'momentum').liveAllowed);
  assert.strictEqual(eng.view().strategyStats.find((s) => s.id === 'momentum').liveNow, false);

  // armed → the next signal goes to the exchange, capped by the $5 limit, and not to the paper account
  assert.deepStrictEqual(eng.armLive(), { ok: true });
  assert.ok(eng._isLive('momentum'));
  await rampUp(eng, clock, w);
  await new Promise((r) => setTimeout(r, 20)); // let the background order finish
  assert.strictEqual(w.exchange.orders.length, 1);
  assert.strictEqual(w.exchange.orders[0].intent, 'ORDER_INTENT_BUY_LONG');
  assert.strictEqual(w.exchange.orders[0].marketSlug, eng.market.slug);
  assert.strictEqual(eng.broker.positions.length, 0, 'nothing on the paper account');
  assert.strictEqual(eng.live.positions.length, 1);
  assert.ok(eng.live.positions[0].cost <= 5 + 1e-9);

  const v = eng.view();
  assert.strictEqual(v.positions.length, 1);
  assert.ok(v.positions[0].live && v.positions[0].canClose);
  assert.strictEqual(v.live.armed, true);
  assert.ok(v.live.openUsd > 0);
  assert.ok(v.strategyStats.find((s) => s.id === 'momentum').liveNow);
  assert.ok(eng.log.some((l) => /\[LIVE · Momentum\] BOUGHT Up/.test(l.msg)));
  assert.ok(!JSON.stringify(v).includes(SECRET) && !JSON.stringify(eng.live.snapshot()).includes(SECRET), 'the secret never leaves the trader');

  // manual close of the real position
  assert.ok(eng.isLivePosition(v.positions[0].id));
  const closed = await eng.closeLivePosition(v.positions[0].id);
  assert.ok(closed.ok);
  assert.strictEqual(w.exchange.orders[1].intent, 'ORDER_INTENT_SELL_LONG');
  assert.strictEqual(w.exchange.orders[1].manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_MANUAL');
  assert.strictEqual(eng.live.positions.length, 0);
  assert.strictEqual(eng.view().trades[0].live, true);

  // stop button: off, orders cancelled, and the strategy is back on paper
  await eng.killLive();
  assert.strictEqual(eng._isLive('momentum'), false);
  assert.strictEqual(w.exchange.cancels, 1);
});

test('live positions settle with the market and stopping the bot disarms live trading', async () => {
  const w = usWorld({ ptb: 59000, btc: 59000 });
  const { eng, clock } = await usEngine(w);
  eng.running = true;
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, takeProfit: 0, stopLoss: 0 });
  await eng.connectLive({ keyId: KEY_ID, secretKey: SECRET });
  eng.setStrategyLive('momentum', true);
  eng.armLive();
  await rampUp(eng, clock, w);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(eng.live.positions.length, 1);
  const slug = eng.live.positions[0].slug;
  const shares = eng.live.positions[0].shares;

  clock.t = (T0 + 900 + 10) * 1000;
  w.resolved = { slug, winner: 'Up' };
  eng.setStrategyEnabled('momentum', false);
  await eng.tick();
  assert.strictEqual(eng.live.positions.length, 0);
  const t = eng.live.trades[0];
  assert.strictEqual(t.exitType, 'settled');
  near(t.proceeds, shares);
  assert.ok(eng.log.some((l) => /\[LIVE · Momentum\] SETTLED Up/.test(l.msg)));

  eng.stop();
  assert.strictEqual(eng.live.armed, false);
});

test('live trading cannot be armed on polymarket.com markets, and leaving Polymarket US disarms it', async () => {
  const w = usWorld({ ptb: 59000 });
  const clock = { t: (T0 + 30) * 1000 };
  const eng = new Engine({ fetchImpl: w.fetch, now: () => clock.t, WebSocketImpl: null });
  eng.running = true;
  assert.match(eng.armLive().error, /Polymarket US/);
  await eng.connectLive({ keyId: KEY_ID, secretKey: SECRET }); // connecting switches the exchange
  assert.strictEqual(eng.settings.venue, 'us');
  assert.ok(eng.armLive().ok);
  eng.updateSettings({ venue: 'global' });
  assert.strictEqual(eng.live.armed, false);
  assert.strictEqual(eng._isLive('momentum'), false);
});

test('with a key connected the order book is read through the signed API, falling back to the public feed if that fails', async () => {
  const w = usWorld({ ptb: 59000 });
  const { eng } = await usEngine(w);
  await eng.tick();
  assert.deepStrictEqual(eng.quotes.Up, { bid: 0.6, ask: 0.62 }); // public gateway
  await eng.connectLive({ keyId: KEY_ID, secretKey: SECRET });
  eng._bookTimer = setTimeout(() => {}, 0); // as when the bot is running its book loop
  await eng._pollBooks(eng.market);
  assert.ok(w.calls.some((c) => c === `GET api.polymarket.us/v1/markets/${eng.market.slug}/book`), 'signed book read');
  assert.strictEqual(eng.restBooks.books.Up.ask, 0.52);

  // a reply in an unexpected form is rejected rather than treated as an empty book
  w.exchange.book = { something: 'else' };
  await assert.rejects(eng._pollBooks(eng.market), /expected form/);
  assert.strictEqual(eng.restBooks.books.Up.ask, 0.52, 'the last good book is kept (and ages out)');
  eng._usBookKeyedOff = true; // what the book loop does after such a failure
  await eng._pollBooks(eng.market);
  assert.strictEqual(eng.restBooks.books.Up.ask, 0.62, 'back on the public feed');
});

test('on Polymarket US strategies act only on a freshly read order book', async () => {
  const w = usWorld({ ptb: 59000, btc: 59000 });
  const { eng, clock } = await usEngine(w);
  const seen = [];
  const spy = { id: 'spy', name: 'Spy', description: '', params: [], initState: () => ({}), onTick: (c) => { seen.push(c.now); return []; } };
  eng._active = [spy];
  eng.params.spy = {};
  eng.strategyState.spy = {};
  await eng.tick(); // reads the book and decides in the same instant
  assert.strictEqual(seen.length, 1);
  clock.t += 300; // a BTC tick arrives 0.3s later: the book is still fresh enough
  eng._evaluate(clock.t);
  assert.strictEqual(seen.length, 2);
  clock.t += 900; // 1.2s after the read: quotes may have moved, so wait for the next read
  eng._evaluate(clock.t);
  assert.strictEqual(seen.length, 2);
  assert.ok(eng.quotes.Up.ask > 0, 'quotes are still shown');
  await eng._pollBooks(eng.market);
  eng._evaluate(clock.t);
  assert.strictEqual(seen.length, 3);
});

test('a tick that started before a window boundary does not pull the old market back', async () => {
  const w = usWorld({ ptb: 59000 });
  const { eng, clock } = await usEngine(w, T0 + 899);
  await eng.tick();
  const first = eng.market.slug;
  await eng._loadMarket(us.windowFor(T0 + 900, '15m'));
  // the tick starts just before the boundary; by the time its requests return the window has rolled over
  const slowFetch = w.fetch;
  eng.fetch = async (url, init) => { const r = await slowFetch(url, init); clock.t = (T0 + 900.2) * 1000; return r; };
  eng._evaluate((T0 + 900.1) * 1000); // streamed update: moves to the new window at once
  const next = eng.market.slug;
  assert.notStrictEqual(next, first);
  clock.t = (T0 + 899.9) * 1000;
  eng.market = eng.marketCache[first]; // state as the in-flight tick saw it when it began
  eng._setMarket(eng.marketCache[next]);
  clock.t = (T0 + 899.95) * 1000;
  await eng.tick();
  assert.strictEqual(eng.market.slug, next, 'still on the new window');
});

// ------------------------------------------------- delayed vs real-time books
test('a cached public order book is shown but never traded on', async () => {
  const w = usWorld({ ptb: 59000, btc: 59000, bookLagMs: 20000 }); // the gateway answers from a 20s-old cache
  const { eng, clock } = await usEngine(w);
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });
  await rampUp(eng, clock, w);
  assert.deepStrictEqual(eng.quotes.Up, { bid: 0.6, ask: 0.62 }, 'quotes are still displayed');
  assert.strictEqual(eng.view().feeds.books, 'delayed');
  assert.strictEqual(eng.broker.positions.length, 0, 'no paper trade on stale quotes');
  assert.ok(eng.log.some((l) => l.level === 'warn' && /only to connected API keys/.test(l.msg)));
  assert.strictEqual(eng._booksFor(eng.market), null, 'and it cannot be traded against by hand either');
  // a book with no timestamp at all is treated the same way
  eng.restBooks.at = 0;
  assert.strictEqual(eng._usBookState(eng.market), 'delayed');

  w.bookLagMs = 0; // a current snapshot
  await rampUp(eng, clock, w, 1);
  assert.strictEqual(eng.view().feeds.books, 'poll');
  assert.strictEqual(eng.broker.positions.length, 1);
});

class FakeWs {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.sent = [];
    FakeWs.all.push(this);
    setImmediate(() => this.onopen && this.onopen());
  }

  send(m) { this.sent.push(m); }
  close() { this.closed = true; }
  push(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}
FakeWs.all = [];
const turn = () => new Promise((r) => setImmediate(r));
const bookMsg = (slug, bid, ask, state = 'MARKET_STATE_OPEN') => ({ requestId: 'books-1', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA', marketData: { marketSlug: slug, state, bids: [{ px: { value: String(bid) }, qty: '300' }], offers: [{ px: { value: String(ask) }, qty: '300' }], transactTime: '2026-11-20T17:45:30Z' } });

test('the real-time US book stream signs its handshake, subscribes, and keeps complete books', async () => {
  FakeWs.all.length = 0;
  const client = new UsClient({ keyId: KEY_ID, secretKey: SECRET, now: () => 1795196700123 });
  const stream = new us.UsBookStream({ client, WebSocketImpl: FakeWs });
  const seen = [];
  stream.on('book', (slug) => seen.push(slug));
  stream.setMarkets(['cpc-a']);
  stream.start();
  await turn();
  const ws = FakeWs.all[0];
  assert.strictEqual(ws.url, 'wss://api.polymarket.us/v1/ws/markets');
  const h = ws.opts.headers;
  assert.strictEqual(h['X-PM-Access-Key'], KEY_ID);
  assert.ok(crypto.verify(null, Buffer.from(`${h['X-PM-Timestamp']}GET/v1/ws/markets`), pair.publicKey, Buffer.from(h['X-PM-Signature'], 'base64')), 'handshake is signed like a GET of the stream path');
  assert.deepStrictEqual(JSON.parse(ws.sent[0]), { subscribe: { requestId: 'books-1', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA', marketSlugs: ['cpc-a'] } });

  assert.strictEqual(stream.books('cpc-a'), null, 'nothing until a book arrives');
  ws.push({ heartbeat: {} });
  ws.push(bookMsg('cpc-a', 0.39, 0.4));
  ws.push(bookMsg('cpc-other', 0.1, 0.2)); // not subscribed: ignored
  const b = stream.books('cpc-a');
  assert.deepStrictEqual([b.Up.bid, b.Up.ask, b.Down.bid, b.Down.ask], [0.39, 0.4, 0.6, 0.61]);
  assert.ok(b.open);
  assert.deepStrictEqual(seen, ['cpc-a']);
  ws.push(bookMsg('cpc-a', 0.41, 0.42)); // every message is a complete book
  assert.strictEqual(stream.books('cpc-a').Up.bid, 0.41);

  // rolling to the next window: drop the old subscription, add the new one
  stream.setMarkets(['cpc-a', 'cpc-b']);
  assert.deepStrictEqual(JSON.parse(ws.sent[1]), { unsubscribe: { requestId: 'books-1' } });
  assert.deepStrictEqual(JSON.parse(ws.sent[2]).subscribe.marketSlugs, ['cpc-a', 'cpc-b']);
  stream.setMarkets(['cpc-b']);
  assert.strictEqual(stream.books('cpc-a'), null);

  let problem = null;
  stream.on('problem', (m) => { problem = m; });
  ws.push({ error: { message: 'unknown market' }, requestId: 'books-3' });
  assert.strictEqual(problem, 'unknown market');

  stream.stop();
  assert.ok(ws.closed);
  assert.strictEqual(stream.books('cpc-b'), null);
});

test('with a key connected the engine trades on the pushed book the moment it changes', async () => {
  FakeWs.all.length = 0;
  const w = usWorld({ ptb: 59000, btc: 59000, bookLagMs: 20000 }); // the public book is stale throughout
  const { eng, clock } = await usEngine(w, T0 + 120, FakeWs);
  eng.updateSettings({ evalMs: 0, pollMs: 60000 });
  eng.setStrategyEnabled('momentum', false);
  const acted = [];
  const spy = { id: 'spy', name: 'Spy', description: '', params: [], initState: () => ({}), onTick: (c) => { acted.push(c.quotes.Up.ask); return []; } };
  eng.start();
  try {
    for (let i = 0; i < 20 && !eng.market; i++) await turn();
    eng._active = [spy];
    eng.params.spy = {};
    eng.strategyState.spy = {};
    const coinbase = FakeWs.all.find((x) => x.url.includes('coinbase'));
    coinbase.push({ type: 'ticker', product_id: 'BTC-USD', price: '59010' });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(acted.length, 0, 'no key, stale public book: strategies wait');
    assert.strictEqual(eng.view().feeds.books, 'delayed');
    assert.ok(!FakeWs.all.some((x) => x.url.includes('api.polymarket.us')), 'no authenticated stream without a key');

    await eng.connectLive({ keyId: KEY_ID, secretKey: SECRET });
    await turn();
    const usWs = FakeWs.all.find((x) => x.url.includes('api.polymarket.us'));
    assert.ok(usWs, 'connecting a key opens the real-time book stream');
    assert.deepStrictEqual(JSON.parse(usWs.sent[0]).subscribe.marketSlugs, [eng.market.slug]);
    usWs.push(bookMsg(eng.market.slug, 0.55, 0.57));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(eng.view().feeds.books, 'stream');
    assert.deepStrictEqual(acted.slice(-1), [0.57], 'strategies ran on the pushed book');
    assert.strictEqual(eng.armed, undefined);
    assert.strictEqual(eng.live.armed, false, 'connecting never arms real trading');

    const before = acted.length;
    clock.t += 5000; // long after any snapshot age limit: a pushed book stays valid until replaced
    coinbase.push({ type: 'ticker', product_id: 'BTC-USD', price: '59020' });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(acted.length > before, 'and a BTC tick alone re-runs them');

    usWs.push(bookMsg(eng.market.slug, 0.55, 0.57, 'MARKET_STATE_SUSPENDED'));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(eng._booksFor(eng.market), null, 'a halted market is not traded');

    eng.disconnectLive();
    assert.ok(usWs.closed, 'disconnecting closes the stream');
    assert.strictEqual(eng.usStream, null);
  } finally {
    eng.stop();
  }
  assert.ok(FakeWs.all.every((x) => x.closed));
});
