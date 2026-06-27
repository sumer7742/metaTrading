const { Wallet, WalletLedger } = require('../models/Wallet');
const { Deposit, Withdrawal } = require('../models/index');
const TradingAccount = require('../models/TradingAccount');
const walletService = require('../services/walletService');
const currencyService = require('../services/currencyService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { gt, sub } = require('../utils/decimal');

// Single source of truth: every account holds ONE real wallet,
// denominated in this base currency. Other currencies (INR / EUR /
// GBP / USDT) are display-only conversions.
const BASE_CURRENCY = 'USD';

const getBalances = asyncHandler(async (req, res) => {
  const { accountId } = req.query;
  const balances = await walletService.getBalances(req.userId, accountId);
  // include 'free' = balance - locked
  const enriched = balances.map((w) => ({
    ...w,
    free: gt(w.balance, w.locked || '0') ? sub(w.balance, w.locked || '0') : '0',
  }));
  sendSuccess(res, enriched);
});

// Where to SEND money for a manual deposit (admin-configured per method).
// Shown to the client in the "Add funds" modal. Read-only.
const depositDetails = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  sendSuccess(res, await systemSettings.getSetting('deposit.paymentDetails'));
});

const getLedger = asyncHandler(async (req, res) => {
  const { limit = 100, accountId } = req.query;
  const filter = { userId: req.userId };
  if (accountId) filter.accountId = accountId;
  const entries = await WalletLedger.find(filter).sort({ createdAt: -1 }).limit(Number(limit)).lean();

  // Enrich peer-to-peer transfer rows with the counterparty's display
  // name so the wallet history can render "Transfer to/from <name>"
  // without an extra round-trip from the FE. We look at all
  // INTERNAL_TRANSFER_* rows for this user, find the matching pair-row
  // (same referenceId, other user) and inline its userId / name.
  const transferIds = entries
    .filter((e) => (e.type === 'INTERNAL_TRANSFER_OUT' || e.type === 'INTERNAL_TRANSFER_IN') && e.referenceId)
    .map((e) => e.referenceId);
  if (transferIds.length) {
    const pairs = await WalletLedger.find({
      referenceId: { $in: transferIds },
      userId: { $ne: req.userId },
      type: { $in: ['INTERNAL_TRANSFER_OUT', 'INTERNAL_TRANSFER_IN'] },
    }).select('userId referenceId').lean();
    const otherIdByRef = new Map(pairs.map((p) => [String(p.referenceId), String(p.userId)]));
    const userIds = [...new Set(pairs.map((p) => String(p.userId)))];
    const User = require('../models/User');
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firstName lastName email referralCode avatarUrl').lean()
      : [];
    const userById = new Map(users.map((u) => [String(u._id), u]));
    for (const e of entries) {
      if (e.type !== 'INTERNAL_TRANSFER_OUT' && e.type !== 'INTERNAL_TRANSFER_IN') continue;
      const otherId = otherIdByRef.get(String(e.referenceId));
      if (!otherId) continue;
      const u = userById.get(otherId);
      if (!u) continue;
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
      e.counterparty = {
        userId:       String(u._id),
        name,
        referralCode: u.referralCode || null,
        avatarUrl:    u.avatarUrl || null,
      };
    }
  }

  sendSuccess(res, entries);
});

const createDeposit = asyncHandler(async (req, res) => {
  const {
    accountId,
    currency,
    amount,
    method,
    txReference,
    note,
    screenshot,           // base64 data URL of payment proof
    screenshotMimeType,   // 'image/png' | 'image/jpeg'
    senderName,
    senderUpiId,
    senderBankAccount,
  } = req.body;

  // Reject non-positive / non-numeric amounts up front. Without this guard
  // a Number("abc") cast or a negative amount would slip past the AppError
  // chain and either zero-credit the wallet or, worse, decrement it.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // Practice-money accounts (DEMO / VIRTUAL) skip every real-money gate: no
  // KYC, no payment screenshot, no admin review — they auto-credit instantly.
  // EVERY other type is a live plan tier (STANDARD / PRO / FREE / +IC variants,
  // legacy REAL, CUSTOM) and is treated as real money. Previously these gates
  // only matched the legacy 'REAL' type, so plan-coded live accounts slipped
  // past KYC + screenshot entirely.
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  const isRealMoney = !isDemoLike;

  // KYC gate — real-money deposits are blocked until KYC APPROVED.
  // Demo / virtual accounts are exempt (no real funds at risk).
  // Disable with KYC_REQUIRED=false in env for staging / sandbox.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && isRealMoney) {
    if (req.user?.kycStatus !== 'APPROVED') {
      throw new AppError(
        'KYC verification must be approved before depositing on a real-money account.',
        403,
        'KYC_REQUIRED'
      );
    }
  }

  // For real-money accounts, screenshot is MANDATORY (proof of payment)
  if (isRealMoney) {
    if (!screenshot) {
      throw new AppError('Payment screenshot is required for real account deposits', 400);
    }
    // Basic validation: must be data URL or HTTPS URL
    const isDataUrl = typeof screenshot === 'string' && screenshot.startsWith('data:image/');
    const isHttpsUrl = typeof screenshot === 'string' && screenshot.startsWith('https://');
    if (!isDataUrl && !isHttpsUrl) {
      throw new AppError('Invalid screenshot format. Upload an image file.', 400);
    }
    // Size guard: base64 strings can be huge — cap at ~700KB encoded (~500KB raw image)
    if (isDataUrl && screenshot.length > 700 * 1024) {
      throw new AppError('Screenshot too large. Please compress to under 500KB.', 413);
    }
    if (!txReference || String(txReference).trim().length < 4) {
      throw new AppError('Transaction reference (UPI ref / bank ref) is required', 400);
    }
  }

  // For practice accounts (DEMO / VIRTUAL), allow direct credit without
  // screenshot (instant top-up) — no admin review, no real funds at risk.
  if (isDemoLike) {
    // Cap per-request and per-day so a user can't self-fund unlimited demo
    // balances, which would skew the trader-profile / routing analytics
    // and waste DB rows.
    const DEMO_PER_REQUEST_CAP = 1000000; // 10 lakh INR per request
    const DEMO_PER_DAY_CAP = 10000000;    // 1 crore INR per 24h
    if (amtNum > DEMO_PER_REQUEST_CAP) {
      throw new AppError(`Demo top-ups are capped at ${DEMO_PER_REQUEST_CAP} per request`, 400);
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTotal = await Deposit.aggregate([
      { $match: { userId: account.userId, accountId: account._id, method: 'DEMO', createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } },
    ]);
    const usedToday = recentTotal[0]?.total || 0;
    if (usedToday + amtNum > DEMO_PER_DAY_CAP) {
      throw new AppError(
        `Demo top-up would exceed daily cap (${DEMO_PER_DAY_CAP}). Used today: ${usedToday}.`,
        400
      );
    }

    // Auto-confirm demo deposits — no admin review needed. Store the
    // original currency/amount the user typed AND the USD-equivalent
    // base figures, then credit the base wallet only.
    const convDemo = await currencyService.toBase(currency || 'INR', amtNum);
    const dep = await Deposit.create({
      userId: req.userId,
      accountId,
      currency: currency || 'INR',
      amount: String(amtNum), // user-facing original
      baseCurrency: convDemo.baseCurrency,
      baseAmount: String(convDemo.baseAmount),
      fxRateUsed: convDemo.rate,
      method: method || 'DEMO',
      txReference: 'DEMO-' + Date.now(),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      note: 'Demo balance top-up (auto-approved)',
    });
    const { credit } = require('../services/walletService');
    await credit({
      userId: req.userId,
      accountId,
      currency: BASE_CURRENCY,
      amount: String(convDemo.baseAmount),
      type: 'DEPOSIT',
      referenceType: 'Deposit',
      referenceId: dep._id,
      note: `Demo top-up · ${convDemo.originalAmount} ${convDemo.originalCurrency} @ ${convDemo.rate}`,
    });
    return sendSuccess(res, dep, 201);
  }

  // REAL deposits — pending admin review. Pre-compute the USD base
  // figure so the eventual admin confirm credits the base wallet.
  const convReal = await currencyService.toBase(currency || 'INR', amtNum);

  // ─── Minimum-deposit gate (per AccountPlan tier) ────────────────────
  // Each live tier defines a minimum deposit amount (USD base), enforced on
  // EVERY deposit — not just the first. Demo/virtual practice accounts are
  // exempt (handled above; they return before this point).
  {
    const accountFeeService = require('../services/accountFeeService');
    const minDep = await accountFeeService.getMinDeposit(account); // USD
    if (minDep > 0) {
      const baseAmt = Number(convReal.baseAmount);
      if (baseAmt < minDep) {
        throw new AppError(
          `Minimum deposit for the ${account.nickname || account.accountType} plan is ${minDep} USD — you entered ≈ ${baseAmt.toFixed(2)} USD.`,
          400,
          'BELOW_MIN_DEPOSIT'
        );
      }
    }
  }

  const dep = await Deposit.create({
    userId: req.userId,
    accountId,
    currency: currency || 'INR',
    amount: String(amount),
    baseCurrency: convReal.baseCurrency,
    baseAmount: String(convReal.baseAmount),
    fxRateUsed: convReal.rate,
    method: method || 'UPI',
    txReference,
    note,
    screenshot,
    screenshotMimeType,
    senderName,
    senderUpiId,
    senderBankAccount,
    status: 'PENDING',
  });
  // Echo to the user's open sessions so the notification bell + wallet
  // history table show the new pending deposit row instantly.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(req.userId), 'wallet', {
      action: 'pending',
      reason: 'DEPOSIT_CREATED',
      depositId: String(dep._id),
      amount: dep.amount,
      currency: dep.currency,
    });
  } catch (_) {}
  sendSuccess(res, dep, 201);
});

const listDeposits = asyncHandler(async (req, res) => {
  const deposits = await Deposit.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, deposits);
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  const {
    accountId,
    currency,
    amount,
    method,
    // UPI fields
    upiId,
    // Bank fields
    bankAccountNumber,
    bankIFSC,
    bankAccountHolderName,
    bankName,
    // Crypto fields
    cryptoAddress,
    cryptoNetwork,
    // Legacy fallbacks
    destination,
    whitelistId,
  } = req.body;

  // Reject non-positive / non-numeric amounts before any side effects.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // ── Demo / virtual accounts: instant self-service withdrawal ─────────
  // Practice money — no real payout, so no admin review, KYC, whitelist or
  // AML. Just validate the balance, debit immediately, and record a
  // COMPLETED row so the user's history stays consistent.
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  if (isDemoLike) {
    const displayCur = currency || 'INR';
    const conv = await currencyService.toBase(displayCur, amtNum);
    const baseAmountStr = String(conv.baseAmount);

    const wallet = await Wallet.findOne({ userId: req.userId, accountId, currency: BASE_CURRENCY });
    if (!wallet) throw new AppError('No funds on this account.', 400, 'INSUFFICIENT_FUNDS');
    const freeBase = gt(wallet.balance, wallet.locked || '0') ? sub(wallet.balance, wallet.locked || '0') : '0';
    if (gt(baseAmountStr, freeBase)) {
      const freeDisplay = await currencyService.fromBase(displayCur, Number(freeBase));
      throw new AppError(
        `Insufficient balance. Available: ${freeDisplay.toFixed(2)} ${displayCur} (requested ${amtNum} ${displayCur}).`,
        400,
        'INSUFFICIENT_FUNDS'
      );
    }

    const { WALLET_TX_TYPE } = require('../config/constants');
    // Debit first (the money-moving op). If the history record then fails to
    // write, refund so demo balance can't silently vanish.
    await walletService.debit({
      userId: req.userId,
      accountId,
      currency: BASE_CURRENCY,
      amount: baseAmountStr,
      type: WALLET_TX_TYPE.WITHDRAWAL,
      referenceType: 'withdrawal',
      note: `Demo withdrawal (auto-approved) · ${amtNum} ${displayCur}`,
    });

    let wd;
    try {
      wd = await Withdrawal.create({
        userId: req.userId,
        accountId,
        currency: displayCur,
        amount: String(amtNum),
        baseCurrency: BASE_CURRENCY,
        baseAmount: baseAmountStr,
        fxRateUsed: conv.rate,
        method: (method || 'DEMO').toUpperCase(),
        destination: 'Demo balance withdrawal (auto-approved)',
        status: 'COMPLETED',
        approvedAt: new Date(),
        payoutAt: new Date(),
      });
    } catch (createErr) {
      try {
        await walletService.credit({
          userId: req.userId,
          accountId,
          currency: BASE_CURRENCY,
          amount: baseAmountStr,
          type: WALLET_TX_TYPE.ADJUSTMENT,
          referenceType: 'withdrawal',
          note: 'Refund — demo withdrawal record failed',
        });
      } catch (e) {
        console.error('[wallet] failed to refund after demo withdrawal create error:', e.message);
      }
      throw createErr;
    }

    try {
      const broadcaster = require('../websocket/server');
      broadcaster.notifyUser(String(req.userId), 'wallet', {
        action: 'debited',
        reason: 'WITHDRAWAL_COMPLETED',
        withdrawalId: String(wd._id),
        amount: wd.amount,
        currency: wd.currency,
      });
    } catch (_) {}

    return sendSuccess(res, wd, 201);
  }

  // KYC gate — every real withdrawal needs KYC APPROVED (AML requirement).
  // Disable for sandbox via KYC_REQUIRED=false.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && req.user?.kycStatus !== 'APPROVED') {
    throw new AppError(
      'KYC verification must be approved before withdrawing funds.',
      403,
      'KYC_REQUIRED'
    );
  }

  // Method ↔ currency compatibility. UPI / BANK rails settle in INR only
  // (NEFT/IMPS/UPI are domestic), so requesting USD via UPI is nonsensical
  // and would just create stuck withdrawals admin can't process.
  const cur = (currency || 'INR').toUpperCase();
  const incomingMethod = (method || '').toUpperCase();
  if ((incomingMethod === 'UPI' || incomingMethod === 'BANK') && cur !== 'INR') {
    throw new AppError(`${incomingMethod} withdrawals are only available for INR. Use CRYPTO for ${cur}.`, 400);
  }

  // Validate per method
  const m = incomingMethod;
  if (m === 'UPI') {
    if (!upiId || !upiId.includes('@')) {
      throw new AppError('Valid UPI ID required (e.g. yourname@bank)', 400);
    }
  } else if (m === 'BANK') {
    if (!bankAccountNumber || String(bankAccountNumber).length < 5) {
      throw new AppError('Valid bank account number required', 400);
    }
    if (!bankIFSC || String(bankIFSC).length !== 11) {
      throw new AppError('Valid 11-character IFSC code required', 400);
    }
    if (!bankAccountHolderName || bankAccountHolderName.trim().length < 2) {
      throw new AppError('Account holder name required', 400);
    }
  } else if (m === 'CRYPTO') {
    if (!cryptoAddress || typeof cryptoAddress !== 'string') {
      throw new AppError('Valid crypto wallet address required', 400);
    }
    if (!cryptoNetwork) {
      throw new AppError('Network required (ERC20 / TRC20 / BEP20)', 400);
    }
    // Per-network format checks. Without these, a user could whitelist a
    // TRC20 address against an ERC20 network (or vice versa) and lose funds
    // when the admin pays out on the wrong chain.
    const net = String(cryptoNetwork).toUpperCase();
    const addr = cryptoAddress.trim();
    const NET_VALIDATORS = {
      ERC20: /^0x[a-fA-F0-9]{40}$/,                 // Ethereum / BEP20-like
      BEP20: /^0x[a-fA-F0-9]{40}$/,
      TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,         // Tron base58
      BTC:   /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,87}$/, // legacy/p2sh/bech32
    };
    const re = NET_VALIDATORS[net];
    if (!re) {
      throw new AppError(`Unsupported network: ${net}`, 400);
    }
    if (!re.test(addr)) {
      throw new AppError(`Invalid ${net} address format`, 400);
    }

    // For CRYPTO only, enforce whitelist
    const { WhitelistedAddress } = require('../models/Compliance');
    const whitelistEntry = await WhitelistedAddress.findOne({
      userId: req.userId,
      address: cryptoAddress,
      isActive: true,
    });
    if (!whitelistEntry) {
      throw new AppError('Crypto address must be whitelisted. Add it first under Profile > Whitelist.', 400, 'NOT_WHITELISTED');
    }
    if (whitelistEntry.activeFrom && whitelistEntry.activeFrom > new Date()) {
      const minsLeft = Math.ceil((whitelistEntry.activeFrom - new Date()) / 60000);
      throw new AppError(`Whitelist entry is in 24h cooldown. ${minsLeft} minutes remaining.`, 400, 'COOLDOWN');
    }
  } else {
    throw new AppError('Method must be UPI, BANK, or CRYPTO', 400);
  }

  // AML transaction screening
  const { Withdrawal: WdModel, Deposit: DepModel } = require('../models/index');
  const [recentWds, recentDeps] = await Promise.all([
    WdModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean(),
    DepModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const recentTxs = [
    ...recentWds.map((w) => ({ ...w, type: 'WITHDRAWAL' })),
    ...recentDeps.map((d) => ({ ...d, type: 'DEPOSIT' })),
  ];
  const aml = require('../services/amlService').screenTransaction({
    userId: req.userId,
    amount: String(amount),
    currency,
    type: 'WITHDRAWAL',
    recentTransactions: recentTxs,
  });

  // Convert the user-requested amount into the canonical base
  // currency (USD) using the live FX rate. The single real wallet is
  // USD-denominated; non-USD inputs are display-only.
  const displayCur = currency || 'INR';
  const conv = await currencyService.toBase(displayCur, amount);
  const baseAmountStr = String(conv.baseAmount);

  // Check the canonical USD wallet's free balance.
  const wallet = await Wallet.findOne({ userId: req.userId, accountId, currency: BASE_CURRENCY });
  if (!wallet) {
    throw new AppError('No funds on this account. Make a deposit first.', 400, 'INSUFFICIENT_FUNDS');
  }
  const freeBase = gt(wallet.balance, wallet.locked || '0') ? sub(wallet.balance, wallet.locked || '0') : '0';
  if (gt(baseAmountStr, freeBase)) {
    // Convert the available base figure back into the user's display
    // currency for a friendlier error.
    const freeDisplay = await currencyService.fromBase(displayCur, Number(freeBase));
    throw new AppError(
      `Insufficient balance. Available: ${freeDisplay.toFixed(2)} ${displayCur} (requested ${amount} ${displayCur}).`,
      400,
      'INSUFFICIENT_FUNDS'
    );
  }

  // Build destination summary string for backwards-compat display
  let destSummary = '';
  if (m === 'UPI') destSummary = upiId;
  else if (m === 'BANK') destSummary = `${bankAccountHolderName} - ${bankAccountNumber} (${bankIFSC})`;
  else if (m === 'CRYPTO') destSummary = `${cryptoAddress} (${cryptoNetwork})`;

  // Lock the canonical USD funds FIRST so a free-balance race can't
  // approve while the funds aren't reserved.
  await walletService.lock({
    userId: req.userId,
    accountId,
    currency: BASE_CURRENCY,
    amount: baseAmountStr,
  });

  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      accountId,
      // User-facing original — what the admin pays out and what the
      // user sees in their history.
      currency: displayCur,
      amount: String(amount),
      // Canonical base — what's actually locked / debited on the
      // single USD wallet.
      baseCurrency: BASE_CURRENCY,
      baseAmount: baseAmountStr,
      fxRateUsed: conv.rate,
      method: m,
      destination: destSummary,
      upiId: m === 'UPI' ? upiId : undefined,
      bankAccountNumber: m === 'BANK' ? bankAccountNumber : undefined,
      bankIFSC: m === 'BANK' ? bankIFSC : undefined,
      bankAccountHolderName: m === 'BANK' ? bankAccountHolderName : undefined,
      bankName: m === 'BANK' ? bankName : undefined,
      cryptoAddress: m === 'CRYPTO' ? cryptoAddress : undefined,
      cryptoNetwork: m === 'CRYPTO' ? cryptoNetwork : undefined,
      status: 'PENDING',
    });
  } catch (createErr) {
    // Rollback the lock so funds aren't stuck.
    try {
      await walletService.unlock({
        userId: req.userId,
        accountId,
        currency: BASE_CURRENCY,
        amount: baseAmountStr,
      });
    } catch (e) {
      console.error('[wallet] failed to unlock after withdrawal create error:', e.message);
    }
    throw createErr;
  }

  // Email confirmation to user
  try {
    const email = require('../services/emailService');
    await email.sendWithdrawalAlert({
      to: req.user.email,
      amount: String(amount),
      currency: currency || 'INR',
      status: 'REQUESTED',
      destination: destSummary,
    });
  } catch (e) { /* non-fatal */ }

  // Live update to the user's open sessions so the wallet hero +
  // history table show the pending withdrawal + locked funds without
  // a refresh.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(req.userId), 'wallet', {
      action: 'pending',
      reason: 'WITHDRAWAL_REQUESTED',
      withdrawalId: String(wd._id),
      amount: wd.amount,
      currency: wd.currency,
    });
  } catch (_) {}

  sendSuccess(res, { ...wd.toObject(), aml: aml.requiresReview ? { flagged: true, score: aml.score, flags: aml.flags } : undefined }, 201);
});

const listWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, withdrawals);
});

/**
 * Internal transfer between two of the same user's trading accounts.
 * E.g. moving funds from a Real account to a Demo account (top-up).
 * Both accounts must belong to req.userId.
 */
const internalTransfer = asyncHandler(async (req, res) => {
  const { fromAccountId, toAccountId, currency, amount, note } = req.body;
  if (!fromAccountId || !toAccountId || !currency || !amount) {
    throw new AppError('fromAccountId, toAccountId, currency, amount required', 400);
  }
  if (String(fromAccountId) === String(toAccountId)) {
    throw new AppError('Cannot transfer to the same account', 400);
  }

  // Subscription ("Main") wallet and Bonus wallet are identified by the
  // literal sentinels 'subscription' / 'bonus' on either side. Both live
  // at the user level (no accountId) — the routing below dispatches
  // debit/credit to the matching service.
  const isSubFrom = String(fromAccountId) === 'subscription';
  const isSubTo   = String(toAccountId)   === 'subscription';
  const isBonusFrom = String(fromAccountId) === 'bonus';
  const isBonusTo   = String(toAccountId)   === 'bonus';
  const isSpecialFrom = isSubFrom || isBonusFrom;
  const isSpecialTo   = isSubTo   || isBonusTo;

  const TradingAccount = require('../models/TradingAccount');
  const [from, to] = await Promise.all([
    isSpecialFrom ? Promise.resolve(null) : TradingAccount.findOne({ _id: fromAccountId, userId: req.userId }),
    isSpecialTo   ? Promise.resolve(null) : TradingAccount.findOne({ _id: toAccountId,   userId: req.userId }),
  ]);
  if (!isSpecialFrom && !from) throw new AppError('Source account not found or not yours', 404);
  if (!isSpecialTo   && !to)   throw new AppError('Destination account not found or not yours', 404);

  // Validate amount up front so a bad input doesn't reach walletService.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const amtStr = String(amtNum);

  const subscriptionWalletService = require('../services/subscriptionWalletService');
  const bonusWalletService = require('../services/bonusWalletService');

  const destLabel = isBonusTo ? 'Bonus Wallet' : isSubTo ? 'Main Wallet' : (to && to.accountNumber);
  const srcLabel  = isBonusFrom ? 'Bonus Wallet' : isSubFrom ? 'Main Wallet' : (from && from.accountNumber);

  // ── Debit source ──
  if (isBonusFrom) {
    try {
      await bonusWalletService.debit({
        userId: req.userId,
        amount: amtStr,
        reason: 'TRANSFER_OUT',
        note: note || `Transfer to ${destLabel || 'wallet'}`,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BONUS_BALANCE') throw new AppError(err.message, 402, err.code);
      throw err;
    }
  } else if (isSubFrom) {
    try {
      await subscriptionWalletService.debit({
        userId: req.userId,
        amount: amtStr,
        reason: 'ADMIN_DEBIT',
        note: note || `Transfer to ${destLabel || 'wallet'}`,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
        throw new AppError(err.message, 402, err.code);
      }
      throw err;
    }
  } else {
    await walletService.debit({
      userId: req.userId,
      accountId: fromAccountId,
      currency,
      amount: amtStr,
      type: 'TRANSFER',
      referenceType: 'transfer',
      note: note || `Transfer to ${destLabel || 'wallet'}`,
    });
  }

  // ── Credit destination, with a compensating rollback if it fails ──
  try {
    if (isBonusTo) {
      await bonusWalletService.credit({
        userId: req.userId,
        amount: amtStr,
        reason: 'TRANSFER_IN',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    } else if (isSubTo) {
      await subscriptionWalletService.credit({
        userId: req.userId,
        amount: amtStr,
        reason: 'DEPOSIT',
        paymentMethod: 'internal_transfer',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    } else {
      await walletService.credit({
        userId: req.userId,
        accountId: toAccountId,
        currency,
        amount: amtStr,
        type: 'TRANSFER',
        referenceType: 'transfer',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    }
  } catch (creditErr) {
    // Compensating credit on source — best-effort. Logs loudly if both
    // legs fail so an on-call can reconcile from the ledger.
    try {
      if (isBonusFrom) {
        await bonusWalletService.credit({
          userId: req.userId,
          amount: amtStr,
          reason: 'TRANSFER_IN',
          note: 'Rollback: failed transfer credit on destination',
        });
      } else if (isSubFrom) {
        await subscriptionWalletService.credit({
          userId: req.userId,
          amount: amtStr,
          reason: 'REFUND',
          paymentMethod: 'internal_transfer',
          note: 'Rollback: failed transfer credit on destination',
        });
      } else {
        await walletService.credit({
          userId: req.userId,
          accountId: fromAccountId,
          currency,
          amount: amtStr,
          type: 'TRANSFER',
          referenceType: 'transfer',
          note: 'Rollback: failed transfer credit on destination',
        });
      }
    } catch (rbErr) {
      console.error(
        `[wallet] CRITICAL: failed to roll back transfer ` +
        `from=${fromAccountId} to=${toAccountId} amount=${amtStr}: ` +
        `creditErr=${creditErr.message} rollbackErr=${rbErr.message}`
      );
    }
    throw creditErr;
  }

  sendSuccess(res, { ok: true, from: fromAccountId, to: toAccountId, amount: amtStr, currency });
});

/**
 * Razorpay deposit flow (alongside the existing screenshot upload method).
 *
 *   1. Client POSTs /wallet/razorpay/order with { accountId, amount, currency }
 *      → server creates a Razorpay order, returns { orderId, keyId, amount }.
 *   2. Client opens Razorpay Checkout SDK with that orderId.
 *   3. After payment, Razorpay redirects with { paymentId, signature }.
 *   4. Client POSTs /wallet/razorpay/verify with those three values.
 *      → server verifies HMAC signature, marks Deposit COMPLETED, credits wallet.
 *
 * The existing manual screenshot flow at POST /wallet/deposit is untouched —
 * users can still do bank/UPI transfers + admin approval if they prefer.
 *
 * Webhook endpoint at POST /wallet/razorpay/webhook also accepts events
 * directly from Razorpay (in case the client never returns to /verify).
 * Both verify and webhook are idempotent via paymentId dedupe.
 */
const paymentService = require('../services/paymentService');
const { WALLET_TX_TYPE } = require('../config/constants');

const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { accountId, currency = 'INR', amount } = req.body;
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  if (isDemoLike) {
    throw new AppError('Razorpay deposits are only for real-money accounts', 400);
  }
  // KYC gate — same as the manual flow.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && req.user?.kycStatus !== 'APPROVED') {
    throw new AppError('KYC must be approved before depositing.', 403, 'KYC_REQUIRED');
  }

  // Minimum-deposit gate (per AccountPlan tier) — enforced on EVERY deposit,
  // mirroring the manual flow.
  {
    const accountFeeService = require('../services/accountFeeService');
    const minDep = await accountFeeService.getMinDeposit(account); // USD
    if (minDep > 0) {
      const conv = await currencyService.toBase(currency || 'INR', amtNum);
      const baseAmt = Number(conv.baseAmount);
      if (baseAmt < minDep) {
        throw new AppError(
          `Minimum deposit for the ${account.nickname || account.accountType} plan is ${minDep} USD — you entered ≈ ${baseAmt.toFixed(2)} USD.`,
          400,
          'BELOW_MIN_DEPOSIT'
        );
      }
    }
  }

  // Create the Razorpay order. If RAZORPAY env vars aren't set, the
  // service silently falls back to mock mode (auto-confirms) so dev works.
  const order = await paymentService.createOrder({
    amount: amtNum,
    currency,
    metadata: {
      userId: String(req.userId),
      accountId: String(account._id),
    },
  });

  // Persist a PENDING Deposit row keyed by the Razorpay order id so the
  // verify/webhook can find it idempotently.
  const dep = await Deposit.create({
    userId: req.userId,
    accountId: account._id,
    currency,
    amount: String(amtNum),
    method: 'RAZORPAY',
    txReference: order.orderId,
    status: 'PENDING',
  });

  sendSuccess(res, {
    depositId: dep._id,
    orderId: order.orderId,
    amount: amtNum,
    currency,
    keyId: order.providerData?.keyId || process.env.RAZORPAY_KEY_ID,
  });
});

const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  if (!orderId || !paymentId || !signature) {
    throw new AppError('orderId, paymentId, signature all required', 400);
  }
  const dep = await Deposit.findOne({ txReference: orderId, userId: req.userId });
  if (!dep) throw new AppError('Deposit not found', 404);
  if (dep.status === 'COMPLETED' || dep.status === 'CONFIRMED') {
    // Idempotent — already credited. Just acknowledge.
    return sendSuccess(res, { depositId: dep._id, status: dep.status, alreadyCredited: true });
  }

  const verified = await paymentService.verifyPayment({ orderId, paymentId, signature });
  if (!verified.ok) {
    dep.status = 'REJECTED';
    dep.rejectionReason = verified.reason;
    await dep.save();
    throw new AppError(`Payment verification failed: ${verified.reason}`, 400, 'PAYMENT_VERIFY_FAILED');
  }

  // Credit the wallet. Use the Razorpay paymentId as a dedupeKey on the
  // wallet ledger so a replay (verify hits + webhook hits) only credits once.
  await walletService.credit({
    userId: dep.userId,
    accountId: dep.accountId,
    currency: dep.currency,
    amount: dep.amount,
    type: WALLET_TX_TYPE.DEPOSIT,
    referenceType: 'deposit',
    referenceId: dep._id,
    dedupeKey: `RAZORPAY:${paymentId}`,
    note: `Razorpay deposit ${paymentId}`,
  });
  dep.status = 'COMPLETED';
  dep.completedAt = new Date();
  dep.providerPaymentId = paymentId;
  await dep.save();

  // Partner program: try the first-deposit bonus hook. Best-effort.
  try {
    const partnerService = require('../services/partnerService');
    await partnerService.handleFirstQualifyingDeposit({ userId: dep.userId, deposit: dep });
  } catch (e) {
    console.warn('[razorpay verify] partner hook failed:', e.message);
  }

  sendSuccess(res, { depositId: dep._id, status: 'COMPLETED' });
});

// Webhook fired directly by Razorpay (configure URL in Razorpay dashboard).
// Body comes as raw bytes for signature verification; need express.raw()
// middleware on this route specifically. For simplicity, we require the
// `x-razorpay-signature` header matched against the JSON body.
const razorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, reason: 'webhook not configured' });
  }
  const rawBody = JSON.stringify(req.body);
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected !== signature) {
    return res.status(401).json({ ok: false, reason: 'invalid signature' });
  }

  const event = req.body.event;
  const payment = req.body.payload?.payment?.entity;
  if (event === 'payment.captured' && payment) {
    const dep = await Deposit.findOne({ txReference: payment.order_id });
    if (dep && dep.status !== 'COMPLETED' && dep.status !== 'CONFIRMED') {
      await walletService.credit({
        userId: dep.userId,
        accountId: dep.accountId,
        currency: dep.currency,
        amount: dep.amount,
        type: WALLET_TX_TYPE.DEPOSIT,
        referenceType: 'deposit',
        referenceId: dep._id,
        dedupeKey: `RAZORPAY:${payment.id}`,
        note: `Razorpay webhook ${payment.id}`,
      });
      dep.status = 'COMPLETED';
      dep.completedAt = new Date();
      dep.providerPaymentId = payment.id;
      await dep.save();
      // Partner program: best-effort first-deposit bonus.
      try {
        const partnerService = require('../services/partnerService');
        await partnerService.handleFirstQualifyingDeposit({ userId: dep.userId, deposit: dep });
      } catch (e) {
        console.warn('[razorpay webhook] partner hook failed:', e.message);
      }
    }
  }
  res.json({ ok: true });
});

/**
 * In-account currency conversion. Debits the source wallet and credits
 * the destination wallet (same account) with the converted amount.
 *
 * The fxRate is supplied by the client (which uses the live `useFxRate`
 * hook) so the user sees the same rate the rest of the UI is showing.
 * The server still validates the rate looks sane (within ±20 % of the
 * configured FX_DEFAULT_RATE) to prevent obvious tampering.
 */
const convertCurrency = asyncHandler(async (req, res) => {
  const { accountId, fromCurrency, toCurrency, amount, fxRate: clientFxRate } = req.body;

  if (!accountId || !fromCurrency || !toCurrency) {
    throw new AppError('accountId, fromCurrency, toCurrency required', 400);
  }
  if (String(fromCurrency).toUpperCase() === String(toCurrency).toUpperCase()) {
    throw new AppError('Source and target currency must be different', 400);
  }
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // Resolve the FX rate. Sanity-bound the client's value (±20 %) so a
  // tampered request can't get a 1000x conversion. Falls back to the
  // configured default if the client didn't send a rate.
  const DEFAULT_RATE = Number(process.env.FX_DEFAULT_RATE || 83);
  let rate = Number(clientFxRate);
  if (!Number.isFinite(rate) || rate <= 0) rate = DEFAULT_RATE;
  const minRate = DEFAULT_RATE * 0.8;
  const maxRate = DEFAULT_RATE * 1.2;
  if (rate < minRate || rate > maxRate) rate = DEFAULT_RATE;

  // Compute the target amount. Only USD↔INR pairs are auto-converted;
  // anything else returns the same magnitude (no FX risk taken).
  let targetAmount;
  if (from === 'USD' && to === 'INR') targetAmount = amtNum * rate;
  else if (from === 'INR' && to === 'USD') targetAmount = amtNum / rate;
  else targetAmount = amtNum;

  // Debit source first; if credit fails, compensate to keep the user whole.
  await walletService.debit({
    userId: req.userId,
    accountId,
    currency: from,
    amount: String(amtNum),
    type: WALLET_TX_TYPE.ADJUSTMENT,
    referenceType: 'conversion',
    note: `Convert ${amtNum} ${from} → ${to} @ ${rate}`,
  });
  try {
    await walletService.credit({
      userId: req.userId,
      accountId,
      currency: to,
      amount: String(targetAmount.toFixed(2)),
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'conversion',
      note: `Convert ${amtNum} ${from} → ${to} @ ${rate}`,
    });
  } catch (err) {
    // Rollback the debit so the user's funds aren't lost.
    await walletService.credit({
      userId: req.userId,
      accountId,
      currency: from,
      amount: String(amtNum),
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'conversion-rollback',
      note: `Convert rollback (credit failed)`,
    });
    throw err;
  }

  sendSuccess(res, {
    accountId,
    fromCurrency: from,
    toCurrency: to,
    fromAmount: String(amtNum),
    toAmount: targetAmount.toFixed(2),
    rate,
  });
});

/**
 * GET /wallet/recipients/search?q=<term>
 * Autocomplete for the "Send to user" form. Matches against referralCode,
 * email, name, or _id. Excludes the caller and blocked users. Returns a
 * slim recipient shape ({ _id, name, email, referralCode, avatarUrl }).
 */
const searchTransferRecipients = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const { q, limit, by } = req.query;
  // `by=uid` → match the permanent public User ID only (recipient picker
  // restricted to User ID search). Anything else keeps the broad match.
  const results = await userTransferService.searchRecipients(
    req.userId, q, Number(limit) || 10, { uidOnly: by === 'uid' }
  );
  sendSuccess(res, results);
});

/**
 * GET /wallet/transfer-user/settings
 * Returns the current admin-tunable limits for the form (so the FE can
 * show min/max hints + a fee preview before submit).
 */
const getUserTransferSettings = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const cfg = await userTransferService.getTransferSettings();
  sendSuccess(res, {
    enabled:    cfg['userTransfer.enabled'] !== false,
    min:        String(cfg['userTransfer.min']        || '0'),
    max:        String(cfg['userTransfer.max']        || '0'),
    feePercent: String(cfg['userTransfer.feePercent'] || '0'),
  });
});

/**
 * POST /wallet/transfer-user
 * Body: {
 *   fromAccountId, currency, amount, note?,
 *   recipientUserId? | recipientUsername? | recipientReferralCode?
 * }
 * Sends funds to another registered user. Reuses walletService.credit/debit;
 * writes two ledger rows (INTERNAL_TRANSFER_OUT on sender, INTERNAL_TRANSFER_IN
 * on receiver) with a shared referenceId.
 */
const transferToUser = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const {
    fromAccountId, currency, amount, note,
    recipientUserId, recipientUsername, recipientReferralCode,
  } = req.body || {};

  const result = await userTransferService.transferToUser({
    fromUserId:    req.userId,
    fromAccountId,
    currency:      currency || BASE_CURRENCY,
    amount,
    note,
    recipient:     { recipientUserId, recipientUsername, recipientReferralCode },
    req,
  });
  sendSuccess(res, result);
});

module.exports = {
  getBalances,
  depositDetails,
  getLedger,
  createDeposit,
  listDeposits,
  requestWithdrawal,
  listWithdrawals,
  internalTransfer,
  convertCurrency,
  createRazorpayOrder,
  verifyRazorpayPayment,
  razorpayWebhook,
  searchTransferRecipients,
  getUserTransferSettings,
  transferToUser,
};
