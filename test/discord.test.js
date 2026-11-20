'use strict';
// Discord bot: position cards with live P&L and a Close button.
// Discord is simulated (REST + gateway); nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert');

const { DiscordBot } = require('../src/core/discordBot');
const { PositionCards, renderOpen, renderClosed, EDIT_MS } = require('../src/core/discordCards');
const { Engine } = require('../src/core/engine');

// Made-up values in the right shape. The token is assembled here rather than written out,
// so that nothing shaped like a real credential sits in the repository.
const APP = '123456789012345678';
const TOKEN = [Buffer.from(APP).toString('base64'), 'GabcdE', 'x'.repeat(38)].join('.');
const CH = '222222222222222222';
const OWNER = '333333333333333333';
const STRANGER = '444444444444444444';
const HOOK_URL = 'https://discord.com/api/webhooks/555555555555555555/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789-xyz';
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function discordSim(over = {}) {
  const d = { messages: new Map(), calls: [], nextId: 1000, responses: [], followups: [], sockets: [], channelVisible: true, replies: [], clicks: 0, ...over };
  d.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
    if (url === HOOK_URL) return json({ id: '555555555555555555', channel_id: CH, type: 1 });
    if (u.hostname !== 'discord.com') throw new Error('unexpected host ' + u.hostname);
    const p = u.pathname.replace('/api/v10', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    d.calls.push(`${method} ${p}`);
    const forced = d.replies.shift();
    if (forced) return json(forced.body || {}, forced.status);
    if (p.startsWith('/interactions/')) { assert.ok(!init.headers.Authorization, 'interaction replies use the interaction token, not the bot token'); d.responses.push(body); return json({}, 204); }
    if (p.startsWith('/webhooks/')) { d.followups.push(body); return json({ id: 'f1' }); }
    if (init.headers.Authorization !== `Bot ${TOKEN}`) return json({ message: '401: Unauthorized' }, 401);
    if (p === '/users/@me') return json({ id: APP, username: 'TradeBot' });
    if (p === `/channels/${CH}`) return d.channelVisible ? json({ id: CH }) : json({ message: 'Missing Access' }, 403);
    if (p === `/channels/${CH}/messages` && method === 'POST') {
      if (!d.channelVisible) return json({ message: 'Missing Access' }, 403);
      const id = String(d.nextId++);
      d.messages.set(id, body);
      return json({ id });
    }
    const m = p.match(/^\/channels\/\d+\/messages\/(\d+)$/);
    if (m && method === 'PATCH') {
      if (!d.messages.has(m[1])) return json({ message: 'Unknown Message' }, 404);
      d.messages.set(m[1], body);
      return json({ id: m[1] });
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
  d.WS = class Gateway {
    constructor(url) {
      this.url = url;
      this.sent = [];
      d.sockets.push(this);
      setImmediate(() => this.onmessage && this.onmessage({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) }));
    }

    send(s) {
      const p = JSON.parse(s);
      this.sent.push(p);
      if (p.op === 2) {
        setImmediate(() => {
          if (p.d.token !== TOKEN) { if (this.onclose) this.onclose({ code: 4004 }); return; }
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { username: 'TradeBot' }, application: { id: APP }, session_id: 's1' } }) });
        });
      }
    }

    close() { this.closed = true; }

    /** Simulate someone pressing a button on one of the bot's messages. */
    click(customId, userId) {
      const n = ++d.clicks;
      this.onmessage({ data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: 10 + n, d: { id: `i${n}`, token: `itok${n}`, application_id: APP, type: 3, data: { custom_id: customId, component_type: 2 }, member: { user: { id: userId } } } }) });
    }
  };
  d.gw = () => d.sockets[d.sockets.length - 1];
  d.lastMessage = () => [...d.messages.values()].pop();
  return d;
}

async function connectedBot(d) {
  const bot = new DiscordBot({ fetchImpl: d.fetch, WebSocketImpl: d.WS, restGapMs: 0 });
  assert.deepStrictEqual(bot.configure({ token: TOKEN, channelId: CH, userId: OWNER }), { ok: true });
  bot.start();
  await pause(15);
  return bot;
}

// ------------------------------------------------------------------ client
test('the bot needs a token, a channel and the one user it will obey; the token is never shown', () => {
  const bot = new DiscordBot({ fetchImpl: async () => { throw new Error('no network'); }, WebSocketImpl: null });
  assert.match(bot.configure({ token: 'nope', channelId: CH, userId: OWNER }).error, /bot token/);
  assert.match(bot.configure({ token: TOKEN, channelId: CH, userId: 'me' }).error, /user ID/);
  assert.match(bot.configure({ token: TOKEN, channelId: '', userId: OWNER }).error, /channel ID/);
  assert.strictEqual(bot.configured, false);
  assert.ok(bot.configure({ token: ` ${TOKEN} `, channelId: CH, userId: OWNER }).ok);
  assert.ok(bot.configured);
  assert.ok(!JSON.stringify(bot.status()).includes(TOKEN));
  bot.clear();
  assert.strictEqual(bot.configured, false);
});

test('it connects out to the gateway, identifies without asking for any message content, and becomes ready', async () => {
  const d = discordSim();
  const bot = await connectedBot(d);
  const gw = d.gw();
  assert.strictEqual(gw.url, 'wss://gateway.discord.gg/?v=10&encoding=json');
  const identify = gw.sent.find((p) => p.op === 2);
  assert.strictEqual(identify.d.token, TOKEN);
  assert.strictEqual(identify.d.intents, 0);
  assert.ok(bot.ready);
  assert.deepStrictEqual(bot.status(), { configured: true, connected: true, botName: 'TradeBot', inviteUrl: `https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot&permissions=19456`, lastError: null });
  // a heartbeat request from Discord is answered at once
  gw.onmessage({ data: JSON.stringify({ op: 1 }) });
  assert.deepStrictEqual(gw.sent[gw.sent.length - 1], { op: 1, d: 1 });
  bot.stop();
  assert.ok(gw.closed);
  assert.strictEqual(bot.ready, false);
});

test('it reconnects when Discord asks, but stops for good if the token is rejected', async () => {
  const d = discordSim();
  const bot = await connectedBot(d);
  d.gw().onmessage({ data: JSON.stringify({ op: 7 }) }); // "please reconnect"
  assert.strictEqual(bot.ready, false);
  await pause(600);
  assert.strictEqual(d.sockets.length, 2);
  assert.ok(bot.ready);
  bot.stop();

  const bad = new DiscordBot({ fetchImpl: d.fetch, WebSocketImpl: d.WS, restGapMs: 0 });
  bad.configure({ token: TOKEN.replace('GabcdE', 'Gzzzzz'), channelId: CH, userId: OWNER });
  let problem = null;
  bad.on('problem', (m) => { problem = m; });
  bad.start();
  await pause(20);
  assert.match(problem, /rejected the bot token/);
  assert.strictEqual(bad.ready, false);
  const before = d.sockets.length;
  await pause(1200);
  assert.strictEqual(d.sockets.length, before, 'no reconnect loop on a bad token');
});

test('messages are posted and edited through the REST API; a rate-limit reply is waited out once', async () => {
  const d = discordSim();
  const bot = await connectedBot(d);
  const id = await bot.send({ content: 'hello' });
  assert.deepStrictEqual(d.messages.get(id), { content: 'hello' });
  d.replies.push({ status: 429, body: { retry_after: 0.01 } });
  await bot.edit(id, { content: 'edited' });
  assert.deepStrictEqual(d.messages.get(id), { content: 'edited' });
  assert.strictEqual(d.calls.filter((c) => c.startsWith('PATCH')).length, 2);
  d.channelVisible = false;
  await assert.rejects(bot.send({ content: 'x' }), /Invite it to the server/);
  await assert.rejects(bot.edit('999', { content: 'x' }), (e) => e.status === 404);
  bot.stop();
});

// ------------------------------------------------------------------- cards
const position = (over = {}) => ({ id: 'pos_1', live: false, outcome: 'Up', strategy: 'momentum', strategyName: 'Momentum', title: 'BTC Up or Down 5m', shares: 50, avgPrice: 0.5, cost: 25.5, mark: 0.56, windowEnd: 1795197000, canClose: true, ...over });

test('an open position\'s card shows its unrealised P&L, a self-updating countdown and a Close button', () => {
  const c = renderOpen(position());
  const e = c.embeds[0];
  assert.strictEqual(e.title, '📄 Paper · Up · Momentum');
  assert.strictEqual(e.fields[0].value, '**+$2.50** (+9.8%)'); // 50 × 0.56 − 25.50
  assert.strictEqual(e.fields[1].value, '0.500 → 0.560');
  assert.strictEqual(e.fields[3].value, '<t:1795197000:R>');
  assert.strictEqual(e.color, 0x2ecc71);
  assert.deepStrictEqual(c.components[0].components[0], { type: 2, style: 4, label: 'Close position', custom_id: 'close:pos_1', disabled: false });
  assert.deepStrictEqual(c.allowed_mentions, { parse: [] });

  const losing = renderOpen(position({ live: true, mark: 0.4, canClose: false }));
  assert.strictEqual(losing.embeds[0].title, '🔴 LIVE · Up · Momentum');
  assert.strictEqual(losing.embeds[0].fields[0].value, '**−$5.50** (−21.6%)');
  assert.strictEqual(losing.embeds[0].color, 0xff5c5c);
  assert.deepStrictEqual([losing.components[0].components[0].label, losing.components[0].components[0].disabled], ['Settling…', true]);
});

test('a finished position\'s card shows the result and has no button', () => {
  const last = position();
  const won = renderClosed(last, [{ pnl: 9.5, shares: 50, exitPrice: 0.7, exitType: 'manual', exitReason: 'closed manually' }]);
  assert.strictEqual(won.embeds[0].title, '✅ +$9.50 · 📄 Paper · Up · Momentum');
  assert.strictEqual(won.embeds[0].fields[1].value, '0.500 → 0.700');
  assert.strictEqual(won.embeds[0].fields[2].value, 'Closed by you');
  assert.deepStrictEqual(won.components, []);
  // two partial exits add up
  const split = renderClosed(last, [{ pnl: -3, shares: 20, exitPrice: 0.4, exitType: 'sell', exitReason: 'stop loss' }, { pnl: -25.5 + 15, shares: 30, exitPrice: 0, exitType: 'settled', exitReason: 'Down won' }]);
  assert.strictEqual(split.embeds[0].title, '❌ −$13.50 · 📄 Paper · Up · Momentum');
  assert.strictEqual(split.embeds[0].fields[2].value, 'Settled — Down won');
  assert.match(renderClosed(last, []).embeds[0].fields[0].value, /No longer tracked/);
});

test('cards are created once, edited only when something changed and not too often, then finished off', async () => {
  const d = discordSim();
  const bot = await connectedBot(d);
  let t = 1000000;
  const cards = new PositionCards({ bot, now: () => t });
  const trades = [];
  const sync = (positions) => cards.sync(positions, (id) => trades.filter((x) => x.positionId === id));
  const count = (verb) => d.calls.filter((c) => c.startsWith(verb + ' /channels') && c.includes('/messages')).length;

  await sync([position()]);
  assert.strictEqual(count('POST'), 1);
  const [id] = [...d.messages.keys()];
  await sync([position()]);
  assert.strictEqual(count('PATCH'), 0, 'nothing changed: no edit');
  await sync([position({ mark: 0.6 })]);
  assert.strictEqual(count('PATCH'), 0, 'changed, but too soon after the last write');
  t += EDIT_MS;
  await sync([position({ mark: 0.6 })]);
  assert.strictEqual(count('PATCH'), 1);
  assert.strictEqual(d.messages.get(id).embeds[0].fields[0].value, '**+$4.50** (+17.6%)');

  // survives a restart: the saved map is enough to finish the card
  const restored = new PositionCards({ bot, now: () => t, state: JSON.parse(JSON.stringify(cards.snapshot())) });
  trades.push({ positionId: 'pos_1', pnl: 4.5, shares: 50, exitPrice: 0.6, exitType: 'sell', exitReason: 'take profit' });
  await restored.sync([], (pid) => trades.filter((x) => x.positionId === pid));
  assert.strictEqual(d.messages.get(id).embeds[0].title, '✅ +$4.50 · 📄 Paper · Up · Momentum');
  assert.deepStrictEqual(d.messages.get(id).components, []);
  assert.strictEqual(restored.cards.size, 0);
  assert.strictEqual(count('POST'), 1, 'still just the one message');

  // a card deleted in Discord is replaced rather than retried forever
  await sync([position({ mark: 0.6 })]);
  t += EDIT_MS;
  d.messages.clear();
  await sync([position({ mark: 0.7 })]);
  assert.strictEqual(cards.cards.size, 0);
  await sync([position({ mark: 0.7 })]);
  assert.strictEqual(cards.cards.size, 1);
  bot.stop();
});

// ------------------------------------------------------------------- engine
function world(d) {
  const w = { btc: 100000 };
  w.fetch = async (url, init) => {
    if (url.includes('discord.com')) return d.fetch(url, init);
    const body = (() => {
      if (url.includes('/ticker')) return { price: String(w.btc) };
      if (url.includes('/candles')) return [[0, 0, 0, 100000, w.btc, 1]];
      if (url.includes('gamma-api')) return [{ title: 'Bitcoin Up or Down', markets: [{ outcomes: '["Up","Down"]', clobTokenIds: '["UP","DOWN"]', outcomePrices: '["0.5","0.5"]', closed: false }] }];
      const up = w.up || { bid: 0.6, ask: 0.62 };
      if (url.includes('token_id=UP')) return { bids: [{ price: String(up.bid), size: '500' }], asks: [{ price: String(up.ask), size: '500' }] };
      if (url.includes('token_id=DOWN')) return { bids: [{ price: '0.37', size: '500' }], asks: [{ price: '0.39', size: '500' }] };
      throw new Error('unexpected ' + url);
    })();
    return { ok: true, status: 200, json: async () => body };
  };
  return w;
}
const T0 = 1763614800;

async function engineWithBot(d, w) {
  const clock = { t: (T0 + 30) * 1000 };
  let saved = null;
  const store = { load: () => null, save: (obj) => { saved = obj; }, recordTick: () => {} };
  const eng = new Engine({ store, fetchImpl: w.fetch, now: () => clock.t, WebSocketImpl: d.WS });
  eng.discord.restGapMs = 0;
  eng.updateSettings({ feeModel: 'flat', feeRate: 0 });
  eng.setStrategy('momentum', { minElapsedSec: 60, lookbackSec: 30, takeProfit: 0, stopLoss: 0 });
  const r = await eng.setDiscordBot({ token: TOKEN, channelId: CH, userId: OWNER });
  await pause(15);
  return { eng, clock, r, saved: () => saved };
}
const step = async (eng, clock, w, n = 1) => { for (let i = 0; i < n; i++) { w.btc += 30; clock.t += 15000; await eng.tick(); await pause(10); } };

test('setting up the bot: a bad token is refused; an uninvited bot is accepted with an invite link; the webhook\'s channel is the default', async () => {
  const d = discordSim({ channelVisible: false });
  const w = world(d);
  const eng = new Engine({ fetchImpl: w.fetch, now: () => T0 * 1000, WebSocketImpl: d.WS });
  eng.discord.restGapMs = 0;
  assert.match((await eng.setDiscordBot({ token: TOKEN.replace('GabcdE', 'Gzzzzz'), channelId: CH, userId: OWNER })).error, /rejected the bot token/);
  assert.strictEqual(eng.view().discord.configured, false);
  assert.match((await eng.setDiscordBot({ token: TOKEN, channelId: '', userId: OWNER })).error, /channel ID/);

  const r = await eng.setDiscordBot({ token: TOKEN, channelId: CH, userId: OWNER });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.botName, r.channelOk], ['TradeBot', false]);
  assert.match(r.inviteUrl, new RegExp(`client_id=${APP}&scope=bot`));
  assert.match((await eng.testDiscordBot()).error, /Invite it to the server/);

  d.channelVisible = true; // invited
  assert.ok((await eng.testDiscordBot()).ok);
  assert.strictEqual(d.lastMessage().components[0].components[0].custom_id, 'test:1');

  // no channel given, but a webhook is set: use the webhook's channel
  eng.setWebhook(HOOK_URL);
  const viaHook = await eng.setDiscordBot({ token: TOKEN, channelId: '', userId: OWNER });
  assert.deepStrictEqual([viaHook.ok, viaHook.channelId, viaHook.channelOk], [true, CH, true]);
  eng.removeDiscordBot();
  assert.strictEqual(eng.view().discord.configured, false);
});

test('each open position gets a card whose P&L follows the market; the token never reaches the window or disk', async () => {
  const d = discordSim();
  const w = world(d);
  const { eng, clock, r, saved } = await engineWithBot(d, w);
  assert.ok(r.ok && r.channelOk);
  assert.ok(eng.view().discord.connected);

  await step(eng, clock, w, 3);
  assert.strictEqual(eng.broker.positions.length, 1);
  await step(eng, clock, w, 1);
  assert.strictEqual(d.messages.size, 1);
  const [id] = [...d.messages.keys()];
  const pos = eng.broker.positions[0];
  assert.strictEqual(d.messages.get(id).embeds[0].title, '📄 Paper · Up · Momentum');
  assert.strictEqual(d.messages.get(id).components[0].components[0].custom_id, `close:${pos.id}`);
  assert.match(d.messages.get(id).embeds[0].fields[0].value, /^\*\*−\$/); // bought at the ask, marked at the bid

  w.up = { bid: 0.8, ask: 0.82 }; // the market moves our way
  await step(eng, clock, w, 1);
  const pnl = pos.shares * 0.8 - pos.cost;
  assert.strictEqual(d.messages.get(id).embeds[0].fields[0].value, `**+$${pnl.toFixed(2)}** (+${((pnl / pos.cost) * 100).toFixed(1)}%)`);
  assert.strictEqual(d.messages.size, 1, 'the same message is edited, not a new one posted');

  const v = eng.view();
  assert.deepStrictEqual([v.discord.connected, v.discord.botName, v.discord.cards], [true, 'TradeBot', 1]);
  assert.ok(!JSON.stringify(v).includes(TOKEN), 'not in what the window receives');
  assert.ok(saved() && !JSON.stringify(saved()).includes(TOKEN), 'not in state.json');
  assert.ok(!JSON.stringify(eng.log).includes(TOKEN), 'not in the activity log');
  assert.strictEqual(saved().discordCards[pos.id].messageId, id);
  eng.discord.stop();
});

test('only the owner\'s click closes a paper position; the card then shows the result', async () => {
  const d = discordSim();
  const w = world(d);
  const { eng, clock } = await engineWithBot(d, w);
  await step(eng, clock, w, 4);
  const pos = eng.broker.positions[0];
  const [id] = [...d.messages.keys()];

  d.gw().click(`close:${pos.id}`, STRANGER);
  await pause();
  assert.strictEqual(eng.broker.positions.length, 1, 'someone else pressing the button does nothing');
  assert.match(d.responses[0].data.content, /Only the owner/);
  assert.strictEqual(d.responses[0].data.flags, 64, 'the refusal is visible only to them');

  d.gw().click(`close:${pos.id}`, OWNER);
  await pause();
  assert.strictEqual(eng.broker.positions.length, 0);
  const trade = eng.broker.trades[0];
  assert.deepStrictEqual([trade.exitType, trade.positionId], ['manual', pos.id]);
  near(trade.exitPrice, 0.6);
  assert.match(d.responses[1].data.content, /^Closed at 0\.600 for [+−]\$/);
  assert.strictEqual(d.responses[1].data.flags, 64);
  await pause();
  assert.match(d.messages.get(id).embeds[0].title, /^[✅❌] [+−]\$\d+\.\d\d · 📄 Paper · Up · Momentum$/);
  assert.strictEqual(d.messages.get(id).embeds[0].fields[2].value, 'Closed by you');
  assert.deepStrictEqual(d.messages.get(id).components, []);

  // pressing it again (or an old card's button) explains instead of failing silently
  d.gw().click(`close:${pos.id}`, OWNER);
  await pause();
  assert.match(d.responses[2].data.content, /already be closed/);
  d.gw().click('test:1', OWNER);
  await pause();
  assert.match(d.responses[3].data.content, /Buttons work/);
  eng.discord.stop();
});

test('closing a REAL position from Discord takes a second, explicit confirmation', async () => {
  const d = discordSim();
  const w = world(d);
  const { eng } = await engineWithBot(d, w);
  const sold = [];
  eng.isLivePosition = (id) => id === 'live_1';
  eng.closeLivePosition = async (id) => { sold.push(id); return { ok: true, partial: false, trade: { exitPrice: 0.7, pnl: 1.25 } }; };

  d.gw().click('close:live_1', OWNER);
  await pause();
  assert.deepStrictEqual(sold, [], 'the first click only asks');
  const ask = d.responses[0];
  assert.deepStrictEqual([ask.type, ask.data.flags], [4, 64]);
  assert.match(ask.data.content, /REAL/);
  assert.deepStrictEqual(ask.data.components[0].components[0], { type: 2, style: 4, label: 'Yes, sell it', custom_id: 'confirm:live_1' });

  d.gw().click('confirm:live_1', STRANGER);
  await pause();
  assert.deepStrictEqual(sold, [], 'and only the owner can confirm');

  d.gw().click('confirm:live_1', OWNER);
  await pause();
  assert.deepStrictEqual(sold, ['live_1']);
  assert.deepStrictEqual(d.responses[2], { type: 6 }, 'acknowledged first, inside Discord\'s deadline');
  assert.deepStrictEqual([d.followups[0].content, d.followups[0].flags], ['Closed at 0.700 for +$1.25.', 64]);

  // live trading being armed or switched off is announced by the bot too
  eng._log('trade', 'LIVE TRADING ARMED — max $5/order, $25 open, stop at $20 daily loss');
  eng._log('error', '[LIVE · Momentum] BUY Up failed: timeout');
  eng._log('trade', '[Momentum] BUY Up 50.00 @ 0.500 — the card covers this');
  await pause();
  const lines = [...d.messages.values()].map((m) => m.content).filter(Boolean);
  assert.deepStrictEqual(lines, ['🔴 **LIVE**  LIVE TRADING ARMED — max $5/order, $25 open, stop at $20 daily loss', '⚠️ **LIVE**  [LIVE · Momentum] BUY Up failed: timeout']);
  eng.discord.stop();
});
