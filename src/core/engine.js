'use strict';
// The paper-trading engine.
//
// Fast path (event driven): BTC prices and Polymarket order books arrive over
// WebSockets; every update re-runs all enabled strategies against the live
// books, so the bot reacts in milliseconds rather than on a polling interval.
//
// Slow path (tick, about once a second): finds the current market, records the
// price to beat, settles finished windows, logs, saves — and polls REST for any
// feed whose stream is down, so the bot keeps working without WebSockets.

const { EventEmitter } = require('events');
const pm = require('./polymarket');
const feed = require('./btcFeed');
const model = require('./model');
const { PaperBroker, stats, statsByStrategy } = require('./broker');
const registry = require('./strategies');
const { BtcStream, BookStream, ChainlinkStream } = require('./streams');

const DEFAULT_SETTINGS = {
  windowKey: '15m',
  pollMs: 1000, // housekeeping tick; also the REST polling rate when a stream is down
  evalMs: 50, // minimum gap between strategy runs on streamed data
  streaming: true, // use WebSocket feeds (falls back to polling automatically)
  startingCash: 1000,
  feeModel: 'market', // 'market' = Polymarket's published fee curve, 'flat' = feeRate × notional
  feeRate: 0.01,
  maxSlippage: 0.03,
  officialWaitSec: 600, // wait this long for Polymarket's official result before estimating
  recordTicks: true,
  activeStrategies: ['momentum'],
};

const UI_MS = 200; // at most 5 UI updates a second
const HISTORY_GAP_MS = 250; // BTC history resolution
const HISTORY_MAX = 9000; // ≈ 37 minutes at that resolution
const STREAM_GRACE_MS = 5000; // how long to wait for a (re)connecting book stream before trading on REST snapshots
const EMPTY_STATS = stats([]);

class Engine extends EventEmitter {
  constructor({ store, fetchImpl = fetch, now = () => Date.now(), WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.WS = WebSocketImpl || null;
    const saved = (store && store.load()) || {};
    const savedSettings = saved.settings || {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };

    // Saves from the single-strategy version carry `strategyId` instead of a list.
    const legacyId = savedSettings.strategyId;
    if (!Array.isArray(savedSettings.activeStrategies)) this.settings.activeStrategies = [legacyId || 'momentum'];
    delete this.settings.strategyId;
    this.settings.activeStrategies = [...new Set(this.settings.activeStrategies)].filter(registry.hasStrategy);

    this.params = {};
    this.strategyState = {};
    const savedState = saved.strategyState || {};
    const legacyState = 'entries' in savedState && !registry.strategies.some((s) => s.id in savedState);
    for (const s of registry.strategies) {
      this.params[s.id] = registry.sanitiseParams(s, (saved.params || {})[s.id]);
      if (legacyState) this.strategyState[s.id] = s.id === (legacyId || 'momentum') ? savedState : s.initState();
      else this.strategyState[s.id] = savedState[s.id] || s.initState();
    }
    this._refreshActive();

    this.broker = new PaperBroker(saved.broker || {}, this.settings);
    this.equityCurve = saved.equityCurve || [];
    this.pendingSettle = saved.pendingSettle || {}; // slug -> {start, end, priceToBeat}

    this.btcPrice = null;
    this.btcHistory = []; // [{t, p}] oldest→newest, one sample per HISTORY_GAP_MS
    this.spark = [];
    this.vol = null; // realised volatility, fraction per √second
    this.volSeed = null;
    this.basis = 0; // settlement feed minus Coinbase, smoothed
    this.market = null;
    this.marketCache = {};
    this.priceToBeat = {}; // slug -> price
    this.ptbSource = {}; // slug -> 'chainlink' (exact) | 'coinbase' (estimate)
    this.restBooks = null; // { slug, books } from the last REST poll
    this.quotes = {};
    this.manualHold = new Set(); // `${strategyId}|${slug}`: no re-entry after a manual close
    this.running = false;
    this.lastError = null;
    this.log = [];
    this.rev = { log: 0, equity: 0, spark: 0, strategies: 0 };
    this._sent = {};
    this._statsCache = { rev: -1 };
    this._warned = new Map();
    this._timer = null;
    this._evalTimer = null;
    this._emitTimer = null;
    this._lastEval = 0;
    this._lastEmit = 0;
    this._sparkAt = 0;
    this._volSeedAt = 0;
    this.evalCount = 0;
    this.btcStream = null;
    this.bookStream = null;
    this.chainlink = null;
  }

  // ------------------------------------------------------------------ control
  start() {
    if (this.running) return;
    this.running = true;
    const names = this._active.map((s) => s.name).join(', ') || 'no strategies enabled';
    this._log('info', `Started (${names}; ${this.settings.windowKey} windows)`);
    this._startStreams();
    this._loop();
  }

  stop() {
    if (!this.running && !this._timer) return;
    this.running = false;
    clearTimeout(this._timer);
    clearTimeout(this._evalTimer);
    this._timer = this._evalTimer = null;
    this._stopStreams();
    this._log('info', 'Stopped');
    this._persist(true);
    this._emit();
  }

  async _loop() {
    if (!this.running) return;
    try {
      await this.tick();
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
      this._warn('tick', 'error', e.message);
    }
    if (!this.running) return;
    this._requestEmit();
    // Wake exactly at the next window boundary so the new market is picked up at once.
    const nowMs = this.now();
    const w = pm.WINDOWS[this.settings.windowKey].seconds * 1000;
    const toBoundary = w - (nowMs % w) + 25;
    this._timer = setTimeout(() => this._loop(), Math.max(50, Math.min(this.settings.pollMs, toBoundary)));
  }

  // ------------------------------------------------------------------ streams
  _startStreams() {
    if (!this.settings.streaming || !this.WS || this.btcStream) return;
    this.btcStream = new BtcStream({ WebSocketImpl: this.WS });
    this.btcStream.on('price', (p) => { this._onPrice(p, this.now()); this._requestEval(); });
    this.bookStream = new BookStream({ WebSocketImpl: this.WS });
    this.bookStream.on('change', (slug) => { if (this.market && slug === this.market.slug) this._requestEval(); });
    this.chainlink = new ChainlinkStream({ WebSocketImpl: this.WS });
    this.chainlink.on('price', (p, sec) => this._onChainlink(p, sec));
    this.btcStream.start();
    this.chainlink.start();
    if (this.market) this.bookStream.track(this.market.slug, this.market.tokenByOutcome);
  }

  _stopStreams() {
    for (const s of [this.btcStream, this.bookStream, this.chainlink]) {
      if (!s) continue;
      s.stop();
      s.removeAllListeners();
    }
    this.btcStream = this.bookStream = this.chainlink = null;
    this.basis = 0;
  }

  _onPrice(price, tMs) {
    this.btcPrice = price;
    const h = this.btcHistory;
    const last = h[h.length - 1];
    if (!last || tMs - last.t >= HISTORY_GAP_MS) {
      h.push({ t: tMs, p: price });
      if (h.length > HISTORY_MAX) h.splice(0, HISTORY_MAX / 5);
    }
    if (tMs - this._sparkAt >= 2000) {
      this._sparkAt = tMs;
      this.spark.push(price);
      if (this.spark.length > 300) this.spark.shift();
      this.rev.spark++;
    }
  }

  /** Track how far the settlement feed sits from Coinbase so the model compares like with like. */
  _onChainlink(price, sec) {
    const cb = model.priceAt(this.btcHistory, sec * 1000);
    if (cb == null) return;
    const d = price - cb;
    this.basis = this._basisSet ? this.basis + 0.1 * (d - this.basis) : d;
    this._basisSet = true;
  }

  _requestEval() {
    if (this._evalTimer || !this.running) return;
    const run = () => {
      this._evalTimer = null;
      this._lastEval = Date.now();
      try {
        this._evaluate(this.now());
      } catch (e) {
        this._warn('eval', 'error', e.message);
      }
      this._requestEmit();
    };
    this._evalTimer = setTimeout(run, Math.max(0, this._lastEval + this.settings.evalMs - Date.now()));
  }

  _requestEmit() {
    if (this._emitTimer) return;
    const wait = Math.max(0, this._lastEmit + UI_MS - Date.now());
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this._emit();
    }, wait);
  }

  // --------------------------------------------------------------------- tick
  async tick() {
    const nowMs = this.now();
    const nowSec = nowMs / 1000;
    const win = pm.windowFor(nowSec, this.settings.windowKey);
    const errors = [];
    const guard = (promise) => promise.catch((e) => { errors.push(e); });

    // 1) refresh whatever the streams aren't delivering, all in parallel
    const jobs = [];
    if (!(this.btcStream && this.btcStream.live)) jobs.push(guard(this._pollSpot()));
    let market = this.marketCache[win.slug];
    if (!market) jobs.push(guard(this._loadMarket(win)));
    else if (!this._streamBooks(market)) jobs.push(guard(this._pollBooks(market)));
    if (jobs.length) await Promise.all(jobs);
    if (!market) {
      market = this.marketCache[win.slug] || null;
      if (market && !this._streamBooks(market)) await guard(this._pollBooks(market));
    }

    // 2) window rollover
    this._setMarket(market);
    for (const slug of Object.keys(this.marketCache)) if (this.marketCache[slug].end <= win.start) delete this.marketCache[slug];
    if (this.bookStream) {
      if (market) this.bookStream.track(market.slug, market.tokenByOutcome);
      this._prefetchNext(win, nowSec);
      this.bookStream.keep(Object.keys(this.marketCache));
    }
    if (this.chainlink && !this.chainlink.live) this.basis = 0;

    // 3) price to beat for this window
    if (market && this._needsPriceToBeat(win)) await guard(this._resolvePriceToBeat(win, nowSec));
    if (market && this.ptbSource[win.slug] === 'coinbase' && this._estimateNoted !== win.slug) {
      this._estimateNoted = win.slug;
      this._log('warn', 'Price to beat for this window is an estimate (no Chainlink history for its opening). Model-based strategies sit this window out.');
    }

    // 4) volatility estimate for the models
    this.vol = model.realisedVol(this.btcHistory, nowMs) ?? this.volSeed;
    if (this.volSeed == null && nowMs - this._volSeedAt > 60000) {
      this._volSeedAt = nowMs;
      feed.fetchRecentCloses(20, this.fetch)
        .then((closes) => { this.volSeed = model.volFromCloses(closes, 60); this.vol ??= this.volSeed; })
        .catch(() => {});
    }

    // 5) strategies
    this._evaluate(nowMs);

    // 6) settle finished windows
    await guard(this._settleFinished(nowSec));
    for (const slug of Object.keys(this.priceToBeat)) {
      if (slug === win.slug || this.pendingSettle[slug]) continue;
      delete this.priceToBeat[slug];
      delete this.ptbSource[slug];
    }

    // 7) equity curve (1 point/minute) + tick log
    const eq = this.broker.equity();
    const last = this.equityCurve[this.equityCurve.length - 1];
    if (!last || nowMs - last.t >= 60000) {
      this.equityCurve.push({ t: nowMs, e: eq });
      if (this.equityCurve.length > 20000) this.equityCurve.splice(0, this.equityCurve.length - 20000);
      this.rev.equity++;
    }
    if (this.settings.recordTicks && this.store && market && this.btcPrice) {
      const slug = market.slug;
      this.store.recordTick({
        t: nowMs, slug, btc: this.btcPrice, ptb: this.priceToBeat[slug] ?? null, up: this.quotes.Up, down: this.quotes.Down,
        cl: this.chainlink && this.chainlink.live ? this.chainlink.price : undefined,
      });
    }
    this._persist();
    if (errors.length) throw errors[0];
  }

  _setMarket(market) {
    if (market === this.market) return;
    this.market = market;
    this.quotes = {};
    if (market) this._log('info', `Tracking ${market.title}`);
  }

  async _pollSpot() {
    const price = await feed.fetchSpot(this.fetch);
    this._onPrice(price, this.now());
  }

  async _loadMarket(win) {
    const market = await pm.fetchMarket(win, this.fetch);
    if (market) this.marketCache[win.slug] = market;
    return market;
  }

  async _pollBooks(market) {
    const books = {};
    await Promise.all(market.outcomes.map(async (o) => {
      books[o] = await pm.fetchBook(market.tokenByOutcome[o], this.fetch);
    }));
    this.restBooks = { slug: market.slug, books };
  }

  /** Load the next window's market shortly before it opens so its books are already streaming at the boundary. */
  _prefetchNext(win, nowSec) {
    if (win.end - nowSec > 30 || this._prefetching) return;
    const next = pm.windowFor(win.end + 1, this.settings.windowKey);
    const cached = this.marketCache[next.slug];
    if (cached) { this.bookStream.track(next.slug, cached.tokenByOutcome); return; }
    this._prefetching = true;
    this._loadMarket(next).catch(() => {}).finally(() => { this._prefetching = false; });
  }

  _streamBooks(market) {
    return this.bookStream ? this.bookStream.books(market.slug) : null;
  }

  /** Books to trade against: the live stream, or REST snapshots once the stream has been down a while. */
  _booksFor(market) {
    const live = this._streamBooks(market);
    if (live) return live;
    if (this.bookStream && this.bookStream.connecting(market.slug, STREAM_GRACE_MS)) return null;
    return this.restBooks && this.restBooks.slug === market.slug ? this.restBooks.books : null;
  }

  /**
   * The price to beat is the settlement feed's reading as the window opens. On
   * TWAP markets (all BTC Up/Down windows today) that reading is itself the
   * average of the previous `twapSec` seconds, so a window's price to beat is
   * the number the window before it settled on. Taken from the Chainlink feed
   * it is exact; without that feed it is estimated from Coinbase.
   */
  async _resolvePriceToBeat(win, nowSec) {
    const set = (price, source) => { this.priceToBeat[win.slug] = price; this.ptbSource[win.slug] = source; };
    const market = this.marketCache[win.slug];
    const L = market ? market.twapSec || 0 : 0;
    const exact = this._chainlinkAt(win.start, L);
    if (exact != null) return set(exact, 'chainlink');
    if (this.priceToBeat[win.slug] != null) return undefined; // keep the estimate we already have
    // The reading for the opening second lands about a second later; give it a moment.
    if (this.chainlink && this.chainlink.live && nowSec - win.start < 4) return undefined;

    let estimate = null;
    const fromMs = (win.start - L) * 1000;
    if (this.btcHistory.length && this.btcHistory[0].t <= fromMs) {
      // our own Coinbase history covers the opening: average it the same way
      let sum = 0;
      let n = 0;
      for (let t = win.start - L + (L ? 1 : 0); t <= win.start; t++) {
        const p = model.priceAt(this.btcHistory, t * 1000);
        if (p != null) { sum += p; n++; }
      }
      if (n) estimate = sum / n;
    }
    if (estimate == null) {
      estimate = L > 0
        ? await feed.fetchMinuteAverage(win.start - 60, this.fetch).catch(() => null)
        : await feed.fetchMinuteOpen(win.start, this.fetch).catch(() => null);
    }
    if (estimate) set(estimate + this.basis, 'coinbase');
    return undefined;
  }

  /** The settlement feed's value at `sec`: a single reading, or the mean of the `twapSec` readings ending there. */
  _chainlinkAt(sec, twapSec) {
    const cl = this.chainlink;
    if (!cl || cl.lastSec < sec) return null;
    if (!twapSec) return cl.samples.get(sec) ?? null;
    const m = cl.mean(sec - twapSec, sec);
    return m.count >= twapSec * 0.9 ? m.mean : null;
  }

  /** A Coinbase-based price to beat is an estimate; replace it as soon as the real one can be computed. */
  _needsPriceToBeat(win) {
    if (this.priceToBeat[win.slug] == null) return true;
    if (this.ptbSource[win.slug] !== 'coinbase') return false;
    const market = this.marketCache[win.slug];
    return this._chainlinkAt(win.start, market ? market.twapSec || 0 : 0) != null;
  }

  _settleInfo(market, nowSec) {
    const L = market.twapSec || 0;
    const live = !!(this.chainlink && this.chainlink.live);
    const info = {
      source: live ? 'chainlink' : 'coinbase',
      strikeExact: this.ptbSource[market.slug] === 'chainlink',
      basis: this.basis,
      twapSec: L,
      realisedMean: null,
      realisedSec: 0,
    };
    const from = market.end - L;
    if (L > 0 && nowSec > from) {
      if (live) {
        const m = this.chainlink.mean(from, nowSec);
        if (m.count) { info.realisedMean = m.mean; info.realisedSec = m.count; }
      } else {
        let sum = 0;
        let n = 0;
        for (let t = Math.floor(from) + 1; t <= nowSec; t++) {
          const p = model.priceAt(this.btcHistory, t * 1000);
          if (p != null) { sum += p; n++; }
        }
        if (n) { info.realisedMean = sum / n; info.realisedSec = n; }
      }
    }
    return info;
  }

  // --------------------------------------------------------------- strategies
  /** Run every enabled strategy once against the current books. Synchronous and cheap. */
  _evaluate(nowMs) {
    // The next window's market is loaded ahead of time: move to it the moment this one ends.
    if (this.market && nowMs >= this.market.end * 1000) {
      const next = this.marketCache[pm.windowFor(nowMs / 1000, this.settings.windowKey).slug];
      if (next) this._setMarket(next);
    }
    const market = this.market;
    if (!market) return;
    const books = this._booksFor(market);
    if (!books) return;
    const quotes = {};
    for (const o of market.outcomes) {
      const b = books[o];
      if (!b) return;
      quotes[o] = { bid: b.bid, ask: b.ask };
      this.broker.markToMarket(market.slug, o, b.bid);
    }
    this.quotes = quotes;
    const nowSec = nowMs / 1000;
    if (!this.btcPrice || nowSec >= market.end || nowSec < market.start || !this._active.length) return;
    this.evalCount++;
    const broker = this.broker;
    const base = {
      now: nowMs,
      market,
      btc: { price: this.btcPrice, history: this.btcHistory },
      priceToBeat: this.priceToBeat[market.slug] ?? null,
      quotes,
      books,
      vol: this.vol,
      settle: this._settleInfo(market, nowSec),
      fee: (price) => broker.feePerShare(price, market.feeRate),
    };
    for (const s of this._active) {
      let actions;
      try {
        actions = s.onTick({
          ...base,
          positions: broker.positions.length ? broker.positions.filter((x) => x.strategy === s.id) : broker.positions,
          balance: broker.cash,
          p: this.params[s.id],
          state: this.strategyState[s.id],
        });
      } catch (e) {
        this._warn(`strategy:${s.id}`, 'error', `${s.name} failed: ${e.message}`);
        continue;
      }
      if (actions && actions.length) for (const a of actions) this._execute(s, a, market, books, nowMs);
    }
  }

  _execute(s, a, market, books, nowMs) {
    if (a.type === 'buy') {
      if (this.manualHold.has(`${s.id}|${market.slug}`)) return;
      const r = this.broker.buy({ market, outcome: a.outcome, usd: a.usd, shares: a.shares, maxPrice: a.maxPrice, book: books[a.outcome], reason: a.reason, strategy: s.id, now: nowMs });
      if (r.error) this._warn(`buy:${s.id}`, 'warn', `[${s.name}] Buy ${a.outcome} skipped: ${r.error}`);
      else {
        this._log('trade', `[${s.name}] BUY ${a.outcome} ${r.shares.toFixed(2)} @ ${r.avgPrice.toFixed(3)} — ${a.reason}`);
        this._persist(true);
      }
    } else if (a.type === 'sell') {
      const pos = this.broker.positions.find((x) => x.id === a.positionId && x.strategy === s.id);
      if (!pos) return;
      const r = this.broker.sell({ positionId: a.positionId, book: books[pos.outcome], reason: a.reason, now: nowMs });
      if (r.error) this._warn(`sell:${s.id}`, 'warn', `[${s.name}] Sell skipped: ${r.error}`);
      else {
        this._log('trade', `[${s.name}] SELL ${r.outcome} @ ${r.exitPrice.toFixed(3)} P&L ${r.pnl.toFixed(2)} — ${a.reason}`);
        this._persist(true);
      }
    }
  }

  // --------------------------------------------------------------- settlement
  async _settleFinished(nowSec) {
    // remember windows that have open positions so they can be settled later
    for (const pos of this.broker.positions) {
      if (!this.pendingSettle[pos.slug]) {
        const m = this.marketCache[pos.slug];
        this.pendingSettle[pos.slug] = {
          start: pos.windowStart,
          end: pos.windowEnd,
          priceToBeat: this.priceToBeat[pos.slug] ?? null,
          twapSec: m ? m.twapSec || 0 : 0,
          conditionId: m ? m.conditionId : null,
        };
      } else if (this.priceToBeat[pos.slug] != null) {
        this.pendingSettle[pos.slug].priceToBeat = this.priceToBeat[pos.slug];
      }
    }
    for (const [slug, info] of Object.entries(this.pendingSettle)) {
      if (nowSec < info.end + 5) continue;
      if (!this.broker.positions.some((p) => p.slug === slug)) { delete this.pendingSettle[slug]; continue; }
      // Official result from Polymarket: check often at first, then every 30s. The order-book
      // API usually has it within a few minutes; Gamma (slower) is the second opinion.
      const gap = nowSec - info.end < 300 ? 10 : 30;
      if (!info.lastCheck || nowSec - info.lastCheck >= gap) {
        info.lastCheck = nowSec;
        let winner = info.conditionId ? await pm.fetchWinner(info.conditionId, this.fetch).catch(() => null) : null;
        if (!winner) {
          const m = await pm.fetchMarket({ slug, start: info.start, end: info.end }, this.fetch).catch(() => null);
          if (m && m.resolved) winner = m.resolved;
          if (m && m.conditionId) info.conditionId = m.conditionId;
        }
        if (winner) {
          this._settle(slug, winner, false);
          continue;
        }
      }
      // fallback: estimate the result ourselves if Polymarket is slow
      if (nowSec > info.end + this.settings.officialWaitSec) {
        const L = info.twapSec || 0;
        const ptb = info.priceToBeat ?? await feed.fetchMinuteOpen(info.start, this.fetch).catch(() => null);
        let close = this._chainlinkAt(info.end, L);
        if (close == null) {
          close = L > 0
            ? await feed.fetchMinuteAverage(info.end - 60, this.fetch).catch(() => null)
            : await feed.fetchMinuteClose(info.end, this.fetch).catch(() => null);
          if (close != null) close += this.basis;
        }
        if (ptb && close) this._settle(slug, close >= ptb ? 'Up' : 'Down', true);
      }
    }
  }

  _settle(slug, winner, estimated) {
    const closed = this.broker.settle({ slug, winner, estimated, now: this.now() });
    delete this.pendingSettle[slug];
    delete this.priceToBeat[slug];
    delete this.ptbSource[slug];
    for (const key of this.manualHold) if (key.endsWith(`|${slug}`)) this.manualHold.delete(key);
    for (const t of closed) this._log('trade', `[${this._name(t.strategy)}] SETTLED ${t.outcome} (${winner} won${estimated ? ', estimated' : ''}) P&L ${t.pnl.toFixed(2)}`);
    if (closed.length) this._persist(true);
  }

  // ------------------------------------------------------------- manual close
  /** Sell one open position into the live bids right now. Returns { ok, trade } or { error }. */
  closePosition(id) {
    const pos = this.broker.positions.find((p) => p.id === id);
    if (!pos) return { error: 'Position not found — it may already be closed.' };
    const market = this.market;
    const nowMs = this.now();
    if (!market || market.slug !== pos.slug || nowMs / 1000 >= market.end) {
      return { error: 'That window has ended, so it can no longer be traded. The position will settle automatically.' };
    }
    const books = this._booksFor(market);
    if (!books || !books[pos.outcome]) return { error: 'No live order book yet — try again in a moment.' };
    const r = this.broker.sell({ positionId: id, book: books[pos.outcome], reason: 'closed manually', exitType: 'manual', now: nowMs });
    if (r.error) return { error: `Could not close: ${r.error}.` };
    // Don't let the strategy that opened it jump straight back in this window.
    this.manualHold.add(`${pos.strategy}|${pos.slug}`);
    const part = r.partial ? ` (partial: ${r.shares.toFixed(2)} sold, the book was too thin for the rest)` : '';
    this._log('trade', `[${this._name(pos.strategy)}] MANUAL CLOSE ${r.outcome} @ ${r.exitPrice.toFixed(3)} P&L ${r.pnl.toFixed(2)}${part}`);
    this._persist(true);
    this._emit();
    return { ok: true, partial: !!r.partial, trade: r };
  }

  /** Close every position that can still be traded. Returns { closed, failed }. */
  closeAllPositions() {
    let closed = 0;
    let failed = 0;
    for (const pos of [...this.broker.positions]) {
      if (this.closePosition(pos.id).ok) closed++;
      else failed++;
    }
    return { closed, failed };
  }

  // ----------------------------------------------------------------- settings
  updateSettings(patch = {}) {
    const allowed = ['windowKey', 'pollMs', 'evalMs', 'streaming', 'feeModel', 'feeRate', 'maxSlippage', 'officialWaitSec', 'recordTicks'];
    const before = { windowKey: this.settings.windowKey, streaming: this.settings.streaming };
    for (const k of allowed) if (k in patch) this.settings[k] = patch[k];
    const num = (v, dflt, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
    this.settings.pollMs = num(this.settings.pollMs, 1000, 500, 60000);
    this.settings.evalMs = num(this.settings.evalMs, 50, 0, 5000);
    this.settings.feeRate = num(this.settings.feeRate, 0.01, 0, 0.5);
    this.settings.maxSlippage = num(this.settings.maxSlippage, 0.03, 0, 0.5);
    this.settings.officialWaitSec = num(this.settings.officialWaitSec, 600, 30, 86400);
    this.settings.streaming = !!this.settings.streaming;
    if (!pm.WINDOWS[this.settings.windowKey]) this.settings.windowKey = '15m';
    if (!['market', 'flat'].includes(this.settings.feeModel)) this.settings.feeModel = 'market';
    this.broker.feeModel = this.settings.feeModel;
    this.broker.feeRate = this.settings.feeRate;
    this.broker.maxSlippage = this.settings.maxSlippage;
    if (before.windowKey !== this.settings.windowKey) {
      this.marketCache = {};
      this.restBooks = null;
      if (this.bookStream) this.bookStream.keep([]);
    }
    if (this.running && before.streaming !== this.settings.streaming) {
      if (this.settings.streaming) this._startStreams();
      else this._stopStreams();
    }
    this._persist(true);
    this._emit();
  }

  /** Turn a strategy on or off. Its open positions stay and still settle. */
  setStrategyEnabled(id, on) {
    if (!registry.hasStrategy(id)) return false;
    const set = new Set(this.settings.activeStrategies);
    if (on) set.add(id); else set.delete(id);
    this.settings.activeStrategies = registry.strategies.map((s) => s.id).filter((x) => set.has(x));
    this._refreshActive();
    this._log('info', `${this._name(id)} ${on ? 'enabled' : 'disabled'}`);
    this.rev.strategies++;
    this._persist(true);
    this._emit();
    return true;
  }

  setStrategyParams(id, params) {
    if (!registry.hasStrategy(id)) return false;
    const s = registry.getStrategy(id);
    this.params[id] = registry.sanitiseParams(s, { ...this.params[id], ...(params || {}) });
    this._log('info', `Strategy params updated (${s.name})`);
    this.rev.strategies++;
    this._persist(true);
    this._emit();
    return true;
  }

  /** Enable a strategy and (optionally) set its params in one call. */
  setStrategy(id, params) {
    if (!registry.hasStrategy(id)) return false;
    if (params) this.setStrategyParams(id, params);
    if (!this.settings.activeStrategies.includes(id)) this.setStrategyEnabled(id, true);
    return true;
  }

  reset(startingCash) {
    const cash = Number(startingCash) > 0 ? Number(startingCash) : this.settings.startingCash;
    this.settings.startingCash = cash;
    this.broker = new PaperBroker({ cash }, this.settings);
    this.equityCurve = [];
    this.pendingSettle = {};
    this.manualHold.clear();
    for (const s of registry.strategies) this.strategyState[s.id] = s.initState();
    this._statsCache = { rev: -1 };
    this._sent = {};
    this.rev.equity++;
    this._log('info', `Account reset to $${cash}`);
    this._persist(true);
    this._emit();
  }

  _refreshActive() {
    this._active = registry.strategies.filter((s) => this.settings.activeStrategies.includes(s.id));
  }

  _name(id) {
    return registry.hasStrategy(id) ? registry.getStrategy(id).name : id || 'unknown';
  }

  // ------------------------------------------------------------------- output
  _stats() {
    const c = this._statsCache;
    if (c.rev !== this.broker.rev || c.n !== this.broker.trades.length) {
      c.rev = this.broker.rev;
      c.n = this.broker.trades.length;
      c.all = stats(this.broker.trades);
      c.by = statsByStrategy(this.broker.trades);
    }
    return c;
  }

  /**
   * Snapshot for the UI. The small live fields are always present; the bulky
   * ones (trade history, equity curve, log, sparkline, strategy schemas) are
   * only included when they changed since the last call — or when `full`.
   */
  view(full = true) {
    const nowMs = this.now();
    const nowSec = nowMs / 1000;
    const m = this.market;
    const st = this._stats();
    const ptb = m ? this.priceToBeat[m.slug] ?? null : null;
    const open = {};
    for (const p of this.broker.positions) {
      const o = (open[p.strategy] ||= { n: 0, cost: 0, value: 0 });
      o.n++;
      o.cost += p.cost;
      o.value += p.shares * (p.mark ?? p.avgPrice);
    }
    let fairUp = null;
    if (m && ptb && this.btcPrice && this.vol && nowSec < m.end) {
      const s = this._settleInfo(m, nowSec);
      fairUp = model.probUp({ price: this.btcPrice + s.basis, strike: ptb, sigma: this.vol, secLeft: m.end - nowSec, twapSec: s.twapSec, realisedMean: s.realisedMean, realisedSec: s.realisedSec });
    }
    const live = (s) => !!(s && s.live);
    const v = {
      running: this.running,
      lastError: this.lastError,
      settings: this.settings,
      feeds: {
        btc: live(this.btcStream) ? 'stream' : 'poll',
        books: m && this._streamBooks(m) ? 'stream' : 'poll',
        settle: live(this.chainlink) ? 'stream' : 'off',
      },
      btc: this.btcPrice,
      chainlink: live(this.chainlink) ? this.chainlink.price : null,
      vol: this.vol,
      fairUp,
      market: m && { title: m.title, slug: m.slug, url: m.url, start: m.start, end: m.end, feeRate: m.feeRate, secondsLeft: Math.max(0, Math.round(m.end - nowSec)) },
      priceToBeat: ptb,
      ptbSource: m ? this.ptbSource[m.slug] ?? null : null,
      quotes: this.quotes,
      cash: this.broker.cash,
      equity: this.broker.equity(),
      startingCash: this.settings.startingCash,
      positions: this.broker.positions.map((p) => ({ ...p, strategyName: this._name(p.strategy), canClose: !!m && p.slug === m.slug && nowSec < m.end })),
      stats: st.all,
      strategyStats: registry.strategies.map((s) => {
        const o = open[s.id];
        return { id: s.id, enabled: this.settings.activeStrategies.includes(s.id), ...(st.by[s.id] || EMPTY_STATS), open: o ? o.n : 0, openCost: o ? o.cost : 0, unrealised: o ? o.value - o.cost : 0 };
      }),
      rev: { ...this.rev, trades: st.n },
    };
    const sent = full ? {} : this._sent;
    if (sent.strategies !== this.rev.strategies) {
      v.strategies = registry.strategies.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params, values: this.params[s.id] }));
    }
    if (sent.trades !== st.rev) v.trades = this.broker.trades.slice(-200).reverse().map((t) => ({ ...t, strategyName: this._name(t.strategy) }));
    if (sent.equity !== this.rev.equity) v.equityCurve = this.equityCurve.slice(-1440);
    if (sent.log !== this.rev.log) v.log = this.log.slice(-150);
    if (sent.spark !== this.rev.spark) v.btcSpark = this.spark;
    if (!full) this._sent = { ...this.rev, trades: st.rev };
    return v;
  }

  tradesCsv() {
    const cols = ['closedAt', 'title', 'strategy', 'outcome', 'shares', 'entryPrice', 'exitPrice', 'cost', 'proceeds', 'fees', 'pnl', 'exitType', 'entryReason', 'exitReason'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = this.broker.trades.map((t) => cols.map((c) => esc(c === 'closedAt' ? new Date(t[c]).toISOString() : t[c])).join(','));
    return [cols.join(','), ...rows].join('\n');
  }

  /** Queue a save. `soon` (after a trade or a settings change) writes within a moment instead of waiting. */
  _persist(soon = false) {
    if (!this.store) return;
    this.store.save({
      settings: this.settings,
      params: this.params,
      broker: this.broker.snapshot(),
      equityCurve: this.equityCurve,
      strategyState: this.strategyState,
      pendingSettle: this.pendingSettle,
    }, soon);
  }

  _log(level, msg) {
    this.log.push({ t: this.now(), level, msg });
    if (this.log.length > 500) this.log.shift();
    this.rev.log++;
  }

  /** Log, but at most once every 15s per key — strategies run many times a second. */
  _warn(key, level, msg) {
    const t = Date.now();
    if (t - (this._warned.get(key) || 0) < 15000) return;
    this._warned.set(key, t);
    this._log(level, msg);
  }

  _emit() {
    this._lastEmit = Date.now();
    if (this.listenerCount('update')) this.emit('update', this.view(false));
  }
}

module.exports = { Engine, DEFAULT_SETTINGS };
