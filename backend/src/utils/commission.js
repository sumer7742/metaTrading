/**
 * Instrument commission — single source of truth for the per-instrument
 * commission model. Exactly one method is active:
 *
 *   FIXED      → commission = commissionPerTrade   (flat fee per trade)
 *   PERCENTAGE → commission = notional × commissionPercent
 *
 * `commissionType` drives the choice. For legacy instruments written before
 * the type field existed, we infer it (a non-zero commissionPercent ⇒
 * PERCENTAGE, else FIXED) so behaviour stays correct until the boot backfill
 * stamps an explicit type.
 */
const { mul, gt } = require('./decimal');

function resolveCommissionType(instrument) {
  const t = String(instrument?.commissionType || '').toUpperCase();
  if (t === 'FIXED' || t === 'PERCENTAGE') return t;
  return Number(instrument?.commissionPercent) > 0 ? 'PERCENTAGE' : 'FIXED';
}

// Returns the commission (as a decimal string) for a trade of the given
// notional value (price × quantity) on this instrument.
function computeInstrumentCommission(instrument, notional) {
  if (resolveCommissionType(instrument) === 'FIXED') {
    return String(instrument?.commissionPerTrade || '0');
  }
  return mul(String(notional || '0'), String(instrument?.commissionPercent || '0'));
}

// Find the per-account-type commission override for `accountType` on this
// instrument, or null when none (→ caller inherits the account-type default).
function findCommissionOverride(instrument, accountType) {
  const list = instrument?.commissionOverrides;
  if (!accountType || !Array.isArray(list) || !list.length) return null;
  const code = String(accountType).toUpperCase();
  return list.find((o) => String(o.accountType || '').toUpperCase() === code) || null;
}

// Commission for a closing trade under an override config:
//   FIXED         → flat commissionValue
//   PERCENTAGE    → notional × commissionValue (raw fraction)
//   PCT_OF_PROFIT → realizedProfit × commissionValue, ONLY when pnl > 0
//                   (loss / breakeven → 0)
function computeOverrideCommission(override, notional, pnl) {
  if (!override) return null;
  const t = String(override.commissionType).toUpperCase();
  if (t === 'FIXED') return String(override.commissionValue || 0);
  if (t === 'PCT_OF_PROFIT') {
    if (!gt(String(pnl || '0'), '0')) return '0';   // only profitable closes
    return mul(String(pnl || '0'), String(override.commissionValue || 0));
  }
  return mul(String(notional || '0'), String(override.commissionValue || 0)); // PERCENTAGE
}

module.exports = {
  resolveCommissionType,
  computeInstrumentCommission,
  findCommissionOverride,
  computeOverrideCommission,
};
