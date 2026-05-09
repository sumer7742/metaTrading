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
const { KYC_STATUS, WALLET_TX_TYPE } = require('../config/constants');
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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    User.countDocuments(filter),
  ]);
  sendSuccess(res, { users, total, page: Number(page), limit: Number(limit) });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('-passwordHash -twoFactorSecret -refreshTokens');
  if (!user) throw new AppError('User not found', 404);
  const accounts = await TradingAccount.find({ userId: user._id }).lean();
  const wallets = await Wallet.find({ userId: user._id }).lean();
  sendSuccess(res, { user, accounts, wallets });
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

  // Debit balance + unlock
  await walletService.unlock({
    userId: wd.userId,
    accountId: wd.accountId,
    currency: wd.currency,
    amount: wd.amount,
  });
  await walletService.debit({
    userId: wd.userId,
    accountId: wd.accountId,
    currency: wd.currency,
    amount: wd.amount,
    type: WALLET_TX_TYPE.WITHDRAWAL,
    referenceType: 'withdrawal',
    referenceId: wd._id,
    note: `Withdrawal paid out: ${payoutTxReference}`,
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
  // Unlock the funds
  await walletService.unlock({
    userId: wd.userId,
    accountId: wd.accountId,
    currency: wd.currency,
    amount: wd.amount,
  });
  await logAction(req, 'WITHDRAWAL_REJECTED', { type: 'WITHDRAWAL', id: wd._id }, { reason });
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
  await walletService.credit({
    userId: dep.userId,
    accountId: dep.accountId,
    currency: dep.currency,
    amount: dep.amount,
    type: WALLET_TX_TYPE.DEPOSIT,
    referenceType: 'deposit',
    referenceId: dep._id,
    note: 'Deposit confirmed',
  });
  await logAction(req, 'DEPOSIT_CONFIRMED', { type: 'DEPOSIT', id: dep._id });
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

module.exports = {
  dashboard,
  listUsers,
  getUser,
  updateUserStatus,
  reviewKyc,
  adjustBalance,
  listWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  listDeposits,
  confirmDeposit,
  rejectDeposit,
  listAuditLog,
  tradesReport,
};
