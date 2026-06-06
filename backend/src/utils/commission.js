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
const { mul } = require('./decimal');

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

module.exports = { resolveCommissionType, computeInstrumentCommission };
