/**
 * Client-side account-type helpers — mirror the backend's
 * config/accountTypes.js. The 6-tier catalogue (STANDARD / STANDARD_IC /
 * PRO / PRO_IC / FREE / FREE_IC) replaced the legacy REAL / DEMO /
 * VIRTUAL types. We keep these helpers thin so any new tier added on
 * the backend just shows up — no client deploy needed for the actual
 * types (only for any tier-specific labels/icons we might add).
 *
 * Legacy:
 *   REAL    — live money. Treated identically to the new 6 tiers.
 *   DEMO    — practice / virtual seed.
 *   VIRTUAL — synonym of DEMO.
 */
const LEGACY_DEMO_TYPES = new Set(['DEMO', 'VIRTUAL']);

/** True when this account is a real-money / live account (any non-demo). */
export function isLiveAccount(account) {
  if (!account) return false;
  const t = String(account.accountType || '').toUpperCase();
  return !LEGACY_DEMO_TYPES.has(t);
}

/** True only for legacy DEMO/VIRTUAL accounts (self-funded, no deposits). */
export function isDemoAccount(account) {
  if (!account) return false;
  const t = String(account.accountType || '').toUpperCase();
  return LEGACY_DEMO_TYPES.has(t);
}

/** Same predicate, but accepts a raw type string (for filter convenience). */
export function isLiveType(accountType) {
  const t = String(accountType || '').toUpperCase();
  return !LEGACY_DEMO_TYPES.has(t);
}

export function isDemoType(accountType) {
  const t = String(accountType || '').toUpperCase();
  return LEGACY_DEMO_TYPES.has(t);
}
