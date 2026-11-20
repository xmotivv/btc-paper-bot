'use strict';
/* global bot */
// Renderer. The engine pushes small live updates several times a second and
// sends the bulky parts (trade history, equity curve, log, strategy forms) only
// when they change. Rendering follows suit: text nodes are touched only when
// their value changed, tables are patched row by row, and hidden tabs are skipped.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const c3 = (n) => (n == null ? '—' : Number(n).toFixed(3));
const pct = (n, d = 0) => `${(n * 100).toFixed(d)}%`;
const time = (t) => new Date(t).toLocaleTimeString();
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Write text / class only when it actually changed. */
function setText(node, text) {
  if (node.__t !== text) { node.__t = text; node.textContent = text; }
}
function setClass(node, c) {
  if (node.__c !== c) { node.__c = c; node.className = c; }
}

let view = null;
let activeTab = 'positions';
let frame = 0;
let settingsBuilt = false;
let strategiesBuilt = false;
let posKey = null;
const posRows = new Map();
const dirty = { spark: true, equity: true, trades: true, log: true, strategies: true };
const HEAVY = { btcSpark: 'spark', equityCurve: 'equity', trades: 'trades', log: 'log', strategies: 'strategies' };

function onUpdate(patch) {
  if (!view) return; // wait for the first full snapshot
  for (const k in HEAVY) if (patch[k]) dirty[HEAVY[k]] = true;
  Object.assign(view, patch);
  schedule();
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
}

// ---------------------------------------------------------------- charts
function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = Number(cv.getAttribute('data-h') || cv.getAttribute('height'));
  if (!cv.getAttribute('data-h')) cv.setAttribute('data-h', h);
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function line(cv, values, color, { baseline = null, labels = false } = {}) {
  const { ctx, w, h } = sizeCanvas(cv);
  if (!values || values.length < 2) return;
  let min = baseline ?? Infinity;
  let max = baseline ?? -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const pad = labels ? 18 : 4;
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - min) / (max - min));
  const x = (i) => (i / (values.length - 1)) * (w - (labels ? 60 : 0));
  if (baseline != null) {
    ctx.strokeStyle = '#2c3a4f'; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, y(baseline)); ctx.lineTo(w, y(baseline)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  if (labels) {
    ctx.fillStyle = '#8b98a8'; ctx.font = '11px Segoe UI';
    ctx.fillText(usd(max), w - 56, pad + 4); ctx.fillText(usd(min), w - 56, h - pad + 4);
  }
}

// ---------------------------------------------------------------- render
function render() {
  const v = view;
  if (!v) return;
  renderHeader(v);
  renderCards(v);
  if (dirty.spark || render.ptb !== v.priceToBeat) {
    dirty.spark = false;
    render.ptb = v.priceToBeat;
    line($('btcSpark'), v.btcSpark, '#f7931a', { baseline: v.priceToBeat });
  }
  const total = v.equity - v.startingCash;
  if (dirty.equity || render.eqSign !== (total >= 0)) {
    dirty.equity = false;
    render.eqSign = total >= 0;
    line($('equityChart'), v.equityCurve.map((p) => p.e), total >= 0 ? '#2ecc71' : '#ff5c5c', { baseline: v.startingCash, labels: true });
    setText($('equityRange'), v.equityCurve.length ? `since ${new Date(v.equityCurve[0].t).toLocaleString()}` : 'builds one point per minute');
  }
  const pc = $('posCount');
  setText(pc, String(v.positions.length));
  pc.classList.toggle('hidden', v.positions.length === 0);
  const on = v.strategyStats.filter((s) => s.enabled).length;
  setText($('stratCount'), `${on} on`);
  $('stratCount').classList.toggle('hidden', on === 0);
  const liveOn = v.strategyStats.filter((s) => s.liveNow).length;
  setText($('liveCount'), v.live && v.live.armed ? `armed · ${liveOn}` : 'connected');
  setClass($('liveCount'), `count${v.live && v.live.armed ? ' hot' : ''}${v.live && v.live.connected ? '' : ' hidden'}`);

  renderWebhook(v);
  if (!strategiesBuilt) buildStrategies(v);
  if (!settingsBuilt) buildSettings(v);
  if (activeTab === 'positions') renderPositions(v);
  else if (activeTab === 'trades') renderTrades(v);
  else if (activeTab === 'strategy') renderStrategies(v);
  else if (activeTab === 'live') renderLive(v);
  else if (activeTab === 'log') renderLog(v);
}

function renderHeader(v) {
  const L = v.live || {};
  const us = v.venue === 'us';
  setText($('statusPill'), v.running ? '● Running' : 'Stopped');
  setClass($('statusPill'), `pill ${v.running ? 'on' : 'off'}`);
  setText($('toggleBtn'), v.running ? 'Stop' : 'Start');
  const f = v.feeds || {};
  const streaming = f.btc === 'stream' && f.books === 'stream';
  const fp = $('feedPill');
  if (!v.running) { setText(fp, 'Feeds idle'); setClass(fp, 'pill off'); }
  else if (us) {
    const label = { stream: '⚡ US feed · live', poll: 'US feed · polling', delayed: L.connected ? 'US feed · reconnecting…' : 'US feed · delayed — connect a key' }[f.books] || 'US feed';
    setText(fp, label);
    setClass(fp, `pill ${f.books === 'delayed' ? 'warn' : 'on'}`);
    fp.title = f.books === 'delayed' ? 'Polymarket US only gives a live order book to connected API keys. The public one is up to 30 seconds old, so strategies wait.' : 'Order book is current';
  }
  else if (streaming) { setText(fp, '⚡ Live stream'); setClass(fp, 'pill on'); }
  else if (v.settings.streaming) { setText(fp, 'Connecting… (polling)'); setClass(fp, 'pill warn'); }
  else { setText(fp, 'Polling'); setClass(fp, 'pill warn'); }
  setText($('subTitle'), `${us ? 'Polymarket US' : 'Polymarket'} BTC Up/Down · ${L.armed ? 'LIVE TRADING ARMED — real money' : 'paper trading'}`);
  const lp = $('livePill');
  lp.classList.toggle('hidden', !L.connected);
  if (L.connected) { setText(lp, L.armed ? '● LIVE' : 'Account connected'); setClass(lp, `pill ${L.armed ? 'live' : 'off'}`); }
  $('killBtn').classList.toggle('hidden', !L.armed);
  $('errorBar').classList.toggle('hidden', !v.lastError);
  setText($('errorBar'), v.lastError ? `Last error: ${v.lastError} (retrying)` : '');
}

function renderCards(v) {
  setText($('btcPrice'), usd(v.btc));
  setText($('clPrice'), v.chainlink ? usd(v.chainlink) : v.running ? 'connecting…' : '—');
  setText($('clLabel'), v.venue === 'us' ? '(BRTI, 60s average)' : '(Chainlink)');

  const m = v.market;
  setText($('marketTitle'), m ? m.title : 'Waiting for market…');
  $('marketTitle').dataset.url = m ? m.url : '';
  setText($('ptb'), usd(v.priceToBeat));
  setText($('ptbSource'), { chainlink: '(Chainlink)', coinbase: '(estimate)', index: '(index)', official: '(official)' }[v.ptbSource] || '');
  if (v.btc && v.priceToBeat) {
    const ref = v.chainlink || v.btc;
    const bps = ((ref - v.priceToBeat) / v.priceToBeat) * 1e4;
    setText($('move'), `${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps`);
    setClass($('move'), cls(bps));
  } else setText($('move'), '—');
  renderCountdown();
  if (v.fairUp != null) {
    setText($('fair'), pct(v.fairUp, 1));
    setClass($('fair'), v.fairUp >= 0.5 ? 'pos' : 'neg');
  } else { setText($('fair'), '—'); setClass($('fair'), ''); }

  const q = v.quotes || {};
  const up = q.Up || {};
  const down = q.Down || {};
  setText($('upQ'), `${c3(up.bid)} / ${c3(up.ask)}`);
  setText($('downQ'), `${c3(down.bid)} / ${c3(down.ask)}`);
  if (up.ask != null && down.ask != null) {
    const sum = up.ask + down.ask;
    setText($('pairCost'), `$${sum.toFixed(3)}`);
    setClass($('pairCost'), sum < 1 ? 'pos' : '');
    const rate = m && v.settings.feeModel === 'market' ? m.feeRate : null;
    const fee = (p) => (rate != null ? rate * (1 - p) : v.settings.feeRate);
    setText($('feeNow'), `Up ${pct(fee(up.ask), 1)} · Down ${pct(fee(down.ask), 1)}`);
  } else { setText($('pairCost'), '—'); setText($('feeNow'), '—'); }

  const total = v.equity - v.startingCash;
  setText($('equity'), usd(v.equity));
  setText($('cash'), usd(v.cash));
  setText($('pnl'), signed(total));
  setClass($('pnl'), cls(total));
  setText($('winrate'), `${pct(v.stats.winRate)} · ${v.stats.trades}`);
  const pf = v.stats.profitFactor;
  setText($('pf'), `${pf === Infinity || pf == null ? '∞' : pf} · ${usd(v.stats.fees)}`);
}

function renderCountdown() {
  const m = view && view.market;
  setText($('countdown'), m ? mmss(Math.max(0, Math.round(m.end - Date.now() / 1000))) : '—');
}

// ---- open positions: rows are created once per position and patched in place,
// so a Close button never disappears from under the cursor mid-click.
function renderPositions(v) {
  const body = $('positionsBody');
  const key = v.positions.map((p) => p.id).join(',');
  if (key !== posKey) {
    posKey = key;
    posRows.clear();
    body.textContent = '';
    for (const p of v.positions) {
      const tr = el('tr');
      const cells = {
        account: el('td'),
        market: el('td', '', p.title),
        strategy: el('td', '', p.strategyName),
        side: el('td', p.outcome === 'Up' ? 'pos' : 'neg', p.outcome),
        shares: el('td'),
        entry: el('td'),
        mark: el('td'),
        pnl: el('td'),
        why: el('td', 'reason', p.reason),
        act: el('td', 'act'),
      };
      cells.account.append(el('span', p.live ? 'tag live' : 'tag', p.live ? 'LIVE' : 'paper'));
      const btn = el('button', 'btn small danger', 'Close');
      btn.dataset.close = p.id;
      if (p.live) btn.dataset.live = '1';
      cells.act.append(btn);
      tr.append(...Object.values(cells));
      body.append(tr);
      posRows.set(p.id, { cells, btn });
    }
    $('positionsEmpty').classList.toggle('hidden', v.positions.length > 0);
  }
  let closable = 0;
  for (const p of v.positions) {
    const row = posRows.get(p.id);
    if (!row) continue;
    const u = p.shares * (p.mark ?? p.avgPrice) - p.cost;
    setText(row.cells.shares, p.shares.toFixed(2));
    setText(row.cells.entry, c3(p.avgPrice));
    setText(row.cells.mark, c3(p.mark));
    setText(row.cells.pnl, signed(u));
    setClass(row.cells.pnl, cls(u));
    if (p.canClose) closable++;
    if (!row.btn.dataset.busy) {
      row.btn.disabled = !p.canClose;
      setText(row.btn, p.canClose ? 'Close' : 'Settling…');
      row.btn.title = !p.canClose ? 'The window has ended; this settles automatically' : p.live ? 'Sell this REAL position on Polymarket US now' : 'Sell this paper position into the live bids now';
    }
  }
  $('closeAllBtn').disabled = closable === 0;
}

function renderTrades(v) {
  if (!dirty.trades) return;
  dirty.trades = false;
  const body = $('tradesBody');
  const frag = document.createDocumentFragment();
  for (const t of v.trades) {
    const tr = el('tr');
    tr.append(
      el('td', '', new Date(t.closedAt).toLocaleString()),
      (() => { const td = el('td'); td.append(el('span', t.live ? 'tag live' : 'tag', t.live ? 'LIVE' : 'paper')); return td; })(),
      el('td', '', t.title),
      el('td', '', t.strategyName),
      el('td', t.outcome === 'Up' ? 'pos' : 'neg', t.outcome),
      el('td', '', c3(t.entryPrice)),
      el('td', '', c3(t.exitPrice)),
      el('td', cls(t.pnl), signed(t.pnl)),
      el('td', '', t.exitType),
      el('td', 'reason', t.entryReason),
    );
    frag.append(tr);
  }
  body.replaceChildren(frag);
  $('tradesEmpty').classList.toggle('hidden', v.trades.length > 0);
}

function renderLog(v) {
  if (!dirty.log) return;
  dirty.log = false;
  const lg = $('logList');
  const atBottom = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 10;
  const frag = document.createDocumentFragment();
  for (const l of v.log) frag.append(el('div', l.level, `${time(l.t)} ${l.level.toUpperCase()} ${l.msg}`));
  lg.replaceChildren(frag);
  if (atBottom) lg.scrollTop = lg.scrollHeight;
}

// ---- strategies: one card each, built once; stats and switches are patched live.
function buildStrategies(v) {
  strategiesBuilt = true;
  const list = $('strategyList');
  list.textContent = '';
  for (const s of v.strategies) {
    const card = el('div', 'strategy');
    card.dataset.id = s.id;

    const head = el('div', 'strategy-head');
    const sw = el('label', 'switch');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.toggle = s.id;
    sw.append(cb, el('span', 'slider'));
    sw.title = 'Turn this strategy on or off';
    const stats = el('div', 'strategy-stats');
    for (const k of ['trades', 'win', 'pnl', 'open']) {
      const cell = el('div', 'stat');
      cell.append(el('span', 'muted', { trades: 'Trades', win: 'Win rate', pnl: 'Realised P&L', open: 'Open' }[k]), el('b'));
      cell.dataset.stat = k;
      stats.append(cell);
    }
    const real = el('label', 'real-money');
    const rcb = el('input');
    rcb.type = 'checkbox';
    rcb.dataset.live = s.id;
    real.append(rcb, el('span', '', 'Real money'));
    real.title = 'Let this strategy place real orders on Polymarket US while live trading is armed';
    head.append(sw, el('div', 'strategy-name', s.name), real, stats);

    const details = el('details');
    details.append(el('summary', '', 'Settings'));
    const form = el('form', 'grid-form');
    form.dataset.form = s.id;
    for (const p of s.params) {
      const label = el('label', '', p.label);
      const input = el('input');
      input.name = p.key;
      input.type = 'number';
      input.step = p.step ?? 'any';
      if (p.min != null) input.min = p.min;
      if (p.max != null) input.max = p.max;
      input.value = s.values[p.key];
      label.append(input);
      form.append(label);
    }
    const bar = el('div', 'toolbar');
    const apply = el('button', 'btn primary', 'Apply');
    apply.type = 'button';
    apply.dataset.apply = s.id;
    const reset = el('button', 'btn', 'Defaults');
    reset.type = 'button';
    reset.dataset.defaults = s.id;
    bar.append(apply, reset, el('span', 'muted saved'));
    details.append(form, bar);

    const liveLine = el('p', 'live-line hidden');
    liveLine.dataset.liveLine = s.id;
    card.append(head, el('p', 'muted', s.description), liveLine, details);
    list.append(card);
  }
}

function renderStrategies(v) {
  for (const st of v.strategyStats) {
    const card = document.querySelector(`.strategy[data-id="${st.id}"]`);
    if (!card) continue;
    setClass(card, `strategy${st.enabled ? ' on' : ''}${st.liveNow ? ' live' : ''}`);
    const rcb = card.querySelector('[data-live]');
    if (!rcb.dataset.busy) rcb.checked = st.liveAllowed;
    rcb.disabled = !(v.live && v.live.connected) && !st.liveAllowed;
    const line = card.querySelector('[data-live-line]');
    const showLive = st.liveAllowed || st.liveTrades > 0 || st.liveOpen > 0;
    line.classList.toggle('hidden', !showLive);
    if (showLive) {
      const state = st.liveNow ? 'TRADING REAL MONEY NOW' : st.liveAllowed ? (v.live && v.live.armed ? 'real money allowed (strategy is switched off)' : 'real money allowed — waiting for live trading to be armed') : 'real money off';
      setText(line, `${state} · live trades ${st.liveTrades} · live P&L ${st.liveTrades ? signed(st.livePnl) : '—'} · open ${st.liveOpen}${st.liveOpen ? ` (${signed(st.liveUnrealised)})` : ''}`);
    }
    const cb = card.querySelector('[data-toggle]');
    if (!cb.dataset.busy) cb.checked = st.enabled;
    const stat = (k) => card.querySelector(`[data-stat="${k}"] b`);
    setText(stat('trades'), String(st.trades));
    setText(stat('win'), st.trades ? pct(st.winRate) : '—');
    setText(stat('pnl'), st.trades ? signed(st.pnl) : '—');
    setClass(stat('pnl'), st.trades ? cls(st.pnl) : '');
    setText(stat('open'), st.open ? `${st.open} (${signed(st.unrealised)})` : '0');
    setClass(stat('open'), st.open ? cls(st.unrealised) : '');
  }
  if (!dirty.strategies) return;
  dirty.strategies = false;
  // Server-side values changed (Apply / Defaults): refresh inputs the user isn't editing.
  for (const s of v.strategies) {
    const form = document.querySelector(`form[data-form="${s.id}"]`);
    if (!form) continue;
    for (const input of form.elements) {
      if (input.name && !input.dataset.dirty) input.value = s.values[input.name];
    }
  }
}

// ---- live account
let limitsBuilt = false;
function renderLive(v) {
  const L = v.live || {};
  setText($('liveStatus'), L.connected ? `Connected · key ${L.key}` : 'Not connected');
  setClass($('liveStatus'), `live-status${L.connected ? ' ok' : ''}`);
  $('liveKeyForm').classList.toggle('hidden', !!L.connected);
  $('liveConnectBtn').classList.toggle('hidden', !!L.connected);
  $('liveDisconnectBtn').classList.toggle('hidden', !L.connected);
  if (!limitsBuilt && L.limits) {
    limitsBuilt = true;
    for (const input of $('liveLimitsForm').elements) if (input.name) input.value = L.limits[input.name];
  }
  const allowed = v.strategyStats.filter((s) => s.liveAllowed).map((s) => (v.strategies.find((x) => x.id === s.id) || {}).name || s.id);
  setText($('liveStrategies'), allowed.length ? allowed.join(', ') : 'none — tick Real money on the Strategies tab');
  setText($('liveArmState'), L.armed ? 'ARMED — strategies marked Real money are placing real orders' : L.connected ? (v.venue === 'us' ? 'Off' : 'Off — set Exchange to Polymarket US in Settings') : 'Off — connect a key first');
  setClass($('liveArmState'), `live-status${L.armed ? ' hot' : ''}`);
  $('liveArmBtn').classList.toggle('hidden', !!L.armed);
  $('liveArmBtn').disabled = !L.connected || v.venue !== 'us' || !v.running;
  $('liveDisarmBtn').classList.toggle('hidden', !L.armed);
  const a = L.account;
  setText($('liveCash'), a && a.cash != null ? usd(a.cash) : '—');
  setText($('liveBp'), a && a.buyingPower != null ? usd(a.buyingPower) : '—');
  setText($('liveOpenUsd'), L.connected || L.openUsd ? usd(L.openUsd) : '—');
  setText($('liveDayPnl'), L.stats && L.stats.trades ? signed(L.dayPnl) : '—');
  setClass($('liveDayPnl'), cls(L.dayPnl));
  setText($('liveTrades'), L.stats && L.stats.trades ? `${L.stats.trades} · ${pct(L.stats.winRate)} · ${signed(L.stats.pnl)} all time` : '0');
  setText($('liveOrders'), L.connected ? String(L.ordersToday) : '—');
  const ex = a && a.positions ? a.positions : [];
  setText($('liveExchangePositions'), !L.connected ? '—' : ex.length ? ex.map((p) => `${p.title}: ${p.net > 0 ? '+' : ''}${p.net}`).join('  ·  ') : 'none');
}

function renderWebhook(v) {
  if (activeTab !== 'settings') return;
  const n = v.notify || {};
  const text = n.enabled
    ? `On · ${n.where} · ${n.sent} sent${n.waiting ? ` · ${n.waiting} waiting` : ''}${n.dropped ? ` · ${n.dropped} dropped` : ''}${n.lastError ? ` · last problem: ${n.lastError}` : ''}`
    : n.lastError ? `Off · ${n.lastError}` : 'Off';
  setText($('hookStatus'), text);
  setClass($('hookStatus'), `live-status${n.enabled ? (n.lastError ? '' : ' ok') : ''}`);
  $('hookTest').disabled = !n.enabled;
  $('hookRemove').classList.toggle('hidden', !n.enabled);

  const d = v.discord || {};
  const state = !d.configured
    ? (d.lastError ? `Off · ${d.lastError}` : 'Off')
    : `${d.connected ? 'Connected' : 'Connecting…'} as ${d.botName || 'bot'} · ${d.cards} position card${d.cards === 1 ? '' : 's'}${d.lastError ? ` · last problem: ${d.lastError}` : ''}`;
  setText($('botStatus'), state);
  setClass($('botStatus'), `live-status${d.configured && d.connected && !d.lastError ? ' ok' : ''}`);
  $('botForm').classList.toggle('hidden', !!d.configured);
  $('botSave').classList.toggle('hidden', !!d.configured);
  $('botTest').disabled = !d.configured;
  $('botRemove').classList.toggle('hidden', !d.configured);
  $('botInvite').classList.toggle('hidden', !d.inviteUrl);
  $('botInvite').dataset.url = d.inviteUrl || '';
}

function buildSettings(v) {
  settingsBuilt = true;
  const f = $('settingsForm');
  for (const input of f.elements) {
    if (!input.name) continue;
    const val = v.settings[input.name];
    if (input.type === 'checkbox') input.checked = !!val;
    else if (val != null) input.value = val;
  }
  $('resetCash').value = v.startingCash;
}

function renderUpdate(u) {
  if (!u) return;
  $('updateText').textContent = u.message || '';
  const b = $('updateBadge');
  if (u.status === 'ready') { b.textContent = `⬆ ${u.message}`; b.classList.remove('hidden'); }
  else if (u.status === 'downloading') { b.textContent = u.message; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function flash(node, text, ms = 2500) {
  node.textContent = text;
  clearTimeout(node.__flash);
  node.__flash = setTimeout(() => { node.textContent = ''; }, ms);
}

// ---------------------------------------------------------------- events
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  activeTab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${activeTab}`));
  dirty.trades = dirty.log = dirty.strategies = true;
  schedule();
}));

$('toggleBtn').addEventListener('click', () => (view && view.running ? bot.stop() : bot.start()));
$('marketTitle').addEventListener('click', (e) => { e.preventDefault(); if (e.target.dataset.url) bot.openUrl(e.target.dataset.url); });
$('exportBtn').addEventListener('click', async () => { await bot.exportCsv(); });

// manual close
$('positionsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-close]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.live && !confirm('Sell this REAL position on Polymarket US now, at the current bid?')) return;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.textContent = 'Closing…';
  const r = await bot.closePosition(btn.dataset.close);
  delete btn.dataset.busy;
  if (r && r.ok) {
    flash($('closeMsg'), r.partial
      ? `Partly closed: sold ${r.trade.shares.toFixed(2)} shares at ${c3(r.trade.exitPrice)} (${signed(r.trade.pnl)}). The book was too thin for the rest.`
      : `Closed at ${c3(r.trade.exitPrice)} for ${signed(r.trade.pnl)}.`, 5000);
  } else flash($('closeMsg'), (r && r.error) || 'Could not close the position.', 6000);
  schedule();
});
$('closeAllBtn').addEventListener('click', async () => {
  const n = view ? view.positions.filter((p) => p.canClose).length : 0;
  const real = view ? view.positions.filter((p) => p.canClose && p.live).length : 0;
  if (!n || !confirm(`Close ${n} open position${n === 1 ? '' : 's'} at the current bid?${real ? `\n\n${real} of them ${real === 1 ? 'is a REAL position' : 'are REAL positions'} on Polymarket US and will be sold for real.` : ''}`)) return;
  const r = await bot.closeAllPositions();
  flash($('closeMsg'), `Closed ${r.closed} position${r.closed === 1 ? '' : 's'}${r.failed ? `; ${r.failed} could not be closed (window ended or no bids)` : ''}.`, 5000);
});

// strategies
$('strategyList').addEventListener('change', async (e) => {
  const rcb = e.target.closest('input[data-live]');
  if (rcb) {
    const name = (view.strategies.find((s) => s.id === rcb.dataset.live) || {}).name || rcb.dataset.live;
    if (rcb.checked && !confirm(`Allow "${name}" to trade REAL money?\n\nWhile live trading is armed it will place real orders on your Polymarket US account, within your limits. Its paper results so far do not show that it is profitable.`)) { rcb.checked = false; return; }
    rcb.dataset.busy = '1';
    await bot.setStrategyLive(rcb.dataset.live, rcb.checked);
    delete rcb.dataset.busy;
    return;
  }
  const cb = e.target.closest('input[data-toggle]');
  if (!cb) return;
  cb.dataset.busy = '1';
  await bot.setStrategyEnabled(cb.dataset.toggle, cb.checked);
  delete cb.dataset.busy;
});
$('strategyList').addEventListener('input', (e) => {
  if (e.target.matches('form[data-form] input')) e.target.dataset.dirty = '1';
});
$('strategyList').addEventListener('click', async (e) => {
  const apply = e.target.closest('button[data-apply]');
  const defaults = e.target.closest('button[data-defaults]');
  if (!apply && !defaults) return;
  const id = (apply || defaults).dataset.apply || defaults.dataset.defaults;
  const form = document.querySelector(`form[data-form="${id}"]`);
  const schema = view.strategies.find((s) => s.id === id);
  const params = defaults
    ? Object.fromEntries(schema.params.map((p) => [p.key, p.default]))
    : Object.fromEntries(new FormData(form).entries());
  for (const input of form.elements) delete input.dataset.dirty;
  await bot.setStrategyParams(id, params);
  flash((apply || defaults).parentElement.querySelector('.saved'), defaults ? 'Defaults restored ✓' : 'Applied ✓');
});
$('strategyList').addEventListener('submit', (e) => e.preventDefault());

// live account
$('liveConnectBtn').addEventListener('click', async () => {
  const keyId = $('liveKeyId').value.trim();
  const secret = $('liveSecret').value.trim();
  if (!keyId || !secret) { flash($('liveConnectMsg'), 'Enter both the Key ID and the Secret key.', 4000); return; }
  $('liveConnectBtn').disabled = true;
  setText($('liveConnectMsg'), 'Connecting…');
  const r = await bot.liveConnect(keyId, secret);
  $('liveConnectBtn').disabled = false;
  $('liveSecret').value = '';
  if (r && r.ok) { $('liveKeyId').value = ''; flash($('liveConnectMsg'), r.remembered ? 'Connected ✓ (key saved encrypted on this PC)' : 'Connected ✓ (could not save the key securely, so you will need to enter it again next time)', 7000); }
  else flash($('liveConnectMsg'), (r && r.error) || 'Could not connect.', 9000);
  settingsBuilt = false;
  schedule();
});
$('liveDisconnectBtn').addEventListener('click', async () => {
  if (!confirm('Disconnect and delete the saved key from this PC? Live trading will stop. Open positions stay on your account.')) return;
  await bot.liveDisconnect();
  schedule();
});
$('liveLimitsBtn').addEventListener('click', async () => {
  const patch = Object.fromEntries([...new FormData($('liveLimitsForm')).entries()].map(([k, val]) => [k, Number(val)]));
  await bot.liveLimits(patch);
  limitsBuilt = false;
  flash($('liveLimitsMsg'), 'Saved ✓');
});
$('liveArmBtn').addEventListener('click', async () => {
  const L = view.live;
  const names = view.strategyStats.filter((s) => s.liveAllowed && s.enabled).map((s) => (view.strategies.find((x) => x.id === s.id) || {}).name);
  const who = names.length ? names.join(', ') : 'none yet (tick Real money on a strategy)';
  if (!confirm(`Arm live trading with REAL money?\n\nStrategies that will trade: ${who}\nMost per order: ${usd(L.limits.maxOrderUsd)}\nMost in open positions: ${usd(L.limits.maxOpenUsd)}\nSwitches off after losing: ${usd(L.limits.maxDailyLossUsd)} in a day\n\nYou can stop at any moment with the red STOP button at the top.`)) return;
  const r = await bot.liveArm();
  if (r && r.error) alert(r.error);
  schedule();
});
$('liveDisarmBtn').addEventListener('click', async () => { await bot.liveDisarm(); schedule(); });
$('killBtn').addEventListener('click', async () => { await bot.liveKill(); schedule(); });

// discord webhook
$('hookSave').addEventListener('click', async () => {
  const url = $('hookUrl').value.trim();
  if (!url) { flash($('hookMsg'), 'Paste the webhook address first.', 4000); return; }
  const r = await bot.setWebhook(url);
  if (r && r.ok) { $('hookUrl').value = ''; flash($('hookMsg'), r.remembered ? 'Saved ✓' : 'On for now (could not be stored securely, so it will need entering again next time)', 6000); }
  else flash($('hookMsg'), (r && r.error) || 'Could not save.', 8000);
  schedule();
});
$('hookTest').addEventListener('click', async () => {
  setText($('hookMsg'), 'Sending…');
  const r = await bot.testWebhook();
  flash($('hookMsg'), r && r.ok ? 'Test message sent ✓ — check the channel' : (r && r.error) || 'Could not send.', 7000);
  schedule();
});
$('hookRemove').addEventListener('click', async () => {
  if (!confirm('Stop sending trade activity to Discord and delete the saved webhook address?')) return;
  await bot.setWebhook('');
  flash($('hookMsg'), 'Removed');
  schedule();
});

// discord bot
$('botSave').addEventListener('click', async () => {
  const cfg = { token: $('botToken').value.trim(), userId: $('botUser').value.trim(), channelId: $('botChannel').value.trim() };
  if (!cfg.token || !cfg.userId) { flash($('botMsg'), 'Enter the bot token and your Discord user ID.', 5000); return; }
  $('botSave').disabled = true;
  setText($('botMsg'), 'Connecting…');
  const r = await bot.setDiscordBot(cfg);
  $('botSave').disabled = false;
  $('botToken').value = '';
  if (r && r.ok) {
    flash($('botMsg'), r.channelOk
      ? `Connected as ${r.botName} ✓ — press Send test message`
      : `Token accepted (${r.botName}), but the bot can't see the channel yet. Press "Invite bot to your server", then Send test message.`, 12000);
  } else flash($('botMsg'), (r && r.error) || 'Could not connect the bot.', 10000);
  schedule();
});
$('botInvite').addEventListener('click', (e) => { if (e.target.dataset.url) bot.openUrl(e.target.dataset.url); });
$('botTest').addEventListener('click', async () => {
  setText($('botMsg'), 'Sending…');
  const r = await bot.testDiscordBot();
  flash($('botMsg'), r && r.ok ? 'Sent ✓ — press the button on the message in Discord to check clicks arrive' : (r && r.error) || 'Could not send.', 10000);
  schedule();
});
$('botRemove').addEventListener('click', async () => {
  if (!confirm('Disconnect the Discord bot and delete its saved token?')) return;
  await bot.removeDiscordBot();
  flash($('botMsg'), 'Removed');
  schedule();
});

// settings
$('saveSettings').addEventListener('click', async () => {
  const f = $('settingsForm');
  const patch = {};
  for (const input of f.elements) {
    if (!input.name) continue;
    patch[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  }
  await bot.updateSettings(patch);
  settingsBuilt = false;
  flash($('settingsSaved'), 'Saved ✓');
});
$('resetBtn').addEventListener('click', async () => {
  const cash = Number($('resetCash').value);
  if (confirm(`Reset the paper account to ${usd(cash)}? This clears all positions and trade history.`)) await bot.reset(cash);
});
$('dataBtn').addEventListener('click', () => bot.openDataFolder());
$('checkUpdateBtn').addEventListener('click', () => bot.checkUpdate());
$('updateBadge').addEventListener('click', () => { if (confirm('Restart now to install the update? The bot will stop and restart.')) bot.installUpdate(); });
window.addEventListener('resize', () => { dirty.spark = dirty.equity = true; schedule(); });

bot.onEngine(onUpdate);
bot.onUpdate(renderUpdate);
bot.state().then((s) => {
  view = s;
  $('version').textContent = s.version;
  renderUpdate(s.update);
  schedule();
});
setInterval(renderCountdown, 250); // keep the clock ticking between engine updates
