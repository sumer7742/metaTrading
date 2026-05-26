/**
 * accountPlansService — central read/cache layer for the AccountPlan
 * collection. The matching engine + order controller hit this on every
 * order, so caching matters. Refresh is forced by the admin write paths
 * (any CRUD on plans calls invalidate() before returning).
 *
 * Also owns the bootstrap: on server boot, inserts the 6 canonical
 * plans (Standard / Standard IC / Pro / Pro IC / Free / Free IC) if
 * none exist yet. Existing plans are left untouched so admin tweaks
 * survive restarts.
 */
const AccountPlan = require('../models/AccountPlan');

const CACHE_TTL_MS = 60 * 1000; // 1 minute — short enough that admin
                                // edits propagate quickly even if
                                // invalidate() somehow isn't called.

let _cache = null;
let _cacheAt = 0;
let _byCode = new Map();

async function _refresh() {
  const plans = await AccountPlan.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
  _cache = plans;
  _cacheAt = Date.now();
  _byCode = new Map(plans.map((p) => [p.code, p]));
}

function _stale() {
  return !_cache || (Date.now() - _cacheAt) > CACHE_TTL_MS;
}

/** Force a refresh on the next read. Call from admin write paths. */
function invalidate() {
  _cache = null;
  _cacheAt = 0;
  _byCode = new Map();
}

/** Get all plans (active + inactive) from cache. Used by admin. */
async function getAllCached() {
  if (_stale()) await _refresh();
  return _cache;
}

/** Get only active plans, sorted. Used by public Plans page + account picker. */
async function getActiveCached() {
  if (_stale()) await _refresh();
  return _cache.filter((p) => p.isActive);
}

/** Resolve a single plan by code (case-insensitive). Returns null if missing. */
async function getByCode(code) {
  if (!code) return null;
  if (_stale()) await _refresh();
  return _byCode.get(String(code).toUpperCase()) || null;
}

// ── Canonical 6-tier seed ──────────────────────────────────────────
// Canonical 6-tier catalogue. Refreshed on every boot — admin tweaks
// to non-canonical fields (icon, accentColor, badge text) are preserved;
// canonical pricing/fee/leverage fields are reset to these values.
const SEED_PLANS = [
  {
    code: 'STANDARD',
    name: 'Standard',
    description: 'Low minimum deposit, percentage fee. Made for all traders.',
    minDeposit: 100,
    maxLeverage: 100,           // capped at 1:100
    feeKind: 'PCT_OF_VALUE',
    feeValue: 0.00005,           // 0.005% of trade value
    lossWaive: false,
    buyCloseOnly: false,
    feeDisplay: '0.005% of trade value',
    supportLabel: 'Standard support',
    sortOrder: 1,
    isActive: true,
  },
  {
    code: 'STANDARD_IC',
    name: 'IC',
    description: 'Lowest minimum deposit · buy-only entries.',
    minDeposit: 10,
    maxLeverage: null,           // unlimited
    feeKind: 'PCT_OF_VALUE',
    feeValue: 0.00005,
    lossWaive: false,
    buyCloseOnly: true,
    feeDisplay: '0.005% of trade value',
    supportLabel: 'Standard support',
    sortOrder: 2,
    isActive: true,
  },
  {
    code: 'PRO',
    name: 'Pro',
    description: 'Flat per-trade fee — best for high-volume traders.',
    minDeposit: 500,
    maxLeverage: null,
    feeKind: 'FIXED_PER_TRADE',
    feeValue: 0.1,
    lossWaive: false,
    buyCloseOnly: false,
    feeDisplay: '$0.10 fixed per trade',
    supportLabel: 'Standard support',
    sortOrder: 3,
    isActive: true,
  },
  {
    code: 'PRO_IC',
    name: 'Pro IC',
    description: 'Flat per-trade fee · buy-only entries.',
    minDeposit: 300,
    maxLeverage: null,
    feeKind: 'FIXED_PER_TRADE',
    feeValue: 0.1,
    lossWaive: false,
    buyCloseOnly: true,
    feeDisplay: '$0.10 fixed per trade',
    supportLabel: 'Standard support',
    sortOrder: 4,
    isActive: true,
  },
  {
    code: 'FREE',
    name: 'Free',
    description: '1% of profit. Zero fee on losing trades.',
    minDeposit: 1000,
    maxLeverage: null,
    feeKind: 'PCT_OF_PROFIT',
    feeValue: 0.01,
    lossWaive: true,
    buyCloseOnly: false,
    feeDisplay: '1% of profit · zero fee for losing trades',
    supportLabel: 'Standard support',
    sortOrder: 5,
    isActive: true,
    isPopular: true,
    badge: 'Most Popular',
  },
  {
    code: 'FREE_IC',
    name: 'Free IC',
    description: '1% of profit · zero fee on losses · buy-only entries.',
    minDeposit: 800,
    maxLeverage: null,
    feeKind: 'PCT_OF_PROFIT',
    feeValue: 0.01,
    lossWaive: true,
    buyCloseOnly: true,
    feeDisplay: '1% of profit · zero fee for losing trades',
    supportLabel: 'Standard support',
    sortOrder: 6,
    isActive: true,
  },
];

/**
 * Bootstrap canonical plans. Inserts any missing tier with the full
 * SEED values on first run. For EXISTING plans, only refreshes labels
 * and sort order — admin-owned trading rules (minDeposit, maxLeverage,
 * fee*, buyCloseOnly, lossWaive) are preserved so an admin override
 * in the dashboard survives a restart.
 *
 * If you intentionally want a code-level spec change to land on
 * existing rows, do it via the admin endpoint or a one-off migration
 * script — not via this boot path.
 */
async function ensureDefaultPlans() {
  let inserted = 0;
  let refreshed = 0;
  for (const p of SEED_PLANS) {
    const existing = await AccountPlan.findOne({ code: p.code });
    if (!existing) {
      await AccountPlan.create(p);
      inserted++;
      console.log(`[accountPlansBootstrap] inserted ${p.code}`);
      continue;
    }
    // Refresh ONLY labels / display fields. Trading-rule fields
    // (minDeposit, maxLeverage, feeKind, feeValue, feeDisplay,
    // buyCloseOnly, lossWaive) are admin-owned — leave them alone.
    existing.name = p.name;
    existing.description = p.description;
    existing.sortOrder = p.sortOrder;
    existing.isActive = p.isActive;
    if (p.supportLabel) existing.supportLabel = p.supportLabel;
    if (p.isPopular !== undefined && existing.isPopular === undefined) {
      existing.isPopular = p.isPopular;
    }
    if (p.badge && !existing.badge) existing.badge = p.badge;
    await existing.save();
    refreshed++;
  }
  console.log(
    `[accountPlansBootstrap] inserted ${inserted} · refreshed labels on ${refreshed} plan(s) (admin trading rules preserved)`
  );

  invalidate();
}

module.exports = {
  SEED_PLANS,
  ensureDefaultPlans,
  getAllCached,
  getActiveCached,
  getByCode,
  invalidate,
};
