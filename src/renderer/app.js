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

  if (!strategiesBuilt) buildStrategies(v);
  if (!settingsBuilt) buildSettings(v);
  if (activeTab === 'positions') renderPositions(v);
  else if (activeTab === 'trades') renderTrades(v);
  else if (activeTab === 'strategy') renderStrategies(v);
  else if (activeTab === 'log') renderLog(v);
}

function renderHeader(v) {
  setText($('statusPill'), v.running ? '● Running' : 'Stopped');
  setClass($('statusPill'), `pill ${v.running ? 'on' : 'off'}`);
  setText($('toggleBtn'), v.running ? 'Stop' : 'Start');
  const f = v.feeds || {};
  const streaming = f.btc === 'stream' && f.books === 'stream';
  const fp = $('feedPill');
  if (!v.running) { setText(fp, 'Feeds idle'); setClass(fp, 'pill off'); }
  else if (streaming) { setText(fp, '⚡ Live stream'); setClass(fp, 'pill on'); }
  else if (v.settings.streaming) { setText(fp, 'Connecting… (polling)'); setClass(fp, 'pill warn'); }
  else { setText(fp, 'Polling'); setClass(fp, 'pill warn'); }
  $('errorBar').classList.toggle('hidden', !v.lastError);
  setText($('errorBar'), v.lastError ? `Last error: ${v.lastError} (retrying)` : '');
}

function renderCards(v) {
  setText($('btcPrice'), usd(v.btc));
  setText($('clPrice'), v.chainlink ? usd(v.chainlink) : v.running ? 'connecting…' : '—');

  const m = v.market;
  setText($('marketTitle'), m ? m.title : 'Waiting for market…');
  $('marketTitle').dataset.url = m ? m.url : '';
  setText($('ptb'), usd(v.priceToBeat));
  setText($('ptbSource'), { chainlink: '(Chainlink)', coinbase: '(estimate)' }[v.ptbSource] || '');
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
      const btn = el('button', 'btn small danger', 'Close');
      btn.dataset.close = p.id;
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
      row.btn.title = p.canClose ? 'Sell this position into the live bids now' : 'The window has ended; this settles automatically';
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
    head.append(sw, el('div', 'strategy-name', s.name), stats);

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

    card.append(head, el('p', 'muted', s.description), details);
    list.append(card);
  }
}

function renderStrategies(v) {
  for (const st of v.strategyStats) {
    const card = document.querySelector(`.strategy[data-id="${st.id}"]`);
    if (!card) continue;
    setClass(card, `strategy${st.enabled ? ' on' : ''}`);
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
  if (!n || !confirm(`Close ${n} open position${n === 1 ? '' : 's'} at the current bid?`)) return;
  const r = await bot.closeAllPositions();
  flash($('closeMsg'), `Closed ${r.closed} position${r.closed === 1 ? '' : 's'}${r.failed ? `; ${r.failed} could not be closed (window ended or no bids)` : ''}.`, 5000);
});

// strategies
$('strategyList').addEventListener('change', async (e) => {
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
