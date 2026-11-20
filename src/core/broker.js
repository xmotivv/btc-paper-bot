'use strict';
// Paper broker: simulates fills by walking the real order book, charges fees,
// tracks cash, open positions and closed trades. Never touches real money.

let seq = 0;
const newId = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

class PaperBroker {
  constructor(state = {}, opts = {}) {
    this.cash = state.cash ?? opts.startingCash ?? 1000;
    this.positions = state.positions ?? [];
    this.trades = state.trades ?? [];
    this.feeRate = opts.feeRate ?? 0.01; // fraction of notional per fill
    this.maxSlippage = opts.maxSlippage ?? 0.03; // stop walking the book beyond best + this
  }

  snapshot() {
    return { cash: this.cash, positions: this.positions, trades: this.trades };
  }

  /** Buy `usd` worth of an outcome, walking asks. Returns position or {error}. */
  buy({ market, outcome, usd, book, reason = '', strategy = '', now = Date.now() }) {
    if (!(usd > 0)) return { error: 'usd must be > 0' };
    if (!book || !book.asks.length) return { error: 'no asks' };
    const budget = Math.min(usd, this.cash / (1 + this.feeRate));
    if (budget < 1) return { error: 'insufficient cash' };
    const limit = book.asks[0].price + this.maxSlippage;
    let spent = 0;
    let shares = 0;
    for (const lvl of book.asks) {
      if (lvl.price > limit || lvl.price >= 1) break;
      const remaining = budget - spent;
      if (remaining <= 1e-9) break;
      const take = Math.min(lvl.size, remaining / lvl.price);
      shares += take;
      spent += take * lvl.price;
    }
    if (shares <= 0) return { error: 'no liquidity within slippage limit' };
    const fee = spent * this.feeRate;
    this.cash = round(this.cash - spent - fee);
    const pos = {
      id: newId('pos'),
      slug: market.slug,
      title: market.title,
      windowStart: market.start,
      windowEnd: market.end,
      outcome,
      shares: round(shares),
      avgPrice: round(spent / shares),
      cost: round(spent + fee),
      fees: round(fee),
      openedAt: now,
      reason,
      strategy,
      mark: round(spent / shares),
    };
    this.positions.push(pos);
    return pos;
  }

  /** Sell an entire position into the bids. */
  sell({ positionId, book, reason = '', now = Date.now() }) {
    const i = this.positions.findIndex((p) => p.id === positionId);
    if (i < 0) return { error: 'position not found' };
    if (!book || !book.bids.length) return { error: 'no bids' };
    const pos = this.positions[i];
    const limit = book.bids[0].price - this.maxSlippage;
    let left = pos.shares;
    let proceeds = 0;
    for (const lvl of book.bids) {
      if (lvl.price < limit || left <= 1e-9) break;
      const take = Math.min(lvl.size, left);
      proceeds += take * lvl.price;
      left -= take;
    }
    const sold = pos.shares - left;
    if (sold <= 1e-9) return { error: 'no liquidity within slippage limit' };
    const fee = proceeds * this.feeRate;
    const net = proceeds - fee;
    const costPart = pos.cost * (sold / pos.shares);
    this.cash = round(this.cash + net);
    const trade = this._close(pos, {
      shares: sold,
      exitPrice: proceeds / sold,
      proceeds: net,
      cost: costPart,
      fees: pos.fees * (sold / pos.shares) + fee,
      exitType: 'sell',
      reason,
      now,
    });
    if (left > 1e-6) {
      pos.shares = round(left);
      pos.cost = round(pos.cost - costPart);
      pos.fees = round(pos.fees * (left / (left + sold)));
    } else {
      this.positions.splice(i, 1);
    }
    return trade;
  }

  /** Settle every open position in `slug` at resolution: winner pays $1/share. */
  settle({ slug, winner, estimated = false, now = Date.now() }) {
    const out = [];
    this.positions = this.positions.filter((pos) => {
      if (pos.slug !== slug) return true;
      const payout = pos.outcome === winner ? pos.shares : 0;
      this.cash = round(this.cash + payout);
      out.push(this._close(pos, {
        shares: pos.shares,
        exitPrice: pos.outcome === winner ? 1 : 0,
        proceeds: payout,
        cost: pos.cost,
        fees: pos.fees,
        exitType: estimated ? 'settled (estimated)' : 'settled',
        reason: `${winner} won`,
        now,
      }));
      return false;
    });
    return out;
  }

  markToMarket(slug, outcome, bid) {
    for (const p of this.positions) if (p.slug === slug && p.outcome === outcome && bid != null) p.mark = bid;
  }

  equity() {
    return round(this.cash + this.positions.reduce((s, p) => s + p.shares * (p.mark ?? p.avgPrice), 0), 2);
  }

  _close(pos, x) {
    const t = {
      id: newId('trd'),
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
      closedAt: x.now,
      entryReason: pos.reason,
      exitType: x.exitType,
      exitReason: x.reason,
    };
    this.trades.push(t);
    return t;
  }
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const fees = trades.reduce((s, t) => s + t.fees, 0);
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  return {
    trades: n,
    winRate: n ? wins / n : 0,
    pnl: round(pnl, 2),
    fees: round(fees, 2),
    avgPnl: n ? round(pnl / n, 3) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
  };
}

module.exports = { PaperBroker, stats };
