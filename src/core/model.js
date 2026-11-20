'use strict';
// Shared maths for strategies: price lookups, realised volatility and a
// fair-value model for "will BTC finish above the price to beat?".

/** Price at or before `tMs` in an oldest→newest [{t, p}] history (binary search). */
function priceAt(history, tMs) {
  let lo = 0;
  let hi = history.length - 1;
  if (hi < 0 || history[0].t > tMs) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (history[mid].t <= tMs) lo = mid;
    else hi = mid - 1;
  }
  return history[lo].p;
}

/**
 * Realised volatility as a fraction per √second, from returns sampled every
 * `stepSec` over the last `lookbackSec`. Returns null without enough history.
 */
function realisedVol(history, nowMs, lookbackSec = 300, stepSec = 5) {
  let prev = priceAt(history, nowMs);
  if (prev == null) return null;
  let sumSq = 0;
  let n = 0;
  for (let back = stepSec; back <= lookbackSec; back += stepSec) {
    const p = priceAt(history, nowMs - back * 1000);
    if (p == null) break;
    const r = Math.log(prev / p);
    sumSq += r * r;
    n++;
    prev = p;
  }
  if (n < 12) return null;
  return Math.sqrt(sumSq / (n * stepSec));
}

/** Volatility per √second from a list of evenly spaced closes (oldest→newest). */
function volFromCloses(closes, stepSec) {
  let sumSq = 0;
  let n = 0;
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) continue;
    const r = Math.log(closes[i] / closes[i - 1]);
    sumSq += r * r;
    n++;
  }
  return n >= 5 ? Math.sqrt(sumSq / (n * stepSec)) : null;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, error < 1e-7). */
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Probability that the settlement price ends at or above `strike`, treating
 * BTC as a driftless random walk with volatility `sigma` (fraction per √s).
 *
 * Polymarket settles these markets on a TWAP: the average price over the last
 * `twapSec` seconds. Averaging shrinks the uncertainty (an average of a random
 * walk over L seconds, seen from τ seconds out, has variance σ²(τ − 2L/3)), and
 * once inside the averaging window part of the result is already locked in:
 * `realisedMean` over `realisedSec` seconds.
 */
function probUp({ price, strike, sigma, secLeft, twapSec = 0, realisedMean = null, realisedSec = 0 }) {
  if (!(price > 0) || !(strike > 0) || !(sigma > 0)) return null;
  const tau = Math.max(0, secLeft);
  const L = Math.max(0, twapSec);
  let expected = price;
  let variance;
  if (L > 0 && tau < L) {
    const done = realisedMean > 0 ? Math.min(Math.max(0, realisedSec), L - tau) : 0;
    expected = done > 0 ? (realisedMean * done + price * (L - done)) / L : price;
    // Unobserved part of the window: the stretch still to come, plus any gap we have no samples for.
    const gap = L - tau - done;
    variance = sigma * sigma * ((tau * tau * tau) / (3 * L * L) + (gap > 0 ? (gap * gap * gap) / (3 * L * L) : 0));
  } else {
    variance = sigma * sigma * (L > 0 ? tau - (2 * L) / 3 : tau);
  }
  const sd = Math.sqrt(Math.max(variance, 0));
  if (sd < 1e-9) return expected >= strike ? 0.995 : 0.005;
  const p = normCdf(Math.log(expected / strike) / sd);
  return Math.min(0.995, Math.max(0.005, p));
}

/** Fair probability of "Up" for a strategy tick context, or null if it can't be modelled yet. */
function fairUp(ctx, volMult = 1) {
  if (!ctx.priceToBeat || !ctx.btc.price || !ctx.vol) return null;
  const s = ctx.settle || {};
  // A price to beat estimated from another exchange can be off by more than the edge being traded.
  if (s.strikeExact === false) return null;
  return probUp({
    price: ctx.btc.price + (s.basis || 0),
    strike: ctx.priceToBeat,
    sigma: ctx.vol * volMult,
    secLeft: ctx.market.end - ctx.now / 1000,
    twapSec: s.twapSec || 0,
    realisedMean: s.realisedMean,
    realisedSec: s.realisedSec || 0,
  });
}

module.exports = { priceAt, realisedVol, volFromCloses, normCdf, probUp, fairUp };
