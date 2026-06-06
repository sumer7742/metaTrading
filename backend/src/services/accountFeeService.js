/**
 * Account-fee service — resolves the right fee for a close trade based
 * on the account's tier (STANDARD / PRO / FREE / + IC variants).
 *
 * Three fee models are supported, all defined in config/accountTypes.js:
 *
 *   PCT_OF_VALUE     — fee = closeNotional × rate   (e.g. STANDARD 0.005%)
 *   FIXED_PER_TRADE  — fee = flat $value per close  (e.g. PRO $0.10)
 *   PCT_OF_PROFIT    — fee = max(pnl, 0) × rate     (e.g. FREE 1% of profit)
 *
 * Each can have `lossWaive: true` which zeroes the fee on a losing close
 * (used by the FREE tier — "you only pay when you win").
 *
 * The matching engine calls computeCloseFee() during settlement; the
 * legacy instrument-level commissionPercent is only used if the account
 * has no tier metadata (truly orphaned legacy accounts).
 */
const accountPlansService = require('./accountPlansService');
const { mul, gt } = require('../utils/decimal');
const { computeInstrumentCommission } = require('../utils/commission');

/**
 * Resolve the live AccountPlan for an account from the cached
 * DB-backed catalogue. Falls back to STANDARD when the account's type
 * isn't in the catalogue (legacy REAL/DEMO/VIRTUAL docs or admin-
 * deleted plans that still have lingering accounts).
 */
async function _resolvePlan(account) {
  const code = account?.accountType;
  if (code) {
    const plan = await accountPlansService.getByCode(code);
    if (plan) return plan;
  }
  return (await accountPlansService.getByCode('STANDARD')) || null;
}

/**
 * Compute the close fee for a settled trade based on the account's
 * AccountPlan tier. The matching engine awaits this during settlement.
 *
 * @returns {Promise<string>} fee amount in account base currency
 */
async function computeCloseFee({ account, instrument, closeQty, closePrice, closePnl }) {
  const plan = await _resolvePlan(account);

  // No plan in DB and no STANDARD fallback — fall through to the instrument's
  // own commission setting (FIXED or PERCENTAGE), honouring its type.
  if (!plan) {
    return computeInstrumentCommission(instrument, mul(closeQty, closePrice));
  }

  // Loss-waive: no fee on a losing close. gt('0', x) === true ⇔ x < 0
  if (plan.lossWaive && gt('0', closePnl)) {
    return '0';
  }

  switch (plan.feeKind) {
    case 'PCT_OF_VALUE': {
      const notional = mul(closeQty, closePrice);
      return mul(notional, String(plan.feeValue));
    }
    case 'FIXED_PER_TRADE':
      return String(plan.feeValue);
    case 'PCT_OF_PROFIT':
      if (!gt(closePnl, '0')) return '0';
      return mul(String(closePnl), String(plan.feeValue));
    default:
      return computeInstrumentCommission(instrument, mul(closeQty, closePrice));
  }
}

/**
 * Leverage cap for the account's tier. Returns null when the tier is
 * unlimited (every tier except STANDARD per the default spec).
 */
async function getAccountMaxLeverage(account) {
  const plan = await _resolvePlan(account);
  return plan ? plan.maxLeverage : null;
}

/**
 * Does this account's tier permit BUY entries only? IC variants set
 * this; order controller uses it to reject SELL orders that aren't
 * closing an existing LONG.
 */
async function isBuyCloseOnly(account) {
  const plan = await _resolvePlan(account);
  return !!(plan && plan.buyCloseOnly);
}

/** Minimum deposit threshold for this tier (USD). 0 = no minimum. */
async function getMinDeposit(account) {
  const plan = await _resolvePlan(account);
  return plan ? Number(plan.minDeposit || 0) : 0;
}

module.exports = {
  computeCloseFee,
  getAccountMaxLeverage,
  isBuyCloseOnly,
  getMinDeposit,
};
