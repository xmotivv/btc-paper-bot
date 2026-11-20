'use strict';
/**
 * Momentum strategy for BTC "Up or Down" windows.
 *
 * Idea: once a window is underway, if BTC has already moved away from the
 * "price to beat" AND the short-term trend is still pushing the same way,
 * buy that side — but only while the market hasn't fully priced it in.
 *
 * Every strategy exports: id, name, description, params (UI schema),
 * and onTick(ctx) -> array of actions. See "Adding a strategy" in the README.
 */

const { priceAt } = require('../model');

const params = [
  { key: 'stakeUsd', label: 'Stake per trade ($)', type: 'number', default: 25, min: 1, max: 1000, step: 1 },
  { key: 'minElapsedSec', label: 'Wait after window opens (s)', type: 'number', default: 120, min: 0, max: 840, step: 10 },
  { key: 'stopEntrySecBeforeEnd', label: 'No new entries in last (s)', type: 'number', default: 60, min: 0, max: 600, step: 10 },
  { key: 'minMoveBps', label: 'Min move vs price to beat (bps)', type: 'number', default: 8, min: 0, max: 200, step: 1 },
  { key: 'lookbackSec', label: 'Trend lookback (s)', type: 'number', default: 60, min: 10, max: 600, step: 10 },
  { key: 'minTrendBps', label: 'Min trend over lookback (bps)', type: 'number', default: 2, min: 0, max: 100, step: 0.5 },
  { key: 'maxEntryPrice', label: 'Max entry price (¢ as 0–1)', type: 'number', default: 0.75, min: 0.05, max: 0.99, step: 0.01 },
  { key: 'maxSpread', label: 'Max bid/ask spread', type: 'number', default: 0.04, min: 0.01, max: 0.2, step: 0.01 },
  { key: 'takeProfit', label: 'Take profit at bid ≥ (0 = hold)', type: 'number', default: 0.95, min: 0, max: 0.99, step: 0.01 },
  { key: 'stopLoss', label: 'Stop loss at bid ≤ (0 = off)', type: 'number', default: 0.2, min: 0, max: 0.9, step: 0.01 },
  { key: 'maxEntriesPerWindow', label: 'Max entries per window', type: 'number', default: 1, min: 1, max: 5, step: 1 },
];

function onTick(ctx) {
  const { now, market, btc, priceToBeat, quotes, positions, p, state } = ctx;
  const actions = [];
  if (!market || !priceToBeat || !btc.price) return actions;

  // ---- exits on open positions in this window
  for (const pos of positions) {
    if (pos.slug !== market.slug) continue;
    const bid = quotes[pos.outcome] && quotes[pos.outcome].bid;
    if (bid == null) continue;
    if (p.takeProfit > 0 && bid >= p.takeProfit) actions.push({ type: 'sell', positionId: pos.id, reason: `take profit (bid ${bid})` });
    else if (p.stopLoss > 0 && bid <= p.stopLoss) actions.push({ type: 'sell', positionId: pos.id, reason: `stop loss (bid ${bid})` });
  }

  // ---- entries
  const nowSec = now / 1000;
  const elapsed = nowSec - market.start;
  const left = market.end - nowSec;
  if (elapsed < p.minElapsedSec || left < p.stopEntrySecBeforeEnd) return actions;
  state.entries ||= {};
  const keys = Object.keys(state.entries);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete state.entries[k];
  const entries = state.entries[market.slug] || 0;
  if (entries >= p.maxEntriesPerWindow) return actions;

  const moveBps = ((btc.price - priceToBeat) / priceToBeat) * 1e4;
  const past = priceAt(btc.history, now - p.lookbackSec * 1000);
  if (past == null) return actions;
  const trendBps = ((btc.price - past) / past) * 1e4;

  let side = null;
  if (moveBps >= p.minMoveBps && trendBps >= p.minTrendBps) side = 'Up';
  else if (moveBps <= -p.minMoveBps && trendBps <= -p.minTrendBps) side = 'Down';
  if (!side) return actions;

  const q = quotes[side];
  if (!q || q.ask == null || q.bid == null) return actions;
  if (q.ask > p.maxEntryPrice) return actions;
  if (q.ask - q.bid > p.maxSpread) return actions;

  state.entries[market.slug] = entries + 1;
  actions.push({
    type: 'buy',
    outcome: side,
    usd: p.stakeUsd,
    reason: `move ${moveBps.toFixed(1)}bps, trend ${trendBps.toFixed(1)}bps/${p.lookbackSec}s, ask ${q.ask}`,
  });
  return actions;
}

module.exports = {
  id: 'momentum',
  name: 'Momentum',
  description: 'Buys the side BTC is already moving toward, once the move is confirmed by a short-term trend and the market price is still below your max entry.',
  params,
  initState: () => ({ entries: {} }),
  onTick,
};
