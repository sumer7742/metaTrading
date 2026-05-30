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
const { KYC_STATUS, WALLET_TX_TYPE, BOOK_TYPE, LP_PROVIDER } = require('../config/constants');
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

  const [totalUsers, activeUsers24h, kycPending, withdrawPending, trades24h, openPositions] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastLoginAt: { $gte: dayAgo } }),
    User.countDocuments({ kycStatus: KYC_STATUS.PENDING }),
    Withdrawal.countDocuments({ status: 'PENDING' }),
    Trade.countDocuments({ executedAt: { $gte: dayAgo } }),
    Position.countDocuments({ status: 'OPEN' }),
  ]);

  // Volume by routing
  const volumeAgg = await Trade.aggregate([
    { $match: { executedAt: { $gte: weekAgo } } },
    {
      $group: {
        _id: '$routing',
        count: { $sum: 1 },
      },
    },
  ]);

  // Net exposure per instrument
  const exposureAgg = await Position.aggregate([
    { $match: { status: 'OPEN' } },
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
const listUsers = asyncHandler(async (req, res) => {
  const { search, kyc, status, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (search) {
    filter.$or = [
      { email: new RegExp(search, 'i') },
      { firstName: new RegExp(search, 'i') },
      { lastName: new RegExp(search, 'i') },
      { phone: new RegExp(search, 'i') },
    ];
  }
  if (kyc) filter.kycStatus = kyc;
  if (status === 'active') filter.isActive = true;
  if (status === 'inactive') filter.isActive = false;

  const skip = (Number(page) - 1) * Number(limit);
  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-passwordHash -twoFactorSecret -refreshTokens')
      // Surface the referrer's basic identity so the user list can
      // show "Referred by John D." inline (admin needs to see referral
      // attribution at a glance, not just on the detail page).
      .populate('referredBy', 'firstName lastName email referralCode')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    User.countDocuments(filter),
  ]);
  sendSuccess(res, { users, total, page: Number(page), limit: Number(limit) });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .select('-passwordHash -twoFactorSecret -refreshTokens')
    .populate('referredBy', 'firstName lastName email referralCode');
  if (!user) throw new AppError('User not found', 404);
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
const listWithdrawals = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = status ? { status } : {};
  const items = await Withdrawal.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, items);
});

const approveWithdrawal = asyncHandler(async (req, res) => {
  const { payoutTxReference, payoutProof, payoutProofMimeType } = req.body || {};

  const wd = await Withdrawal.findById(req.params.id);
  if (!wd) throw new AppError('Withdrawal not found', 404);
  if (wd.status !== 'PENDING') throw new AppError('Withdrawal already processed', 400);

  // For approval (marking as paid), require payout proof
  if (!payoutTxReference || !payoutProof) {
    throw new AppError('Payout transaction reference and proof screenshot are required', 400);
  }
  // Validate screenshot format
  if (typeof payoutProof !== 'string' || (!payoutProof.startsWith('data:image/') && !payoutProof.startsWith('https://'))) {
    throw new AppError('Invalid payout proof format', 400);
  }
  if (payoutProof.length > 700 * 1024) {
    throw new AppError('Payout proof too large (max 500KB)', 413);
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
  // Unlock the funds on the canonical base wallet.
  await walletService.unlock({
    userId: wd.userId,
    accountId: wd.accountId,
    currency: wd.baseCurrency || 'USD',
    amount: wd.baseAmount && Number(wd.baseAmount) > 0 ? wd.baseAmount : wd.amount,
  });
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
  const { status } = req.query;
  const filter = status ? { status } : {};
  const items = await Deposit.find(filter).sort({ createdAt: -1 }).limit(200).lean();
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
  if (dep.targetWallet === 'subscription') {
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
    } else if (Object.values(BOOK_TYPE).includes(routingMode)) {
      user.riskOverride.routingMode = routingMode;
    } else {
      throw new AppError(`routingMode must be one of A_BOOK, B_BOOK, HYBRID, or INHERIT`, 400);
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
  } = req.body;

  // Validate intent before any writes — keeps the system in a consistent
  // state if either field is malformed.
  if (routingMode !== undefined) {
    if (!Object.values(BOOK_TYPE).includes(routingMode)) {
      throw new AppError(
        `routingMode must be one of ${Object.values(BOOK_TYPE).join(', ')}`,
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
  }

  if (routingMode !== undefined) await systemSettings.setSetting('routingMode', routingMode, req.userId);
  if (defaultLpProvider !== undefined) await systemSettings.setSetting('defaultLpProvider', defaultLpProvider, req.userId);
  if (partner && typeof partner === 'object') {
    if (partner.enabled     !== undefined) await systemSettings.setSetting('partner.enabled',     !!partner.enabled, req.userId);
    if (partner.bonusAmount !== undefined) await systemSettings.setSetting('partner.bonusAmount', String(partner.bonusAmount), req.userId);
    if (partner.minDeposit  !== undefined) await systemSettings.setSetting('partner.minDeposit',  String(partner.minDeposit),  req.userId);
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
  }
  if (userTransfer && typeof userTransfer === 'object') {
    if (userTransfer.enabled    !== undefined) await systemSettings.setSetting('userTransfer.enabled',    !!userTransfer.enabled, req.userId);
    if (userTransfer.min        !== undefined) await systemSettings.setSetting('userTransfer.min',        String(userTransfer.min), req.userId);
    if (userTransfer.max        !== undefined) await systemSettings.setSetting('userTransfer.max',        String(userTransfer.max), req.userId);
    if (userTransfer.feePercent !== undefined) await systemSettings.setSetting('userTransfer.feePercent', String(userTransfer.feePercent), req.userId);
  }

  await logAction(req, 'SYSTEM_SETTINGS_UPDATE', { type: 'SYSTEM', id: null }, {
    routingMode, defaultLpProvider, userTransfer,
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
  const { limit = 100, before, fromUserId, toUserId, currency, minAmount, maxAmount, status } = req.query;

  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  const filter = { type: 'INTERNAL_TRANSFER_OUT' };
  if (currency) filter.currency = currency;
  if (fromUserId) filter.userId = fromUserId;
  if (before) filter.createdAt = { $lt: new Date(before) };

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
  const filtered = rows.filter((r) => {
    if (toUserId && r.to?.userId !== String(toUserId)) return false;
    if (status && r.status !== String(status).toUpperCase()) return false;
    if (minAmount != null && Number(r.amount) < Number(minAmount)) return false;
    if (maxAmount != null && Number(r.amount) > Number(maxAmount)) return false;
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
    const lvl = await partnerService.getPartnerLevel(u._id);
    if (req.query.level && lvl.tier.name !== String(req.query.level).toUpperCase()) continue;
    const totalReferrals = await User.countDocuments({ referredBy: u._id });
    const comm = commByUser.get(String(u._id)) || { lifetime: 0, paid: 0, pending: 0 };
    out.push({
      _id:          String(u._id),
      name:         [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      email:        u.email,
      referralCode: u.referralCode,
      level:        lvl.tier.name,
      percent:      lvl.tier.percent,
      locked:       lvl.locked,
      blocked:      !!u.partnerBlocked,
      activeReferrals: lvl.activeCount,
      totalReferrals,
      lifetimeEarnings: Number(comm.lifetime).toFixed(2),
      paidEarnings:     Number(comm.paid).toFixed(2),
      pendingEarnings:  Number(comm.pending).toFixed(2),
      createdAt:    u.createdAt,
    });
  }
  // Sort: most active referrals first.
  out.sort((a, b) => b.activeReferrals - a.activeReferrals);
  sendSuccess(res, out);
});

/**
 * PUT /admin/partners/:id/level
 * Body: { level: 'BRONZE'|'SILVER'|'GOLD'|'DIAMOND'|null, locked: boolean }
 * Pins a tier override or clears it.
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
  const totalPartners = (await User.distinct('referredBy', { referredBy: { $ne: null } })).length;
  const totalReferrals = await User.countDocuments({ referredBy: { $ne: null } });

  const totals = await Commission.aggregate([
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

module.exports = {
  dashboard,
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
};
