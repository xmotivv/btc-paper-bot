'use strict';
/**
 * Fair-value edge (also called spot-lag or latency arbitrage).
 *
 * Idea: at any moment the chance BTC finishes above the price to beat can be
 * estimated from three numbers — how far BTC is from the price to beat, how
 * volatile it has been, and how much time is left. Polymarket quotes lag the
 * spot market by a beat, so when a quote sits well below that estimate (after
 * the taker fee), buy it. Sell if the market later pays more than the estimate.
 *
 * The edge is only as good as the model: `volMult` widens the volatility so the
 * model is less sure of itself, and `minEdge` is the margin of safety.
 */

const { fairUp } = require('../model');

const params = [
  { key: 'stakeUsd', label: 'Stake per trade ($)', type: 'number', default: 25, min: 1, max: 1000, step: 1 },
  { key: 'minEdge', label: 'Min edge after fees (0–1)', type: 'number', default: 0.05, min: 0.005, max: 0.5, step: 0.005 },
  { key: 'volMult', label: 'Volatility safety multiplier', type: 'number', default: 1.15, min: 0.5, max: 3, step: 0.05 },
  { key: 'minElapsedSec', label: 'Wait after window opens (s)', type: 'number', default: 30, min: 0, max: 840, step: 5 },
  { key: 'stopEntrySecBeforeEnd', label: 'No new entries in last (s)', type: 'number', default: 15, min: 0, max: 600, step: 5 },
  { key: 'minEntryPrice', label: 'Min entry price (0–1)', type: 'number', default: 0.1, min: 0.01, max: 0.9, step: 0.01 },
  { key: 'maxEntryPrice', label: 'Max entry price (0–1)', type: 'number', default: 0.9, min: 0.1, max: 0.99, step: 0.01 },
  { key: 'maxSpread', label: 'Max bid/ask spread', type: 'number', default: 0.04, min: 0.01, max: 0.2, step: 0.01 },
  { key: 'exitEdge', label: 'Sell when bid beats fair value by (0 = hold)', type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.005 },
  { key: 'stopProb', label: 'Bail out if fair value falls below (0 = hold)', type: 'number', default: 0, min: 0, max: 0.9, step: 0.01 },
  { key: 'cooldownSec', label: 'Min gap between entries (s)', type: 'number', default: 30, min: 0, max: 600, step: 5 },
  { key: 'maxEntriesPerWindow', label: 'Max entries per window', type: 'number', default: 2, min: 1, max: 10, step: 1 },
];

function prune(map, keep = 50) {
  const keys = Object.keys(map);
  if (keys.length > keep) for (const k of keys.slice(0, keys.length - keep)) delete map[k];
}

function onTick(ctx) {
  const { now, market, quotes, positions, p, state } = ctx;
  const actions = [];
  const pUp = fairUp(ctx, p.volMult);
  if (pUp == null) return actions;
  const fairOf = (side) => (side === 'Up' ? pUp : 1 - pUp);

  // ---- exits
  let held = null;
  for (const pos of positions) {
    if (pos.slug !== market.slug) continue;
    held = pos.outcome;
    const bid = quotes[pos.outcome] && quotes[pos.outcome].bid;
    if (bid == null) continue;
    const fair = fairOf(pos.outcome);
    if (p.exitEdge > 0 && bid - ctx.fee(bid) - fair >= p.exitEdge) {
      actions.push({ type: 'sell', positionId: pos.id, reason: `bid ${bid} above fair ${fair.toFixed(3)}` });
    } else if (p.stopProb > 0 && fair <= p.stopProb) {
      actions.push({ type: 'sell', positionId: pos.id, reason: `fair value fell to ${fair.toFixed(3)}` });
    }
  }

  // ---- entries
  const nowSec = now / 1000;
  if (nowSec - market.start < p.minElapsedSec || market.end - nowSec < p.stopEntrySecBeforeEnd) return actions;
  state.entries ||= {};
  state.last ||= {};
  const entries = state.entries[market.slug] || 0;
  if (entries >= p.maxEntriesPerWindow) return actions;
  if (now - (state.last[market.slug] || 0) < p.cooldownSec * 1000) return actions;

  let best = null;
  for (const side of ['Up', 'Down']) {
    if (held && held !== side) continue; // never hold both sides of one window
    const q = quotes[side];
    if (!q || q.ask == null || q.bid == null) continue;
    if (q.ask < p.minEntryPrice || q.ask > p.maxEntryPrice || q.ask - q.bid > p.maxSpread) continue;
    const fee = ctx.fee(q.ask);
    const edge = fairOf(side) - q.ask - fee;
    if (edge >= p.minEdge && (!best || edge > best.edge)) best = { side, edge, ask: q.ask, fee, fair: fairOf(side) };
  }
  if (!best) return actions;

  state.entries[market.slug] = entries + 1;
  state.last[market.slug] = now;
  prune(state.entries);
  prune(state.last);
  actions.push({
    type: 'buy',
    outcome: best.side,
    usd: p.stakeUsd,
    maxPrice: best.fair - best.fee - p.minEdge, // only take levels that still clear the minimum edge
    reason: `fair ${best.fair.toFixed(3)} vs ask ${best.ask} (edge ${(best.edge * 100).toFixed(1)}¢ after fees)`,
  });
  return actions;
}

module.exports = {
  id: 'fair-value',
  name: 'Fair-value edge',
  description: 'Prices each side from BTC\'s distance to the price to beat, recent volatility and time left, then buys whichever side Polymarket is quoting well below that value after fees. Sells if the market later overpays.',
  params,
  initState: () => ({ entries: {}, last: {} }),
  onTick,
};
