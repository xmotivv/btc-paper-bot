'use strict';
// Real-money trading on Polymarket US. Everything that can spend money goes
// through this file, and nothing here acts unless ALL of these hold:
//   • an API key is connected,
//   • live trading has been armed in this session (it never arms itself and is
//     always off after a restart),
//   • the order fits every limit: per order, total open exposure, today's loss.
//
// Orders are immediate-or-cancel limit orders, so a stale quote can only cause
// a missed fill, never a fill at a worse price than intended. Nothing is ever
// retried automatically. If the bot cannot tell what happened to an order it
// stops trading and says so.

const { UsClient } = require('./usClient');

const DEFAULT_LIMITS = {
  maxOrderUsd: 5, // most a single order may cost, fees included
  maxOpenUsd: 25, // most that may be tied up in open live positions
  maxDailyLossUsd: 20, // realised loss today at which live trading switches itself off
  maxOrdersPerDay: 200, // runaway backstop
};
const LIMIT_BOUNDS = { maxOrderUsd: [1, 10000], maxOpenUsd: [1, 100000], maxDailyLossUsd: [1, 100000], maxOrdersPerDay: [1, 5000] };
const ORDER_GAP_MS = 1000; // at most one new entry a second
const MAX_FAILURES = 3; // consecutive order errors before live trading switches itself off
const EPS = 1e-9;

let seq = 0;
const newId = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const amount = (a) => (a == null ? null : typeof a === 'object' ? (a.value == null || a.value === '' ? null : Number(a.value)) : Number(a));
const decimalsOf = (step) => Math.max(0, Math.round(-Math.log10(step)));
const floorTo = (x, step) => Math.floor((x + EPS) / step) * step;
const ceilTo = (x, step) => Math.ceil((x - EPS) / step) * step;
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Build the exchange order for buying or selling an outcome. `limit` is in the
 * outcome's own terms (what one Down share costs); the exchange only has the
 * Up-side instrument, so Down orders are sent at 1 − limit.
 */
function buildOrder({ market, outcome, action, qty, limit, manual = false }) {
  const dec = decimalsOf(market.tick);
  const up = outcome === 'Up';
  const intent = action === 'buy' ? (up ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT') : (up ? 'ORDER_INTENT_SELL_LONG' : 'ORDER_INTENT_SELL_SHORT');
  return {
    marketSlug: market.slug,
    type: 'ORDER_TYPE_LIMIT',
    price: { value: (up ? limit : 1 - limit).toFixed(dec), currency: 'USD' },
    quantity: Number(qty.toFixed(decimalsOf(market.minQty))),
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    intent,
    manualOrderIndicator: manual ? 'MANUAL_ORDER_INDICATOR_MANUAL' : 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    synchronousExecution: true,
    maxBlockTime: '2',
  };
}

/** What an order response says was filled: { qty, avgPrice (outcome terms), fee, rejected, known }. */
function readFills(resp, outcome) {
  let qty = 0;
  let notional = 0;
  let fee = 0;
  let feeKnown = false;
  let last = null;
  let rejected = null;
  for (const e of (resp && resp.executions) || []) {
    if (e.order) last = e.order;
    if (e.type === 'EXECUTION_TYPE_PARTIAL_FILL' || e.type === 'EXECUTION_TYPE_FILL') {
      const q = Number(e.lastShares);
      const px = amount(e.lastPx);
      if (q > 0 && px > 0) { qty += q; notional += q * px; }
      const c = amount(e.commissionNotionalCollected);
      if (c != null) { fee += c; feeKnown = true; }
    } else if (e.type === 'EXECUTION_TYPE_REJECTED') {
      rejected = e.text || e.orderRejectReason || 'rejected by the exchange';
    }
  }
  if (!qty && last && Number(last.cumQuantity) > 0 && amount(last.avgPx) > 0) {
    qty = Number(last.cumQuantity);
    notional = qty * amount(last.avgPx);
    const c = amount(last.commissionNotionalTotalCollected);
    if (c != null) { fee = c; feeKnown = true; }
  }
  // "known" = the response told us the order's fate (filled, cancelled unfilled, or rejected).
  const terminal = ['ORDER_STATE_FILLED', 'ORDER_STATE_CANCELED', 'ORDER_STATE_REJECTED', 'ORDER_STATE_EXPIRED'];
  const known = qty > 0 || !!rejected || !!(last && terminal.includes(last.state)) || ((resp && resp.executions) || []).some((e) => ['EXECUTION_TYPE_CANCELED', 'EXECUTION_TYPE_EXPIRED'].includes(e.type));
  const longAvg = qty ? notional / qty : null;
  return { qty, avgPrice: qty ? (outcome === 'Up' ? longAvg : 1 - longAvg) : null, fee: feeKnown ? fee : null, rejected, known };
}

class LiveTrader {
  constructor({ state = {}, log = () => {}, now = () => Date.now(), fetchImpl = fetch } = {}) {
    this.log = log;
    this.now = now;
    this.fetch = fetchImpl;
    this.client = null;
    this.keyId = null;
    this.armed = false; // deliberately not restored from disk
    this.limits = this._cleanLimits({ ...DEFAULT_LIMITS, ...(state.limits || {}) });
    this.positions = state.positions || []; // live positions this bot opened
    this.trades = state.trades || [];
    this.orderTimes = state.orderTimes || []; // ms timestamps of orders sent (pruned to today)
    this.account = null; // { cash, buyingPower, positions: [{slug, net, cost}], at }
    this.busy = false;
    this.failures = 0;
    this.lastOrderAt = 0;
    this.status = 'Not connected';
    this.rev = 0;
  }

  snapshot() {
    return { limits: this.limits, positions: this.positions, trades: this.trades, orderTimes: this.orderTimes };
  }

  get connected() { return !!this.client; }

  // --------------------------------------------------------------- connection
  /** Connect with an API key pair. Verifies it by reading the account; throws if that fails. */
  async connect({ keyId, secretKey }) {
    const client = new UsClient({ keyId, secretKey, fetchImpl: this.fetch });
    if (this.armed) this.disarm('a different key is being connected');
    this.client = client;
    try {
      await this.refreshAccount(true);
    } catch (e) {
      this.client = null;
      this.status = 'Not connected';
      throw new Error(e.status === 401 || e.status === 403 ? 'Polymarket US rejected that key. Check the Key ID and Secret Key, and that the key has not been revoked.' : `Could not reach your account: ${e.message}`);
    }
    this.keyId = client.keyId;
    this.failures = 0;
    this.status = 'Connected';
    this.rev++;
    this.log('info', `Connected to Polymarket US account (key ${this.maskedKey()})`);
    return true;
  }

  disconnect() {
    if (this.armed) this.disarm('disconnected');
    this.client = null;
    this.keyId = null;
    this.account = null;
    this.status = 'Not connected';
    this.rev++;
  }

  maskedKey() {
    const k = this.keyId || '';
    return k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;
  }

  async refreshAccount(strict = false) {
    if (!this.client) return null;
    try {
      const [bal, pos] = await Promise.all([this.client.balances(), this.client.positions()]);
      const b = (bal.balances || []).find((x) => !x.currency || x.currency === 'USD') || (bal.balances || [])[0] || {};
      const positions = Object.entries(pos.positions || {}).map(([slug, p]) => ({
        slug,
        title: (p.marketMetadata && p.marketMetadata.title) || slug,
        net: Number(p.netPositionDecimal ?? p.netPosition) || 0,
        cost: amount(p.cost),
      })).filter((p) => Math.abs(p.net) > 0.0001);
      this.account = { cash: amount(b.currentBalance), buyingPower: amount(b.buyingPower), positions, at: this.now() };
      this.rev++;
      return this.account;
    } catch (e) {
      if (strict) throw e;
      if (e.status === 401 || e.status === 403) {
        this.log('error', 'Polymarket US no longer accepts the API key. Live trading is off; reconnect on the Live account tab.');
        this.disconnect();
      }
      return null;
    }
  }

  // ------------------------------------------------------------------ control
  arm() {
    if (!this.client) return { error: 'Connect your Polymarket US API key first.' };
    this.armed = true;
    this.failures = 0;
    this.status = 'Armed';
    this.rev++;
    this.log('trade', `LIVE TRADING ARMED — max $${this.limits.maxOrderUsd}/order, $${this.limits.maxOpenUsd} open, stop at $${this.limits.maxDailyLossUsd} daily loss`);
    return { ok: true };
  }

  disarm(reason = 'switched off') {
    if (!this.armed) return;
    this.armed = false;
    this.status = this.client ? `Connected — live trading off (${reason})` : 'Not connected';
    this.rev++;
    this.log('trade', `LIVE TRADING OFF — ${reason}`);
  }

  /** Stop everything: no new orders, and cancel anything resting on the exchange. Open positions are left alone. */
  async kill() {
    this.disarm('stopped by you');
    if (!this.client) return { ok: true };
    try {
      await this.client.cancelAll();
      return { ok: true };
    } catch (e) {
      this.log('error', `Could not confirm open orders were cancelled: ${e.message}. Check the Polymarket US app.`);
      return { error: e.message };
    }
  }

  _cleanLimits(l) {
    const out = {};
    for (const [k, [min, max]] of Object.entries(LIMIT_BOUNDS)) {
      const n = Number(l[k]);
      out[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_LIMITS[k];
    }
    return out;
  }

  setLimits(patch = {}) {
    this.limits = this._cleanLimits({ ...this.limits, ...patch });
    this.rev++;
  }

  // ------------------------------------------------------------------- limits
  openUsd() {
    let v = 0;
    for (const p of this.positions) v += p.cost;
    return v;
  }

  dayPnl(nowMs = this.now()) {
    const from = startOfDay(nowMs);
    let v = 0;
    for (const t of this.trades) if (t.closedAt >= from) v += t.pnl;
    return round(v, 4);
  }

  ordersToday(nowMs = this.now()) {
    const from = startOfDay(nowMs);
    if (this.orderTimes.length && this.orderTimes[0] < from) this.orderTimes = this.orderTimes.filter((t) => t >= from);
    return this.orderTimes.length;
  }

  /** Why a new entry may not be sent right now, or null if it may. */
  blocked(nowMs = this.now()) {
    if (!this.client) return 'not connected';
    if (!this.armed) return 'live trading is off';
    if (this.busy) return 'another order is in flight';
    if (nowMs - this.lastOrderAt < ORDER_GAP_MS) return 'too soon after the last order';
    if (this.dayPnl(nowMs) <= -this.limits.maxDailyLossUsd) {
      this.disarm(`daily loss stop hit ($${Math.abs(this.dayPnl(nowMs)).toFixed(2)} lost today)`);
      return 'daily loss stop';
    }
    if (this.ordersToday(nowMs) >= this.limits.maxOrdersPerDay) {
      this.disarm(`daily order cap reached (${this.limits.maxOrdersPerDay})`);
      return 'daily order cap';
    }
    return null;
  }

  // ------------------------------------------------------------------- orders
  /**
   * Buy an outcome with real money. Sized so that even if every share filled at
   * the limit price, the cost including fees stays inside every limit.
   * Returns the new position, or { error } / { skipped }.
   */
  async buy({ market, outcome, usd, shares, maxPrice, book, slippage = 0.03, reason = '', strategy = '' }) {
    const nowMs = this.now();
    const why = this.blocked(nowMs);
    if (why) return { skipped: why };
    if (market.venue !== 'us') return { skipped: 'live trading only works on Polymarket US markets' };
    if (!book || !book.asks.length) return { skipped: 'no asks' };
    if (this.positions.some((p) => p.slug === market.slug && p.outcome !== outcome)) {
      // The exchange nets Up against Down in one market; opposing lots would silently cancel each other out.
      return { skipped: `already holding the other side of this market live` };
    }

    const cap = Math.min(maxPrice > 0 ? maxPrice : book.asks[0].price + slippage, 1 - market.tick);
    const limit = floorTo(cap, market.tick);
    if (limit < book.asks[0].price - EPS) return { skipped: 'best ask is above the limit price' };
    const fee = (p) => (market.feeRate || 0) * p * (1 - p);
    const unit = limit + fee(limit); // worst-case cost of one share
    let budget = Math.min(usd > 0 ? usd : Infinity, this.limits.maxOrderUsd, this.limits.maxOpenUsd - this.openUsd());
    if (this.account && this.account.buyingPower != null) budget = Math.min(budget, this.account.buyingPower * 0.98);
    let depth = 0;
    for (const lvl of book.asks) {
      if (lvl.price > limit + EPS) break;
      depth += lvl.size;
    }
    const qty = floorTo(Math.min(depth, shares > 0 ? shares : Infinity, budget / unit), market.minQty);
    if (!(qty >= market.minQty) || qty * unit < 0.5) return { skipped: budget < 0.5 ? 'limits leave no room for another order' : 'order would be too small' };

    const order = buildOrder({ market, outcome, action: 'buy', qty, limit });
    const fill = await this._send(order, outcome, `BUY ${outcome}`);
    if (fill.error) return fill;
    if (!fill.qty) return { skipped: 'no fill (the price moved away)' };

    const feePaid = fill.fee != null ? fill.fee : fill.qty * fee(fill.avgPrice);
    const pos = {
      id: newId('live'),
      live: true,
      orderId: fill.orderId,
      slug: market.slug,
      title: market.title,
      windowStart: market.start,
      windowEnd: market.end,
      outcome,
      shares: round(fill.qty),
      avgPrice: round(fill.avgPrice),
      cost: round(fill.qty * fill.avgPrice + feePaid),
      fees: round(feePaid),
      feeRate: market.feeRate ?? null,
      tick: market.tick,
      minQty: market.minQty,
      openedAt: nowMs,
      reason,
      strategy,
      mark: round(fill.avgPrice),
    };
    this.positions.push(pos);
    this.rev++;
    this.refreshAccount();
    return pos;
  }

  /** Sell a live position into the bids. `manual` marks an order you placed yourself. */
  async sell({ positionId, book, slippage = 0.03, reason = '', manual = false, exitType = 'sell' }) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return { error: 'position not found' };
    if (!this.client) return { error: 'not connected' };
    if (this.busy) return { skipped: 'another order is in flight' };
    if (!manual && !this.armed) return { skipped: 'live trading is off' };
    if (!book || !book.bids.length) return { error: 'no bids' };
    const market = { slug: pos.slug, tick: pos.tick || 0.01, minQty: pos.minQty || 0.01 };

    // Never sell more than the exchange says is there: if the position was closed in the
    // Polymarket app, a sell from here would open a new position the other way.
    this.busy = true;
    let held;
    try {
      const r = await this.client.positions(pos.slug);
      const p = (r.positions || {})[pos.slug];
      held = p ? Math.abs(Number(p.netPositionDecimal ?? p.netPosition) || 0) : 0;
    } catch (e) {
      this.busy = false;
      return { error: `could not confirm the position with the exchange (${e.message})` };
    }
    this.busy = false;
    if (held < market.minQty) {
      this._drop(pos, 'closed outside the bot');
      return { error: 'the exchange shows no position in this market — it was closed outside the bot, so it has been removed here' };
    }
    const qty = floorTo(Math.min(pos.shares, held), market.minQty);
    const limit = Math.min(1 - market.tick, Math.max(market.tick, ceilTo(book.bids[0].price - slippage, market.tick)));

    const order = buildOrder({ market, outcome: pos.outcome, action: 'sell', qty, limit, manual });
    const fill = await this._send(order, pos.outcome, `SELL ${pos.outcome}`);
    if (fill.error) return fill;
    if (!fill.qty) return { error: 'no fill (no bids at the limit price)' };

    const feeRate = pos.feeRate || 0;
    const feePaid = fill.fee != null ? fill.fee : fill.qty * feeRate * fill.avgPrice * (1 - fill.avgPrice);
    const part = Math.min(1, fill.qty / pos.shares);
    const costPart = pos.cost * part;
    const trade = this._close(pos, {
      shares: fill.qty,
      exitPrice: fill.avgPrice,
      proceeds: fill.qty * fill.avgPrice - feePaid,
      cost: costPart,
      fees: pos.fees * part + feePaid,
      exitType: manual ? 'manual' : exitType,
      reason,
    });
    if (pos.shares - fill.qty > market.minQty - EPS) {
      pos.shares = round(pos.shares - fill.qty);
      pos.cost = round(pos.cost - costPart);
      pos.fees = round(pos.fees * (1 - part));
      trade.partial = true;
    } else {
      this.positions = this.positions.filter((p) => p !== pos);
    }
    this.rev++;
    this.refreshAccount();
    return trade;
  }

  /** Send one order and work out what happened to it. Never retries. */
  async _send(order, outcome, label) {
    this.busy = true;
    this.lastOrderAt = this.now();
    this.orderTimes.push(this.lastOrderAt);
    try {
      let resp;
      try {
        resp = await this.client.createOrder(order);
      } catch (e) {
        return this._failed(`${label} failed: ${e.message}`, e);
      }
      let fill = readFills(resp, outcome);
      if (!fill.known && resp && resp.id) {
        // The reply didn't include the outcome; ask once.
        try {
          const o = await this.client.order(resp.id);
          fill = readFills({ executions: [{ order: o.order || o }] }, outcome);
        } catch { /* handled below */ }
      }
      if (!fill.known) {
        this.disarm(`could not confirm what happened to order ${resp && resp.id ? resp.id : '(no id)'} — check the Polymarket US app`);
        this.refreshAccount();
        return { error: 'order outcome unknown; live trading has been switched off as a precaution' };
      }
      if (fill.rejected && !fill.qty) return this._failed(`${label} rejected: ${fill.rejected}`);
      this.failures = 0;
      return { ...fill, orderId: resp.id };
    } finally {
      this.busy = false;
    }
  }

  _failed(message, e) {
    this.failures++;
    if (e && (e.status === 401 || e.status === 403)) {
      this.disarm('the exchange rejected the API key');
    } else if (this.failures >= MAX_FAILURES) {
      this.disarm(`${MAX_FAILURES} orders in a row failed`);
    }
    return { error: message };
  }

  // -------------------------------------------------------------- bookkeeping
  /** The exchange pays out settled markets itself; this records the result against the bot's own lots. */
  settle({ slug, winner, estimated = false }) {
    const out = [];
    for (const pos of this.positions.filter((p) => p.slug === slug)) {
      const won = pos.outcome === winner;
      out.push(this._close(pos, {
        shares: pos.shares,
        exitPrice: won ? 1 : 0,
        proceeds: won ? pos.shares : 0,
        cost: pos.cost,
        fees: pos.fees,
        exitType: estimated ? 'settled (estimated)' : 'settled',
        reason: `${winner} won`,
      }));
    }
    if (out.length) {
      this.positions = this.positions.filter((p) => p.slug !== slug);
      this.rev++;
      this.refreshAccount();
    }
    return out;
  }

  markToMarket(slug, outcome, bid) {
    if (bid == null) return;
    for (const p of this.positions) if (p.slug === slug && p.outcome === outcome) p.mark = bid;
  }

  _drop(pos, why) {
    this.positions = this.positions.filter((p) => p !== pos);
    this.rev++;
    this.log('warn', `Live position ${pos.outcome} ${pos.shares} in ${pos.title} removed: ${why}`);
  }

  _close(pos, x) {
    const t = {
      id: newId('ltrd'),
      live: true,
      slug: pos.slug,
      title: pos.title,
      outcome: pos.outcome,
      strategy: pos.strategy,
      shares: round(x.shares),
      entryPrice: pos.avgPrice,
      exitPrice: round(x.exitPrice),
      cost: round(x.cost, 4),
      proceeds: round(x.proceeds, 4),
      fees: round(x.fees, 4),
      pnl: round(x.proceeds - x.cost, 4),
      openedAt: pos.openedAt,
      closedAt: this.now(),
      entryReason: pos.reason,
      exitType: x.exitType,
      exitReason: x.reason,
    };
    this.trades.push(t);
    return t;
  }
}

module.exports = { LiveTrader, DEFAULT_LIMITS, buildOrder, readFills };
