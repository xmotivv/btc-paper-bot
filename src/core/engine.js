'use strict';
// The paper-trading loop: pull prices → find current market → ask strategy →
// simulate fills → settle finished windows → persist → notify the UI.

const { EventEmitter } = require('events');
const pm = require('./polymarket');
const feed = require('./btcFeed');
const { PaperBroker, stats } = require('./broker');
const registry = require('./strategies');

const DEFAULT_SETTINGS = {
  windowKey: '15m',
  pollMs: 2000,
  startingCash: 1000,
  feeRate: 0.01,
  maxSlippage: 0.03,
  officialWaitSec: 600, // wait this long for Polymarket's official result before estimating
  recordTicks: true,
  strategyId: 'momentum',
};

class Engine extends EventEmitter {
  constructor({ store, fetchImpl = fetch, now = () => Date.now() } = {}) {
    super();
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    const saved = (store && store.load()) || {};
    this.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    this.strategy = registry.getStrategy(this.settings.strategyId);
    this.params = registry.sanitiseParams(this.strategy, (saved.params || {})[this.strategy.id]);
    this.allParams = saved.params || {};
    this.broker = new PaperBroker(saved.broker || {}, this.settings);
    this.equityCurve = saved.equityCurve || [];
    this.strategyState = saved.strategyState || this.strategy.initState();
    this.pendingSettle = saved.pendingSettle || {}; // slug -> {end, priceToBeat}
    this.btcHistory = [];
    this.market = null;
    this.marketCache = {};
    this.priceToBeat = {}; // slug -> price
    this.quotes = {};
    this.running = false;
    this.lastError = null;
    this.log = [];
    this._timer = null;
  }

  // ------------------------------------------------------------------ control
  start() {
    if (this.running) return;
    this.running = true;
    this._log('info', `Started (${this.strategy.name}, ${this.settings.windowKey} windows)`);
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    this._log('info', 'Stopped');
    this._persist();
    this._emit();
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this.tick();
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this._log('error', e.message);
    }
    this._emit();
    this._timer = setTimeout(() => this._loop(), this.settings.pollMs);
  }

  // --------------------------------------------------------------------- tick
  async tick() {
    const nowMs = this.now();
    const nowSec = nowMs / 1000;

    // 1) BTC price
    const price = await feed.fetchSpot(this.fetch);
    this.btcHistory.push({ t: nowMs, p: price });
    const cutoff = nowMs - 2 * 3600 * 1000;
    while (this.btcHistory.length && this.btcHistory[0].t < cutoff) this.btcHistory.shift();

    // 2) current market
    const win = pm.windowFor(nowSec, this.settings.windowKey);
    let market = this.marketCache[win.slug];
    if (!market) {
      market = await pm.fetchMarket(win, this.fetch);
      if (market) {
        this.marketCache = { [win.slug]: market };
        this._log('info', `Tracking ${market.title}`);
      }
    }
    this.market = market || null;

    // 3) price to beat for this window
    if (market && this.priceToBeat[win.slug] == null) {
      if (nowSec - win.start <= 10) this.priceToBeat[win.slug] = price;
      else {
        const open = await feed.fetchMinuteOpen(win.start, this.fetch).catch(() => null);
        if (open) this.priceToBeat[win.slug] = open;
      }
    }
    const ptb = market ? this.priceToBeat[win.slug] : null;

    // 4) order books
    const books = {};
    this.quotes = {};
    if (market) {
      await Promise.all(market.outcomes.map(async (o) => {
        books[o] = await pm.fetchBook(market.tokenByOutcome[o], this.fetch);
        this.quotes[o] = { bid: books[o].bid, ask: books[o].ask };
        this.broker.markToMarket(market.slug, o, books[o].bid);
      }));
    }

    // 5) strategy
    if (market && ptb) {
      const actions = this.strategy.onTick({
        now: nowMs,
        market,
        btc: { price, history: this.btcHistory },
        priceToBeat: ptb,
        quotes: this.quotes,
        positions: this.broker.positions,
        balance: this.broker.cash,
        p: this.params,
        state: this.strategyState,
      }) || [];
      for (const a of actions) this._execute(a, market, books, nowMs);
    }

    // remember windows that have open positions so we can settle them later
    for (const pos of this.broker.positions) {
      if (!this.pendingSettle[pos.slug]) {
        this.pendingSettle[pos.slug] = { start: pos.windowStart, end: pos.windowEnd, priceToBeat: this.priceToBeat[pos.slug] ?? null };
      }
    }

    // 6) settle finished windows
    await this._settleFinished(nowSec);

    // 7) equity curve (1 point/minute) + tick log
    const eq = this.broker.equity();
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || nowMs - last.t >= 60000) {
      this.equityCurve.push({ t: nowMs, e: eq });
      if (this.equityCurve.length > 20000) this.equityCurve.splice(0, this.equityCurve.length - 20000);
    }
    if (this.settings.recordTicks && this.store && market) {
      this.store.recordTick({ t: nowMs, slug: market.slug, btc: price, ptb, up: this.quotes.Up, down: this.quotes.Down });
    }
    this._persist();
  }

  _execute(a, market, books, nowMs) {
    if (a.type === 'buy') {
      const r = this.broker.buy({ market, outcome: a.outcome, usd: a.usd, book: books[a.outcome], reason: a.reason, strategy: this.strategy.id, now: nowMs });
      if (r.error) this._log('warn', `Buy ${a.outcome} skipped: ${r.error}`);
      else this._log('trade', `BUY ${a.outcome} ${r.shares.toFixed(2)} @ ${r.avgPrice.toFixed(3)} — ${a.reason}`);
    } else if (a.type === 'sell') {
      const pos = this.broker.positions.find((x) => x.id === a.positionId);
      if (!pos) return;
      const r = this.broker.sell({ positionId: a.positionId, book: books[pos.outcome], reason: a.reason, now: nowMs });
      if (r.error) this._log('warn', `Sell skipped: ${r.error}`);
      else this._log('trade', `SELL ${r.outcome} @ ${r.exitPrice.toFixed(3)} P&L ${r.pnl.toFixed(2)} — ${a.reason}`);
    }
  }

  async _settleFinished(nowSec) {
    for (const [slug, info] of Object.entries(this.pendingSettle)) {
      if (nowSec < info.end + 5) continue;
      if (!this.broker.positions.some((p) => p.slug === slug)) { delete this.pendingSettle[slug]; continue; }
      // official result from Polymarket (check at most every 30s)
      if (!info.lastCheck || nowSec - info.lastCheck > 30) {
        info.lastCheck = nowSec;
        const m = await pm.fetchMarket({ slug, start: info.start, end: info.end }, this.fetch).catch(() => null);
        if (m && m.resolved) {
          this._settle(slug, m.resolved, false);
          continue;
        }
      }
      // fallback: estimate from Coinbase if Polymarket is slow
      if (nowSec > info.end + this.settings.officialWaitSec) {
        const ptb = info.priceToBeat ?? await feed.fetchMinuteOpen(info.start, this.fetch).catch(() => null);
        const close = await feed.fetchMinuteClose(info.end, this.fetch).catch(() => null);
        if (ptb && close) this._settle(slug, close >= ptb ? 'Up' : 'Down', true);
      }
    }
  }

  _settle(slug, winner, estimated) {
    const closed = this.broker.settle({ slug, winner, estimated, now: this.now() });
    delete this.pendingSettle[slug];
    for (const t of closed) this._log('trade', `SETTLED ${t.outcome} (${winner} won${estimated ? ', estimated' : ''}) P&L ${t.pnl.toFixed(2)}`);
  }

  // ----------------------------------------------------------------- settings
  updateSettings(patch = {}) {
    const allowed = ['windowKey', 'pollMs', 'feeRate', 'maxSlippage', 'officialWaitSec', 'recordTicks'];
    for (const k of allowed) if (k in patch) this.settings[k] = patch[k];
    this.settings.pollMs = Math.max(1000, Number(this.settings.pollMs) || 2000);
    if (!pm.WINDOWS[this.settings.windowKey]) this.settings.windowKey = '15m';
    this.broker.feeRate = Number(this.settings.feeRate);
    this.broker.maxSlippage = Number(this.settings.maxSlippage);
    this.marketCache = {};
    this._persist();
    this._emit();
  }

  setStrategy(id, params) {
    const s = registry.getStrategy(id);
    if (s.id !== this.strategy.id) {
      this.strategy = s;
      this.strategyState = s.initState();
      this.settings.strategyId = s.id;
    }
    this.params = registry.sanitiseParams(s, params || this.allParams[s.id]);
    this.allParams[s.id] = this.params;
    this._log('info', `Strategy params updated (${s.name})`);
    this._persist();
    this._emit();
  }

  reset(startingCash) {
    const cash = Number(startingCash) > 0 ? Number(startingCash) : this.settings.startingCash;
    this.settings.startingCash = cash;
    this.broker = new PaperBroker({ cash }, this.settings);
    this.equityCurve = [];
    this.pendingSettle = {};
    this.strategyState = this.strategy.initState();
    this._log('info', `Account reset to $${cash}`);
    this._persist();
    this._emit();
  }

  // ------------------------------------------------------------------- output
  view() {
    const nowSec = this.now() / 1000;
    const m = this.market;
    return {
      running: this.running,
      lastError: this.lastError,
      settings: this.settings,
      strategies: registry.strategies.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params })),
      strategyId: this.strategy.id,
      params: this.params,
      btc: this.btcHistory.length ? this.btcHistory[this.btcHistory.length - 1].p : null,
      btcSpark: this.btcHistory.slice(-300).map((x) => x.p),
      market: m && { title: m.title, slug: m.slug, url: m.url, start: m.start, end: m.end, secondsLeft: Math.max(0, Math.round(m.end - nowSec)) },
      priceToBeat: m ? this.priceToBeat[m.slug] ?? null : null,
      quotes: this.quotes,
      cash: this.broker.cash,
      equity: this.broker.equity(),
      startingCash: this.settings.startingCash,
      positions: this.broker.positions,
      trades: this.broker.trades.slice(-200).reverse(),
      stats: stats(this.broker.trades),
      equityCurve: this.equityCurve.slice(-1440),
      log: this.log.slice(-150),
    };
  }

  tradesCsv() {
    const cols = ['closedAt', 'title', 'strategy', 'outcome', 'shares', 'entryPrice', 'exitPrice', 'cost', 'proceeds', 'fees', 'pnl', 'exitType', 'entryReason', 'exitReason'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = this.broker.trades.map((t) => cols.map((c) => esc(c === 'closedAt' ? new Date(t[c]).toISOString() : t[c])).join(','));
    return [cols.join(','), ...rows].join('\n');
  }

  _persist() {
    if (!this.store) return;
    this.store.save({
      settings: this.settings,
      params: this.allParams,
      broker: this.broker.snapshot(),
      equityCurve: this.equityCurve,
      strategyState: this.strategyState,
      pendingSettle: this.pendingSettle,
    });
  }

  _log(level, msg) {
    this.log.push({ t: this.now(), level, msg });
    if (this.log.length > 500) this.log.shift();
  }

  _emit() {
    this.emit('update', this.view());
  }
}

module.exports = { Engine, DEFAULT_SETTINGS };
