/**
 * optionUniverse.js — decides which option contracts the platform keeps ACTIVE.
 *
 * The Dhan scrip master lists every strike of every expiry (~6k contracts for a
 * few index underlyings). Holding them all floods the instrument APIs, the live
 * feed and WebSocket fan-out. This module picks a small, tradeable near-expiry
 * chain per underlying instead. Shared by:
 *   - services/dhanInstrumentSync.js   (import filter)
 *   - scripts/cleanup-options.js       (one-off DB migration)
 *
 * Rules (all env-tunable, safe defaults):
 *   DHAN_SYNC_FNO       underlyings to keep options for
 *                       (default NIFTY,BANKNIFTY,FINNIFTY)
 *   DHAN_OPT_EXPIRIES   keep the N nearest non-expired expiries / underlying
 *                       (default 2)
 *   DHAN_OPT_STRIKE_PCT keep strikes within ±N% of the underlying's reference
 *                       (ATM) price; 0/unset = keep all strikes
 *                       (default 12)
 */
const DAY = 24 * 60 * 60 * 1000;

const { FNO_UNDERLYINGS } = require('../config/indianFnoUnderlyings');
const FO_UNDERLYINGS = FNO_UNDERLYINGS;
const OPT_EXPIRIES = Math.max(1, Number(process.env.DHAN_OPT_EXPIRIES) || 2);
const OPT_STRIKE_PCT = process.env.DHAN_OPT_STRIKE_PCT != null
  ? Number(process.env.DHAN_OPT_STRIKE_PCT)
  : 12;

const isUnderlyingAllowed = (u) => FO_UNDERLYINGS.includes(String(u || '').toUpperCase());

// Start-of-today (local) — an option expiring today is still tradeable, one that
// expired yesterday is not.
function todayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whether an expiry timestamp is today or in the future (i.e. not expired). */
function isLiveExpiry(expiryTs, now = Date.now()) {
  return Number.isFinite(expiryTs) && expiryTs >= todayStart(now);
}

/**
 * From a list of expiry timestamps, return a Set of the N nearest that are not
 * expired. (N defaults to OPT_EXPIRIES.)
 */
function nearestExpiries(expiryTsList, now = Date.now(), n = OPT_EXPIRIES) {
  const live = [...new Set(expiryTsList.filter((t) => isLiveExpiry(t, now)))].sort((a, b) => a - b);
  return new Set(live.slice(0, n));
}

/**
 * Keep a strike only if it's within ±OPT_STRIKE_PCT of the reference (ATM)
 * price. No reference (price unknown) or pct<=0 → keep all strikes.
 */
function strikeInWindow(strike, refPrice) {
  if (!(OPT_STRIKE_PCT > 0) || !(refPrice > 0)) return true;
  const k = Number(strike);
  if (!Number.isFinite(k) || k <= 0) return true;
  return Math.abs(k - refPrice) <= refPrice * (OPT_STRIKE_PCT / 100);
}

module.exports = {
  FO_UNDERLYINGS,
  OPT_EXPIRIES,
  OPT_STRIKE_PCT,
  isUnderlyingAllowed,
  isLiveExpiry,
  nearestExpiries,
  strikeInWindow,
};
