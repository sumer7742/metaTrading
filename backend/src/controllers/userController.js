const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { asyncHandler, sendSuccess, AppError } = require('../utils/errors');
const { ACCOUNT_TYPES, TRADING_MODE, KYC_STATUS } = require('../config/constants');

const updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'phone'];
  const updates = {};
  allowed.forEach((k) => k in req.body && (updates[k] = req.body[k]));
  const user = await User.findByIdAndUpdate(req.userId, updates, { new: true });
  sendSuccess(res, user.toSafeJSON());
});

const submitKYC = asyncHandler(async (req, res) => {
  const { documents } = req.body; // [{ type, url }]
  if (!Array.isArray(documents) || !documents.length) throw new AppError('Documents required', 400);
  const user = await User.findById(req.userId);
  user.kycDocuments = documents.map((d) => ({ ...d, uploadedAt: new Date() }));
  user.kycStatus = KYC_STATUS.PENDING;
  await user.save();
  sendSuccess(res, { status: user.kycStatus });
});

const getKycStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('kycStatus kycRejectionReason');
  sendSuccess(res, { status: user.kycStatus, rejectionReason: user.kycRejectionReason });
});

// Trading accounts
const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await TradingAccount.find({ userId: req.userId, isActive: true }).lean();
  sendSuccess(res, accounts);
});

const createAccount = asyncHandler(async (req, res) => {
  const { accountType, baseCurrency, leverage, mode, nickname, initialBalance } = req.body;
  if (!Object.values(ACCOUNT_TYPES).includes(accountType) && accountType !== 'CUSTOM') {
    throw new AppError('Invalid account type', 400);
  }

  // Validate initialBalance for demo/virtual seeds: must be a positive finite
  // number under a sane ceiling. Without this, a user could self-fund with
  // any amount, distort the trader profile, and inflate routing analytics.
  const DEMO_SEED_CAP = 1000000; // 10 lakh INR max for demo/virtual seed
  let seed = '0';
  const isVirtual = accountType === ACCOUNT_TYPES.DEMO || accountType === ACCOUNT_TYPES.VIRTUAL;
  if (isVirtual) {
    const requested = initialBalance == null ? 10000 : Number(initialBalance);
    if (!Number.isFinite(requested) || requested < 0) {
      throw new AppError('initialBalance must be a non-negative number', 400);
    }
    if (requested > DEMO_SEED_CAP) {
      throw new AppError(`initialBalance exceeds demo cap (${DEMO_SEED_CAP})`, 400);
    }
    seed = String(requested);
  } else if (initialBalance != null) {
    // REAL accounts can never be self-funded — must come through deposit.
    throw new AppError('initialBalance not allowed for non-demo accounts', 400);
  }

  // Plan-based limit (doc §7.16)
  const subscriptionService = require('../services/subscriptionService');
  const check = await subscriptionService.canCreateAccount(req.userId);
  if (!check.allowed) {
    throw new AppError(
      `Your ${check.planCode} plan allows max ${check.max} accounts (you have ${check.current}). Upgrade to add more.`,
      403,
      'PLAN_LIMIT_REACHED'
    );
  }

  // UUID-style account number: a high-entropy suffix avoids collisions on
  // rapid creation (Date.now().slice(-9) repeats once per ~16 mins).
  const { v4: uuidv4 } = require('uuid');
  const accountNumber = 'TA' + uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
  const account = await TradingAccount.create({
    userId: req.userId,
    accountNumber,
    accountType,
    baseCurrency: baseCurrency || 'INR',
    leverage: leverage || 100,
    mode: mode || TRADING_MODE.HYBRID,
    nickname,
  });
  await Wallet.create({
    userId: req.userId,
    accountId: account._id,
    currency: baseCurrency || 'INR',
    balance: seed,
  });
  sendSuccess(res, account, 201);
});

module.exports = { updateProfile, submitKYC, getKycStatus, listAccounts, createAccount };
