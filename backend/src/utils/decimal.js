const Decimal = require('decimal.js');

// Configure for financial precision
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

const D = (v) => new Decimal(v == null || v === '' ? 0 : v);

const add = (a, b) => D(a).plus(D(b)).toString();
const sub = (a, b) => D(a).minus(D(b)).toString();
const mul = (a, b) => D(a).times(D(b)).toString();
const div = (a, b) => D(a).dividedBy(D(b)).toString();

const gt = (a, b) => D(a).greaterThan(D(b));
const gte = (a, b) => D(a).greaterThanOrEqualTo(D(b));
const lt = (a, b) => D(a).lessThan(D(b));
const lte = (a, b) => D(a).lessThanOrEqualTo(D(b));
const eq = (a, b) => D(a).equals(D(b));

const round = (v, decimals = 8) => D(v).toFixed(decimals);

module.exports = { D, add, sub, mul, div, gt, gte, lt, lte, eq, round };
