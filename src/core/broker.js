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
    // 'market': Polymarket's published curve, fee = shares × rate × p × (1 − p), rate read from each market.
    // 'flat':   feeRate × notional. Also the fallback when a market publishes no rate.
    this.feeModel = opts.feeModel ?? 'flat';
    this.feeRate = opts.feeRate ?? 0.01;
    this.maxSlippage = opts.maxSlippage ?? 0.03; // stop walking the book beyond best + this
    this.rev = 0; // bumped whenever positions or trades change
  }

  snapshot() {
    return { cash: this.cash, positions: this.positions, trades: this.trades };
  }

  /** Taker fee in dollars for one share at `price`. `marketRate` is the market's published coefficient. */
  feePerShare(price, marketRate) {
    if (this.feeModel === 'market' && marketRate != null) return marketRate * price * (1 - price);
    return this.feeRate * price;
  }

  /**
   * Buy an outcome by walking the asks. Size it with `usd` (notional to spend),
   * `shares` (exact share count), or both (whichever runs out first). `maxPrice`
   * is an optional limit price; without one, fills stop at best ask + maxSlippage.
   * Returns the position or {error}.
   */
  buy({ market, outcome, usd, shares, maxPrice, book, reason = '', strategy = '', now = Date.now() }) {
    const wantUsd = usd > 0 ? usd : Infinity;
    const wantShares = shares > 0 ? shares : Infinity;
    if (wantUsd === Infinity && wantShares === Infinity) return { error: 'usd or shares must be > 0' };
    if (!book || !book.asks.length) return { error: 'no asks' };
    if (this.cash < 1) return { error: 'insufficient cash' };
    const asks = book.asks;
    const limit = (maxPrice > 0 ? maxPrice : asks[0].price + this.maxSlippage) + 1e-9;
    const rate = market.feeRate;
    let spent = 0;
    let got = 0;
    let fee = 0;
    let cashLeft = this.cash;
    for (const lvl of asks) {
      if (lvl.price > limit || lvl.price >= 1) break;
      const unitFee = this.feePerShare(lvl.price, rate);
      const take = Math.min(lvl.size, (wantUsd - spent) / lvl.price, wantShares - got, cashLeft / (lvl.price + unitFee));
      if (take <= 1e-9) break;
      got += take;
      spent += take * lvl.price;
      fee += take * unitFee;
      cashLeft -= take * (lvl.price + unitFee);
    }
    if (got <= 1e-9) return { error: 'no liquidity within slippage limit' };
    this.cash = round(this.cash - spent - fee);
    const pos = {
      id: newId('pos'),
      slug: market.slug,
      title: market.title,
      windowStart: market.start,
      windowEnd: market.end,
      outcome,
      shares: round(got),
      avgPrice: round(spent / got),
      cost: round(spent + fee),
      fees: round(fee),
      feeRate: rate ?? null,
      openedAt: now,
      reason,
      strategy,
      mark: round(spent / got),
    };
    this.positions.push(pos);
    this.rev++;
    return pos;
  }

  /** Sell an entire position into the bids (partially, if the book is thin). */
  sell({ positionId, book, reason = '', exitType = 'sell', now = Date.now() }) {
    const i = this.positions.findIndex((p) => p.id === positionId);
    if (i < 0) return { error: 'position not found' };
    if (!book || !book.bids.length) return { error: 'no bids' };
    const pos = this.positions[i];
    const limit = book.bids[0].price - this.maxSlippage - 1e-9;
    let left = pos.shares;
    let proceeds = 0;
    let fee = 0;
    for (const lvl of book.bids) {
      if (lvl.price < limit || left <= 1e-9) break;
      const take = Math.min(lvl.size, left);
      proceeds += take * lvl.price;
      fee += take * this.feePerShare(lvl.price, pos.feeRate);
      left -= take;
    }
    const sold = pos.shares - left;
    if (sold <= 1e-9) return { error: 'no liquidity within slippage limit' };
    const net = proceeds - fee;
    const costPart = pos.cost * (sold / pos.shares);
    this.cash = round(this.cash + net);
    const trade = this._close(pos, {
      shares: sold,
      exitPrice: proceeds / sold,
      proceeds: net,
      cost: costPart,
      fees: pos.fees * (sold / pos.shares) + fee,
      exitType,
      reason,
      now,
    });
    if (left > 1e-6) {
      pos.shares = round(left);
      pos.cost = round(pos.cost - costPart);
      pos.fees = round(pos.fees * (left / (left + sold)));
      trade.partial = true;
    } else {
      this.positions.splice(i, 1);
    }
    this.rev++;
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
    if (out.length) this.rev++;
    return out;
  }

  markToMarket(slug, outcome, bid) {
    if (bid == null) return;
    for (const p of this.positions) if (p.slug === slug && p.outcome === outcome) p.mark = bid;
  }

  equity() {
    let v = this.cash;
    for (const p of this.positions) v += p.shares * (p.mark ?? p.avgPrice);
    return round(v, 2);
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
  let wins = 0;
  let pnl = 0;
  let fees = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    pnl += t.pnl;
    fees += t.fees;
    if (t.pnl > 0) { wins++; grossWin += t.pnl; } else if (t.pnl < 0) grossLoss -= t.pnl;
  }
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? wins / n : 0,
    pnl: round(pnl, 2),
    fees: round(fees, 2),
    avgPnl: n ? round(pnl / n, 3) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
  };
}

/** stats() per strategy id: { [strategyId]: stats }. */
function statsByStrategy(trades) {
  const groups = {};
  for (const t of trades) (groups[t.strategy || 'unknown'] ||= []).push(t);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stats(v)]));
}

module.exports = { PaperBroker, stats, statsByStrategy };
