/**
 * optionGreeks.js — Black-Scholes implied volatility + option Greeks.
 *
 * Display-only (no money/margin impact): given spot, strike, time-to-expiry and
 * the market premium, we back out the implied vol, then compute Delta / Gamma /
 * Theta / Vega. Used to enrich the option-chain API.
 *
 * Conventions: IV as a fraction (0.14 = 14%); Theta per DAY; Vega per 1% vol.
 * Risk-free rate via RISK_FREE_RATE (default 6.5%, India-ish).
 */
const R = Number(process.env.RISK_FREE_RATE) || 0.065;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SQRT2PI_INV = 0.3989422804014327;

// Standard normal CDF (Zelen & Severo approximation) + PDF.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = SQRT2PI_INV * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
const normPdf = (x) => SQRT2PI_INV * Math.exp(-x * x / 2);

function bsPrice(type, S, K, T, r, sigma) {
  const sq = sigma * Math.sqrt(T);
  if (sq <= 0) return type === 'CE' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  return type === 'CE'
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// Implied vol by bisection (robust, monotonic in sigma).
function impliedVol(type, mkt, S, K, T, r) {
  if (!(mkt > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = type === 'CE' ? Math.max(S - K * Math.exp(-r * T), 0) : Math.max(K * Math.exp(-r * T) - S, 0);
  if (mkt < intrinsic - 1e-6) return null; // price below intrinsic — can't solve
  let lo = 0.001; let hi = 5;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, S, K, T, r, mid) > mkt) hi = mid; else lo = mid;
  }
  const iv = (lo + hi) / 2;
  return (iv > 4.9 || iv < 0.0011) ? null : iv; // hit a bound → unreliable
}

function greeks(type, S, K, T, r, sigma) {
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  const nd1 = normPdf(d1);
  return {
    delta: type === 'CE' ? normCdf(d1) : normCdf(d1) - 1,
    gamma: nd1 / (S * sigma * sq),
    vega: (S * nd1 * sq) / 100,                                   // per 1% vol
    theta: ((type === 'CE'
      ? -(S * nd1 * sigma) / (2 * sq) - r * K * Math.exp(-r * T) * normCdf(d2)
      : -(S * nd1 * sigma) / (2 * sq) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365), // per day
  };
}

/**
 * @returns {{iv,delta,gamma,theta,vega}|null} rounded; null if uncomputable.
 */
function computeForOption({ type, S, K, expiryMs, premium, r = R }) {
  const T = (Number(expiryMs) - Date.now()) / YEAR_MS;
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(premium > 0)) return null;
  const iv = impliedVol(type, Number(premium), S, K, T, r);
  if (iv == null) return { iv: null, delta: null, gamma: null, theta: null, vega: null };
  const g = greeks(type, S, K, T, r, iv);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return { iv: r4(iv), delta: r4(g.delta), gamma: r4(g.gamma), theta: Math.round(g.theta * 100) / 100, vega: Math.round(g.vega * 100) / 100 };
}

module.exports = { computeForOption, impliedVol, greeks, bsPrice };
