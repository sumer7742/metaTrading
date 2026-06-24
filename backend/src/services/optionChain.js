/**
 * optionChain.js — build a VALIDATED option chain. Data correctness first.
 *
 * Rules:
 *  • NEVER emit 0.00 for a missing/invalid premium — emit null (UI shows "--").
 *  • Reject non-positive / NaN ticks (NO_PRICE) and prices below intrinsic
 *    against the forward/future (BELOW_INTRINSIC = stale or mis-mapped).
 *  • Flag stale ticks (age > OPTION_STALE_SEC).
 *  • Attach Black-Scholes Greeks ONLY when the premium is trustworthy; invalid IV
 *    → null (UI shows "N/A").
 *  • Report monotonicity violations (CE non-increasing, PE non-decreasing in
 *    strike) — flagged, never silently "fixed".
 *
 * Reference price (ref) is the FUTURE of the chain's expiry (the forward the
 * option is actually priced off), so intrinsic = max(F−K,0) / max(K−F,0).
 * Pure + unit-tested (see backend/tests/optionChain.test.js).
 */
const { computeForOption } = require('./optionGreeks');

const STALE_MS = (Number(process.env.OPTION_STALE_SEC) || 15) * 1000;
const round2 = (x) => Math.round(Number(x) * 100) / 100;

/**
 * Validate one CE/PE leg → a safe, typed record. `ltp` is null (never 0) when
 * the price can't be trusted.
 */
function validateLeg(doc, { type, ref, refExpiryMs, now = Date.now() }) {
  if (!doc) return null;
  const K = Number(doc.strike);
  const px = Number(doc.lastPrice);
  const tick = Number(doc.tickSize) || 0.05;
  const ageMs = doc.lastPriceUpdatedAt ? now - new Date(doc.lastPriceUpdatedAt).getTime() : null;
  const intrinsic = ref > 0 && K > 0 ? (type === 'CE' ? Math.max(ref - K, 0) : Math.max(K - ref, 0)) : null;

  let valid = true;
  let reason = null;
  if (!Number.isFinite(px) || px <= 0) {
    valid = false; reason = 'NO_PRICE';
  } else if (intrinsic != null && px < intrinsic - Math.max(2 * tick, intrinsic * 0.01)) {
    // Below intrinsic vs the forward by more than a small tolerance → stale/bad.
    valid = false; reason = 'BELOW_INTRINSIC';
  }

  const stale = ageMs != null && ageMs > STALE_MS;
  // ref is the FUTURE (forward), so use r=0 (Black-76 approximation): intrinsic
  // = max(F−K,0), consistent with the validation above — otherwise discounting
  // the strike makes IV unsolvable for legitimate near-the-forward premiums.
  const greeks = valid && ref > 0 && refExpiryMs
    ? computeForOption({ type, S: ref, K, expiryMs: refExpiryMs, premium: px, r: 0 })
    : null;

  return {
    symbol: doc.symbol,
    token: doc.instrumentToken || null,
    lotSize: doc.lotSize || null,
    ltp: valid ? String(doc.lastPrice) : null,                  // null ⇒ "--"
    intrinsic: intrinsic != null ? round2(intrinsic) : null,
    timeValue: valid && intrinsic != null ? round2(px - intrinsic) : null,
    stale,
    ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
    valid,
    reason,
    iv: greeks ? greeks.iv : null,                              // null ⇒ "N/A"
    delta: greeks ? greeks.delta : null,
    gamma: greeks ? greeks.gamma : null,
    theta: greeks ? greeks.theta : null,
    vega: greeks ? greeks.vega : null,
  };
}

// CE premium should be non-increasing in strike; PE non-decreasing. Flag only.
function checkIntegrity(rows) {
  const ce = rows.filter((r) => r.ce && r.ce.valid).map((r) => [Number(r.strike), Number(r.ce.ltp)]);
  const pe = rows.filter((r) => r.pe && r.pe.valid).map((r) => [Number(r.strike), Number(r.pe.ltp)]);
  let ceV = 0; let peV = 0;
  for (let i = 1; i < ce.length; i += 1) if (ce[i][1] > ce[i - 1][1] + 1e-6) ceV += 1;
  for (let i = 1; i < pe.length; i += 1) if (pe[i][1] < pe[i - 1][1] - 1e-6) peV += 1;
  const invalidLegs = rows.reduce((n, r) => n + (r.ce && !r.ce.valid ? 1 : 0) + (r.pe && !r.pe.valid ? 1 : 0), 0);
  const staleLegs = rows.reduce((n, r) => n + (r.ce && r.ce.stale ? 1 : 0) + (r.pe && r.pe.stale ? 1 : 0), 0);
  return { ceMonotonicityViolations: ceV, peMonotonicityViolations: peV, invalidLegs, staleLegs };
}

/**
 * @param {object} p
 * @param {Array}  p.options      raw OPT instrument docs (symbol, strike, optionType, expiryDate, lastPrice, lastPriceUpdatedAt, lotSize, instrumentToken, tickSize)
 * @param {string} p.expiryIso    chain expiry (ISO) to build
 * @param {number} p.ref          forward/future price for that expiry
 * @param {number} p.refExpiryMs  expiry ms (for Greeks T)
 * @returns {{rows, atm, integrity}}
 */
function buildChain({ options, expiryIso, ref, refExpiryMs, now = Date.now() }) {
  const byStrike = new Map();
  for (const o of options) {
    if (!o.expiryDate || new Date(o.expiryDate).toISOString() !== expiryIso) continue;
    const k = String(o.strike);
    if (!byStrike.has(k)) byStrike.set(k, { strike: o.strike, ce: null, pe: null });
    if (o.optionType === 'CE') byStrike.get(k).ce = validateLeg(o, { type: 'CE', ref, refExpiryMs, now });
    else if (o.optionType === 'PE') byStrike.get(k).pe = validateLeg(o, { type: 'PE', ref, refExpiryMs, now });
  }
  const rows = [...byStrike.values()].sort((a, b) => Number(a.strike) - Number(b.strike));

  let atm = null;
  if (ref > 0 && rows.length) {
    atm = rows.reduce((best, r) => (Math.abs(Number(r.strike) - ref) < Math.abs(Number(best.strike) - ref) ? r : best), rows[0]).strike;
  }
  return { rows, atm, integrity: checkIntegrity(rows) };
}

module.exports = { buildChain, validateLeg, checkIntegrity, STALE_MS };
