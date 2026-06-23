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
const { mul, add, gt } = require('../utils/decimal');
const { computeInstrumentCommission, findCommissionOverride, computeOverrideCommission, resolveCommissionType } = require('../utils/commission');

// Display grouping for a fee TYPE — the SAME categorization the UI uses:
//   COMMISSION ← PERCENTAGE / PCT_OF_VALUE
//   CHARGES    ← FIXED / FIXED_PER_TRADE / PCT_OF_PROFIT
// A trade incurs exactly ONE fee, so it belongs to exactly one of these.
function feeCategoryForKind(kind) {
  const k = String(kind || '').toUpperCase();
  if (k === 'FIXED' || k === 'FIXED_PER_TRADE' || k === 'PCT_OF_PROFIT') return 'CHARGES';
  return 'COMMISSION';
}

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
/**
 * Total close-leg fee = platform brokerage + (NSE/BSE) statutory charges.
 * For Indian cash equity, STT/stamp/exchange/SEBI/GST pass through on top of
 * brokerage (services/indianCharges.js). Leveraged/margin trades use INTRADAY
 * rates. NOTE: buy-leg statutory charges (stamp duty; delivery STT) are a
 * follow-up — only the close (sell) leg is charged here today.
 */
async function computeCloseFee(args) {
  const brokerage = await _computeBrokerage(args);
  const { instrument, closeQty, closePrice, entryPrice, productType } = args;
  if (instrument && (instrument.exchange === 'NSE' || instrument.exchange === 'BSE')) {
    const { computeEquityCharges } = require('./indianCharges');
    // DELIVERY → STT 0.1% on BOTH legs; INTRADAY → 0.025% sell-only. Default
    // INTRADAY keeps the prior behaviour for any caller that omits productType.
    const product = String(productType).toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'INTRADAY';
    const sell = computeEquityCharges({
      side: 'SELL', turnover: mul(closeQty, closePrice), exchange: instrument.exchange, product, brokerage,
    });
    let total = sell.total;
    // Delivery: the entry (buy) leg also attracts STT + stamp + exchange/SEBI/GST.
    // No extra brokerage on the buy leg (platform charges its fee once, at close).
    if (product === 'DELIVERY' && entryPrice != null) {
      const buy = computeEquityCharges({
        side: 'BUY', turnover: mul(closeQty, entryPrice), exchange: instrument.exchange, product, brokerage: '0',
      });
      total = add(total, buy.total);
    }
    return total;
  }
  return brokerage;
}

async function _computeBrokerage({ account, instrument, closeQty, closePrice, closePnl }) {
  // 1. Per-account-type OVERRIDE wins — if this instrument has a commission
  //    override for the account's type, it replaces the account-type default
  //    for that type only. (Applies to this account type, not others.)
  const override = findCommissionOverride(instrument, account?.accountType);
  if (override) {
    return computeOverrideCommission(override, mul(closeQty, closePrice), closePnl);
  }

  // 2. Otherwise inherit the account type's own commission (AccountPlan).
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
 * Resolve the DISPLAY fee category ('COMMISSION' | 'CHARGES') for a trade,
 * mirroring computeCloseFee's resolution order (override → account plan →
 * legacy instrument) but returning the TYPE's group rather than an amount.
 * Used only to decide which column a trade's single fee shows under.
 */
async function resolveFeeCategory({ account, instrument }) {
  const override = findCommissionOverride(instrument, account?.accountType);
  if (override) return feeCategoryForKind(override.commissionType);
  const plan = await _resolvePlan(account);
  if (plan && plan.feeKind) return feeCategoryForKind(plan.feeKind);
  return feeCategoryForKind(resolveCommissionType(instrument));
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
  resolveFeeCategory,
  feeCategoryForKind,
  getAccountMaxLeverage,
  isBuyCloseOnly,
  getMinDeposit,
};
