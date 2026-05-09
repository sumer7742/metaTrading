const { Wallet, WalletLedger } = require('../models/Wallet');
const { Deposit, Withdrawal } = require('../models/index');
const TradingAccount = require('../models/TradingAccount');
const walletService = require('../services/walletService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { gt, sub } = require('../utils/decimal');

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

const getLedger = asyncHandler(async (req, res) => {
  const { limit = 100, accountId } = req.query;
  const filter = { userId: req.userId };
  if (accountId) filter.accountId = accountId;
  const entries = await WalletLedger.find(filter).sort({ createdAt: -1 }).limit(Number(limit)).lean();
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

  // For REAL accounts, screenshot is MANDATORY (proof of payment)
  if (account.accountType === 'REAL') {
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

  // For DEMO accounts, allow direct credit without screenshot (instant top-up)
  if (account.accountType === 'DEMO') {
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

    // Auto-confirm demo deposits — no admin review needed
    const dep = await Deposit.create({
      userId: req.userId,
      accountId,
      currency: currency || 'INR',
      amount: String(amtNum), // canonical numeric form
      method: method || 'DEMO',
      txReference: 'DEMO-' + Date.now(),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      note: 'Demo balance top-up (auto-approved)',
    });
    // Credit demo wallet immediately
    const { credit } = require('../services/walletService');
    await credit({
      userId: req.userId,
      accountId,
      currency: currency || 'INR',
      amount: String(amtNum),
      type: 'DEPOSIT',
      referenceType: 'Deposit',
      referenceId: dep._id,
      note: 'Demo balance top-up',
    });
    return sendSuccess(res, dep, 201);
  }

  // REAL deposits — pending admin review
  const dep = await Deposit.create({
    userId: req.userId,
    accountId,
    currency: currency || 'INR',
    amount: String(amount),
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

  // Block withdrawals from DEMO accounts
  if (account.accountType === 'DEMO') {
    throw new AppError('Withdrawals not allowed from demo accounts', 400);
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

  // check available balance
  const wallet = await Wallet.findOne({ userId: req.userId, accountId, currency: currency || 'INR' });
  if (!wallet) throw new AppError('Wallet not found', 404);
  const free = gt(wallet.balance, wallet.locked || '0') ? sub(wallet.balance, wallet.locked || '0') : '0';
  if (gt(amount, free)) throw new AppError('Insufficient free balance', 400, 'INSUFFICIENT_FUNDS');

  // Build destination summary string for backwards-compat display
  let destSummary = '';
  if (m === 'UPI') destSummary = upiId;
  else if (m === 'BANK') destSummary = `${bankAccountHolderName} - ${bankAccountNumber} (${bankIFSC})`;
  else if (m === 'CRYPTO') destSummary = `${cryptoAddress} (${cryptoNetwork})`;

  // Lock the funds FIRST so a free-balance race can't open a window where
  // the withdrawal is PENDING but the funds aren't reserved (admin could
  // approve and we'd over-pay). If create fails, roll the lock back.
  await walletService.lock({
    userId: req.userId,
    accountId,
    currency: currency || 'INR',
    amount: String(amount),
  });

  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      accountId,
      currency: currency || 'INR',
      amount: String(amount),
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
    // Rollback the lock so the user's funds aren't stuck.
    try {
      await walletService.unlock({
        userId: req.userId,
        accountId,
        currency: currency || 'INR',
        amount: String(amount),
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

  const TradingAccount = require('../models/TradingAccount');
  const [from, to] = await Promise.all([
    TradingAccount.findOne({ _id: fromAccountId, userId: req.userId }),
    TradingAccount.findOne({ _id: toAccountId, userId: req.userId }),
  ]);
  if (!from || !to) throw new AppError('Account not found or not yours', 404);

  // Validate amount up front so a bad input doesn't reach walletService.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const amtStr = String(amtNum);

  // Debit source, credit destination — single user, no FX, simple flow.
  // If credit fails after a successful debit, roll the debit back via a
  // compensating credit on the source so the user's funds aren't lost.
  // Mongo standalone (dev/MVP) lacks transactions, so this rollback path
  // is the next-best correctness guarantee.
  await walletService.debit({
    userId: req.userId,
    accountId: fromAccountId,
    currency,
    amount: amtStr,
    type: 'TRANSFER',
    referenceType: 'transfer',
    note: note || `Transfer to ${to.accountNumber}`,
  });

  try {
    await walletService.credit({
      userId: req.userId,
      accountId: toAccountId,
      currency,
      amount: amtStr,
      type: 'TRANSFER',
      referenceType: 'transfer',
      note: note || `Transfer from ${from.accountNumber}`,
    });
  } catch (creditErr) {
    // Compensating credit on source — best-effort. If THIS fails too, we
    // log loudly so the on-call can manually reconcile from the ledger.
    try {
      await walletService.credit({
        userId: req.userId,
        accountId: fromAccountId,
        currency,
        amount: amtStr,
        type: 'TRANSFER',
        referenceType: 'transfer',
        note: 'Rollback: failed transfer credit on destination',
      });
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

module.exports = {
  getBalances,
  getLedger,
  createDeposit,
  listDeposits,
  requestWithdrawal,
  listWithdrawals,
  internalTransfer,
};
