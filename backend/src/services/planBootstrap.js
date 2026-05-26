/**
 * Plan bootstrap — runs on server start to guarantee the canonical
 * subscription plans exist in MongoDB. Upserts the four canonical plans
 * (FREE / PREMIUM / VIP / POSTPAID) so a code-level redefinition lands
 * in a running DB without needing ops to re-seed. Stale plans (e.g. the
 * old GOLD tier) get soft-disabled so they vanish from the pricing page
 * but historical subscriptions keep a foreign-key target.
 */
const { Plan } = require('../models/Subscription');

const DEFAULT_PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    description: 'Get started with zero maintenance fee.',
    monthlyPrice: '0',
    yearlyPrice: '0',
    sortOrder: 1,
    isActive: true,
    limits: {
      maxAccounts: 2,
      maxDevices: 3,
      defaultLeverage: 100,
      maxLeverageOverride: null,
      withdrawalDailyLimit: null,
    },
    features: {
      feeDiscountPercent: '0',
      apiAccess: false,
      prioritySupport: false,
      copyTradingEnabled: false,
      affiliateBonus: '0',
      customSupport: false,
      postPaid: false,
      maintenanceFee: false,
    },
    highlights: [
      'Zero maintenance fee',
      '2 trading accounts',
      'All instruments',
      '24/7 access',
      '3 devices login at a time',
      'Standard support',
    ],
  },
  {
    code: 'PREMIUM',
    name: 'Premium',
    description: 'For active traders. API access, more accounts.',
    monthlyPrice: '33',
    yearlyPrice: '100',
    sortOrder: 2,
    badge: 'Most Popular',
    isActive: true,
    limits: {
      maxAccounts: 5,
      maxDevices: 10,
      defaultLeverage: 200,
      maxLeverageOverride: null,
      withdrawalDailyLimit: null,
    },
    features: {
      feeDiscountPercent: '0',
      apiAccess: true,
      prioritySupport: false,
      copyTradingEnabled: false,
      affiliateBonus: '0',
      customSupport: false,
      postPaid: false,
      maintenanceFee: false,
    },
    highlights: [
      'Zero maintenance fee',
      '5 trading accounts',
      'All instruments',
      '24/7 access',
      'API access',
      '10 devices login at a time',
      'Standard support',
    ],
  },
  {
    code: 'VIP',
    name: 'VIP',
    description: 'Elite traders. Higher account & device limits.',
    monthlyPrice: '49',
    yearlyPrice: '499',
    sortOrder: 3,
    isActive: true,
    limits: {
      maxAccounts: 10,
      maxDevices: 20,
      defaultLeverage: 500,
      maxLeverageOverride: 500,
      withdrawalDailyLimit: null,
    },
    features: {
      feeDiscountPercent: '0',
      apiAccess: true,
      prioritySupport: false,
      copyTradingEnabled: false,
      affiliateBonus: '0',
      customSupport: false,
      postPaid: false,
      maintenanceFee: false,
    },
    highlights: [
      'Zero maintenance fee',
      '10 trading accounts',
      'All instruments',
      '24/7 access',
      'API access',
      '20 devices login at a time',
      'Standard support',
    ],
  },
  {
    code: 'POSTPAID',
    name: 'Post Paid',
    description: 'Pay-as-you-trade. Unlimited everything, dedicated support.',
    monthlyPrice: '0', // billed per-trade — price column shows "Post charges"
    yearlyPrice: '0',
    sortOrder: 4,
    isActive: true,
    limits: {
      maxAccounts: null, // null = unlimited
      maxDevices: null,
      defaultLeverage: 500,
      maxLeverageOverride: 500,
      withdrawalDailyLimit: null,
    },
    features: {
      feeDiscountPercent: '0',
      apiAccess: true,
      prioritySupport: true,
      copyTradingEnabled: false,
      affiliateBonus: '0',
      customSupport: true, // dedicated manager
      postPaid: true,
      maintenanceFee: true,
    },
    // Billing formula:
    //   monthly_bill = max(50, 2 * devices_used + 4 * accounts_used)
    // i.e. usage charges only kick in once they exceed the $50 minimum.
    postPaidRates: {
      perDevicePerMonth: '2',
      perAccountPerMonth: '4',
      minimumMonthlyFee: '50',
      currency: 'USD',
    },
    highlights: [
      '$2 per device / month',
      '$4 per account / month',
      'Minimum $50/month maintenance fee',
      'Unlimited trading accounts',
      'Unlimited devices login at a time',
      'All instruments',
      '24/7 access',
      'API access',
      'Dedicated support',
    ],
  },
];

async function ensureDefaultPlans() {
  let inserted = 0;
  let updated = 0;
  for (const p of DEFAULT_PLANS) {
    const existing = await Plan.findOne({ code: p.code });
    if (!existing) {
      await Plan.create(p);
      inserted++;
      console.log(`[planBootstrap] inserted missing plan: ${p.code}`);
    } else {
      // Refresh canonical fields so a redefinition (new price, new
      // limits, new highlights) propagates without manual DB surgery.
      // Admin-tweakable cosmetic fields (badge text, icon, accentColor)
      // are NOT overwritten so dashboard customisations survive.
      Object.assign(existing, {
        name: p.name,
        description: p.description,
        monthlyPrice: p.monthlyPrice,
        yearlyPrice: p.yearlyPrice,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
        limits: { ...existing.limits?.toObject?.() ?? existing.limits, ...p.limits },
        features: { ...existing.features?.toObject?.() ?? existing.features, ...p.features },
        highlights: p.highlights,
      });
      if (p.postPaidRates) {
        existing.postPaidRates = {
          ...(existing.postPaidRates?.toObject?.() ?? existing.postPaidRates ?? {}),
          ...p.postPaidRates,
        };
      }
      if (p.badge && !existing.badge) existing.badge = p.badge;
      await existing.save();
      updated++;
    }
  }

  // Retire the legacy GOLD plan if it's still hanging around. Soft-disable
  // (not delete) so existing Subscription docs that reference it keep an
  // intact foreign key for historical reporting.
  const gold = await Plan.findOne({ code: 'GOLD' });
  if (gold && gold.isActive) {
    gold.isActive = false;
    await gold.save();
    console.log('[planBootstrap] retired legacy plan: GOLD');
  }

  console.log(
    `[planBootstrap] inserted ${inserted} plan(s), refreshed ${updated} canonical plan(s)`
  );
}

module.exports = { ensureDefaultPlans, DEFAULT_PLANS };
