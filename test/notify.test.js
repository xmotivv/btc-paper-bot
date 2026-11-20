'use strict';
// Discord webhook notifications. No network: Discord is simulated.
const test = require('node:test');
const assert = require('node:assert');

const { DiscordNotifier, formatActivity } = require('../src/core/notify');
const { Engine } = require('../src/core/engine');

// A made-up address in the right shape (not a real webhook).
const HOOK_URL = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789-xyz';
const TOKEN = HOOK_URL.split('/').pop();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function discord(replies = []) {
  const d = { posts: [], replies };
  d.fetch = async (url, init) => {
    assert.strictEqual(url, HOOK_URL);
    d.posts.push(JSON.parse(init.body));
    const r = d.replies.shift() || { status: 204 };
    if (r.throw) throw new Error(r.throw);
    return { ok: r.status < 300, status: r.status, headers: { get: (k) => (k === 'retry-after' ? r.retryAfter ?? null : null) }, json: async () => r.body || {} };
  };
  return d;
}
const fast = (d) => new DiscordNotifier({ fetchImpl: d.fetch, minGapMs: 15, firstDelayMs: 2 });

test('only real Discord webhook addresses are accepted, and the secret part is never shown', () => {
  const n = new DiscordNotifier({ fetchImpl: async () => { throw new Error('no network in this test'); } });
  assert.strictEqual(n.enabled, false);
  for (const bad of ['http://discord.com/api/webhooks/123456789012345678/' + TOKEN, 'https://example.com/api/webhooks/123456789012345678/' + TOKEN, 'https://discord.com/api/webhooks/123456789012345678', 'https://discord.com.evil.io/api/webhooks/123456789012345678/' + TOKEN, 'not a url']) {
    assert.ok(n.setUrl(bad).error, bad);
    assert.strictEqual(n.enabled, false);
  }
  assert.deepStrictEqual(n.setUrl(`  ${HOOK_URL}  `), { ok: true, enabled: true });
  assert.ok(n.setUrl('https://discordapp.com/api/webhooks/123456789012345678/' + TOKEN).ok);
  assert.ok(n.setUrl('https://canary.discord.com/api/webhooks/123456789012345678/' + TOKEN + '/').ok);
  assert.strictEqual(n.masked(), 'discord.com/api/webhooks/1234…/••••');
  assert.ok(!JSON.stringify(n.status()).includes(TOKEN));
  assert.deepStrictEqual(n.setUrl(''), { ok: true, enabled: false });
  assert.strictEqual(n.masked(), null);
});

test('lines are batched into one message that cannot ping anyone', async () => {
  const d = discord();
  const n = fast(d);
  n.push('nothing is sent without a webhook');
  n.setUrl(HOOK_URL);
  n.push('📄 paper  [Momentum] BUY Up 50.00 @ 0.500');
  n.push('📄 paper  [Pair arbitrage] BUY Down 10.00 @ 0.480 @everyone');
  await wait(30);
  assert.strictEqual(d.posts.length, 1);
  assert.strictEqual(d.posts[0].content, '📄 paper  [Momentum] BUY Up 50.00 @ 0.500\n📄 paper  [Pair arbitrage] BUY Down 10.00 @ 0.480 @everyone');
  assert.deepStrictEqual(d.posts[0].allowed_mentions, { parse: [] });
  assert.strictEqual(d.posts[0].username, 'BTC Paper Bot');
  assert.deepStrictEqual([n.sent, n.queue.length, n.lastError], [2, 0, null]);
});

test('messages stay under Discord\'s size limit and are paced', async () => {
  const d = discord();
  const n = fast(d);
  n.setUrl(HOOK_URL);
  for (let i = 0; i < 5; i++) n.push(`${i} ${'x'.repeat(700)}`);
  await wait(120);
  assert.ok(d.posts.length >= 3, `${d.posts.length} posts`);
  assert.ok(d.posts.every((p) => p.content.length <= 2000));
  assert.strictEqual(n.sent, 5);
  assert.deepStrictEqual(d.posts.flatMap((p) => p.content.split('\n').map((l) => l[0])), ['0', '1', '2', '3', '4'], 'in order, nothing lost');
});

test('a rate-limit reply delays the batch and then delivers it', async () => {
  const d = discord([{ status: 429, body: { retry_after: 0.02 } }]);
  const n = fast(d);
  n.setUrl(HOOK_URL);
  n.push('a');
  await wait(8);
  assert.strictEqual(d.posts.length, 1);
  assert.strictEqual(n.sent, 0);
  assert.match(n.lastError, /slow down/);
  await wait(1200); // Discord's wait is honoured (never less than a second)
  assert.strictEqual(d.posts.length, 2);
  assert.deepStrictEqual([n.sent, n.lastError], [1, null]);
});

test('if Discord is unreachable nothing throws; after a few tries the backlog is dropped', async () => {
  const d = discord(Array.from({ length: 10 }, () => ({ throw: 'getaddrinfo ENOTFOUND' })));
  const n = fast(d);
  n.setUrl(HOOK_URL);
  n.push('a');
  n.push('b');
  await wait(200);
  assert.strictEqual(d.posts.length, 5, 'five attempts, then it gives up on that backlog');
  assert.deepStrictEqual([n.sent, n.queue.length, n.dropped], [0, 0, 2]);
  assert.match(n.lastError, /Could not reach Discord/);
  assert.ok(n.enabled, 'still on for the next trade');
  d.replies.length = 0;
  n.push('c');
  await wait(40);
  assert.deepStrictEqual([n.sent, n.lastError], [1, null]);
});

test('a deleted webhook switches notifications off with an explanation', async () => {
  const d = discord([{ status: 404 }]);
  const n = fast(d);
  n.setUrl(HOOK_URL);
  n.push('a');
  await wait(20);
  assert.strictEqual(n.enabled, false);
  assert.match(n.status().lastError, /no longer exists/);
  n.push('b');
  await wait(20);
  assert.strictEqual(d.posts.length, 1);
});

test('the test button posts straight away and reports the result', async () => {
  const d = discord([{ status: 204 }, { status: 500 }]);
  const n = fast(d);
  assert.ok((await n.test()).error);
  n.setUrl(HOOK_URL);
  assert.deepStrictEqual(await n.test(), { ok: true });
  assert.match(d.posts[0].content, /connected to this channel/);
  assert.match((await n.test()).error, /HTTP 500/);
});

test('trade activity is recognised and labelled; everything else is ignored', () => {
  assert.strictEqual(formatActivity('trade', '[Momentum] BUY Up 50.00 @ 0.500 — move 8bps'), '📄 paper  [Momentum] BUY Up 50.00 @ 0.500 — move 8bps');
  assert.strictEqual(formatActivity('trade', '[Momentum] SETTLED Up (Up won) P&L 12.00'), '📄 paper  [Momentum] SETTLED Up (Up won) P&L 12.00');
  assert.match(formatActivity('trade', '[LIVE · Momentum] BOUGHT Up 7.50 @ 0.620 for $4.82 — test'), /^🔴 \*\*LIVE\*\* {2}\[LIVE · Momentum\] BOUGHT/);
  assert.match(formatActivity('trade', 'LIVE TRADING ARMED — max $5/order'), /^🔴 \*\*LIVE\*\*/);
  assert.match(formatActivity('trade', 'Momentum: real-money trading ALLOWED'), /^🔴 \*\*LIVE\*\*/);
  assert.match(formatActivity('error', '[LIVE · Momentum] BUY Up failed: timeout'), /^⚠️ \*\*LIVE\*\*/);
  assert.strictEqual(formatActivity('info', 'Tracking BTC Up or Down 15m'), null);
  assert.strictEqual(formatActivity('warn', '[Momentum] Buy Up skipped: no asks'), null);
  assert.strictEqual(formatActivity('error', 'HTTP 500 for https://example.com'), null);
  // paper trades can be left out; real ones never are
  assert.strictEqual(formatActivity('trade', '[Momentum] BUY Up 50.00 @ 0.500', { includePaper: false }), null);
  assert.ok(formatActivity('trade', '[LIVE · Momentum] SOLD Up 7.50 @ 0.700 P&L 0.52', { includePaper: false }));
});

// ------------------------------------------------------------------- engine
function world() {
  const w = { btc: 100000, posts: [], other: 0 };
  w.fetch = async (url, init) => {
    if (url === HOOK_URL) { w.posts.push(JSON.parse(init.body)); return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) }; }
    w.other++;
    const body = (() => {
      if (url.includes('/ticker')) return { price: String(w.btc) };
      if (url.includes('/candles')) return [[0, 0, 0, 100000, w.btc, 1]];
      if (url.includes('gamma-api')) return [{ title: 'Bitcoin Up or Down', markets: [{ outcomes: '["Up","Down"]', clobTokenIds: '["UP","DOWN"]', outcomePrices: w.resolved || '["0.5","0.5"]', closed: !!w.resolved }] }];
      if (url.includes('token_id=UP')) return { bids: [{ price: '0.60', size: '500' }], asks: [{ price: '0.62', size: '500' }] };
      if (url.includes('token_id=DOWN')) return { bids: [{ price: '0.37', size: '500' }], asks: [{ price: '0.39', size: '500' }] };
      throw new Error('unexpected ' + url);
    })();
    return { ok: true, status: 200, json: async () => body };
  };
  return w;
}
const T0 = 1763614800;

test('the engine reports every trade to Discord, and the webhook address never reaches the window or the saved state', async () => {
  const w = world();
  let t = (T0 + 30) * 1000;
  let saved = null;
  const store = { load: () => null, save: (obj) => { saved = obj; }, recordTick: () => {} };
  const eng = new Engine({ store, fetchImpl: w.fetch, now: () => t, WebSocketImpl: null });
  eng.notifier.minGapMs = 10;
  eng.notifier.firstDelayMs = 1;
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30 });

  // no webhook: nothing is sent anywhere
  for (let i = 0; i < 2; i++) { w.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.view().notify.enabled, false);
  assert.strictEqual(eng.broker.positions.length, 0, 'no trade yet');

  assert.ok(eng.setWebhook('https://example.com/hook').error);
  assert.deepStrictEqual(eng.setWebhook(HOOK_URL), { ok: true, enabled: true });
  for (let i = 0; i < 3 && !eng.broker.positions.length; i++) { w.btc += 30; t += 15000; await eng.tick(); }
  assert.strictEqual(eng.broker.positions.length, 1);
  await wait(30);
  assert.strictEqual(w.posts.length, 1);
  assert.match(w.posts[0].content, /^📄 paper {2}\[Momentum\] BUY Up /);

  // manual close and settlement are reported too
  const id = eng.broker.positions[0].id;
  eng.closePosition(id);
  await wait(30);
  assert.match(w.posts[1].content, /MANUAL CLOSE Up/);

  const v = eng.view();
  assert.deepStrictEqual([v.notify.enabled, v.notify.where, v.notify.sent], [true, 'discord.com/api/webhooks/1234…/••••', 2]);
  assert.ok(!JSON.stringify(v).includes(TOKEN), 'not in what the window receives');
  assert.ok(saved && !JSON.stringify(saved).includes(TOKEN), 'not in state.json');
  assert.ok(!JSON.stringify(eng.log).includes(TOKEN), 'not in the activity log');

  // paper trades can be switched off; removing the webhook stops everything
  eng.updateSettings({ notifyPaper: false });
  eng._log('trade', '[Momentum] BUY Up 1.00 @ 0.500 — paper');
  eng._log('trade', '[LIVE · Momentum] BOUGHT Up 1.00 @ 0.500 for $0.52 — real');
  await wait(30);
  assert.strictEqual(w.posts.length, 3);
  assert.match(w.posts[2].content, /^🔴 \*\*LIVE\*\* {2}\[LIVE · Momentum\] BOUGHT/);
  assert.ok(!/paper/.test(w.posts[2].content.split('—')[0]));
  eng.setWebhook('');
  eng._log('trade', '[LIVE · Momentum] SOLD Up 1.00 @ 0.600 P&L 0.08');
  await wait(30);
  assert.strictEqual(w.posts.length, 3);
});
