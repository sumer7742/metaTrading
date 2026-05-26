/**
 * Account-type catalogue — single source of truth for the 6 trading-
 * account tiers. The matching engine, order controller, auth signup,
 * and frontend all read from this map so a tweak here propagates
 * everywhere without scattered constants.
 *
 * Each entry defines:
 *   label         — human display name on the account picker
 *   description   — short pitch shown in marketing/dropdowns
 *   minDeposit    — USD threshold to start trading (UI hint + deposit gate)
 *   maxLeverage   — number cap, or null = unlimited
 *   feeModel      — { kind, value, lossWaive }
 *                     kind: 'PCT_OF_VALUE'      → value × notional (raw decimal, NOT percent)
 *                           'FIXED_PER_TRADE'   → flat $value charged per close
 *                           'PCT_OF_PROFIT'     → value × max(pnl, 0) on close
 *                     lossWaive: true → fee = 0 when the close booked a loss
 *   buyCloseOnly  — when true, the account can open BUY (LONG) only;
 *                   SELL is permitted only as a close (reduceOnly/closeOnly).
 *                   This is what the "ic" suffix encodes.
 *   sortOrder     — UI ordering on the picker
 */
const ACCOUNT_TYPE_DEFS = {
  STANDARD: {
    label: 'Standard',
    description: 'Capped leverage, transparent % fees. The classic retail tier.',
    minDeposit: 100,
    maxLeverage: 100,
    feeModel: { kind: 'PCT_OF_VALUE', value: 0.00005, lossWaive: false }, // 0.005% of trade value
    feeDisplay: '0.005% of trade value',
    buyCloseOnly: false,
    sortOrder: 1,
  },
  STANDARD_IC: {
    label: 'Standard IC',
    description: 'Lowest barrier to entry — buy-only with unlimited leverage.',
    minDeposit: 10,
    maxLeverage: null,
    feeModel: { kind: 'PCT_OF_VALUE', value: 0.00005, lossWaive: false },
    feeDisplay: '0.005% of trade value',
    buyCloseOnly: true,
    sortOrder: 2,
  },
  PRO: {
    label: 'Pro',
    description: 'Flat per-trade fee — best for high-volume traders.',
    minDeposit: 500,
    maxLeverage: null,
    feeModel: { kind: 'FIXED_PER_TRADE', value: 0.1, lossWaive: false },
    feeDisplay: '$0.10 fixed per trade',
    buyCloseOnly: false,
    sortOrder: 3,
  },
  PRO_IC: {
    label: 'Pro IC',
    description: 'Flat per-trade fee · buy-only entries.',
    minDeposit: 300,
    maxLeverage: null,
    feeModel: { kind: 'FIXED_PER_TRADE', value: 0.1, lossWaive: false },
    feeDisplay: '$0.10 fixed per trade',
    buyCloseOnly: true,
    sortOrder: 4,
  },
  FREE: {
    label: 'Free',
    description: 'No fee on losses. We only take a slice when you win.',
    minDeposit: 1000,
    maxLeverage: null,
    feeModel: { kind: 'PCT_OF_PROFIT', value: 0.01, lossWaive: true }, // 1% of profit, 0 on losing trade
    feeDisplay: '1% of profit · zero fee on losses',
    buyCloseOnly: false,
    sortOrder: 5,
  },
  FREE_IC: {
    label: 'Free IC',
    description: 'No fee on losses · buy-only entries.',
    minDeposit: 800,
    maxLeverage: null,
    feeModel: { kind: 'PCT_OF_PROFIT', value: 0.01, lossWaive: true },
    feeDisplay: '1% of profit · zero fee on losses',
    buyCloseOnly: true,
    sortOrder: 6,
  },
};

const ACCOUNT_TYPE_CODES = Object.keys(ACCOUNT_TYPE_DEFS);

// Legacy types preserved so existing TradingAccount documents still load.
// Treated as STANDARD for fee/leverage purposes when the legacy account
// hasn't been migrated yet.
const LEGACY_TYPES = ['REAL', 'DEMO', 'VIRTUAL', 'CUSTOM'];

/**
 * Look up the canonical metadata for an account. Falls back to STANDARD
 * for legacy / unknown types so existing accounts keep functioning.
 */
function getAccountTypeDef(accountType) {
  if (accountType && ACCOUNT_TYPE_DEFS[accountType]) return ACCOUNT_TYPE_DEFS[accountType];
  return ACCOUNT_TYPE_DEFS.STANDARD;
}

/**
 * Public-facing list (label/description/limits) sent to the frontend so
 * the account-creation picker shows the same metadata that drives the
 * actual trading rules.
 */
function listPublicAccountTypes() {
  return ACCOUNT_TYPE_CODES.map((code) => ({
    code,
    ...ACCOUNT_TYPE_DEFS[code],
  })).sort((a, b) => a.sortOrder - b.sortOrder);
}

module.exports = {
  ACCOUNT_TYPE_DEFS,
  ACCOUNT_TYPE_CODES,
  LEGACY_TYPES,
  getAccountTypeDef,
  listPublicAccountTypes,
};
