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
  const { routingMode, defaultLpProvider } = req.body;

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

  if (routingMode !== undefined) await systemSettings.setSetting('routingMode', routingMode, req.userId);
  if (defaultLpProvider !== undefined) await systemSettings.setSetting('defaultLpProvider', defaultLpProvider, req.userId);

  await logAction(req, 'SYSTEM_SETTINGS_UPDATE', { type: 'SYSTEM', id: null }, {
    routingMode, defaultLpProvider,
  });

  const fresh = await systemSettings.getAllSettings();
  sendSuccess(res, fresh);
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
  updateAccountExecutionConfig,
  updateUserRiskControls,
  getSystemSettings,
  updateSystemSettings,
};
