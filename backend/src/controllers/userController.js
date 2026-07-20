const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { asyncHandler, sendSuccess, AppError } = require('../utils/errors');
const { ACCOUNT_TYPES, TRADING_MODE, KYC_STATUS } = require('../config/constants');

const updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'phone', 'country'];
  const updates = {};
  allowed.forEach((k) => k in req.body && (updates[k] = req.body[k]));
  // Normalise the country to an uppercase ISO-2 code (or clear it).
  if ('country' in updates) updates.country = String(updates.country || '').trim().toUpperCase().slice(0, 2) || null;
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

  // Resolve the requested tier against the live AccountPlan catalogue.
  // Legacy DEMO/VIRTUAL types skip the catalogue check (kept for the
  // "Demo Account" mode in the new-account wizard which provisions a
  // practice account with a seed balance, no real money rules).
  const accountPlansService = require('../services/accountPlansService');
  const isLegacyVirtual = accountType === 'DEMO' || accountType === 'VIRTUAL';
  let plan = null;
  if (!isLegacyVirtual) {
    plan = await accountPlansService.getByCode(accountType);
    if (!plan) {
      throw new AppError(`Unknown account plan "${accountType}"`, 400, 'UNKNOWN_PLAN');
    }
    if (!plan.isActive) {
      throw new AppError(`Plan "${plan.name}" is currently disabled`, 400, 'PLAN_DISABLED');
    }
  }

  // Self-funding only allowed on legacy DEMO/VIRTUAL. Live tiers must
  // come through deposit — keeps the trader profile honest.
  const DEMO_SEED_CAP = 1000000;
  let seed = '0';
  if (isLegacyVirtual) {
    const requested = initialBalance == null ? 10000 : Number(initialBalance);
    if (!Number.isFinite(requested) || requested < 0) {
      throw new AppError('initialBalance must be a non-negative number', 400);
    }
    if (requested > DEMO_SEED_CAP) {
      throw new AppError(`initialBalance exceeds demo cap (${DEMO_SEED_CAP})`, 400);
    }
    seed = String(requested);
  } else if (initialBalance != null) {
    throw new AppError('initialBalance not allowed for live accounts — use a deposit instead', 400);
  }

  // Subscription-plan account-count limit (doc §7.16).
  const subscriptionService = require('../services/subscriptionService');
  const check = await subscriptionService.canCreateAccount(req.userId);
  if (!check.allowed) {
    throw new AppError(
      `Your ${check.planCode} plan allows max ${check.max} accounts (you have ${check.current}). Upgrade to add more.`,
      403,
      'PLAN_LIMIT_REACHED'
    );
  }

  // Leverage selection:
  //   - DEMO / VIRTUAL: permanently 1:Unlimited (999999) — no caps on
  //     practice money, regardless of what the FE sent.
  //   - Real tier with a cap: clamp client input down to the cap.
  //   - Real tier without a cap: honour client input.
  const UNLIMITED = 999999;
  let acctLeverage;
  if (isLegacyVirtual) {
    acctLeverage = UNLIMITED;
  } else {
    acctLeverage = Number(leverage) || 100;
    if (plan && plan.maxLeverage != null && acctLeverage > plan.maxLeverage) {
      acctLeverage = plan.maxLeverage;
    }
  }

  const { v4: uuidv4 } = require('uuid');
  const accountNumber = 'TA' + uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
  const account = await TradingAccount.create({
    userId: req.userId,
    accountNumber,
    accountType,
    baseCurrency: baseCurrency || 'INR',
    leverage: acctLeverage,
    mode: mode || TRADING_MODE.HYBRID,
    nickname: nickname || plan?.name || accountType,
  });
  await Wallet.create({
    userId: req.userId,
    accountId: account._id,
    currency: baseCurrency || 'INR',
    balance: seed,
  });

  // Min-deposit hint — surfaced in the response so the FE can prompt
  // the user to fund the account. Not a hard gate (account exists at
  // $0; the user just can't trade until they fund the minimum).
  const minDepositHint = plan && plan.minDeposit > 0
    ? { minDeposit: plan.minDeposit, currency: 'USD', needsFunding: true }
    : null;

  sendSuccess(res, { ...account.toObject(), minDepositHint }, 201);
});

// ───────── Feedback ─────────
const Feedback = require('../models/Feedback');

const VALID_CATEGORIES = ['BUG', 'FEATURE', 'UX', 'SUPPORT', 'OTHER'];

const submitFeedback = asyncHandler(async (req, res) => {
  const { category, subject, message, rating, context } = req.body;
  if (!subject || typeof subject !== 'string' || subject.trim().length < 3) {
    throw new AppError('Subject is required (min 3 chars)', 400);
  }
  if (!message || typeof message !== 'string' || message.trim().length < 10) {
    throw new AppError('Message is required (min 10 chars)', 400);
  }
  const cat = (category || 'OTHER').toUpperCase();
  if (!VALID_CATEGORIES.includes(cat)) {
    throw new AppError(`Invalid category. Allowed: ${VALID_CATEGORIES.join(', ')}`, 400);
  }
  let parsedRating = null;
  if (rating != null && rating !== '') {
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError('Rating must be 1-5', 400);
    parsedRating = n;
  }

  // Optional attachment — a base64 data: URI (image or PDF), capped so the
  // ticket doc stays lean.
  let attachment = null;
  let attachmentName = null;
  if (req.body.attachment) {
    const raw = String(req.body.attachment);
    const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(raw);
    if (!m) throw new AppError('Invalid attachment — expected a base64 data URI', 400);
    const mime = m[1].toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif)$|^application\/pdf$/.test(mime)) {
      throw new AppError('Attachment must be an image (PNG/JPG/WEBP/GIF) or a PDF', 400);
    }
    if (Math.floor(m[2].length * 0.75) > 3 * 1024 * 1024) {
      throw new AppError('Attachment too large — max 3 MB', 400);
    }
    attachment = raw;
    attachmentName = String(req.body.attachmentName || 'attachment').trim().slice(0, 120);
  }

  const fb = await Feedback.create({
    userId: req.userId,
    category: cat,
    subject: subject.trim().slice(0, 200),
    message: message.trim().slice(0, 4000),
    rating: parsedRating,
    attachment,
    attachmentName,
    context: {
      page: context?.page ? String(context.page).slice(0, 500) : undefined,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      appVersion: context?.appVersion ? String(context.appVersion).slice(0, 50) : undefined,
    },
  });

  // Realtime nudge to the admin Support Tickets inbox — best-effort, never
  // blocks. Admins/super-admins subscribed to 'admin:tickets' refetch on this.
  try {
    require('../websocket/server').publish('admin:tickets', {
      event: 'new', ticketId: String(fb._id), category: fb.category, subject: fb.subject,
    });
  } catch (_) { /* ws optional */ }

  // Best-effort email to ops — never blocks the response.
  try {
    const emailSvc = require('../services/emailService');
    if (typeof emailSvc.sendOpsAlert === 'function') {
      emailSvc.sendOpsAlert({
        subject: `[Feedback] ${cat} — ${fb.subject}`,
        body: `From userId=${req.userId}\nRating: ${parsedRating ?? 'n/a'}\n\n${fb.message}`,
      }).catch(() => {});
    }
  } catch (_) { /* email service optional */ }

  sendSuccess(res, { id: fb._id, status: fb.status }, 201);
});

const listMyFeedback = asyncHandler(async (req, res) => {
  // `-adminNote`: the admin's INTERNAL triage note must never reach the user.
  // The user-facing `adminReply` / `status` / `repliedAt` are kept.
  const items = await Feedback.find({ userId: req.userId })
    .select('-adminNote')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  sendSuccess(res, items);
});

module.exports = { updateProfile, submitKYC, getKycStatus, listAccounts, createAccount, submitFeedback, listMyFeedback };
