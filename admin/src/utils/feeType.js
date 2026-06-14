/**
 * Fee-type DISPLAY grouping (presentation only).
 *
 * Internal values are NEVER changed — this maps an existing fee-type code to a
 * user-facing category + label so screens can group them consistently:
 *
 *   Commission
 *     • Percentage              ← PERCENTAGE / PCT_OF_VALUE
 *   Charges
 *     • Fixed                   ← FIXED / FIXED_PER_TRADE
 *     • Percentage of Profit    ← PCT_OF_PROFIT
 *
 * NOTE: This is used only on fee DISPLAY screens. The Instrument Override
 * module is intentionally left untouched.
 */
const FEE_TYPE_META = {
  PERCENTAGE:      { group: 'Commission', label: 'Percentage' },
  PCT_OF_VALUE:    { group: 'Commission', label: 'Percentage' },
  FIXED:           { group: 'Charges',    label: 'Fixed' },
  FIXED_PER_TRADE: { group: 'Charges',    label: 'Fixed' },
  PCT_OF_PROFIT:   { group: 'Charges',    label: 'Percentage of Profit' },
};

// Accepts either the account-tier `feeKind` (PCT_OF_VALUE/…) or the
// instrument-level `commissionType` (PERCENTAGE/…). Returns null if unknown.
export const feeTypeMeta = (code) => FEE_TYPE_META[String(code || '').toUpperCase()] || null;

// "Commission · Percentage" / "Charges · Fixed" / "" when unknown.
export const feeTypeText = (code) => {
  const m = feeTypeMeta(code);
  return m ? `${m.group} · ${m.label}` : '';
};

// Grouped label + the existing free-text detail (e.g. "0.005% of trade value").
// Falls back to the detail alone when the code is unknown.
export const feeTypeWithDetail = (code, detail) => {
  const text = feeTypeText(code);
  if (text && detail) return `${text} — ${detail}`;
  return text || detail || '—';
};
