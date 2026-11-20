'use strict';
// Strategy registry. To add a strategy: create a file in this folder that
// exports { id, name, description, params, initState, onTick } and add it below.

const momentum = require('./momentum');

const strategies = [momentum];

function getStrategy(id) {
  return strategies.find((s) => s.id === id) || strategies[0];
}

function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map((x) => [x.key, x.default]));
}

/** Clamp/clean user-entered params against the schema. */
function sanitiseParams(strategy, input = {}) {
  const out = defaultParams(strategy);
  for (const s of strategy.params) {
    let v = Number(input[s.key]);
    if (!Number.isFinite(v)) continue;
    if (s.min != null) v = Math.max(s.min, v);
    if (s.max != null) v = Math.min(s.max, v);
    out[s.key] = v;
  }
  return out;
}

module.exports = { strategies, getStrategy, defaultParams, sanitiseParams };
