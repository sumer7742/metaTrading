const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const Position = require('../models/Position');
const TradingAccount = require('../models/TradingAccount');
const Instrument = require('../models/Instrument');
const { Wallet } = require('../models/Wallet');
const { Deposit, Withdrawal, AuditLog } = require('../models/index');
const walletService = require('../services/walletService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { KYC_STATUS, WALLET_TX_TYPE, BOOK_TYPE, LP_PROVIDER, EXECUTION_MODE, ROUTING_RESULT, ROUTING } = require('../config/constants');
const { add, sub, mul } = require('../utils/decimal');

const logAction = async (req, action, target, metadata = {}) => {
  await AuditLog.create({
    actorId: req.userId,
    actorRole: req.user.role,
    action,
    targetType: target?.type,
    targetId: target?.id,
    metadata,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
};

// DASHBOARD
const dashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // ── Hierarchy scope ── ADMIN sees only their subtree; SUPER_ADMIN: all.
  const isAdmin = req.user && req.user.role === 'ADMIN';
  const userScope = isAdmin ? { adminId: req.user._id } : {};
  const scope = isAdmin ? await User.find({ adminId: req.user._id }).distinct('_id') : null;
  const uidIn = scope ? { userId: { $in: scope } } : {};               // Withdrawal / Position
  const tradeIn = scope ? { $or: [{ buyUserId: { $in: scope } }, { sellUserId: { $in: scope } }] } : {}; // Trade

  const [totalUsers, activeUsers24h, kycPending, withdrawPending, trades24h, openPositions] = await Promise.all([
    User.countDocuments(userScope),
    User.countDocuments({ ...userScope, lastLoginAt: { $gte: dayAgo } }),
    User.countDocuments({ ...userScope, kycStatus: KYC_STATUS.PENDING }),
    Withdrawal.countDocuments({ status: 'PENDING', ...uidIn }),
    Trade.countDocuments({ executedAt: { $gte: dayAgo }, ...tradeIn }),
    Position.countDocuments({ status: 'OPEN', ...uidIn }),
  ]);

  // Volume by routing
  const volumeAgg = await Trade.aggregate([
    { $match: { executedAt: { $gte: weekAgo }, ...tradeIn } },
    {
      $group: {
        _id: '$routing',
        count: { $sum: 1 },
      },
    },
  ]);

  // Net exposure per instrument
  const exposureAgg = await Position.aggregate([
    { $match: { status: 'OPEN', ...uidIn } },
    {
      $group: {
        _id: { symbol: '$symbol', side: '$side' },
        total: { $sum: { $toDouble: '$quantity' } },
      },
    },
  ]);

  sendSuccess(res, {
    totalUsers,
    activeUsers24h,
    kycPending,
    withdrawPending,
    trades24h,
    openPositions,
    volumeByRouting: volumeAgg,
    exposure: exposureAgg,
  });
});

// USERS
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const listUsers = asyncHandler(async (req, res) => {
  const { search, kyc, status, plan, role, page = 1, limit = 50, sortBy, sortDir } = req.query;

  // ── Base filter on User fields ──
  const match = {};
  if (search) {
    match.$or = [
      { email: new RegExp(search, 'i') },
      { firstName: new RegExp(search, 'i') },
      { lastName: new RegExp(search, 'i') },
      { phone: new RegExp(search, 'i') },
      { userUid: new RegExp(search, 'i') },   // permanent User ID (e.g. USR100245)
    ];
  }
  if (kyc) match.kycStatus = kyc;
  if (status === 'active') match.isActive = true;
  if (status === 'inactive') match.isActive = false;
  // "Dormant" = hasn't used the platform in the last 6 months: last login is
  // older than 6 months, OR never logged in and the account itself is 6mo+ old.
  if (status === 'dormant') {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const dormantCond = { $or: [
      { lastLoginAt: { $lt: sixMonthsAgo } },
      { lastLoginAt: null, createdAt: { $lt: sixMonthsAgo } },
    ] };
    // Merge with any existing $or (search) via $and so neither clobbers the other.
    if (match.$or) { match.$and = [{ $or: match.$or }, dormantCond]; delete match.$or; }
    else { Object.assign(match, dormantCond); }
  }
  // Account type filter — separate regular users from staff (admin/manager).
  // Accepts a single role or a comma-separated list (e.g. "ADMIN,MANAGER").
  if (role) {
    const roles = String(role).split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
    if (roles.length === 1) match.role = roles[0];
    else if (roles.length > 1) match.role = { $in: roles };
  }

  // ── Hierarchy scope ──
  // An ADMIN sees only THEIR assigned users (their subtree). `adminId` is the
  // denormalised tree key — set on direct admin-assignment AND when a user is
  // assigned to a manager under this admin — so this single filter covers the
  // whole subtree. SUPER_ADMIN (and other staff) see everyone.
  if (req.user && req.user.role === 'ADMIN') {
    match.adminId = req.user._id;
  }

  const lim = Math.min(2000, Math.max(1, Number(limit) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;

  const { SubscriptionWallet } = require('../models/SubscriptionWallet');
  const { BonusWallet } = require('../models/BonusWallet');
  const { Subscription, Plan } = require('../models/Subscription');
  const { Commission } = require('../models/Compliance');
  const currencyService = require('../services/currencyService');

  // One live FX rate so non-USD trading balances normalise to USD INSIDE
  // the pipeline (deposits/withdrawals already carry a USD `baseAmount`).
  let usdInr = 83;
  try { usdInr = Number(await currencyService.getUsdInrRate()) || 83; } catch (_) {}
  const toUsd = (bal, cur) => ({ $cond: [{ $eq: [cur, 'USD'] }, bal, { $divide: [bal, usdInr] }] });
  // Safe string→number: bad/empty/null money strings become 0 instead of
  // throwing and 500-ing the entire user list.
  const num = (f) => ({ $convert: { input: f, to: 'double', onError: 0, onNull: 0 } });

  // Computed columns are sortable server-side (sort happens in-pipeline,
  // before pagination) so ordering spans the whole filtered set, not a page.
  const SORT_FIELDS = {
    createdAt: 'createdAt', joined: 'createdAt', email: 'email', name: 'firstName',
    role: 'role', plan: 'planCode', walletBalance: 'walletBalance',
    totalDeposit: 'totalDeposit', totalWithdrawal: 'totalWithdrawal', totalPnl: 'totalPnl',
    kyc: 'kycStatus', status: 'isActive', lastLogin: 'lastLoginAt',
  };
  const sortField = SORT_FIELDS[sortBy] || 'createdAt';
  const dir = sortDir === 'asc' ? 1 : -1;

  const pipeline = [
    { $match: match },

    // Lifetime deposits (CONFIRMED) — baseAmount is already USD.
    { $lookup: { from: Deposit.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$userId', '$$uid'] }, { $eq: ['$status', 'CONFIRMED'] }] } } },
        { $group: { _id: null, total: { $sum: num('$baseAmount') } } },
      ], as: '_dep' } },
    // Lifetime withdrawals (COMPLETED) — baseAmount is already USD.
    { $lookup: { from: Withdrawal.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$userId', '$$uid'] }, { $eq: ['$status', 'COMPLETED'] }] } } },
        { $group: { _id: null, total: { $sum: num('$baseAmount') } } },
      ], as: '_wd' } },
    // Realized PnL + win/trade counts from CLOSED positions.
    { $lookup: { from: Position.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$userId', '$$uid'] }, { $eq: ['$status', 'CLOSED'] }] } } },
        { $group: { _id: null,
            pnl: { $sum: num('$realizedPnl') },
            comm: { $sum: num('$commission') },
            trades: { $sum: 1 },
            wins: { $sum: { $cond: [{ $gt: [num('$realizedPnl'), 0] }, 1, 0] } },
        } },
      ], as: '_pos' } },
    // Real trading-account wallet balances → USD (demo/virtual excluded).
    { $lookup: { from: Wallet.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$uid'] } } },
        { $lookup: { from: TradingAccount.collection.collectionName, localField: 'accountId', foreignField: '_id', as: '_acc' } },
        { $unwind: '$_acc' },
        { $match: { '_acc.accountType': { $nin: ['DEMO', 'VIRTUAL'] } } },
        { $group: { _id: null, total: { $sum: toUsd(num('$balance'), '$currency') } } },
      ], as: '_tw' } },
    // Main Wallet (USD).
    { $lookup: { from: SubscriptionWallet.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$uid'] } } },
        { $group: { _id: null, total: { $sum: num('$balance') } } },
      ], as: '_mw' } },
    // Bonus Wallet (USD).
    { $lookup: { from: BonusWallet.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$uid'] } } },
        { $group: { _id: null, total: { $sum: num('$balance') } } },
      ], as: '_bw' } },
    // Referral earnings — lifetime commissions earned by this user as the
    // referrer (matches the partner dashboard's "lifetime" figure). Amounts
    // are stored positive; we sum across all statuses.
    { $lookup: { from: Commission.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$referrerId', '$$uid'] } } },
        { $group: { _id: null, total: { $sum: num('$amount') } } },
      ], as: '_ref' } },
    // Subscription plan (code + name; defaults to Free).
    { $lookup: { from: Subscription.collection.collectionName, let: { uid: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$uid'] } } },
        { $lookup: { from: Plan.collection.collectionName, localField: 'planId', foreignField: '_id', as: '_plan' } },
        { $unwind: { path: '$_plan', preserveNullAndEmptyArrays: true } },
        { $project: { _id: 0, planCode: 1, planName: '$_plan.name' } },
      ], as: '_sub' } },

    { $addFields: {
        totalDeposit:    { $ifNull: [{ $arrayElemAt: ['$_dep.total', 0] }, 0] },
        totalWithdrawal: { $ifNull: [{ $arrayElemAt: ['$_wd.total', 0] }, 0] },
        totalPnl:        { $ifNull: [{ $arrayElemAt: ['$_pos.pnl', 0] }, 0] },
        commission:      { $ifNull: [{ $arrayElemAt: ['$_pos.comm', 0] }, 0] },
        tradeCount:      { $ifNull: [{ $arrayElemAt: ['$_pos.trades', 0] }, 0] },
        winCount:        { $ifNull: [{ $arrayElemAt: ['$_pos.wins', 0] }, 0] },
        walletBalance: { $add: [
          { $ifNull: [{ $arrayElemAt: ['$_tw.total', 0] }, 0] },
          { $ifNull: [{ $arrayElemAt: ['$_mw.total', 0] }, 0] },
          { $ifNull: [{ $arrayElemAt: ['$_bw.total', 0] }, 0] },
        ] },
        planCode: { $toUpper: { $ifNull: [{ $arrayElemAt: ['$_sub.planCode', 0] }, 'FREE'] } },
        planName: { $ifNull: [{ $arrayElemAt: ['$_sub.planName', 0] }, 'Free'] },
        referralEarnings: { $ifNull: [{ $arrayElemAt: ['$_ref.total', 0] }, 0] },
    } },

    ...(plan ? [{ $match: { planCode: String(plan).toUpperCase() } }] : []),

    { $sort: { [sortField]: dir, _id: 1 } },

    { $facet: {
        data: [
          { $skip: skip },
          { $limit: lim },
          { $project: {
              passwordHash: 0, twoFactorSecret: 0, refreshTokens: 0,
              _dep: 0, _wd: 0, _pos: 0, _tw: 0, _mw: 0, _bw: 0, _sub: 0, _ref: 0,
          } },
        ],
        meta: [{ $count: 'total' }],
    } },
  ];

  const agg = await User.aggregate(pipeline).allowDiskUse(true);
  const rows = agg[0]?.data || [];
  const total = agg[0]?.meta?.[0]?.total || 0;

  // Batch-populate referredBy / manager / admin identities (no N+1).
  const idSet = new Set();
  for (const u of rows) {
    if (u.referredBy) idSet.add(String(u.referredBy));
    if (u.managerId)  idSet.add(String(u.managerId));
    if (u.adminId)    idSet.add(String(u.adminId));
  }
  let nameMap = new Map();
  if (idSet.size) {
    const refs = await User.find({ _id: { $in: [...idSet] } })
      .select('firstName lastName email referralCode userUid').lean();
    nameMap = new Map(refs.map((r) => [String(r._id), r]));
  }
  const nameOf = (doc) => (doc ? ([doc.firstName, doc.lastName].filter(Boolean).join(' ') || doc.email) : null);

  const users = rows.map((u) => {
    const trades = Number(u.tradeCount) || 0;
    const wins = Number(u.winCount) || 0;
    const dep = Number(u.totalDeposit) || 0;
    const pnl = Number(u.totalPnl) || 0;
    const commission = Number(u.commission) || 0;
    const ref = u.referredBy ? nameMap.get(String(u.referredBy)) : null;
    const mgr = u.managerId ? nameMap.get(String(u.managerId)) : null;
    const adm = u.adminId ? nameMap.get(String(u.adminId)) : null;
    const { tradeCount, winCount, planCode, planName, commission: _comm, ...rest } = u;
    return {
      ...rest,
      referredBy: ref ? { _id: u.referredBy, firstName: ref.firstName, lastName: ref.lastName, email: ref.email, referralCode: ref.referralCode } : null,
      manager: mgr ? { _id: u.managerId, name: nameOf(mgr), email: mgr.email } : null,
      admin:   adm ? { _id: u.adminId, name: nameOf(adm), email: adm.email } : null,
      plan: { code: planCode || 'FREE', name: planName || 'Free' },
      walletBalance:  round2(u.walletBalance),
      totalDeposit:   round2(dep),
      totalWithdrawal: round2(u.totalWithdrawal),
      totalPnl:       round2(pnl),
      referralEarnings: round2(Number(u.referralEarnings) || 0),
      // Platform earnings generated FROM this user = commissions/fees the user
      // paid + the broker's counterparty result on internalised flow (user's
      // net losses are the broker's gain). Mirrors Portfolio's platformRevenue
      // = commissions − closed PnL, applied per user.
      commission:     round2(commission),
      platformEarnings: round2(commission - pnl),
      tradeStats: {
        trades, wins,
        winRate: trades ? round2((wins / trades) * 100) : 0,
        roi: dep > 0 ? round2((pnl / dep) * 100) : 0,
      },
    };
  });

  sendSuccess(res, { users, total, page: Number(page) || 1, limit: lim });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .select('-passwordHash -twoFactorSecret -refreshTokens')
    .populate('referredBy', 'firstName lastName email referralCode');
  if (!user) throw new AppError('User not found', 404);
  // Hierarchy scope — an ADMIN may only open users in their own subtree
  // (can't reach someone else's user by typing the ID). Super Admin: any.
  if (req.user && req.user.role === 'ADMIN' && String(user.adminId || '') !== String(req.user._id)) {
    throw new AppError('User not found', 404);
  }
  const accounts = await TradingAccount.find({ userId: user._id }).lean();
  const wallets = await Wallet.find({ userId: user._id }).lean();
  // Direct referrals (level-1 only) — anyone who signed up with this
  // user's code. Surfaces the affiliate fan-out for compliance review.
  const referees = await User.find({ referredBy: user._id })
    .select('firstName lastName email createdAt kycStatus isActive')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  // Bonus quota: one bonus per referee, lifetime. The FE uses this to
  // disable the "Add bonus" button when all slots are consumed and to
  // show admin how many are left ("2 of 5 available").
  const { Commission } = require('../models/Compliance');
  const bonusesCredited = await Commission.countDocuments({
    referrerId: user._id,
    sourceType: 'ADJUSTMENT',
    status: { $in: ['PENDING', 'PAID'] },
  });
  const bonusQuota = {
    refereeCount: referees.length,
    credited: bonusesCredited,
    available: Math.max(0, referees.length - bonusesCredited),
  };

  sendSuccess(res, { user, accounts, wallets, referees, bonusQuota });
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;
  const user = await User.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
  if (!user) throw new AppError('User not found', 404);
  await logAction(req, isActive ? 'USER_UNBLOCK' : 'USER_BLOCK', { type: 'USER', id: user._id });
  sendSuccess(res, user.toSafeJSON());
});

const reviewKyc = asyncHandler(async (req, res) => {
  const { decision, reason } = req.body; // 'APPROVE' | 'REJECT'
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  if (decision === 'APPROVE') {
    user.kycStatus = KYC_STATUS.APPROVED;
    user.kycRejectionReason = null;
  } else if (decision === 'REJECT') {
    user.kycStatus = KYC_STATUS.REJECTED;
    user.kycRejectionReason = reason || 'Documents insufficient';
  } else {
    throw new AppError('Invalid decision', 400);
  }
  user.kycReviewedAt = new Date();
  user.kycReviewedBy = req.userId;
  await user.save();
  await logAction(req, `KYC_${decision}`, { type: 'USER', id: user._id }, { reason });

  // Email user the decision
  try {
    const emailSvc = require('../services/emailService');
    await emailSvc.sendKycReviewed({ to: user.email, decision: user.kycStatus, reason });
  } catch (e) { /* non-fatal */ }

  sendSuccess(res, { status: user.kycStatus });
});

const adjustBalance = asyncHandler(async (req, res) => {
  const { accountId, currency, amount, reason } = req.body;
  if (!reason) throw new AppError('Reason required for manual balance adjustment', 400);
  if (!currency || typeof currency !== 'string') throw new AppError('Currency required', 400);
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum === 0) {
    throw new AppError('Amount must be a non-zero finite number', 400);
  }
  const account = await TradingAccount.findById(accountId);
  if (!account) throw new AppError('Account not found', 404);

  const absAmt = String(Math.abs(amtNum));
  const wallet = amtNum > 0
    ? await walletService.credit({
        userId: account.userId,
        accountId,
        currency,
        amount: absAmt,
        type: WALLET_TX_TYPE.ADJUSTMENT,
        note: reason,
      })
    : await walletService.debit({
        userId: account.userId,
        accountId,
        currency,
        amount: absAmt,
        type: WALLET_TX_TYPE.ADJUSTMENT,
        note: reason,
      });
  await logAction(req, 'BALANCE_ADJUSTMENT', { type: 'WALLET', id: wallet._id }, { amount: amtNum, reason });
  sendSuccess(res, wallet);
});

// Manually credit an affiliate / referral bonus to a user. Creates a
// Commission row (visible on the user's Affiliate page) AND credits the
// wallet immediately. Different from `adjustBalance` because:
//  • Audit trail labels it as affiliate income, not a generic adjustment
//  • Shows up in the user's commission history with status PAID
//  • Cannot go negative (bonuses are positive-only)
const creditAffiliateBonus = asyncHandler(async (req, res) => {
  const { amount, currency, note } = req.body;
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const affiliateService = require('../services/affiliateService');
  let result;
  try {
    result = await affiliateService.creditManual({
      userId:   req.params.id,
      amount:   amtNum,
      currency: currency || undefined,
      note:     note || undefined,
      adminId:  req.userId,
    });
  } catch (e) {
    throw new AppError(e.message, 400);
  }
  await logAction(
    req,
    'AFFILIATE_BONUS_CREDITED',
    { type: 'USER', id: req.params.id },
    { amount: amtNum, currency: result.currency, commissionId: result.commission._id, note }
  );

  // The wallet credit emits on the user's existing 'wallet' WS channel,
  // and the Affiliate page polls/lists commissions — so no extra
  // notification plumbing is needed. The user sees:
  //   • +amount on their Wallet balance + transaction ledger row
  //   • A new PAID commission row on the Affiliate page
  sendSuccess(res, result.commission);
});

// Manually fix a user's referral attribution (e.g. for chains broken by
// the historical case-sensitive bug, or for KYC-driven corrections).
// Accepts a referral code OR a referrer userId. Pass `null`/empty to
// clear the attribution.
const setReferrer = asyncHandler(async (req, res) => {
  const { referralCode, referrerId } = req.body;
  const target = await User.findById(req.params.id);
  if (!target) throw new AppError('User not found', 404);

  let newReferrer = null;
  if (referralCode) {
    const code = String(referralCode).trim().toUpperCase();
    newReferrer = await User.findOne({ referralCode: code }).select('_id');
    if (!newReferrer) throw new AppError(`No user has referral code ${code}`, 404);
  } else if (referrerId) {
    newReferrer = await User.findById(referrerId).select('_id');
    if (!newReferrer) throw new AppError('Referrer not found', 404);
  }

  // Prevent self-referral loops.
  if (newReferrer && String(newReferrer._id) === String(target._id)) {
    throw new AppError('A user cannot refer themselves', 400);
  }

  const prev = target.referredBy;
  target.referredBy = newReferrer ? newReferrer._id : null;
  await target.save();
  await logAction(
    req,
    'USER_REFERRER_UPDATED',
    { type: 'USER', id: target._id },
    { previous: prev, next: target.referredBy }
  );
  sendSuccess(res, { referredBy: target.referredBy });
});

// ─── Leverage management ─────────────────────────────────────────────
// Admin can read, override, clear, bulk-update, and audit a user's
// effective leverage. The service layer enforces precedence
// (admin → plan default) and persists every change to LeverageLog.
const getLeverage = asyncHandler(async (req, res) => {
  const leverageService = require('../services/leverageService');
  const state = await leverageService.getEffective(req.params.id);
  sendSuccess(res, state);
});

const setLeverage = asyncHandler(async (req, res) => {
  const { value, reason, expiresAt } = req.body;
  const lev = Number(value);
  if (!Number.isFinite(lev) || lev < 1 || lev > 1000) {
    throw new AppError('value must be between 1 and 1000', 400);
  }
  const leverageService = require('../services/leverageService');
  let next;
  try {
    next = await leverageService.setOverride({
      userId:    req.params.id,
      value:     lev,
      adminId:   req.userId,
      reason,
      expiresAt: expiresAt || null,
    });
  } catch (e) {
    throw new AppError(e.message, 400);
  }
  await logAction(req, 'LEVERAGE_OVERRIDE_SET', { type: 'USER', id: req.params.id }, {
    value: lev, reason,
  });
  // Real-time broadcast — push fresh state to the user's WS channel so
  // their open trade terminal updates the cap without a refresh.
  _broadcastLeverage(req.params.id, next);
  sendSuccess(res, next);
});

const clearLeverage = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const leverageService = require('../services/leverageService');
  const next = await leverageService.clearOverride({
    userId:  req.params.id,
    adminId: req.userId,
    reason,
  });
  await logAction(req, 'LEVERAGE_OVERRIDE_CLEARED', { type: 'USER', id: req.params.id }, { reason });
  _broadcastLeverage(req.params.id, next);
  sendSuccess(res, next);
});

const bulkSetLeverage = asyncHandler(async (req, res) => {
  const { userIds, value, reason } = req.body;
  const lev = Number(value);
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new AppError('userIds[] is required', 400);
  }
  if (!Number.isFinite(lev) || lev < 1 || lev > 1000) {
    throw new AppError('value must be between 1 and 1000', 400);
  }
  const leverageService = require('../services/leverageService');
  const result = await leverageService.bulkSetOverride({
    userIds, value: lev, adminId: req.userId, reason,
  });
  await logAction(req, 'LEVERAGE_BULK_UPDATE', { type: 'SYSTEM', id: null }, {
    batchId: result.batchId, count: result.succeeded, value: lev, reason,
  });
  // Broadcast to each successfully-updated user.
  for (const r of result.results) {
    if (!r.ok) continue;
    const leverageService = require('../services/leverageService');
    const fresh = await leverageService.getEffective(r.userId).catch(() => null);
    if (fresh) _broadcastLeverage(r.userId, fresh);
  }
  sendSuccess(res, result);
});

const getLeverageHistory = asyncHandler(async (req, res) => {
  const leverageService = require('../services/leverageService');
  const logs = await leverageService.getHistory(req.params.id, { limit: 100 });
  sendSuccess(res, logs);
});

// Helper — publish leverage update on the user's WS channel.
// FE Trade page subscribes to `user:leverage:<id>` and re-bounds the
// OrderForm slider the moment the message arrives — no refresh needed.
function _broadcastLeverage(userId, state) {
  try {
    const wsServer = require('../websocket/server');
    if (wsServer && typeof wsServer.notifyUser === 'function') {
      wsServer.notifyUser(userId, 'leverage', state);
    }
  } catch (_) { /* WS not available — non-fatal */ }
}

// Diagnostic — dump everything we know about a user's referral state in
// one shot, so admin can see at a glance whether signups are linking
// properly (`referredBy` set + referees list populated). Helps debug
// "I referred someone but they're not showing up" without grepping logs.
const referralDiagnostic = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .select('email firstName lastName referralCode referredBy createdAt isActive')
    .populate('referredBy', 'email firstName lastName referralCode')
    .lean();
  if (!user) throw new AppError('User not found', 404);
  const referees = await User.find({ referredBy: user._id })
    .select('email firstName lastName referralCode createdAt isActive kycStatus')
    .sort({ createdAt: -1 })
    .lean();
  // Walk DOWN — find users referred by this user's referees (L2 indirect).
  const refereeIds = referees.map((r) => r._id);
  const indirectReferees = refereeIds.length
    ? await User.find({ referredBy: { $in: refereeIds } })
        .select('email firstName lastName referralCode referredBy createdAt')
        .lean()
    : [];
  sendSuccess(res, {
    user,
    direct: { count: referees.length, list: referees },
    indirect: { count: indirectReferees.length, list: indirectReferees },
  });
});

// WITHDRAWALS
// Attach a lightweight { userUid, email, name } badge to rows keyed by
// `userId`. Additive — surfaces the permanent User ID on the deposits /
// withdrawals tables without altering any existing field on the row.
async function attachUserBadge(items) {
  if (!Array.isArray(items) || !items.length) return items;
  const ids = [...new Set(items.map((it) => String(it.userId)).filter(Boolean))];
  if (!ids.length) return items;
  const users = await User.find({ _id: { $in: ids } }).select('userUid email firstName lastName').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  for (const it of items) {
    const u = byId.get(String(it.userId));
    it.user = u
      ? { userUid: u.userUid || null, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email }
      : null;
  }
  return items;
}

// Resolve the user IDs an ADMIN is allowed to see (their hierarchy subtree).
// Returns null for SUPER_ADMIN / other staff → no scoping (everyone visible).
async function adminScopeUserIds(req) {
  if (!req.user || req.user.role !== 'ADMIN') return null;
  const users = await User.find({ adminId: req.user._id }).select('_id').lean();
  return users.map((u) => u._id);
}

// Apply the admin subtree scope to a {userId} filter. Returns false when the
// caller asked for a specific userId that is OUTSIDE their scope (→ empty list).
function applyUserScope(filter, scope) {
  if (!scope) return true; // super admin / staff — unscoped
  if (filter.userId) {
    return scope.some((id) => String(id) === String(filter.userId)); // in-scope?
  }
  filter.userId = { $in: scope };
  return true;
}

const listWithdrawals = asyncHandler(async (req, res) => {
  const { status, userId } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (userId) filter.userId = userId;   // per-user history (User Mgmt modal)
  const scope = await adminScopeUserIds(req);
  if (!applyUserScope(filter, scope)) return sendSuccess(res, []);
  const items = await Withdrawal.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  await attachUserBadge(items);
  sendSuccess(res, items);
});

const approveWithdrawal = asyncHandler(async (req, res) => {
  const { payoutTxReference, payoutProof, payoutProofMimeType } = req.body || {};

  const wd = await Withdrawal.findById(req.params.id);
  if (!wd) throw new AppError('Withdrawal not found', 404);
  if (wd.status !== 'PENDING') throw new AppError('Withdrawal already processed', 400);

  // Both the payout TX reference and the proof screenshot are OPTIONAL.
  // Validate the screenshot only when one was actually provided.
  if (payoutProof) {
    if (typeof payoutProof !== 'string' || (!payoutProof.startsWith('data:image/') && !payoutProof.startsWith('https://'))) {
      throw new AppError('Invalid payout proof format', 400);
    }
    if (payoutProof.length > 700 * 1024) {
      throw new AppError('Payout proof too large (max 500KB)', 413);
    }
  }

  // 4-eyes principle: require 2 distinct approvals for amounts > ₹10,00,000 (10 lakh INR).
  // ObjectIds need .equals() for comparison — Array.includes() uses === which
  // never matches different ObjectId instances, allowing the same admin to
  // approve twice and bypass 4-eyes.
  const HIGH_VALUE_THRESHOLD = 1000000;
  const alreadyApproved = wd.approvedBy.some((id) => id && id.equals && id.equals(req.userId));
  if (Number(wd.amount) > HIGH_VALUE_THRESHOLD) {
    if (!alreadyApproved) wd.approvedBy.push(req.userId);
    if (wd.approvedBy.length < 2) {
      await wd.save();
      await logAction(req, 'WITHDRAWAL_APPROVED_PARTIAL', { type: 'WITHDRAWAL', id: wd._id });
      return sendSuccess(res, { ...wd.toObject(), needsAnotherApproval: true });
    }
  } else {
    if (!alreadyApproved) wd.approvedBy.push(req.userId);
  }

  wd.status = 'COMPLETED';
  wd.approvedAt = new Date();
  wd.payoutAt = new Date();
  wd.payoutTxReference = payoutTxReference;
  wd.payoutProof = payoutProof;
  wd.payoutProofMimeType = payoutProofMimeType;
  await wd.save();

  // Main/Bonus-wallet withdrawals were already debited (held) at request
  // time — nothing to unlock/debit on a trading wallet here; the admin made
  // the external payout, so we just leave the balance debited.
  if (wd.source !== 'SUBSCRIPTION' && wd.source !== 'BONUS') {
    // Debit balance + unlock on the canonical base wallet. Use the
    // pre-stored baseCurrency / baseAmount; fall back to currency /
    // amount for legacy records written before the base columns existed.
    const wdBaseCcy = wd.baseCurrency || 'USD';
    const wdBaseAmt = wd.baseAmount && Number(wd.baseAmount) > 0 ? wd.baseAmount : wd.amount;
    await walletService.unlock({
      userId: wd.userId,
      accountId: wd.accountId,
      currency: wdBaseCcy,
      amount: wdBaseAmt,
    });
    await walletService.debit({
      userId: wd.userId,
      accountId: wd.accountId,
      currency: wdBaseCcy,
      amount: wdBaseAmt,
      type: WALLET_TX_TYPE.WITHDRAWAL,
      referenceType: 'withdrawal',
      referenceId: wd._id,
      note: `Withdrawal paid out: ${payoutTxReference} · ${wd.amount} ${wd.currency} @ ${wd.fxRateUsed || 1}`,
    });
  }

  await logAction(req, 'WITHDRAWAL_COMPLETED', { type: 'WITHDRAWAL', id: wd._id, payoutRef: payoutTxReference });

  // Email user
  try {
    const userDoc = await User.findById(wd.userId).select('email').lean();
    if (userDoc) {
      const emailSvc = require('../services/emailService');
      await emailSvc.sendWithdrawalAlert({
        to: userDoc.email,
        amount: wd.amount,
        currency: wd.currency,
        status: 'COMPLETED',
        destination: wd.destination,
      });
    }
  } catch (e) { /* non-fatal */ }

  // Push live update to user's open sessions.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(wd.userId), 'wallet', {
      action: 'debited',
      reason: 'WITHDRAWAL_COMPLETED',
      withdrawalId: String(wd._id),
      amount: wd.amount,
      currency: wd.currency,
      payoutTxReference,
    });
  } catch (_) {}

  sendSuccess(res, wd);
});

const rejectWithdrawal = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const wd = await Withdrawal.findById(req.params.id);
  if (!wd) throw new AppError('Withdrawal not found', 404);
  if (wd.status !== 'PENDING') throw new AppError('Withdrawal already processed', 400);
  wd.status = 'REJECTED';
  wd.rejectedReason = reason || 'Rejected by admin';
  await wd.save();
  const wdRefundAmt = wd.baseAmount && Number(wd.baseAmount) > 0 ? wd.baseAmount : wd.amount;
  if (wd.source === 'SUBSCRIPTION') {
    // Main Wallet was debited up-front — refund it.
    const subscriptionWalletService = require('../services/subscriptionWalletService');
    await subscriptionWalletService.credit({
      userId: wd.userId,
      amount: wdRefundAmt,
      reason: 'REFUND',
      note: `Refund: withdrawal ${wd._id} rejected`,
    });
  } else if (wd.source === 'BONUS') {
    // Bonus Wallet was debited up-front — refund it.
    const bonusWalletService = require('../services/bonusWalletService');
    await bonusWalletService.credit({
      userId: wd.userId,
      amount: wdRefundAmt,
      reason: 'REFUND',
      note: `Refund: withdrawal ${wd._id} rejected`,
    });
  } else {
    // Trading withdrawal: release the lock so funds return to available.
    await walletService.unlock({
      userId: wd.userId,
      accountId: wd.accountId,
      currency: wd.baseCurrency || 'USD',
      amount: wdRefundAmt,
    });
  }
  await logAction(req, 'WITHDRAWAL_REJECTED', { type: 'WITHDRAWAL', id: wd._id }, { reason });
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(wd.userId), 'wallet', {
      action: 'rejected',
      reason: 'WITHDRAWAL_REJECTED',
      withdrawalId: String(wd._id),
      amount: wd.amount,
      currency: wd.currency,
      rejectionReason: wd.rejectedReason,
    });
  } catch (_) {}
  sendSuccess(res, wd);
});

// DEPOSITS
const listDeposits = asyncHandler(async (req, res) => {
  const { status, userId } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (userId) filter.userId = userId;   // per-user history (User Mgmt modal)
  const scope = await adminScopeUserIds(req);
  if (!applyUserScope(filter, scope)) return sendSuccess(res, []);
  const items = await Deposit.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  await attachUserBadge(items);
  sendSuccess(res, items);
});

const confirmDeposit = asyncHandler(async (req, res) => {
  const dep = await Deposit.findById(req.params.id);
  if (!dep) throw new AppError('Deposit not found', 404);
  if (dep.status !== 'PENDING') throw new AppError('Deposit already processed', 400);
  dep.status = 'CONFIRMED';
  dep.confirmedAt = new Date();
  dep.confirmedBy = req.userId;
  await dep.save();
  // Credit amount — always in the base USD value pre-computed at submit.
  const creditCurrency = dep.baseCurrency || 'USD';
  const creditAmount = dep.baseAmount && Number(dep.baseAmount) > 0
    ? dep.baseAmount
    : dep.amount;

  // Route the credit. Subscription-wallet deposits land in the
  // user-level Subscription Wallet via its own service; trading-wallet
  // deposits go through the classic walletService (per-account).
  if (dep.targetWallet === 'bonus') {
    const bonusWalletService = require('../services/bonusWalletService');
    await bonusWalletService.credit({
      userId: dep.userId,
      amount: creditAmount,
      reason: 'DEPOSIT',
      paymentRef: String(dep._id),
      note: `Bonus wallet · ${dep.amount} ${dep.currency} confirmed by admin`,
    });
  } else if (dep.targetWallet === 'subscription') {
    const subscriptionWalletService = require('../services/subscriptionWalletService');
    await subscriptionWalletService.credit({
      userId: dep.userId,
      amount: creditAmount,
      reason: 'DEPOSIT',
      paymentMethod: dep.method,
      paymentRef: String(dep._id),
      note: `Subscription wallet · ${dep.amount} ${dep.currency} confirmed by admin`,
    });
  } else {
    await walletService.credit({
      userId: dep.userId,
      accountId: dep.accountId,
      currency: creditCurrency,
      amount: creditAmount,
      type: WALLET_TX_TYPE.DEPOSIT,
      referenceType: 'deposit',
      referenceId: dep._id,
      note: `Deposit confirmed · ${dep.amount} ${dep.currency} @ ${dep.fxRateUsed || 1}`,
    });
  }
  // Partner program: trigger the first-deposit bonus if this user was
  // referred and this is their first qualifying deposit. Best-effort —
  // never throws, never blocks the deposit confirmation.
  try {
    const partnerService = require('../services/partnerService');
    await partnerService.handleFirstQualifyingDeposit({ userId: dep.userId, deposit: dep });
  } catch (e) {
    console.warn('[deposit confirm] partner hook failed:', e.message);
  }

  await logAction(req, 'DEPOSIT_CONFIRMED', { type: 'DEPOSIT', id: dep._id });
  // Push the credit to the user's open sessions so the wallet hero,
  // notification center, and dashboard balance update instantly
  // without a manual refresh.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(dep.userId), 'wallet', {
      action: 'credited',
      reason: 'DEPOSIT_CONFIRMED',
      depositId: String(dep._id),
      amount: dep.amount,
      currency: dep.currency,
    });
  } catch (_) { /* socket optional */ }
  sendSuccess(res, dep);
});

const rejectDeposit = asyncHandler(async (req, res) => {
  const dep = await Deposit.findById(req.params.id);
  if (!dep) throw new AppError('Deposit not found', 404);
  if (dep.status !== 'PENDING') throw new AppError('Deposit already processed', 400);
  dep.status = 'REJECTED';
  dep.rejectionReason = req.body?.reason || 'No reason provided';
  await dep.save();
  await logAction(req, 'DEPOSIT_REJECTED', { type: 'DEPOSIT', id: dep._id, reason: dep.rejectionReason });
  // Inform the user-side notification system that their deposit was
  // rejected so the bell + toast can surface it immediately.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(dep.userId), 'wallet', {
      action: 'rejected',
      reason: 'DEPOSIT_REJECTED',
      depositId: String(dep._id),
      amount: dep.amount,
      currency: dep.currency,
      rejectionReason: dep.rejectionReason,
    });
  } catch (_) {}
  sendSuccess(res, dep);
});

// AUDIT
const listAuditLog = asyncHandler(async (req, res) => {
  const { limit = 200 } = req.query;
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(Number(limit)).lean();
  sendSuccess(res, logs);
});

// REPORTS
const tradesReport = asyncHandler(async (req, res) => {
  const { from, to, symbol, limit = 500 } = req.query;
  const filter = {};
  if (symbol) filter.symbol = symbol.toUpperCase();
  if (from || to) {
    filter.executedAt = {};
    if (from) filter.executedAt.$gte = new Date(from);
    if (to) filter.executedAt.$lte = new Date(to);
  }
  // Hierarchy scope — an ADMIN only sees trades involving their subtree's
  // users (a trade counts if either leg is one of their users). Super Admin: all.
  const scope = await adminScopeUserIds(req);
  if (scope) filter.$or = [{ buyUserId: { $in: scope } }, { sellUserId: { $in: scope } }];
  const trades = await Trade.find(filter).sort({ executedAt: -1 }).limit(Number(limit)).lean();
  sendSuccess(res, trades);
});

/**
 * Update a trading account's execution config.
 *
 * PATCH /admin/accounts/:accountId/execution-config
 * Body (all optional, only sent fields are applied):
 *   { bookType, lpProvider, isTradingEnabled, leverage }
 *
 * `accountType` is INTENTIONALLY not editable here — flipping DEMO ↔ REAL
 * mid-life corrupts wallet semantics (a demo wallet credited as real money,
 * or vice versa). Account type is baked in at creation.
 *
 * Validation:
 *   - bookType ∈ A_BOOK | B_BOOK | HYBRID
 *   - lpProvider ∈ NONE | OANDA | BINANCE | CUSTOM_LP
 *   - leverage finite & in [1, 1000]
 *   - If the resulting bookType is A_BOOK, lpProvider MUST NOT be NONE.
 */
const updateAccountExecutionConfig = asyncHandler(async (req, res) => {
  const { accountId } = req.params;
  const { bookType, lpProvider, isTradingEnabled, leverage } = req.body;

  const account = await TradingAccount.findById(accountId);
  if (!account) throw new AppError('Account not found', 404);

  if (bookType !== undefined) {
    if (!Object.values(BOOK_TYPE).includes(bookType)) {
      throw new AppError(`bookType must be one of ${Object.values(BOOK_TYPE).join(', ')}`, 400);
    }
    const switchingToB = bookType === BOOK_TYPE.B_BOOK && account.bookType !== BOOK_TYPE.B_BOOK;
    account.bookType = bookType;
    // When admin picks B_BOOK, LP is irrelevant — clear it so the row shows
    // a clean state (no leftover OANDA / BINANCE from a previous A_BOOK).
    // Doesn't touch lpProvider if admin is ALSO sending it in the same patch.
    if (switchingToB && lpProvider === undefined) {
      account.lpProvider = LP_PROVIDER.NONE;
    }
  }
  if (lpProvider !== undefined) {
    if (!Object.values(LP_PROVIDER).includes(lpProvider)) {
      throw new AppError(`lpProvider must be one of ${Object.values(LP_PROVIDER).join(', ')}`, 400);
    }
    account.lpProvider = lpProvider;
  }
  if (isTradingEnabled !== undefined) {
    account.isTradingEnabled = !!isTradingEnabled;
  }
  if (leverage !== undefined) {
    const lev = Number(leverage);
    if (!Number.isFinite(lev) || lev < 1 || lev > 1000) {
      throw new AppError('leverage must be a finite number between 1 and 1000', 400);
    }
    account.leverage = lev;
  }

  // Final-state safety: an A-book account NEEDS an LP. Instead of failing
  // when admin flips B_BOOK → A_BOOK without explicitly picking one, we
  // auto-pick the first credentialed provider (or fall back to a default
  // if none are configured — the adapter will log a clear warning when
  // it runs in stub mode). HYBRID accounts get the same convenience.
  if (
    (account.bookType === BOOK_TYPE.A_BOOK || account.bookType === BOOK_TYPE.HYBRID) &&
    account.lpProvider === LP_PROVIDER.NONE
  ) {
    const { pickAvailableProvider } = require('../adapters/lp');
    account.lpProvider = pickAvailableProvider();
  }

  await account.save();
  await logAction(req, 'ACCOUNT_EXECUTION_CONFIG_UPDATE', {
    type: 'TRADING_ACCOUNT',
    id: account._id,
  }, { bookType, lpProvider, isTradingEnabled, leverage });

  sendSuccess(res, account);
});

/**
 * Update per-user risk controls — used to override A/B-book routing on a
 * specific user (e.g. force a profitable trader's flow to LP regardless
 * of their account.bookType). Also exposes blockedInstruments[] for
 * symbol-level gating and userGroup for trader-group tagging.
 *
 * PATCH /admin/users/:id/risk-controls
 * Body (all optional):
 *   { forceABook, userGroup, blockedInstruments }
 */
const updateUserRiskControls = asyncHandler(async (req, res) => {
  const { forceABook, userGroup, blockedInstruments, routingMode } = req.body;
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);

  user.riskOverride = user.riskOverride || {};
  if (forceABook !== undefined) user.riskOverride.forceABook = !!forceABook;
  // Per-user routing override. '' / null / 'INHERIT' all clear the override
  // so the user falls back to the global SystemSetting.routingMode.
  if (routingMode !== undefined) {
    if (routingMode === null || routingMode === '' || routingMode === 'INHERIT') {
      user.riskOverride.routingMode = null;
    } else if (Object.values(EXECUTION_MODE).includes(routingMode)) {
      user.riskOverride.routingMode = routingMode;
    } else {
      throw new AppError(`routingMode must be one of ${Object.values(EXECUTION_MODE).join(', ')}, or INHERIT`, 400);
    }
  }
  if (userGroup !== undefined) {
    if (typeof userGroup !== 'string' || !userGroup.length) {
      throw new AppError('userGroup must be a non-empty string', 400);
    }
    user.userGroup = userGroup;
  }
  if (blockedInstruments !== undefined) {
    if (!Array.isArray(blockedInstruments)) {
      throw new AppError('blockedInstruments must be an array of symbols', 400);
    }
    user.blockedInstruments = blockedInstruments.map((s) => String(s).toUpperCase());
  }
  user.markModified('riskOverride');
  await user.save();
  await logAction(req, 'USER_RISK_CONTROLS_UPDATE', { type: 'USER', id: user._id }, {
    forceABook, userGroup, blockedInstruments, routingMode,
  });
  sendSuccess(res, user.toSafeJSON());
});

/**
 * GET /admin/system/settings
 * Returns every key/value in SystemSetting + the live LP provider status
 * (which providers have credentials wired up). Drives the admin Settings
 * page's "Routing Mode" toggle and "Default LP Provider" dropdown.
 */
const getSystemSettings = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  const { listProviderStatus } = require('../adapters/lp');
  const settings = await systemSettings.getAllSettings();
  sendSuccess(res, {
    settings,
    lpProviders: listProviderStatus(),
  });
});

/**
 * PUT /admin/system/settings
 * Body: { routingMode?: 'A_BOOK'|'B_BOOK', defaultLpProvider?: 'OANDA'|... }
 *
 * Validation:
 *   - routingMode must be A_BOOK or B_BOOK (HYBRID retired at global level).
 *   - If routingMode is A_BOOK, defaultLpProvider must not be NONE
 *     (checked against final state, like the per-account endpoint did).
 *   - defaultLpProvider must be in LP_PROVIDER enum.
 */
const updateSystemSettings = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  const {
    routingMode, defaultLpProvider,
    userTransfer, // { enabled, min, max, feePercent }
    chatUpload,   // { enabled, maxFileMB, maxTotalMB, maxFiles, allowedExtensions, roles }
  } = req.body;

  // Chat file-upload limits are SUPER-ADMIN only.
  if (chatUpload !== undefined && req.user.role !== 'SUPER_ADMIN') {
    throw new AppError('Only a Super Admin can change chat file-upload settings', 403, 'FORBIDDEN');
  }

  // Validate intent before any writes — keeps the system in a consistent
  // state if either field is malformed.
  if (routingMode !== undefined) {
    if (!Object.values(EXECUTION_MODE).includes(routingMode)) {
      throw new AppError(
        `routingMode must be one of ${Object.values(EXECUTION_MODE).join(', ')}`,
        400
      );
    }
  }
  if (defaultLpProvider !== undefined) {
    if (!Object.values(LP_PROVIDER).includes(defaultLpProvider)) {
      throw new AppError(
        `defaultLpProvider must be one of ${Object.values(LP_PROVIDER).join(', ')}`,
        400
      );
    }
  }
  // Peer-to-peer transfer knobs — light validation: amounts must be
  // non-negative decimals, feePercent in [0, 100], enabled coerced to
  // boolean. Bad input rejects the whole payload so partial writes
  // can't leave the platform half-configured.
  if (userTransfer !== undefined) {
    const isNonNegNum = (v) => v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0;
    if (userTransfer.min !== undefined && !isNonNegNum(userTransfer.min)) {
      throw new AppError('userTransfer.min must be a non-negative number', 400);
    }
    if (userTransfer.max !== undefined && !isNonNegNum(userTransfer.max)) {
      throw new AppError('userTransfer.max must be a non-negative number', 400);
    }
    if (userTransfer.feePercent !== undefined) {
      const f = Number(userTransfer.feePercent);
      if (!Number.isFinite(f) || f < 0 || f > 100) {
        throw new AppError('userTransfer.feePercent must be between 0 and 100', 400);
      }
    }
    if (userTransfer.min !== undefined && userTransfer.max !== undefined) {
      const a = Number(userTransfer.min), b = Number(userTransfer.max);
      if (b > 0 && a > b) {
        throw new AppError('userTransfer.min cannot exceed userTransfer.max', 400);
      }
    }
  }

  // Final-state safety: A_BOOK or HYBRID without an LP is a misconfiguration
  // trap — orders will reject at runtime. Compute final state and reject
  // the change early so admin sees the error in the Settings form, not
  // in production.
  const current = await systemSettings.getAllSettings();
  const finalMode = routingMode !== undefined ? routingMode : current.routingMode;
  const finalLp = defaultLpProvider !== undefined ? defaultLpProvider : current.defaultLpProvider;
  const needsLp = finalMode === BOOK_TYPE.A_BOOK || finalMode === BOOK_TYPE.HYBRID;
  if (needsLp && (!finalLp || finalLp === LP_PROVIDER.NONE)) {
    throw new AppError(
      'LP provider is not configured. Please configure default LP before using A-Book / Hybrid mode.',
      400,
      'LP_PROVIDER_NOT_CONFIGURED'
    );
  }

  // Partner / Referral settings — bonus amount, min deposit, tiers,
  // enabled toggle. Each field is validated then written through.
  const { partner } = req.body || {};
  if (partner && typeof partner === 'object') {
    if (partner.bonusAmount !== undefined && !(Number.isFinite(Number(partner.bonusAmount)) && Number(partner.bonusAmount) >= 0)) {
      throw new AppError('partner.bonusAmount must be a non-negative number', 400);
    }
    if (partner.minDeposit !== undefined && !(Number.isFinite(Number(partner.minDeposit)) && Number(partner.minDeposit) >= 0)) {
      throw new AppError('partner.minDeposit must be a non-negative number', 400);
    }
    if (partner.bonusCurrency !== undefined && (typeof partner.bonusCurrency !== 'string' || !partner.bonusCurrency.trim())) {
      throw new AppError('partner.bonusCurrency must be a non-empty string', 400);
    }
    if (partner.tiers !== undefined) {
      if (!Array.isArray(partner.tiers) || partner.tiers.length === 0) {
        throw new AppError('partner.tiers must be a non-empty array', 400);
      }
      const sorted = [...partner.tiers].sort((a, b) => Number(a.minActive) - Number(b.minActive));
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i];
        if (!t.name || typeof t.name !== 'string') throw new AppError(`partner.tiers[${i}].name is required`, 400);
        if (!Number.isFinite(Number(t.minActive)) || Number(t.minActive) < 0) throw new AppError(`partner.tiers[${i}].minActive must be ≥ 0`, 400);
        if (!Number.isFinite(Number(t.maxActive)) || Number(t.maxActive) < 0) throw new AppError(`partner.tiers[${i}].maxActive must be ≥ 0`, 400);
        const pct = Number(t.percent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new AppError(`partner.tiers[${i}].percent must be 0–100`, 400);
        if (i > 0 && Number(t.minActive) <= Number(sorted[i - 1].minActive)) {
          throw new AppError(`partner.tiers thresholds must be strictly increasing`, 400);
        }
      }
    }
    if (partner.volumeTiers !== undefined) {
      if (!Array.isArray(partner.volumeTiers) || partner.volumeTiers.length === 0) {
        throw new AppError('partner.volumeTiers must be a non-empty array', 400);
      }
      const sorted = [...partner.volumeTiers].sort((a, b) => Number(a.minVolume) - Number(b.minVolume));
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i];
        if (!t.name || typeof t.name !== 'string') throw new AppError(`partner.volumeTiers[${i}].name is required`, 400);
        if (!Number.isFinite(Number(t.minVolume)) || Number(t.minVolume) < 0) throw new AppError(`partner.volumeTiers[${i}].minVolume must be ≥ 0`, 400);
        const pct = Number(t.percent);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new AppError(`partner.volumeTiers[${i}].percent must be 0–100`, 400);
        if (i > 0 && Number(t.minVolume) <= Number(sorted[i - 1].minVolume)) {
          throw new AppError('partner.volumeTiers thresholds must be strictly increasing', 400);
        }
      }
    }
  }

  if (routingMode !== undefined) await systemSettings.setSetting('routingMode', routingMode, req.userId);
  if (defaultLpProvider !== undefined) await systemSettings.setSetting('defaultLpProvider', defaultLpProvider, req.userId);
  if (partner && typeof partner === 'object') {
    if (partner.enabled     !== undefined) await systemSettings.setSetting('partner.enabled',     !!partner.enabled, req.userId);
    if (partner.bonusAmount !== undefined) await systemSettings.setSetting('partner.bonusAmount', String(partner.bonusAmount), req.userId);
    if (partner.minDeposit  !== undefined) await systemSettings.setSetting('partner.minDeposit',  String(partner.minDeposit),  req.userId);
    if (partner.bonusCurrency !== undefined) await systemSettings.setSetting('partner.bonusCurrency', String(partner.bonusCurrency).trim().toUpperCase(), req.userId);
    if (partner.tiers       !== undefined) {
      const normalized = [...partner.tiers]
        .map((t) => ({
          name:      String(t.name).toUpperCase(),
          minActive: Number(t.minActive),
          maxActive: Number(t.maxActive),
          percent:   String(t.percent),
        }))
        .sort((a, b) => a.minActive - b.minActive);
      await systemSettings.setSetting('partner.tiers', normalized, req.userId);
    }
    if (partner.volumeTiers !== undefined) {
      const normalizedVol = [...partner.volumeTiers]
        .map((t) => ({
          name:      String(t.name).toUpperCase(),
          minVolume: Number(t.minVolume),
          percent:   String(t.percent),
        }))
        .sort((a, b) => a.minVolume - b.minVolume);
      await systemSettings.setSetting('partner.volumeTiers', normalizedVol, req.userId);
    }
  }
  if (userTransfer && typeof userTransfer === 'object') {
    if (userTransfer.enabled    !== undefined) await systemSettings.setSetting('userTransfer.enabled',    !!userTransfer.enabled, req.userId);
    if (userTransfer.min        !== undefined) await systemSettings.setSetting('userTransfer.min',        String(userTransfer.min), req.userId);
    if (userTransfer.max        !== undefined) await systemSettings.setSetting('userTransfer.max',        String(userTransfer.max), req.userId);
    if (userTransfer.feePercent !== undefined) await systemSettings.setSetting('userTransfer.feePercent', String(userTransfer.feePercent), req.userId);
  }

  // ── Chat file-upload limits (Super Admin) ──
  if (chatUpload && typeof chatUpload === 'object') {
    const posNum = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;
    for (const k of ['maxFileMB', 'maxTotalMB', 'maxFiles']) {
      if (chatUpload[k] !== undefined && !posNum(chatUpload[k])) throw new AppError(`chatUpload.${k} must be a non-negative number`, 400);
    }
    if (chatUpload.maxFileMB !== undefined && Number(chatUpload.maxFileMB) > 500) throw new AppError('chatUpload.maxFileMB cannot exceed 500 MB', 400);
    if (chatUpload.maxTotalMB !== undefined && Number(chatUpload.maxTotalMB) > 2000) throw new AppError('chatUpload.maxTotalMB cannot exceed 2000 MB', 400);

    if (chatUpload.enabled    !== undefined) await systemSettings.setSetting('chat.upload.enabled', !!chatUpload.enabled, req.userId);
    if (chatUpload.maxFileMB  !== undefined) await systemSettings.setSetting('chat.upload.maxFileMB', Number(chatUpload.maxFileMB), req.userId);
    if (chatUpload.maxTotalMB !== undefined) await systemSettings.setSetting('chat.upload.maxTotalMB', Number(chatUpload.maxTotalMB), req.userId);
    if (chatUpload.maxFiles   !== undefined) await systemSettings.setSetting('chat.upload.maxFiles', Number(chatUpload.maxFiles), req.userId);
    if (chatUpload.allowedExtensions !== undefined) {
      const raw = Array.isArray(chatUpload.allowedExtensions) ? chatUpload.allowedExtensions : String(chatUpload.allowedExtensions).split(',');
      const exts = [...new Set(raw.map((e) => String(e).toLowerCase().trim().replace(/^\./, '')).filter(Boolean))];
      await systemSettings.setSetting('chat.upload.allowedExtensions', exts, req.userId);
    }
    if (chatUpload.roles && typeof chatUpload.roles === 'object') {
      const clean = {};
      for (const r of ['USER', 'MANAGER', 'ADMIN']) {
        const rc = chatUpload.roles[r] || {};
        clean[r] = {
          enabled: rc.enabled !== false,
          maxFileMB:  Math.max(0, Number(rc.maxFileMB) || 0),
          maxTotalMB: Math.max(0, Number(rc.maxTotalMB) || 0),
          maxFiles:   Math.max(0, Number(rc.maxFiles) || 0),
        };
      }
      await systemSettings.setSetting('chat.upload.roles', clean, req.userId);
    }
  }

  await logAction(req, 'SYSTEM_SETTINGS_UPDATE', { type: 'SYSTEM', id: null }, {
    routingMode, defaultLpProvider, userTransfer, chatUpload: chatUpload ? Object.keys(chatUpload) : undefined,
  });

  const fresh = await systemSettings.getAllSettings();
  sendSuccess(res, fresh);
});

/**
 * GET /admin/transfers/user
 * List all peer-to-peer wallet transfers. Pairs the OUT row with its
 * IN row (same referenceId) and returns a flat record per transfer:
 *
 *   { referenceId, createdAt, currency, amount, fee, status,
 *     from: { userId, name, email, accountId },
 *     to:   { userId, name, email, accountId },
 *     note }
 *
 * Pagination: ?limit=100&before=<iso-date>. Filters: ?fromUserId,
 * ?toUserId, ?currency, ?minAmount, ?maxAmount, ?status.
 *
 * NOTE: "status" here is always 'COMPLETED' for paired rows; an
 * unpaired OUT row (no matching IN) is surfaced as 'FAILED' so an
 * on-call can spot stuck transfers and reconcile.
 */
const listUserTransfers = asyncHandler(async (req, res) => {
  const { WalletLedger } = require('../models/Wallet');
  const User = require('../models/User');
  const { limit = 100, before, fromUserId, toUserId, currency, minAmount, maxAmount, status, email, fromDate, toDate } = req.query;

  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  const filter = { type: 'INTERNAL_TRANSFER_OUT' };
  if (currency) filter.currency = currency;
  if (fromUserId) filter.userId = fromUserId;
  // Date range (fromDate/toDate, inclusive end-of-day) takes precedence over
  // the legacy `before` cursor.
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) filter.createdAt.$lte = new Date(new Date(toDate).setHours(23, 59, 59, 999));
  } else if (before) {
    filter.createdAt = { $lt: new Date(before) };
  }

  const outs = await WalletLedger.find(filter).sort({ createdAt: -1 }).limit(cap).lean();
  const refIds = outs.map((o) => o.referenceId).filter(Boolean);
  const ins = refIds.length
    ? await WalletLedger.find({
        type: 'INTERNAL_TRANSFER_IN',
        referenceId: { $in: refIds },
      }).lean()
    : [];
  const inByRef = new Map(ins.map((i) => [String(i.referenceId), i]));

  const userIds = new Set();
  for (const o of outs) userIds.add(String(o.userId));
  for (const i of ins)  userIds.add(String(i.userId));
  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } }).select('_id firstName lastName email referralCode').lean()
    : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const displayUser = (u) => u && ({
    userId:       String(u._id),
    name:         [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    email:        u.email,
    referralCode: u.referralCode || null,
  });

  const rows = outs.map((o) => {
    const inRow = inByRef.get(String(o.referenceId));
    // OUT amount is signed-negative; the absolute value is the sender's
    // debit total (gross amount + fee). The IN row carries the receiver
    // credit (the net gross amount). The fee is the difference.
    const outAbs = Math.abs(Number(o.amount));
    const inAbs  = inRow ? Math.abs(Number(inRow.amount)) : null;
    const fee    = inAbs != null ? Math.max(0, outAbs - inAbs) : 0;
    const rowStatus = inRow ? 'COMPLETED' : 'FAILED';
    return {
      referenceId:  String(o.referenceId),
      createdAt:    o.createdAt,
      currency:     o.currency,
      amount:       inAbs != null ? String(inAbs) : String(outAbs),
      fee:          String(fee),
      totalDebited: String(outAbs),
      status:       rowStatus,
      from: {
        ...displayUser(userById.get(String(o.userId))),
        accountId: String(o.accountId),
      },
      to: inRow ? {
        ...displayUser(userById.get(String(inRow.userId))),
        accountId: String(inRow.accountId),
      } : null,
      note: o.note || null,
    };
  });

  // Optional post-filters (cheaper than threading them through the query).
  const emailRe = email ? new RegExp(_esc(String(email).trim()), 'i') : null;
  const filtered = rows.filter((r) => {
    if (toUserId && r.to?.userId !== String(toUserId)) return false;
    if (status && r.status !== String(status).toUpperCase()) return false;
    if (minAmount != null && minAmount !== '' && Number(r.amount) < Number(minAmount)) return false;
    if (maxAmount != null && maxAmount !== '' && Number(r.amount) > Number(maxAmount)) return false;
    // Email / name search across either counterparty.
    if (emailRe) {
      const hay = `${r.from?.email || ''} ${r.from?.name || ''} ${r.to?.email || ''} ${r.to?.name || ''}`;
      if (!emailRe.test(hay)) return false;
    }
    return true;
  });

  sendSuccess(res, filtered);
});

// ─── Partner / Referral admin endpoints ───────────────────────────────

/**
 * GET /admin/partners
 * List users that have at least one referee, with their tier, active /
 * total referral counts, total commission paid, and block flag.
 * Filters: ?level=BRONZE&blocked=true&search=email,referralCode,name
 */
const listPartners = asyncHandler(async (req, res) => {
  const partnerService = require('../services/partnerService');
  const { Commission } = require('../models/Compliance');

  // Anyone who has at least one referee is a potential partner.
  const partnerIds = await User.distinct('referredBy', { referredBy: { $ne: null } });
  if (!partnerIds.length) return sendSuccess(res, []);

  const filter = { _id: { $in: partnerIds } };
  // Hierarchy scope — an ADMIN sees only partners within their subtree.
  if (req.user && req.user.role === 'ADMIN') filter.adminId = req.user._id;
  if (req.query.blocked === 'true')  filter.partnerBlocked = true;
  if (req.query.blocked === 'false') filter.partnerBlocked = { $ne: true };
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { email: rx }, { firstName: rx }, { lastName: rx }, { referralCode: rx },
    ];
  }

  const users = await User.find(filter)
    .select('_id firstName lastName email referralCode partnerLevel partnerLevelLocked partnerBlocked createdAt')
    .lean();

  // Commission rollups, single aggregate.
  const commGroups = await Commission.aggregate([
    { $match: { referrerId: { $in: users.map((u) => u._id) } } },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    { $group: {
        _id: '$referrerId',
        lifetime: { $sum: '$amtNum' },
        paid:     { $sum: { $cond: [{ $eq: ['$status', 'PAID'] }, '$amtNum', 0] } },
        pending:  { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$amtNum', 0] } },
    } },
  ]);
  const commByUser = new Map(commGroups.map((g) => [String(g._id), g]));

  const out = [];
  for (const u of users) {
    // Monthly volume-based tier (driven by previous-month referral volume).
    const lvl = await partnerService.getEffectiveTier(u._id);
    if (req.query.level && lvl.name !== String(req.query.level).toUpperCase()) continue;
    const totalReferrals = await User.countDocuments({ referredBy: u._id });
    const comm = commByUser.get(String(u._id)) || { lifetime: 0, paid: 0, pending: 0 };
    out.push({
      _id:          String(u._id),
      name:         [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      email:        u.email,
      referralCode: u.referralCode,
      level:        lvl.name,
      percent:      lvl.percent,
      locked:       lvl.locked,
      blocked:      !!u.partnerBlocked,
      previousMonthVolume: Math.round(lvl.prevMonthVolume || 0),
      totalReferrals,
      lifetimeEarnings: Number(comm.lifetime).toFixed(2),
      paidEarnings:     Number(comm.paid).toFixed(2),
      pendingEarnings:  Number(comm.pending).toFixed(2),
      createdAt:    u.createdAt,
    });
  }
  // Sort: highest previous-month referral volume first.
  out.sort((a, b) => b.previousMonthVolume - a.previousMonthVolume);
  sendSuccess(res, out);
});

/**
 * PUT /admin/partners/:id/level
 * Body: { level: 'BRONZE'|'SILVER'|'GOLD'|'PLATINUM'|'ELITE'|null, locked: boolean }
 * Manually pins a partner's tier (overriding the monthly volume calculation)
 * or clears the pin so the auto-calculation resumes next read.
 */
const setPartnerLevel = asyncHandler(async (req, res) => {
  const { level, locked } = req.body || {};
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  if (level !== undefined) user.partnerLevel = level || null;
  if (locked !== undefined) user.partnerLevelLocked = !!locked;
  await user.save();
  await logAction(req, 'PARTNER_LEVEL_OVERRIDE', { type: 'USER', id: user._id }, { level, locked });
  sendSuccess(res, {
    _id: String(user._id),
    partnerLevel:       user.partnerLevel,
    partnerLevelLocked: user.partnerLevelLocked,
  });
});

/**
 * POST /admin/partners/:id/block — Body: { blocked: boolean }
 * Excludes the partner from earning future commissions WITHOUT touching
 * `isActive` (which gates login).
 */
const setPartnerBlocked = asyncHandler(async (req, res) => {
  const { blocked } = req.body || {};
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  user.partnerBlocked = !!blocked;
  await user.save();
  await logAction(req, 'PARTNER_BLOCK_TOGGLE', { type: 'USER', id: user._id }, { blocked: !!blocked });
  sendSuccess(res, { _id: String(user._id), partnerBlocked: user.partnerBlocked });
});

/**
 * GET /admin/partners/analytics
 * Aggregate program-wide stats: total partners, active partners, bonuses
 * paid, revenue shared, commission liability (pending), top earners.
 */
const partnerAnalytics = asyncHandler(async (req, res) => {
  const { Commission } = require('../models/Compliance');
  // Hierarchy scope — an ADMIN's program stats cover only their subtree's
  // partners (referrers who are their users). Super Admin: whole program.
  const scopeIds = (req.user && req.user.role === 'ADMIN')
    ? await User.find({ adminId: req.user._id }).distinct('_id')
    : null;
  const commMatch = scopeIds ? { referrerId: { $in: scopeIds } } : {};
  const refByFilter = scopeIds ? { referredBy: { $in: scopeIds } } : { referredBy: { $ne: null } };

  const totalPartners = (await User.distinct('referredBy', refByFilter)).length;
  const totalReferrals = await User.countDocuments(refByFilter);

  const totals = await Commission.aggregate([
    { $match: commMatch },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    { $group: {
        _id: null,
        bonusesPaid: { $sum: { $cond: [{ $and: [{ $eq: ['$sourceType', 'DEPOSIT_BONUS'] }, { $eq: ['$status', 'PAID'] }] }, '$amtNum', 0] } },
        revenueShared: { $sum: { $cond: [{ $and: [{ $in: ['$sourceType', ['TRADE_FEE','SPREAD']] }, { $eq: ['$status', 'PAID'] }] }, '$amtNum', 0] } },
        liability: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$amtNum', 0] } },
    } },
  ]);
  const t = totals[0] || { bonusesPaid: 0, revenueShared: 0, liability: 0 };

  const topEarners = await Commission.aggregate([
    { $match: commMatch },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    { $group: { _id: '$referrerId', total: { $sum: '$amtNum' } } },
    { $sort: { total: -1 } }, { $limit: 10 },
  ]);
  const topUsers = topEarners.length
    ? await User.find({ _id: { $in: topEarners.map((e) => e._id) } }).select('firstName lastName email referralCode').lean()
    : [];
  const userMap = new Map(topUsers.map((u) => [String(u._id), u]));
  const top = topEarners.map((e) => {
    const u = userMap.get(String(e._id)) || {};
    return {
      userId: String(e._id),
      name:   [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—',
      referralCode: u.referralCode || null,
      total:  Number(e.total).toFixed(2),
    };
  });

  sendSuccess(res, {
    totalPartners,
    totalReferrals,
    bonusesPaid:   Number(t.bonusesPaid).toFixed(2),
    revenueShared: Number(t.revenueShared).toFixed(2),
    commissionLiability: Number(t.liability).toFixed(2),
    topEarners: top,
  });
});

/**
 * GET /admin/execution/stats?period=24h|7d|30d
 * Execution-mode analytics for the admin dashboard:
 *   volumes per venue, user↔user matches, hybrid-routed count, rejections,
 *   routed notional per book (exposure proxy), and routing distribution %.
 */
const getExecutionStats = asyncHandler(async (req, res) => {
  const Trade = require('../models/Trade');
  const RoutingDecision = require('../models/RoutingDecision');

  // Global DateFilter sends fromDate/toDate; fall back to period day-counts.
  const now = new Date();
  let since;
  let until = now;
  if (req.query.fromDate || req.query.toDate) {
    since = req.query.fromDate ? new Date(req.query.fromDate) : new Date(now.getTime() - 7 * 86400000);
    until = req.query.toDate ? new Date(new Date(req.query.toDate).setHours(23, 59, 59, 999)) : now;
  } else {
    const d = { '24h': 1, '7d': 7, '30d': 30 }[req.query.period] || 7;
    since = new Date(now.getTime() - d * 86400000);
  }
  const range = { $gte: since, $lte: until };

  // Executed volume by venue (actual fills).
  const volAgg = await Trade.aggregate([
    { $match: { executedAt: range } },
    { $group: {
        _id: '$routing',
        volume: { $sum: { $multiply: [{ $toDouble: '$price' }, { $toDouble: '$quantity' }] } },
        trades: { $sum: 1 },
    } },
  ]);
  const vmap = {};
  volAgg.forEach((v) => { vmap[v._id] = { volume: round2(v.volume), trades: v.trades }; });

  // True user↔user matched trades (distinct buyer/seller).
  const u2uCount = await Trade.countDocuments({
    executedAt: range,
    routing: ROUTING.INTERNAL_MATCHING,
    $expr: { $ne: ['$buyUserId', '$sellUserId'] },
  });

  // Routing decisions → distribution %, hybrid count, routed notional/venue.
  const decAgg = await RoutingDecision.aggregate([
    { $match: { createdAt: range } },
    { $group: { _id: '$routingResult', count: { $sum: 1 }, notional: { $sum: '$notional' } } },
  ]);
  const dmap = {}; let totalDec = 0;
  decAgg.forEach((d) => { dmap[d._id || 'NULL'] = { count: d.count, notional: round2(d.notional) }; totalDec += d.count; });
  const hybridRouted = await RoutingDecision.countDocuments({ createdAt: range, executionMode: EXECUTION_MODE.HYBRID });
  const pct = (n) => (totalDec ? round2((n / totalDec) * 100) : 0);
  const cnt = (k) => dmap[k]?.count || 0;
  const notl = (k) => dmap[k]?.notional || 0;

  sendSuccess(res, {
    period: req.query.period || 'custom',
    volume: {
      internalMatching: vmap[ROUTING.INTERNAL_MATCHING]?.volume || 0,
      bBook:            vmap[ROUTING.B_BOOK]?.volume || 0,
      aBook:            vmap[ROUTING.EXTERNAL]?.volume || 0,
      legacyInternal:   vmap[ROUTING.INTERNAL]?.volume || 0,
    },
    trades: {
      internalMatching: vmap[ROUTING.INTERNAL_MATCHING]?.trades || 0,
      bBook:            vmap[ROUTING.B_BOOK]?.trades || 0,
      aBook:            vmap[ROUTING.EXTERNAL]?.trades || 0,
      userToUserMatched: u2uCount,
    },
    hybridRoutedOrders: hybridRouted,
    rejectedOrders: cnt('REJECTED'),
    // Routed notional in the window — proxy for exposure each book carries.
    exposure: {
      broker:           notl(ROUTING_RESULT.B_BOOK),            // B-book → broker risk
      lp:               notl(ROUTING_RESULT.A_BOOK),            // A-book → transferred to LP
      internalMatching: notl(ROUTING_RESULT.INTERNAL_MATCHING), // user↔user → broker flat
    },
    distribution: {
      INTERNAL_MATCHING: { count: cnt(ROUTING_RESULT.INTERNAL_MATCHING), pct: pct(cnt(ROUTING_RESULT.INTERNAL_MATCHING)) },
      B_BOOK:            { count: cnt(ROUTING_RESULT.B_BOOK),            pct: pct(cnt(ROUTING_RESULT.B_BOOK)) },
      A_BOOK:            { count: cnt(ROUTING_RESULT.A_BOOK),            pct: pct(cnt(ROUTING_RESULT.A_BOOK)) },
      REJECTED:          { count: cnt('REJECTED'),                       pct: pct(cnt('REJECTED')) },
    },
    totalDecisions: totalDec,
  });
});

/**
 * GET /admin/execution/decisions — paginated routing-decision audit log.
 * Filters: userId, executionMode, routingResult.
 */
const listRoutingDecisions = asyncHandler(async (req, res) => {
  const RoutingDecision = require('../models/RoutingDecision');
  const { userId, executionMode, routingResult, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (userId) filter.userId = userId;
  if (executionMode) filter.executionMode = executionMode;
  if (routingResult) filter.routingResult = routingResult;
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
  const [items, total] = await Promise.all([
    RoutingDecision.find(filter)
      .sort({ createdAt: -1 }).skip(skip).limit(lim)
      .populate('userId', 'email userUid firstName lastName').lean(),
    RoutingDecision.countDocuments(filter),
  ]);
  sendSuccess(res, { items, total, page: Number(page) || 1, limit: lim });
});

// ── Multi-account management ─────────────────────────────────────────
const _esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which users' accounts may this actor touch? null = unrestricted (super).
async function _accountScopeUserIds(actor) {
  if (actor.role === 'SUPER_ADMIN') return null;
  if (actor.role === 'ADMIN')   return User.find({ adminId: actor._id }).distinct('_id');
  if (actor.role === 'MANAGER') return User.find({ managerId: actor._id }).distinct('_id');
  return [];
}
async function _assertAccountInScope(actor, account) {
  if (actor.role === 'SUPER_ADMIN') return;
  const owner = await User.findById(account.userId).select('adminId managerId').lean();
  if (!owner) throw new AppError('Account owner not found', 404);
  if (actor.role === 'ADMIN' && String(owner.adminId) === String(actor._id)) return;
  if (actor.role === 'MANAGER' && String(owner.managerId) === String(actor._id)) return;
  throw new AppError('This account is not in your hierarchy', 403, 'OUT_OF_SCOPE');
}

// GET /admin/accounts — search/filter/paginate across users (hierarchy-scoped).
const listAccounts = asyncHandler(async (req, res) => {
  const { search, status, accountType, userId, page = 1, limit = 50 } = req.query;
  const and = [];
  if (status) and.push({ status });
  if (accountType) and.push({ accountType });
  if (userId) and.push({ userId });
  if (search) {
    const re = new RegExp(_esc(search), 'i');
    const su = await User.find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { userUid: re }] }).distinct('_id');
    and.push({ $or: [{ accountNumber: re }, { userId: { $in: su } }] });
  }
  const scopeIds = await _accountScopeUserIds(req.user);
  if (scopeIds) and.push({ userId: { $in: scopeIds } });

  const filter = and.length ? { $and: and } : {};
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;

  const [rows, total] = await Promise.all([
    TradingAccount.find(filter)
      .populate('userId', 'email firstName lastName userUid')
      .sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    TradingAccount.countDocuments(filter),
  ]);

  const ids = rows.map((a) => a._id);
  const balAgg = ids.length ? await Wallet.aggregate([
    { $match: { accountId: { $in: ids } } },
    { $group: { _id: '$accountId', bal: { $sum: { $convert: { input: '$balance', to: 'double', onError: 0, onNull: 0 } } } } },
  ]) : [];
  const balById = new Map(balAgg.map((b) => [String(b._id), round2(b.bal)]));

  const accounts = rows.map((a) => {
    const u = a.userId || {};
    return {
      _id: a._id,
      accountNumber: a.accountNumber,
      accountType: a.accountType,
      status: a.status || 'ACTIVE',
      isTradingEnabled: a.isTradingEnabled !== false,
      baseCurrency: a.baseCurrency,
      leverage: a.leverage,
      balance: balById.get(String(a._id)) || 0,
      createdAt: a.createdAt,
      notesCount: (a.internalNotes || []).length,
      user: { _id: u._id, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' '), userUid: u.userUid },
    };
  });
  sendSuccess(res, { accounts, total, page: Number(page) || 1, limit: lim });
});

// GET /admin/accounts/:accountId — full detail (+ wallets + notes).
const getAccountDetail = asyncHandler(async (req, res) => {
  const account = await TradingAccount.findById(req.params.accountId).lean();
  if (!account) throw new AppError('Account not found', 404);
  await _assertAccountInScope(req.user, account);
  const [user, wallets] = await Promise.all([
    User.findById(account.userId).select('email firstName lastName userUid kycStatus isActive').lean(),
    Wallet.find({ accountId: account._id }).lean(),
  ]);
  sendSuccess(res, { account, user, wallets, notes: account.internalNotes || [] });
});

// GET /admin/accounts/:accountId/positions — open positions for the account.
const getAccountPositions = asyncHandler(async (req, res) => {
  const account = await TradingAccount.findById(req.params.accountId).select('userId').lean();
  if (!account) throw new AppError('Account not found', 404);
  await _assertAccountInScope(req.user, account);
  const positions = await Position.find({ accountId: account._id, status: { $in: ['OPEN', 'CLOSING'] } })
    .select('symbol side positionSide quantity entryPrice leverage unrealizedPnl realizedPnl stopLoss takeProfit openedAt')
    .sort({ openedAt: -1 }).limit(200).lean();
  sendSuccess(res, positions);
});

// PATCH /admin/accounts/:accountId/status — block / unblock / suspend.
const setAccountStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'BLOCKED', 'SUSPENDED'].includes(status)) {
    throw new AppError('status must be ACTIVE, BLOCKED or SUSPENDED', 400);
  }
  const account = await TradingAccount.findById(req.params.accountId);
  if (!account) throw new AppError('Account not found', 404);
  await _assertAccountInScope(req.user, account);
  const from = account.status || 'ACTIVE';
  account.status = status;
  await account.save();
  await logAction(req, 'ACCOUNT_STATUS_CHANGE', { type: 'ACCOUNT', id: account._id }, {
    from, to: status, accountNumber: account.accountNumber, reason: req.body.reason || '',
  });
  sendSuccess(res, { _id: account._id, status: account.status });
});

// POST /admin/accounts/:accountId/notes — append an internal note.
const addAccountNote = asyncHandler(async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!note) throw new AppError('Note is required', 400);
  const account = await TradingAccount.findById(req.params.accountId);
  if (!account) throw new AppError('Account not found', 404);
  await _assertAccountInScope(req.user, account);
  account.internalNotes.push({
    note,
    by: req.userId,
    byName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
    at: new Date(),
  });
  await account.save();
  await logAction(req, 'ACCOUNT_NOTE_ADD', { type: 'ACCOUNT', id: account._id }, { accountNumber: account.accountNumber });
  sendSuccess(res, { notes: account.internalNotes });
});

// ── User-first accounts management ───────────────────────────────────
const _num = (f) => ({ $convert: { input: f, to: 'double', onError: 0, onNull: 0 } });
const DEMO_TYPES = ['DEMO', 'VIRTUAL'];

async function _assertUserInScope(actor, userId) {
  if (actor.role === 'SUPER_ADMIN') return;
  const u = await User.findById(userId).select('adminId managerId').lean();
  if (!u) throw new AppError('User not found', 404);
  if (actor.role === 'ADMIN' && String(u.adminId) === String(actor._id)) return;
  if (actor.role === 'MANAGER' && String(u.managerId) === String(actor._id)) return;
  throw new AppError('This user is not in your hierarchy', 403, 'OUT_OF_SCOPE');
}

// Build the TradingAccount $match from query filters (status/type/group/date).
function _accFilter({ status, type, group, from, to }) {
  const m = {};
  if (status) m.status = status;
  if (group) m.group = group;
  if (type === 'LIVE') m.accountType = { $nin: DEMO_TYPES };
  else if (type === 'DEMO') m.accountType = { $in: DEMO_TYPES };
  else if (type) m.accountType = type;
  if (from || to) {
    m.createdAt = {};
    if (from) m.createdAt.$gte = new Date(from);
    if (to) m.createdAt.$lte = new Date(to);
  }
  return m;
}

// GET /admin/accounts/users — one row per user with aggregated account stats.
const listAccountUsers = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 25 } = req.query;
  const match = _accFilter(req.query);

  if (search) {
    const re = new RegExp(_esc(search), 'i');
    const su = await User.find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { userUid: re }] }).distinct('_id');
    match.$or = [{ accountNumber: re }, { userId: { $in: su } }];
  }
  const scopeIds = await _accountScopeUserIds(req.user);
  if (scopeIds) match.userId = { $in: scopeIds };

  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * lim;

  // Group accounts by user (cheap counts) + paginate users.
  const grp = await TradingAccount.aggregate([
    { $match: match },
    { $group: {
        _id: '$userId',
        totalAccounts: { $sum: 1 },
        live:      { $sum: { $cond: [{ $in: ['$accountType', DEMO_TYPES] }, 0, 1] } },
        demo:      { $sum: { $cond: [{ $in: ['$accountType', DEMO_TYPES] }, 1, 0] } },
        blocked:   { $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] } },
        suspended: { $sum: { $cond: [{ $eq: ['$status', 'SUSPENDED'] }, 1, 0] } },
    } },
    { $sort: { totalAccounts: -1, _id: 1 } },
    { $facet: { data: [{ $skip: skip }, { $limit: lim }], meta: [{ $count: 'total' }] } },
  ]);
  const groups = grp[0]?.data || [];
  const total = grp[0]?.meta?.[0]?.total || 0;
  const userIds = groups.map((g) => g._id);

  // Enrich the page only (no N+1): user info + balance + open uPnL/margin.
  const [users, walletAgg, posAgg] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('email firstName lastName userUid createdAt').lean(),
    Wallet.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: '$userId', bal: { $sum: _num('$balance') } } }]),
    Position.aggregate([{ $match: { userId: { $in: userIds }, status: 'OPEN' } }, { $group: { _id: '$userId', upnl: { $sum: _num('$unrealizedPnl') }, margin: { $sum: _num('$margin') } } }]),
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const balMap = new Map(walletAgg.map((w) => [String(w._id), w.bal]));
  const posMap = new Map(posAgg.map((p) => [String(p._id), p]));

  const items = groups.map((g) => {
    const id = String(g._id);
    const u = uMap.get(id) || {};
    const bal = round2(balMap.get(id) || 0);
    const pos = posMap.get(id) || { upnl: 0, margin: 0 };
    return {
      userId: id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—',
      email: u.email || '',
      userUid: u.userUid || '',
      totalAccounts: g.totalAccounts,
      liveAccounts: g.live,
      demoAccounts: g.demo,
      totalBalance: bal,
      totalEquity: round2(bal + (pos.upnl || 0)),
      totalMargin: round2(pos.margin || 0),
      overallStatus: g.blocked > 0 ? 'BLOCKED' : g.suspended > 0 ? 'SUSPENDED' : 'ACTIVE',
      registeredAt: u.createdAt || null,
    };
  });
  sendSuccess(res, { items, total, page: Number(page) || 1, limit: lim });
});

// GET /admin/accounts/groups — distinct account groups (hierarchy-scoped) so
// the Accounts filter can offer a real list instead of a free-text box.
const listAccountGroups = asyncHandler(async (req, res) => {
  const match = {};
  const scopeIds = await _accountScopeUserIds(req.user);
  if (scopeIds) match.userId = { $in: scopeIds };
  const groups = (await TradingAccount.distinct('group', match))
    .filter((g) => g && String(g).trim())
    .map((g) => String(g))
    .sort((a, b) => a.localeCompare(b));
  sendSuccess(res, groups);
});

// GET /admin/instruments/live-volume — live OPEN-position volume per symbol,
// split by side (buy=long, sell=short) AND by book (A-book vs B-book), plus the
// net (buy − sell). Powers the Live Buy/Sell · A · B · Net columns on the
// Instruments page. Kept separate from the shared /instruments list so that
// endpoint stays cheap.
const round4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;
const instrumentLiveVolume = asyncHandler(async (req, res) => {
  const agg = await Position.aggregate([
    { $match: { status: 'OPEN' } },
    { $group: { _id: { symbol: '$symbol', side: '$side', book: '$book' }, vol: { $sum: _num('$quantity') } } },
  ]);
  const blank = () => ({ buy: 0, sell: 0, aBuy: 0, aSell: 0, bBuy: 0, bSell: 0, net: 0 });
  const map = {};
  for (const r of agg) {
    const sym = r._id.symbol;
    const isBuy = r._id.side === 'BUY';
    const isA = String(r._id.book || 'B_BOOK').toUpperCase() === 'A_BOOK';
    if (!map[sym]) map[sym] = blank();
    const m = map[sym];
    const v = Number(r.vol) || 0;
    if (isBuy) { m.buy += v; if (isA) m.aBuy += v; else m.bBuy += v; }
    else { m.sell += v; if (isA) m.aSell += v; else m.bSell += v; }
  }
  for (const sym of Object.keys(map)) {
    const m = map[sym];
    m.buy = round4(m.buy); m.sell = round4(m.sell);
    m.aBuy = round4(m.aBuy); m.aSell = round4(m.aSell);
    m.bBuy = round4(m.bBuy); m.bSell = round4(m.bSell);
    m.net = round4(m.buy - m.sell);
  }
  sendSuccess(res, map);
});

// ─── Market Exposure Dashboard ────────────────────────────────────────
// SUPER_ADMIN → whole platform; ADMIN → own hierarchy only. MANAGER/USER
// are blocked upstream by requireAdmin. Only OPEN positions count;
// exposure value = lots × current market price, normalised to USD.

// Effective user-id set for an exposure query: the actor's hierarchy scope,
// optionally narrowed by adminId / managerId / userId filters. Returns
// null = whole platform (super admin, no narrowing).
async function _exposureUserIds(actor, query) {
  const ids = await _accountScopeUserIds(actor); // null (all) | ObjectId[]
  const extra = {};
  if (query.adminId)   extra.adminId = query.adminId;
  if (query.managerId) extra.managerId = query.managerId;
  if (query.userId)    extra._id = query.userId;
  if (Object.keys(extra).length === 0) return ids;
  const narrowed = await User.find(extra).distinct('_id');
  if (ids === null) return narrowed;
  const allow = new Set(narrowed.map(String));
  return ids.filter((id) => allow.has(String(id)));
}

// Core aggregation shared by all exposure endpoints.
async function _computeExposure(userIds, query = {}) {
  // B-BOOK ONLY — exposure is the broker's own risk. A-book positions are
  // forwarded to the LP (no broker risk), so they're excluded. `$ne A_BOOK`
  // also captures legacy positions written before the `book` field existed.
  const match = { status: 'OPEN', book: { $ne: 'A_BOOK' } };
  if (userIds) match.userId = { $in: userIds };
  if (query.symbol) match.symbol = String(query.symbol).toUpperCase();
  if (query.from || query.to) {
    match.openedAt = {};
    if (query.from) match.openedAt.$gte = new Date(query.from);
    if (query.to)   match.openedAt.$lte = new Date(new Date(query.to).setHours(23, 59, 59, 999));
  }

  const agg = await Position.aggregate([
    { $match: match },
    { $group: {
        _id: { symbol: '$symbol', side: '$side' },
        lots: { $sum: _num('$quantity') },
        positions: { $sum: 1 },
        users: { $addToSet: '$userId' },
    } },
  ]);

  const symbols = [...new Set(agg.map((a) => a._id.symbol))];
  const insts = symbols.length
    ? await Instrument.find({ symbol: { $in: symbols } }).select('symbol lastPrice quoteCurrency pricePrecision').lean()
    : [];
  const instMap = new Map(insts.map((i) => [i.symbol, i]));

  let usdInr = 83;
  try { usdInr = Number(await require('../services/currencyService').getUsdInrRate()) || 83; } catch (_) {}
  const toUsd = (val, cur) => (cur === 'INR' ? val / usdInr : val);

  const rows = {};
  const userSet = new Set();
  for (const a of agg) {
    const sym = a._id.symbol;
    const inst = instMap.get(sym) || {};
    const price = Number(inst.lastPrice) || 0;
    const amount = toUsd(a.lots * price, inst.quoteCurrency);
    const r = rows[sym] || (rows[sym] = { symbol: sym, lastPrice: price, buyLots: 0, buyAmount: 0, buyPositions: 0, sellLots: 0, sellAmount: 0, sellPositions: 0 });
    (a.users || []).forEach((u) => userSet.add(String(u)));
    if (a._id.side === 'BUY')       { r.buyLots = a.lots;  r.buyAmount = amount;  r.buyPositions = a.positions; }
    else if (a._id.side === 'SELL') { r.sellLots = a.lots; r.sellAmount = amount; r.sellPositions = a.positions; }
  }

  const instruments = Object.values(rows).map((r) => {
    const buyAmount = round2(r.buyAmount);
    const sellAmount = round2(r.sellAmount);
    const total = buyAmount + sellAmount;
    const net = round2(buyAmount - sellAmount);
    return {
      symbol: r.symbol,
      lastPrice: r.lastPrice,
      buyLots: round4(r.buyLots), buyAmount, buyPositions: r.buyPositions,
      sellLots: round4(r.sellLots), sellAmount, sellPositions: r.sellPositions,
      net,
      buyPct: total > 0 ? round2((buyAmount / total) * 100) : 0,
      sellPct: total > 0 ? round2((sellAmount / total) * 100) : 0,
      status: net > 0 ? 'NET BUY' : net < 0 ? 'NET SELL' : 'BALANCED',
    };
  }).sort((a, b) => (b.buyAmount + b.sellAmount) - (a.buyAmount + a.sellAmount));

  const totalBuyAmount = round2(instruments.reduce((s, r) => s + r.buyAmount, 0));
  const totalSellAmount = round2(instruments.reduce((s, r) => s + r.sellAmount, 0));
  const grand = totalBuyAmount + totalSellAmount;

  return {
    totalUsers: userSet.size,
    totalBuyAmount,
    totalSellAmount,
    difference: round2(totalBuyAmount - totalSellAmount),
    buyPercentage: grand > 0 ? round2((totalBuyAmount / grand) * 100) : 0,
    sellPercentage: grand > 0 ? round2((totalSellAmount / grand) * 100) : 0,
    instruments,
  };
}

const exposureSummary = asyncHandler(async (req, res) => {
  const ids = await _exposureUserIds(req.user, req.query);
  const d = await _computeExposure(ids, req.query);
  sendSuccess(res, {
    totalUsers: d.totalUsers,
    totalBuyAmount: d.totalBuyAmount,
    totalSellAmount: d.totalSellAmount,
    difference: d.difference,
    buyPercentage: d.buyPercentage,
    sellPercentage: d.sellPercentage,
  });
});

const exposureInstruments = asyncHandler(async (req, res) => {
  const ids = await _exposureUserIds(req.user, req.query);
  const d = await _computeExposure(ids, req.query);
  sendSuccess(res, d.instruments);
});

const exposureBuy = asyncHandler(async (req, res) => {
  const ids = await _exposureUserIds(req.user, req.query);
  const d = await _computeExposure(ids, req.query);
  sendSuccess(res, d.instruments
    .filter((r) => r.buyPositions > 0)
    .map((r) => ({ symbol: r.symbol, positions: r.buyPositions, lots: r.buyLots, amount: r.buyAmount }))
    .sort((a, b) => b.amount - a.amount));
});

const exposureSell = asyncHandler(async (req, res) => {
  const ids = await _exposureUserIds(req.user, req.query);
  const d = await _computeExposure(ids, req.query);
  sendSuccess(res, d.instruments
    .filter((r) => r.sellPositions > 0)
    .map((r) => ({ symbol: r.symbol, positions: r.sellPositions, lots: r.sellLots, amount: r.sellAmount }))
    .sort((a, b) => b.amount - a.amount));
});

const exposureNet = asyncHandler(async (req, res) => {
  const ids = await _exposureUserIds(req.user, req.query);
  const d = await _computeExposure(ids, req.query);
  sendSuccess(res, d.instruments.map((r) => ({
    symbol: r.symbol, buyAmount: r.buyAmount, sellAmount: r.sellAmount, difference: r.net, status: r.status,
  })));
});

// GET /admin/accounts/users/:userId/accounts — lazy child list (balance/equity/margin).
const getUserAccounts = asyncHandler(async (req, res) => {
  await _assertUserInScope(req.user, req.params.userId);
  const filter = { ..._accFilter(req.query), userId: req.params.userId };
  const accounts = await TradingAccount.find(filter).sort({ createdAt: -1 }).lean();
  const ids = accounts.map((a) => a._id);
  const [walletAgg, posAgg] = await Promise.all([
    ids.length ? Wallet.aggregate([{ $match: { accountId: { $in: ids } } }, { $group: { _id: '$accountId', bal: { $sum: _num('$balance') } } }]) : [],
    ids.length ? Position.aggregate([{ $match: { accountId: { $in: ids }, status: 'OPEN' } }, { $group: { _id: '$accountId', upnl: { $sum: _num('$unrealizedPnl') }, margin: { $sum: _num('$margin') } } }]) : [],
  ]);
  const balMap = new Map(walletAgg.map((w) => [String(w._id), w.bal]));
  const posMap = new Map(posAgg.map((p) => [String(p._id), p]));
  const out = accounts.map((a) => {
    const bal = round2(balMap.get(String(a._id)) || 0);
    const pos = posMap.get(String(a._id)) || { upnl: 0, margin: 0 };
    return {
      _id: a._id,
      accountNumber: a.accountNumber,
      accountType: a.accountType,
      group: a.group || 'default',
      status: a.status || 'ACTIVE',
      isTradingEnabled: a.isTradingEnabled !== false,
      baseCurrency: a.baseCurrency,
      leverage: a.leverage,
      balance: bal,
      equity: round2(bal + (pos.upnl || 0)),
      margin: round2(pos.margin || 0),
      createdAt: a.createdAt,
    };
  });
  sendSuccess(res, out);
});

// POST /admin/accounts/bulk — { accountIds?, userIds?, action, value }
// action: block | suspend | enable | leverage | group
const bulkAccountAction = asyncHandler(async (req, res) => {
  const { accountIds, userIds, action, value } = req.body;
  const ACTIONS = ['block', 'suspend', 'enable', 'leverage', 'group'];
  if (!ACTIONS.includes(action)) throw new AppError(`action must be one of ${ACTIONS.join(', ')}`, 400);

  let lev, grp;
  if (action === 'leverage') {
    lev = Math.round(Number(value));
    if (!Number.isFinite(lev) || lev < 1) throw new AppError('leverage value must be ≥ 1', 400);
  }
  if (action === 'group') {
    grp = String(value || '').trim();
    if (!grp) throw new AppError('group value required', 400);
  }

  const or = [];
  if (Array.isArray(accountIds) && accountIds.length) or.push({ _id: { $in: accountIds } });
  if (Array.isArray(userIds) && userIds.length) or.push({ userId: { $in: userIds } });
  if (!or.length) throw new AppError('accountIds[] or userIds[] required', 400);

  const targets = await TradingAccount.find({ $or: or });
  let updated = 0;
  for (const acc of targets) {
    try { await _assertAccountInScope(req.user, acc); } catch (_) { continue; } // skip out-of-scope
    if (action === 'block') acc.status = 'BLOCKED';
    else if (action === 'suspend') acc.status = 'SUSPENDED';
    else if (action === 'enable') acc.status = 'ACTIVE';
    else if (action === 'leverage') acc.leverage = lev;
    else if (action === 'group') acc.group = grp;
    await acc.save();
    updated++;
  }
  await logAction(req, 'ACCOUNT_BULK_ACTION', { type: 'ACCOUNT', id: 'bulk' }, { action, value: value ?? null, count: updated });
  sendSuccess(res, { updated });
});

// ── Portfolio (SUPER_ADMIN only) — platform-wide statistics ──────────
function _portfolioRange({ period, from, to, fromDate, toDate }) {
  const now = new Date();
  // All-time: everything since inception up to now (no date filtering).
  if (period === 'all') return { start: new Date(0), end: now, period: 'all' };
  // Global DateFilter sends concrete fromDate/toDate for every preset; prefer
  // them (fall back to the legacy `from`/`to`, then period keys).
  const f = fromDate || from;
  const t = toDate || to;
  if (f || t) {
    const start = f ? new Date(f) : new Date(now.getTime() - 7 * 86400000);
    const end = t ? new Date(new Date(t).setHours(23, 59, 59, 999)) : now; // inclusive end-of-day
    return { start, end, period: period || 'custom' };
  }
  let start;
  if (period === 'today') start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (period === '30d') start = new Date(now.getTime() - 30 * 86400000);
  else start = new Date(now.getTime() - 7 * 86400000); // 7d default
  return { start, end: now, period: period || '7d' };
}

async function _portfolioSeries(start, end) {
  const day = (date) => ({ $dateToString: { format: '%Y-%m-%d', date } });
  const [dep, wd, cp] = await Promise.all([
    Deposit.aggregate([{ $match: { status: 'CONFIRMED', createdAt: { $gte: start, $lte: end } } }, { $group: { _id: day('$createdAt'), t: { $sum: _num('$baseAmount') } } }]),
    Withdrawal.aggregate([{ $match: { status: 'COMPLETED', createdAt: { $gte: start, $lte: end } } }, { $group: { _id: day('$createdAt'), t: { $sum: _num('$baseAmount') } } }]),
    Position.aggregate([{ $match: { status: 'CLOSED', closedAt: { $gte: start, $lte: end } } }, { $group: { _id: day('$closedAt'), t: { $sum: _num('$realizedPnl') } } }]),
  ]);
  const map = {};
  const slot = (d) => (map[d] = map[d] || { date: d, deposits: 0, withdrawals: 0, closedPnl: 0 });
  dep.forEach((r) => { slot(r._id).deposits = round2(r.t); });
  wd.forEach((r) => { slot(r._id).withdrawals = round2(r.t); });
  cp.forEach((r) => { slot(r._id).closedPnl = round2(r.t); });
  return Object.values(map).sort((a, b) => (a.date < b.date ? -1 : 1));
}

const getPortfolio = asyncHandler(async (req, res) => {
  // Hard gate — 403 for anyone who isn't a Super Admin (defence-in-depth on
  // top of the route-level requireRole guard).
  if (req.user.role !== 'SUPER_ADMIN') {
    throw new AppError('Forbidden — Super Admin only', 403, 'FORBIDDEN');
  }

  const { start, end, period } = _portfolioRange(req.query);
  const range = { $gte: start, $lte: end };

  const { SubscriptionWallet } = require('../models/SubscriptionWallet');
  const { BonusWallet } = require('../models/BonusWallet');
  const { Commission } = require('../models/Compliance');
  const RoutingDecision = require('../models/RoutingDecision');
  const currencyService = require('../services/currencyService');
  let usdInr = 83;
  try { usdInr = Number(await currencyService.getUsdInrRate()) || 83; } catch (_) {}
  const toUsd = (bal, cur) => ({ $cond: [{ $eq: [cur, 'USD'] }, bal, { $divide: [bal, usdInr] }] });

  const [twBal, mwBal, bwBal, depAgg, wdAgg, openAgg, closedAgg, routeAgg, commPaidAgg, series] = await Promise.all([
    Wallet.aggregate([{ $group: { _id: null, t: { $sum: toUsd(_num('$balance'), '$currency') } } }]),
    SubscriptionWallet.aggregate([{ $group: { _id: null, t: { $sum: _num('$balance') } } }]),
    BonusWallet.aggregate([{ $group: { _id: null, t: { $sum: _num('$balance') } } }]),
    Deposit.aggregate([{ $match: { status: 'CONFIRMED', createdAt: range } }, { $group: { _id: null, t: { $sum: _num('$baseAmount') }, n: { $sum: 1 } } }]),
    Withdrawal.aggregate([{ $match: { status: 'COMPLETED', createdAt: range } }, { $group: { _id: null, t: { $sum: _num('$baseAmount') }, n: { $sum: 1 } } }]),
    Position.aggregate([{ $match: { status: 'OPEN' } }, { $group: { _id: null, t: { $sum: _num('$unrealizedPnl') } } }]),
    Position.aggregate([{ $match: { status: 'CLOSED', closedAt: range } }, { $group: { _id: null, pnl: { $sum: _num('$realizedPnl') }, comm: { $sum: _num('$commission') } } }]),
    RoutingDecision.aggregate([{ $match: { createdAt: range } }, { $group: { _id: '$routingResult', notional: { $sum: '$notional' } } }]),
    // Referral + partner commissions actually PAID out in the range (partner
    // revenue-share TRADE_FEE/SPREAD + referral DEPOSIT_BONUS + adjustments).
    Commission.aggregate([{ $match: { status: 'PAID', createdAt: range } }, { $group: { _id: '$sourceType', t: { $sum: _num('$amount') } } }]),
    _portfolioSeries(start, end),
  ]);

  const totalUserBalance = round2((twBal[0]?.t || 0) + (mwBal[0]?.t || 0) + (bwBal[0]?.t || 0));
  const totalDeposits = round2(depAgg[0]?.t || 0);
  const totalWithdrawals = round2(wdAgg[0]?.t || 0);
  const totalOpenPnl = round2(openAgg[0]?.t || 0);
  const totalClosedPnl = round2(closedAgg[0]?.pnl || 0);
  const commissionEarnings = round2(closedAgg[0]?.comm || 0);
  const rmap = {}; routeAgg.forEach((r) => { rmap[r._id] = round2(r.notional); });
  // Platform revenue proxy: fees collected + B-book counterparty result
  // (on B-book the broker is the counterparty, so it gains what users lose).
  const platformRevenue = round2(commissionEarnings - totalClosedPnl);
  // Referral + partner commissions paid out to affiliates in the range.
  const cmap = {}; commPaidAgg.forEach((c) => { cmap[c._id] = round2(c.t); });
  const partnerRevenueShare = round2((cmap.TRADE_FEE || 0) + (cmap.SPREAD || 0));
  const referralBonusPaid = round2(cmap.DEPOSIT_BONUS || 0);
  const partnerReferralPaid = round2(partnerRevenueShare + referralBonusPaid + (cmap.ADJUSTMENT || 0));
  const netRevenue = round2(platformRevenue - partnerReferralPaid);

  sendSuccess(res, {
    range: { from: start, to: end, period },
    kpis: {
      totalUserBalance,
      totalDeposits,
      totalWithdrawals,
      totalOpenPnl,
      totalClosedPnl,
      aBookExposure: rmap.A_BOOK || 0,
      bBookExposure: rmap.B_BOOK || 0,
      internalMatchingExposure: rmap.INTERNAL_MATCHING || 0,
      platformRevenue,
      commissionEarnings,
      partnerRevenueShare,
      referralBonusPaid,
      partnerReferralPaid,
      netRevenue,
      depositCount: depAgg[0]?.n || 0,
      withdrawalCount: wdAgg[0]?.n || 0,
    },
    series,
  });
});

// ─── Read-only "View As User" impersonation ───────────────────────────
// Admin/Super-Admin only (route-gated by requireAdmin). Mints a short-lived
// READ-ONLY token scoped to the target user, logs the session start, and
// returns the token for the admin to open the client app as that user.
const startImpersonation = asyncHandler(async (req, res) => {
  const { signAccessToken } = require('../utils/jwt');
  const crypto = require('crypto');

  const target = await User.findById(req.params.userId)
    .select('_id role firstName lastName email userUid isActive').lean();
  if (!target) throw new AppError('User not found', 404);
  if (!target.isActive) throw new AppError('Cannot view an inactive/blocked account', 400, 'USER_INACTIVE');
  // Only regular users can be viewed — never other staff accounts.
  if (['ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(target.role)) {
    throw new AppError('You can only "View As" a regular user account', 400, 'NOT_A_USER');
  }

  const sid = crypto.randomUUID();
  const token = signAccessToken({
    sub: String(target._id),
    role: 'USER',
    isImpersonation: true,
    readOnly: true,
    impersonatedBy: String(req.userId),
    sid,
  }, { expiresIn: '1h' });

  await logAction(req, 'IMPERSONATION_START', { type: 'USER', id: target._id }, {
    sid, adminRole: req.user.role, targetEmail: target.email, targetUserUid: target.userUid || null,
  });

  sendSuccess(res, {
    token,
    sid,
    expiresInSec: 3600,
    // Where to open the session — the CLIENT app URL (never the admin origin).
    clientUrl: process.env.CLIENT_URL || null,
    user: {
      _id: String(target._id),
      name: [target.firstName, target.lastName].filter(Boolean).join(' ') || target.email,
      email: target.email,
      userUid: target.userUid || null,
    },
  });
});

// ─── Executive dashboard analytics (global date filter) ───────────────
//
// Resolves a single { period | fromDate/toDate } range and returns every
// time-based dashboard section in ONE payload (users, deposits, withdrawals,
// trading, routing, B-book P&L, revenue). Exposure is intentionally LIVE
// (current open positions) and ignores the date filter — see `exposure`.
//
// Presets: today | 24h | 7d | 30d | this_month | previous_month | custom.
function _resolveDashRange({ period, fromDate, toDate }) {
  const now = new Date();
  const Y = now.getFullYear(), Mo = now.getMonth(), Da = now.getDate();
  let start, end = now, key = period || '7d';
  if (fromDate || toDate) {
    start = fromDate ? new Date(fromDate) : new Date(now.getTime() - 7 * 86400000);
    end = toDate ? new Date(new Date(toDate).setHours(23, 59, 59, 999)) : now;
    key = (period && period !== 'custom') ? period : 'custom';
  } else {
    switch (period) {
      case 'today':          start = new Date(Y, Mo, Da); break;
      case '24h':            start = new Date(now.getTime() - 24 * 3600 * 1000); break;
      case '30d':            start = new Date(now.getTime() - 30 * 86400000); break;
      case 'this_month':     start = new Date(Y, Mo, 1); break;
      case 'previous_month': start = new Date(Y, Mo - 1, 1); end = new Date(Y, Mo, 1, 0, 0, 0, -1); break;
      case '7d': default:    start = new Date(now.getTime() - 7 * 86400000); key = '7d'; break;
    }
  }
  return { start, end, period: key };
}

const getDashboardAnalytics = asyncHandler(async (req, res) => {
  const { start, end, period } = _resolveDashRange(req.query);
  const range = { $gte: start, $lte: end };
  const num = _num;

  const { Commission } = require('../models/Compliance');
  const RoutingDecision = require('../models/RoutingDecision');

  // Account book sets — used for B-book P&L and LIVE exposure attribution.
  const [bAcctIds, aAcctIds, hAcctIds] = await Promise.all([
    TradingAccount.find({ bookType: BOOK_TYPE.B_BOOK }).distinct('_id'),
    TradingAccount.find({ bookType: BOOK_TYPE.A_BOOK }).distinct('_id'),
    TradingAccount.find({ bookType: BOOK_TYPE.HYBRID }).distinct('_id'),
  ]);

  const mulQtyPrice = { $multiply: [num('$quantity'), num('$entryPrice')] };

  const [
    totalUsers, newUsers,
    loginIds, buyIds, sellIds, depIds, posIds,
    depAgg, depLifetime,
    wdAgg, wdLifetime,
    tradeAgg, openPositions, closedPositions,
    routeDecAgg, hybridRouted,
    bbookClosed, bbookOpen,
    closedPnlComm, commPaidAgg,
    expAgg,
  ] = await Promise.all([
    // ── Users
    User.countDocuments(),
    User.countDocuments({ createdAt: range }),
    User.distinct('_id', { lastLoginAt: range }),
    Trade.distinct('buyUserId', { executedAt: range }),
    Trade.distinct('sellUserId', { executedAt: range }),
    Deposit.distinct('userId', { createdAt: range }),
    Position.distinct('userId', { openedAt: range }),
    // ── Deposits (by status in range) + lifetime confirmed
    Deposit.aggregate([{ $match: { createdAt: range } }, { $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: num('$baseAmount') } } }]),
    Deposit.aggregate([{ $match: { status: 'CONFIRMED' } }, { $group: { _id: null, t: { $sum: num('$baseAmount') } } }]),
    // ── Withdrawals (by status in range) + lifetime completed
    Withdrawal.aggregate([{ $match: { createdAt: range } }, { $group: { _id: '$status', n: { $sum: 1 }, t: { $sum: num('$baseAmount') } } }]),
    Withdrawal.aggregate([{ $match: { status: 'COMPLETED' } }, { $group: { _id: null, t: { $sum: num('$baseAmount') } } }]),
    // ── Trading
    Trade.aggregate([{ $match: { executedAt: range } }, { $group: { _id: '$routing', n: { $sum: 1 }, vol: { $sum: { $multiply: [num('$price'), num('$quantity')] } } } }]),
    Position.countDocuments({ status: 'OPEN' }),
    Position.countDocuments({ status: 'CLOSED', closedAt: range }),
    // ── Routing decisions in range
    RoutingDecision.aggregate([{ $match: { createdAt: range } }, { $group: { _id: '$routingResult', count: { $sum: 1 }, notional: { $sum: '$notional' } } }]),
    RoutingDecision.countDocuments({ createdAt: range, executionMode: EXECUTION_MODE.HYBRID }),
    // ── B-book P&L (broker = counterparty → broker gains what traders lose)
    Position.aggregate([{ $match: { status: 'CLOSED', closedAt: range, accountId: { $in: bAcctIds } } }, { $group: { _id: null, pnl: { $sum: num('$realizedPnl') } } }]),
    Position.aggregate([{ $match: { status: 'OPEN', accountId: { $in: bAcctIds } } }, { $group: { _id: null, upnl: { $sum: num('$unrealizedPnl') } } }]),
    // ── Revenue inputs: closed P&L + commission(fees) in range; commissions paid out
    Position.aggregate([{ $match: { status: 'CLOSED', closedAt: range } }, { $group: { _id: null, pnl: { $sum: num('$realizedPnl') }, comm: { $sum: num('$commission') } } }]),
    Commission.aggregate([{ $match: { status: 'PAID', createdAt: range } }, { $group: { _id: '$sourceType', t: { $sum: num('$amount') } } }]),
    // ── LIVE exposure: open positions grouped by account (book mapped in JS)
    Position.aggregate([
      { $match: { status: 'OPEN' } },
      { $group: {
          _id: '$accountId',
          notional: { $sum: mulQtyPrice },
          signed: { $sum: { $multiply: [{ $cond: [{ $eq: ['$side', 'BUY'] }, 1, -1] }, mulQtyPrice] } },
      } },
    ]),
  ]);

  // ── Users: active = logged in / traded / deposited / opened a position in range
  const activeSet = new Set();
  [loginIds, buyIds, sellIds, depIds, posIds].forEach((arr) => arr.forEach((id) => activeSet.add(String(id))));

  // ── Deposits
  const depMap = {}; depAgg.forEach((d) => { depMap[d._id] = { n: d.n, t: round2(d.t) }; });
  const deposits = {
    totalLifetime: round2(depLifetime[0]?.t || 0),
    periodAmount:  round2(depMap.CONFIRMED?.t || 0),
    periodCount:   depMap.CONFIRMED?.n || 0,
    pending:       depMap.PENDING?.n || 0,
    successful:    depMap.CONFIRMED?.n || 0,
    failed:        (depMap.REJECTED?.n || 0) + (depMap.CANCELLED?.n || 0),
  };

  // ── Withdrawals
  const wdMap = {}; wdAgg.forEach((d) => { wdMap[d._id] = { n: d.n, t: round2(d.t) }; });
  const withdrawals = {
    totalLifetime: round2(wdLifetime[0]?.t || 0),
    periodAmount:  round2(wdMap.COMPLETED?.t || 0),
    periodCount:   wdMap.COMPLETED?.n || 0,
    pending:       (wdMap.PENDING?.n || 0) + (wdMap.PROCESSING?.n || 0),
    approved:      (wdMap.APPROVED?.n || 0) + (wdMap.COMPLETED?.n || 0),
    rejected:      (wdMap.REJECTED?.n || 0) + (wdMap.CANCELLED?.n || 0),
  };

  // ── Trading
  let totalTrades = 0, tradingVolume = 0; const volByRouting = {};
  tradeAgg.forEach((v) => { totalTrades += v.n; tradingVolume += v.vol; volByRouting[v._id] = round2(v.vol); });
  const trading = {
    totalTrades,
    tradingVolume: round2(tradingVolume),
    openPositions,
    closedPositions,
  };

  // ── Routing
  let totalDecisions = 0; routeDecAgg.forEach((d) => { totalDecisions += d.count; });
  const routing = {
    internalMatchingVolume: volByRouting[ROUTING.INTERNAL_MATCHING] || 0,
    bBookVolume:            volByRouting[ROUTING.B_BOOK] || 0,
    aBookVolume:            volByRouting[ROUTING.EXTERNAL] || 0,
    hybridRoutedOrders:     hybridRouted,
    totalRoutingDecisions:  totalDecisions,
  };

  // ── B-book P&L (broker perspective = −trader P&L)
  const bBookPnl = {
    realized:   round2(-(bbookClosed[0]?.pnl || 0)),
    unrealized: round2(-(bbookOpen[0]?.upnl || 0)),
  };
  bBookPnl.net = round2(bBookPnl.realized + bBookPnl.unrealized);

  // ── Revenue
  const closedPnl = round2(closedPnlComm[0]?.pnl || 0);
  const fees = round2(closedPnlComm[0]?.comm || 0);
  const commMap = {}; commPaidAgg.forEach((c) => { commMap[c._id] = round2(c.t); });
  const commissionPaid = round2((commMap.TRADE_FEE || 0) + (commMap.SPREAD || 0) + (commMap.DEPOSIT_BONUS || 0) + (commMap.ADJUSTMENT || 0));
  const partnerRevenueShare = round2((commMap.TRADE_FEE || 0) + (commMap.SPREAD || 0));
  const platformRevenue = round2(fees - closedPnl); // fees + B-book counterparty result
  const revenue = {
    platformRevenue,
    tradingFeesCollected: fees,
    commissionPaid,
    partnerRevenueShare,
    netRevenue: round2(platformRevenue - commissionPaid),
  };

  // ── LIVE exposure (NOT date-filtered) — current open positions by book.
  const bSet = new Set(bAcctIds.map(String)), aSet = new Set(aAcctIds.map(String)), hSet = new Set(hAcctIds.map(String));
  let net = 0, aExp = 0, bExp = 0, hExp = 0;
  expAgg.forEach((row) => {
    const id = String(row._id);
    net += row.signed;
    if (bSet.has(id)) bExp += row.notional;
    else if (aSet.has(id)) aExp += row.notional;
    else if (hSet.has(id)) hExp += row.notional;
  });
  const exposure = {
    netExposure:              round2(net),
    aBookExposure:            round2(aExp),
    bBookExposure:            round2(bExp),
    internalMatchingExposure: round2(hExp), // hybrid flow is matched internally when liquidity exists
    live: true,
  };

  // ── Live operational alerts (not date-filtered)
  const [kycPending, withdrawPending, depositPending] = await Promise.all([
    User.countDocuments({ kycStatus: KYC_STATUS.PENDING }),
    Withdrawal.countDocuments({ status: 'PENDING' }),
    Deposit.countDocuments({ status: 'PENDING' }),
  ]);

  sendSuccess(res, {
    range: { from: start, to: end, period },
    users: { totalUsers, newUsers, activeUsers: activeSet.size },
    deposits,
    withdrawals,
    trading,
    routing,
    bBookPnl,
    revenue,
    exposure,
    alerts: { kycPending, withdrawPending, depositPending },
  });
});

module.exports = {
  dashboard,
  getDashboardAnalytics,
  startImpersonation,
  listUsers,
  getUser,
  updateUserStatus,
  reviewKyc,
  adjustBalance,
  creditAffiliateBonus,
  setReferrer,
  referralDiagnostic,
  getLeverage,
  setLeverage,
  clearLeverage,
  bulkSetLeverage,
  getLeverageHistory,
  listWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  listDeposits,
  confirmDeposit,
  rejectDeposit,
  listAuditLog,
  tradesReport,
  updateAccountExecutionConfig,
  updateUserRiskControls,
  getSystemSettings,
  updateSystemSettings,
  listUserTransfers,
  listPartners,
  setPartnerLevel,
  setPartnerBlocked,
  partnerAnalytics,
  getExecutionStats,
  listRoutingDecisions,
  listAccounts,
  getAccountDetail,
  getAccountPositions,
  setAccountStatus,
  addAccountNote,
  listAccountUsers,
  listAccountGroups,
  instrumentLiveVolume,
  exposureSummary,
  exposureInstruments,
  exposureBuy,
  exposureSell,
  exposureNet,
  getUserAccounts,
  bulkAccountAction,
  getPortfolio,
};
