'use strict';
// Strategy registry. To add a strategy: create a file in this folder that
// exports { id, name, description, params, initState, onTick } and add it below.
// Any number of strategies can run at once; each has its own parameters, state
// and positions.

const momentum = require('./momentum');
const fairValue = require('./fairValue');
const lateSniper = require('./lateSniper');
const pairArb = require('./pairArb');

const strategies = [momentum, fairValue, lateSniper, pairArb];

function getStrategy(id) {
  return strategies.find((s) => s.id === id) || strategies[0];
}

function hasStrategy(id) {
  return strategies.some((s) => s.id === id);
}

function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map((x) => [x.key, x.default]));
}

/** Clamp/clean user-entered params against the schema. */
function sanitiseParams(strategy, input = {}) {
  const out = defaultParams(strategy);
  for (const s of strategy.params) {
    const raw = input == null ? undefined : input[s.key];
    if (raw === '' || raw == null) continue;
    let v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (s.min != null) v = Math.max(s.min, v);
    if (s.max != null) v = Math.min(s.max, v);
    out[s.key] = v;
  }
  return out;
}

module.exports = { strategies, getStrategy, hasStrategy, defaultParams, sanitiseParams };
