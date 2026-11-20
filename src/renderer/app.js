'use strict';
/* global bot */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const c3 = (n) => (n == null ? '—' : Number(n).toFixed(3));
const time = (t) => new Date(t).toLocaleTimeString();

let view = null;
let formsBuiltFor = null;
let settingsBuilt = false;

// ---------------------------------------------------------------- charts
function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = Number(cv.getAttribute('height'));
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function line(cv, values, color, { baseline = null, labels = false } = {}) {
  const { ctx, w, h } = sizeCanvas(cv);
  if (!values || values.length < 2) return;
  let min = Math.min(...values, baseline ?? Infinity);
  let max = Math.max(...values, baseline ?? -Infinity);
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
function render(v) {
  view = v;
  $('statusPill').textContent = v.running ? '● Running' : 'Stopped';
  $('statusPill').className = `pill ${v.running ? 'on' : 'off'}`;
  $('toggleBtn').textContent = v.running ? 'Stop' : 'Start';
  $('errorBar').classList.toggle('hidden', !v.lastError);
  $('errorBar').textContent = v.lastError ? `Last error: ${v.lastError} (retrying)` : '';

  $('btcPrice').textContent = usd(v.btc);
  line($('btcSpark'), v.btcSpark, '#f7931a', { baseline: v.priceToBeat });

  const m = v.market;
  $('marketTitle').textContent = m ? m.title : 'Waiting for market…';
  $('marketTitle').dataset.url = m ? m.url : '';
  $('ptb').textContent = usd(v.priceToBeat);
  if (v.btc && v.priceToBeat) {
    const bps = ((v.btc - v.priceToBeat) / v.priceToBeat) * 1e4;
    $('move').textContent = `${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps`;
    $('move').className = cls(bps);
  } else $('move').textContent = '—';
  $('countdown').textContent = m ? `${Math.floor(m.secondsLeft / 60)}:${String(m.secondsLeft % 60).padStart(2, '0')}` : '—';

  const q = v.quotes || {};
  $('upQ').textContent = `${c3(q.Up && q.Up.bid)} / ${c3(q.Up && q.Up.ask)}`;
  $('downQ').textContent = `${c3(q.Down && q.Down.bid)} / ${c3(q.Down && q.Down.ask)}`;

  const total = v.equity - v.startingCash;
  $('equity').textContent = usd(v.equity);
  $('cash').textContent = usd(v.cash);
  $('pnl').textContent = signed(total);
  $('pnl').className = cls(total);
  $('winrate').textContent = `${(v.stats.winRate * 100).toFixed(0)}% · ${v.stats.trades}`;
  $('pf').textContent = `${v.stats.profitFactor === Infinity ? '∞' : v.stats.profitFactor} · ${usd(v.stats.fees)}`;

  const eq = v.equityCurve.map((p) => p.e);
  line($('equityChart'), eq, total >= 0 ? '#2ecc71' : '#ff5c5c', { baseline: v.startingCash, labels: true });
  $('equityRange').textContent = v.equityCurve.length ? `since ${new Date(v.equityCurve[0].t).toLocaleString()}` : 'builds one point per minute';

  // positions
  $('positionsBody').innerHTML = v.positions.map((p) => {
    const u = p.shares * (p.mark ?? p.avgPrice) - p.cost;
    return `<tr><td>${esc(p.title)}</td><td class="${p.outcome === 'Up' ? 'pos' : 'neg'}">${esc(p.outcome)}</td><td>${p.shares.toFixed(2)}</td><td>${c3(p.avgPrice)}</td><td>${c3(p.mark)}</td><td class="${cls(u)}">${signed(u)}</td><td class="reason">${esc(p.reason)}</td></tr>`;
  }).join('');
  $('positionsEmpty').classList.toggle('hidden', v.positions.length > 0);

  // trades
  $('tradesBody').innerHTML = v.trades.map((t) => `<tr><td>${new Date(t.closedAt).toLocaleString()}</td><td>${esc(t.title)}</td><td class="${t.outcome === 'Up' ? 'pos' : 'neg'}">${esc(t.outcome)}</td><td>${c3(t.entryPrice)}</td><td>${c3(t.exitPrice)}</td><td class="${cls(t.pnl)}">${signed(t.pnl)}</td><td>${esc(t.exitType)}</td><td class="reason">${esc(t.entryReason)}</td></tr>`).join('');
  $('tradesEmpty').classList.toggle('hidden', v.trades.length > 0);

  // log
  const lg = $('logList');
  const atBottom = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 10;
  lg.innerHTML = v.log.map((l) => `<div class="${esc(l.level)}">${time(l.t)} ${esc(l.level.toUpperCase())} ${esc(l.msg)}</div>`).join('');
  if (atBottom) lg.scrollTop = lg.scrollHeight;

  if (formsBuiltFor !== v.strategyId) buildStrategyForm(v);
  if (!settingsBuilt) buildSettings(v);
}

function buildStrategyForm(v) {
  formsBuiltFor = v.strategyId;
  const sel = $('strategySelect');
  sel.innerHTML = v.strategies.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = v.strategyId;
  const s = v.strategies.find((x) => x.id === v.strategyId);
  $('strategyDesc').textContent = s.description;
  $('paramsForm').innerHTML = s.params.map((p) => `<label>${esc(p.label)}<input name="${esc(p.key)}" type="number" step="${p.step ?? 'any'}" min="${p.min ?? ''}" max="${p.max ?? ''}" value="${esc(v.params[p.key])}" /></label>`).join('');
}

function buildSettings(v) {
  settingsBuilt = true;
  const f = $('settingsForm');
  for (const el of f.elements) {
    if (!el.name) continue;
    const val = v.settings[el.name];
    if (el.type === 'checkbox') el.checked = !!val;
    else if (val != null) el.value = val;
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

function flash(id, text) {
  $(id).textContent = text;
  setTimeout(() => { $(id).textContent = ''; }, 2500);
}

// ---------------------------------------------------------------- events
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
  if (view) render(view);
}));

$('toggleBtn').addEventListener('click', () => (view && view.running ? bot.stop() : bot.start()));
$('marketTitle').addEventListener('click', (e) => { e.preventDefault(); if (e.target.dataset.url) bot.openUrl(e.target.dataset.url); });
$('exportBtn').addEventListener('click', async () => { await bot.exportCsv(); });
$('strategySelect').addEventListener('change', async (e) => { formsBuiltFor = null; await bot.setStrategy(e.target.value); });
$('saveParams').addEventListener('click', async () => {
  const params = Object.fromEntries(new FormData($('paramsForm')).entries());
  await bot.setStrategy($('strategySelect').value, params);
  formsBuiltFor = null;
  flash('paramsSaved', 'Applied ✓');
});
$('saveSettings').addEventListener('click', async () => {
  const f = $('settingsForm');
  const patch = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  await bot.updateSettings(patch);
  settingsBuilt = false;
  flash('settingsSaved', 'Saved ✓');
});
$('resetBtn').addEventListener('click', async () => {
  const cash = Number($('resetCash').value);
  if (confirm(`Reset the paper account to ${usd(cash)}? This clears all positions and trade history.`)) await bot.reset(cash);
});
$('dataBtn').addEventListener('click', () => bot.openDataFolder());
$('checkUpdateBtn').addEventListener('click', () => bot.checkUpdate());
$('updateBadge').addEventListener('click', () => { if (confirm('Restart now to install the update? The bot will stop and restart.')) bot.installUpdate(); });
window.addEventListener('resize', () => view && render(view));

bot.onEngine(render);
bot.onUpdate(renderUpdate);
bot.state().then((s) => { $('version').textContent = s.version; render(s); renderUpdate(s.update); });
setInterval(() => { // keep countdown ticking between engine updates
  if (view && view.market && view.market.secondsLeft > 0) { view.market.secondsLeft -= 1; $('countdown').textContent = `${Math.floor(view.market.secondsLeft / 60)}:${String(view.market.secondsLeft % 60).padStart(2, '0')}`; }
}, 1000);
