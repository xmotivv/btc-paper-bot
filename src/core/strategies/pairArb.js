'use strict';
/**
 * Pair arbitrage (a "Dutch book").
 *
 * Idea: exactly one of Up and Down pays $1. If one share of each can be bought
 * for less than $1 in total, fees included, the difference is locked in no
 * matter where BTC goes. Such gaps are small, rare and short-lived, which is
 * why this strategy reads the full order book on every update.
 *
 * It shows up in the trade history as one winning and one losing leg per pair;
 * judge it by total P&L, not win rate.
 */

const params = [
  { key: 'maxStakeUsd', label: 'Max spend per pair ($)', type: 'number', default: 100, min: 5, max: 2000, step: 5 },
  { key: 'minProfit', label: 'Min locked-in profit per pair of shares ($)', type: 'number', default: 0.01, min: 0.001, max: 0.2, step: 0.001 },
  { key: 'minShares', label: 'Min shares per leg', type: 'number', default: 5, min: 1, max: 1000, step: 1 },
  { key: 'minSecLeft', label: 'No new pairs in last (s)', type: 'number', default: 5, min: 0, max: 300, step: 1 },
  { key: 'cooldownSec', label: 'Min gap between pairs (s)', type: 'number', default: 10, min: 0, max: 600, step: 1 },
  { key: 'maxPairsPerWindow', label: 'Max pairs per window', type: 'number', default: 5, min: 1, max: 50, step: 1 },
];

/** Walk both ask ladders together while a pair still costs less than $1 − minProfit. */
function sizePair(asksUp, asksDown, fee, { maxUsd, minProfit }) {
  let i = 0;
  let j = 0;
  let remUp = asksUp.length ? asksUp[0].size : 0;
  let remDown = asksDown.length ? asksDown[0].size : 0;
  let shares = 0;
  let cost = 0;
  let limitUp = null;
  let limitDown = null;
  while (i < asksUp.length && j < asksDown.length) {
    const pu = asksUp[i].price;
    const pd = asksDown[j].price;
    const unit = pu + pd + fee(pu) + fee(pd);
    if (unit > 1 - minProfit + 1e-12) break;
    const take = Math.min(remUp, remDown, (maxUsd - cost) / unit);
    if (take <= 1e-9) break;
    shares += take;
    cost += take * unit;
    limitUp = pu;
    limitDown = pd;
    remUp -= take;
    remDown -= take;
    if (remUp <= 1e-9) { i++; remUp = i < asksUp.length ? asksUp[i].size : 0; }
    if (remDown <= 1e-9) { j++; remDown = j < asksDown.length ? asksDown[j].size : 0; }
  }
  return { shares, cost, limitUp, limitDown };
}

function onTick(ctx) {
  const { now, market, books, p, state } = ctx;
  if (!books || !books.Up || !books.Down) return [];
  if (market.end - now / 1000 < p.minSecLeft) return [];
  state.pairs ||= {};
  state.last ||= {};
  const pairs = state.pairs[market.slug] || 0;
  if (pairs >= p.maxPairsPerWindow) return [];
  if (now - (state.last[market.slug] || 0) < p.cooldownSec * 1000) return [];

  const size = sizePair(books.Up.asks, books.Down.asks, ctx.fee, {
    maxUsd: Math.min(p.maxStakeUsd, ctx.balance * 0.98),
    minProfit: p.minProfit,
  });
  if (size.shares < p.minShares) return [];

  state.pairs[market.slug] = pairs + 1;
  state.last[market.slug] = now;
  for (const map of [state.pairs, state.last]) {
    const keys = Object.keys(map);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete map[k];
  }
  const locked = size.shares - size.cost;
  const reason = `pair ${size.shares.toFixed(1)} sh for $${size.cost.toFixed(2)} → pays $${size.shares.toFixed(2)} (locks $${locked.toFixed(2)})`;
  return [
    { type: 'buy', outcome: 'Up', shares: size.shares, maxPrice: size.limitUp, reason },
    { type: 'buy', outcome: 'Down', shares: size.shares, maxPrice: size.limitDown, reason },
  ];
}

module.exports = {
  id: 'pair-arb',
  name: 'Pair arbitrage',
  description: 'Buys Up and Down together whenever one share of each costs less than $1 after fees. One leg always pays $1, so the gap is locked in whichever way BTC goes. Opportunities are rare and small.',
  params,
  initState: () => ({ pairs: {}, last: {} }),
  onTick,
  sizePair,
};
