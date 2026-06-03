/**
 * Peer-to-peer wallet transfer service.
 *
 * Lets a user send funds from their own trading wallet to another
 * registered user's trading wallet, reusing the existing wallet ledger
 * (no separate payment system). Two ledger rows per transfer:
 *
 *   Sender   →  type=INTERNAL_TRANSFER_OUT  amount=-X
 *   Receiver →  type=INTERNAL_TRANSFER_IN   amount=+X
 *
 * Both rows share a stable `referenceId` (a Mongo ObjectId minted at
 * the start of the transfer) so the pair can be reconstructed from the
 * ledger alone for audit / reconciliation.
 *
 * Admin settings (SystemSetting keys, defaulted via DEFAULTS below):
 *   userTransfer.enabled    boolean   global on/off
 *   userTransfer.min        decimal   min amount per transfer
 *   userTransfer.max        decimal   max amount per transfer (0 = no cap)
 *   userTransfer.feePercent decimal   fee charged to sender, e.g. "0.5"
 */

const mongoose = require('mongoose');
const walletService = require('./walletService');
const systemSettings = require('./systemSettings.service');
const { AppError } = require('../utils/errors');
const { D, gt, gte, mul, sub, add } = require('../utils/decimal');
const { WALLET_TX_TYPE } = require('../config/constants');

const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { Notification, AuditLog } = require('../models');

const DEFAULTS = {
  'userTransfer.enabled':    true,
  'userTransfer.min':        '1',
  'userTransfer.max':        '0',   // 0 → no cap
  'userTransfer.feePercent': '0',   // 0 → no fee
};

/**
 * Load all transfer-related settings in one read, defaulted.
 */
const getTransferSettings = async () => {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const got = await systemSettings.getSetting(k);
    out[k] = got !== undefined ? got : v;
  }
  return out;
};

/**
 * Recipient search. Matches against:
 *   - referralCode (exact, case-insensitive)
 *   - email (exact, case-insensitive)
 *   - _id (exact, when q is a 24-char hex string)
 *   - firstName / lastName / "firstName lastName" (case-insensitive substring)
 *
 * Excludes the calling user and blocked accounts. Returns a slim shape
 * the recipient picker can render without loading other PII.
 */
const searchRecipients = async (callerUserId, q, limit = 10, opts = {}) => {
  const term = String(q || '').trim();
  if (term.length < 2) return [];

  const ors = [];
  const lower = term.toLowerCase();

  if (opts.uidOnly) {
    // Restrict matching to the permanent public User ID ONLY (e.g.
    // USR100245). Contains-match (case-insensitive) so partial typing
    // progressively narrows the list — no email / name / referral fallback.
    ors.push({ userUid: new RegExp(escapeRegex(term), 'i') });
  } else {
    const looksLikeObjectId = /^[a-f0-9]{24}$/i.test(term);
    if (looksLikeObjectId) ors.push({ _id: term });
    ors.push({ userUid: new RegExp(`^${escapeRegex(term)}$`, 'i') });   // permanent User ID (USR100245)
    ors.push({ referralCode: new RegExp(`^${escapeRegex(term)}$`, 'i') });
    ors.push({ email: new RegExp(`^${escapeRegex(lower)}$`, 'i') });
    const rxLoose = new RegExp(escapeRegex(term), 'i');
    ors.push({ firstName: rxLoose });
    ors.push({ lastName: rxLoose });
    // "first last" combined
    const parts = term.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      ors.push({
        firstName: new RegExp(`^${escapeRegex(parts[0])}`, 'i'),
        lastName:  new RegExp(`^${escapeRegex(parts.slice(1).join(' '))}`, 'i'),
      });
    }
  }

  const users = await User.find({
    $or: ors,
    _id: { $ne: callerUserId },
    isActive: { $ne: false },
  })
    .select('_id email firstName lastName referralCode userUid avatarUrl')
    .limit(Math.min(50, Math.max(1, Number(limit) || 10)))
    .lean();

  return users.map((u) => ({
    _id:          String(u._id),
    name:         [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    email:        u.email,
    userUid:      u.userUid || null,
    referralCode: u.referralCode || null,
    avatarUrl:    u.avatarUrl || null,
  }));
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a recipient by any of the supported identifiers. Returns
 * the full User doc (lean) or throws.
 */
const resolveRecipient = async ({ recipientUserId, recipientUsername, recipientReferralCode, recipientUserUid }) => {
  const ors = [];
  if (recipientUserId && /^[a-f0-9]{24}$/i.test(recipientUserId)) ors.push({ _id: recipientUserId });
  if (recipientReferralCode) ors.push({ referralCode: new RegExp(`^${escapeRegex(recipientReferralCode)}$`, 'i') });
  if (recipientUserUid) ors.push({ userUid: new RegExp(`^${escapeRegex(recipientUserUid)}$`, 'i') });
  if (recipientUsername) {
    // Username treated as email OR referralCode OR permanent User ID.
    ors.push({ email: new RegExp(`^${escapeRegex(recipientUsername.toLowerCase())}$`, 'i') });
    ors.push({ referralCode: new RegExp(`^${escapeRegex(recipientUsername)}$`, 'i') });
    ors.push({ userUid: new RegExp(`^${escapeRegex(recipientUsername)}$`, 'i') });
  }
  if (!ors.length) throw new AppError('Recipient identifier required', 400);

  const user = await User.findOne({ $or: ors, isActive: { $ne: false } }).lean();
  if (!user) throw new AppError('Recipient not found', 404);
  return user;
};

/**
 * Pick the recipient's destination wallet — their primary REAL trading
 * account in the requested currency. Falls back to any active non-DEMO
 * account in that currency, then to any active account in that currency
 * (last-resort). Never silently credits to a demo account.
 */
const pickRecipientAccount = async (recipientUserId, currency) => {
  let acct = await TradingAccount.findOne({
    userId: recipientUserId,
    accountType: { $nin: ['DEMO', 'VIRTUAL'] },
    baseCurrency: currency,
    isActive: true,
  }).lean();
  if (!acct) {
    acct = await TradingAccount.findOne({
      userId: recipientUserId,
      accountType: { $nin: ['DEMO', 'VIRTUAL'] },
      isActive: true,
    }).lean();
  }
  if (!acct) {
    throw new AppError(
      'Recipient has no eligible real trading account in ' + currency,
      400,
      'RECIPIENT_NO_ACCOUNT'
    );
  }
  return acct;
};

/**
 * Execute a peer-to-peer transfer.
 *
 * @param {object} ctx
 * @param {ObjectId} ctx.fromUserId
 * @param {ObjectId} ctx.fromAccountId — sender's account to debit
 * @param {string}   ctx.currency
 * @param {string|number} ctx.amount  — gross amount sender requests to send
 * @param {string}   ctx.note         — optional, surfaced on both ledger rows
 * @param {object}   ctx.recipient    — { recipientUserId|recipientUsername|recipientReferralCode }
 * @param {object}   ctx.req          — optional, for IP/UA in the audit log
 *
 * Settlement:
 *   - amount = gross amount sender pays
 *   - fee    = amount * feePercent (deducted on top — sender's debit is amount+fee)
 *     Actually: per spec the receiver gets `amount`; the fee is charged
 *     to the sender separately. So:
 *       senderDebitTotal = amount + fee
 *       receiverCredit   = amount
 *     Fee fees go to a system ledger (none here for v1; logged as note).
 */
const transferToUser = async ({
  fromUserId, fromAccountId, currency, amount, note, recipient, req,
}) => {
  if (!fromUserId)    throw new AppError('fromUserId required', 400);
  if (!fromAccountId) throw new AppError('fromAccountId required', 400);
  if (!currency)      throw new AppError('currency required', 400);

  const amt = D(amount || '0');
  if (!amt.isFinite() || amt.lte(0)) throw new AppError('Amount must be positive', 400);

  // Settings gate.
  const cfg = await getTransferSettings();
  if (cfg['userTransfer.enabled'] === false) {
    throw new AppError('Peer-to-peer transfers are disabled', 403, 'TRANSFERS_DISABLED');
  }
  const min = D(cfg['userTransfer.min'] || '0');
  if (min.gt(0) && amt.lt(min)) {
    throw new AppError(`Minimum transfer is ${min.toString()} ${currency}`, 400, 'BELOW_MIN');
  }
  const max = D(cfg['userTransfer.max'] || '0');
  if (max.gt(0) && amt.gt(max)) {
    throw new AppError(`Maximum transfer is ${max.toString()} ${currency}`, 400, 'ABOVE_MAX');
  }
  const feePct = D(cfg['userTransfer.feePercent'] || '0');
  const fee = feePct.gt(0) ? amt.mul(feePct).div(100) : D(0);
  const senderTotal = amt.plus(fee);

  // Resolve recipient.
  const recipientDoc = await resolveRecipient(recipient || {});
  if (String(recipientDoc._id) === String(fromUserId)) {
    throw new AppError('Cannot transfer to yourself', 400, 'SELF_TRANSFER');
  }

  // Source can be a trading account OR the user-level Main Wallet
  // (sentinel 'subscription'). The Main Wallet is USD-only.
  const isMainFrom = String(fromAccountId) === 'subscription';
  const subscriptionWalletService = require('./subscriptionWalletService');
  if (isMainFrom) {
    if (currency !== 'USD') throw new AppError('Main Wallet transfers must be in USD', 400, 'MAIN_USD_ONLY');
  } else {
    // Verify sender's trading account belongs to them.
    const fromAcct = await TradingAccount.findOne({ _id: fromAccountId, userId: fromUserId }).lean();
    if (!fromAcct) throw new AppError('Source account not found', 404);
  }

  // Pick recipient account.
  const toAcct = await pickRecipientAccount(recipientDoc._id, currency);

  // Shared reference id stamped on both ledger rows. Generated up front
  // so a rollback retains the link.
  const referenceId = new mongoose.Types.ObjectId();
  const referenceType = 'user_transfer';

  // Sender label for the receiver's ledger note (and v.v.).
  const senderName  = displayName(req?.user) || 'a user';
  const recipName   = displayName(recipientDoc) || 'a user';

  // ── 1) Debit sender (amount + fee) ──
  const debitNote = note
    ? `To ${recipName}: ${note}` + (fee.gt(0) ? ` · fee ${fee.toString()}` : '')
    : `Transfer to ${recipName}` + (fee.gt(0) ? ` · fee ${fee.toString()}` : '');
  if (isMainFrom) {
    try {
      await subscriptionWalletService.debit({
        userId: fromUserId,
        amount: senderTotal.toString(),
        reason: 'ADMIN_DEBIT',
        note:   debitNote,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') throw new AppError(err.message, 402, err.code);
      throw err;
    }
  } else {
    await walletService.debit({
      userId:        fromUserId,
      accountId:     fromAccountId,
      currency,
      amount:        senderTotal.toString(),
      type:          WALLET_TX_TYPE.INTERNAL_TRANSFER_OUT,
      referenceType,
      referenceId,
      note:          debitNote,
    });
  }

  // ── 2) Credit recipient — rollback on failure ──
  try {
    await walletService.credit({
      userId:        recipientDoc._id,
      accountId:     toAcct._id,
      currency,
      amount:        amt.toString(),
      type:          WALLET_TX_TYPE.INTERNAL_TRANSFER_IN,
      referenceType,
      referenceId,
      note:          note
        ? `From ${senderName}: ${note}`
        : `Transfer from ${senderName}`,
    });
  } catch (creditErr) {
    // Compensating refund on sender.
    try {
      if (isMainFrom) {
        await subscriptionWalletService.credit({
          userId: fromUserId,
          amount: senderTotal.toString(),
          reason: 'REFUND',
          note:   'Rollback: peer transfer credit failed',
        });
      } else {
        await walletService.credit({
          userId:    fromUserId,
          accountId: fromAccountId,
          currency,
          amount:    senderTotal.toString(),
          type:      WALLET_TX_TYPE.INTERNAL_TRANSFER_OUT,
          referenceType,
          referenceId,
          note:      'Rollback: peer transfer credit failed',
        });
      }
    } catch (rbErr) {
      console.error(
        `[userTransfer] CRITICAL: rollback failed from=${fromUserId} to=${recipientDoc._id} ` +
        `amount=${senderTotal.toString()} ${currency}: creditErr=${creditErr.message} rbErr=${rbErr.message}`
      );
    }
    throw creditErr;
  }

  // ── 3) Notification + audit + WS push (best-effort) ──
  try {
    await Notification.create({
      userId:   recipientDoc._id,
      type:     'TRANSFER_RECEIVED',
      title:    'Funds received',
      message:  `You received ${amt.toString()} ${currency} from ${senderName}` + (note ? ` — "${note}"` : ''),
      channels: ['IN_APP'],
      data:     { fromUserId: String(fromUserId), amount: amt.toString(), currency, referenceId: String(referenceId) },
    });
  } catch (e) {
    console.warn('[userTransfer] notification create failed:', e.message);
  }

  try {
    await AuditLog.create({
      actorId:    fromUserId,
      actorRole:  req?.user?.role || 'USER',
      action:     'USER_TRANSFER',
      targetType: 'USER',
      targetId:   String(recipientDoc._id),
      metadata: {
        fromAccountId: String(fromAccountId),
        toAccountId:   String(toAcct._id),
        currency,
        amount:        amt.toString(),
        fee:           fee.toString(),
        referenceId:   String(referenceId),
        note:          note || null,
      },
      ip:        req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  } catch (e) {
    console.warn('[userTransfer] audit log failed:', e.message);
  }

  // Real-time pushes to both parties so balances refresh instantly.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(fromUserId),        'wallet', { event: 'UPDATED' });
    broadcaster.notifyUser(String(recipientDoc._id),  'wallet', { event: 'UPDATED' });
    broadcaster.notifyUser(String(recipientDoc._id),  'notifications', {
      type: 'TRANSFER_RECEIVED',
      amount: amt.toString(),
      currency,
      fromUserId: String(fromUserId),
      fromName: senderName,
    });
  } catch (e) {
    console.warn('[userTransfer] WS broadcast failed:', e.message);
  }

  return {
    referenceId: String(referenceId),
    fromUserId:  String(fromUserId),
    toUserId:    String(recipientDoc._id),
    recipient:   { name: recipName, userUid: recipientDoc.userUid || null, referralCode: recipientDoc.referralCode || null },
    currency,
    amount:      amt.toString(),
    fee:         fee.toString(),
    totalDebited: senderTotal.toString(),
    createdAt:   new Date(),
  };
};

function displayName(user) {
  if (!user) return null;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return full || user.email || null;
}

module.exports = {
  DEFAULTS,
  getTransferSettings,
  searchRecipients,
  resolveRecipient,
  transferToUser,
};
