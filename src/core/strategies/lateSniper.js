'use strict';
/**
 * Late-window favourite ("endgame sniping").
 *
 * Idea: in the final stretch of a window the outcome is often all but decided
 * — BTC is far from the price to beat relative to how much it can still move —
 * yet the favourite can still be bought a few cents under $1. Buy it and hold
 * to settlement. Polymarket's fee is smallest near the extremes, which is what
 * makes these small margins workable.
 *
 * Wins often and pays little; one reversal costs many wins. `minProb` and
 * `volMult` control how certain the model must be before it buys.
 */

const { fairUp } = require('../model');

const params = [
  { key: 'stakeUsd', label: 'Stake per trade ($)', type: 'number', default: 50, min: 1, max: 1000, step: 1 },
  { key: 'windowSec', label: 'Only trade in the last (s)', type: 'number', default: 90, min: 5, max: 600, step: 5 },
  { key: 'minSecLeft', label: 'Stop entering in the last (s)', type: 'number', default: 4, min: 0, max: 120, step: 1 },
  { key: 'minProb', label: 'Min model probability (0–1)', type: 'number', default: 0.96, min: 0.6, max: 0.995, step: 0.005 },
  { key: 'minEdge', label: 'Min edge after fees (0–1)', type: 'number', default: 0.02, min: 0.002, max: 0.3, step: 0.002 },
  { key: 'minEntryPrice', label: 'Min entry price (0–1)', type: 'number', default: 0.6, min: 0.5, max: 0.98, step: 0.01 },
  { key: 'maxEntryPrice', label: 'Max entry price (0–1)', type: 'number', default: 0.97, min: 0.6, max: 0.99, step: 0.005 },
  { key: 'volMult', label: 'Volatility safety multiplier', type: 'number', default: 1.25, min: 0.5, max: 3, step: 0.05 },
  { key: 'maxSpread', label: 'Max bid/ask spread', type: 'number', default: 0.03, min: 0.005, max: 0.2, step: 0.005 },
  { key: 'bailProb', label: 'Bail out if model probability falls below (0 = hold)', type: 'number', default: 0.55, min: 0, max: 0.95, step: 0.01 },
  { key: 'maxEntriesPerWindow', label: 'Max entries per window', type: 'number', default: 1, min: 1, max: 5, step: 1 },
];

function onTick(ctx) {
  const { now, market, quotes, positions, p, state } = ctx;
  const actions = [];
  const pUp = fairUp(ctx, p.volMult);
  if (pUp == null) return actions;

  // ---- exits: only if the model no longer backs the position
  for (const pos of positions) {
    if (pos.slug !== market.slug || !(p.bailProb > 0)) continue;
    const fair = pos.outcome === 'Up' ? pUp : 1 - pUp;
    if (fair < p.bailProb) actions.push({ type: 'sell', positionId: pos.id, reason: `model probability fell to ${fair.toFixed(3)}` });
  }

  // ---- entries
  const left = market.end - now / 1000;
  if (left > p.windowSec || left < p.minSecLeft) return actions;
  state.entries ||= {};
  const entries = state.entries[market.slug] || 0;
  if (entries >= p.maxEntriesPerWindow) return actions;

  const side = pUp >= 0.5 ? 'Up' : 'Down';
  const fair = side === 'Up' ? pUp : 1 - pUp;
  if (fair < p.minProb) return actions;
  const q = quotes[side];
  if (!q || q.ask == null || q.bid == null) return actions;
  if (q.ask < p.minEntryPrice || q.ask > p.maxEntryPrice || q.ask - q.bid > p.maxSpread) return actions;
  const fee = ctx.fee(q.ask);
  const edge = fair - q.ask - fee;
  if (edge < p.minEdge) return actions;

  state.entries[market.slug] = entries + 1;
  const keys = Object.keys(state.entries);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete state.entries[k];
  actions.push({
    type: 'buy',
    outcome: side,
    usd: p.stakeUsd,
    maxPrice: Math.min(p.maxEntryPrice, fair - fee - p.minEdge),
    reason: `${Math.round(left)}s left, model ${fair.toFixed(3)} vs ask ${q.ask} (edge ${(edge * 100).toFixed(1)}¢ after fees)`,
  });
  return actions;
}

module.exports = {
  id: 'late-sniper',
  name: 'Late-window favourite',
  description: 'Waits for the last minute or so, then buys the side that is all but certain to win if it is still on offer below its modelled value. Holds to settlement. Many small wins, occasional full loss.',
  params,
  initState: () => ({ entries: {} }),
  onTick,
};
