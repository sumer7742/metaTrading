const mongoose = require('mongoose');

const depositSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Target wallet:
    //   'trading'      → credit the user's trading-account wallet (default; legacy behaviour)
    //   'subscription' → credit the user's standalone Subscription Wallet
    // The admin verification flow checks this field to route the credit.
    targetWallet: { type: String, enum: ['trading', 'subscription', 'bonus'], default: 'trading', index: true },
    // accountId is REQUIRED for trading-wallet deposits but ignored for
    // subscription-wallet deposits (the Subscription Wallet is per-user,
    // not per-account). We leave it optional at the schema level and
    // gate it in the controller.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount' },
    // What the user actually saw / paid in (e.g. INR via UPI). Admin
    // reconciles against this against the UPI/bank receipt. Wallet
    // credit, however, happens in the base currency (USD) — see
    // `baseAmount` below.
    currency: { type: String, required: true },
    amount: { type: String, required: true },
    // Canonical base-currency view. The wallet is single-source-of-
    // truth in USD; every deposit gets normalised here so credit /
    // debit logic only ever touches one currency row per account.
    baseCurrency: { type: String, default: 'USD' },
    baseAmount:   { type: String, default: '0' },
    fxRateUsed:   { type: Number, default: 1 },   // rate that was applied to derive baseAmount
    method: String, // 'BANK', 'UPI', 'CRYPTO', 'CARD', 'MANUAL'
    txReference: String, // bank ref / UPI ref / tx hash
    // Payment proof — REQUIRED for real-money deposits.
    // Stored as base64 data URL (small images <500KB) or external URL.
    // For production, use S3/Cloudinary and store the URL only.
    screenshot: { type: String }, // base64 data URL or http(s) URL
    screenshotMimeType: { type: String }, // 'image/png', 'image/jpeg', etc.
    // Sender details (for bank/UPI deposits)
    senderName: String,
    senderUpiId: String,
    senderBankAccount: String, // last 4 digits only
    status: {
      type: String,
      enum: ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    confirmedAt: Date,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: String,
    note: String,

    // ─── Finance auto-distribution (workload-balanced; NOT user ownership) ──
    // The DEPOSIT_OFFICER currently responsible for this request. Set
    // automatically on creation to the least-loaded officer; a manager can
    // reassign. Null = unassigned (no officers configured → admins handle it).
    assignedOfficerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedAt: Date,
    assignmentHistory: [{
      officerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = system auto-assign
      at:        { type: Date, default: Date.now },
      reason:    String,
    }],
  },
  { timestamps: true }
);

const withdrawalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Trading-account withdrawals set this (funds locked on that account's
    // wallet). Main/Subscription-wallet withdrawals (source='SUBSCRIPTION')
    // have NO trading account — the balance is debited up-front instead.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount' },
    // Where the money comes from / how it's settled:
    //   'TRADING'      → account base wallet: lock on request → unlock+debit
    //                    on approve, unlock on reject (existing flow).
    //   'SUBSCRIPTION' → Main Wallet: debited (held) on request → kept on
    //                    approve, refunded on reject.
    //   'BONUS'        → Bonus Wallet: same debit-on-request / refund-on-reject
    //                    model as SUBSCRIPTION.
    source: { type: String, enum: ['TRADING', 'SUBSCRIPTION', 'BONUS'], default: 'TRADING', index: true },
    // What the user requested (e.g. ₹500 to a UPI ID). Admin pays this
    // exact value via UPI / IMPS. The wallet, meanwhile, debits the
    // USD equivalent stored in `baseAmount`.
    currency: { type: String, required: true },
    amount: { type: String, required: true },
    baseCurrency: { type: String, default: 'USD' },
    baseAmount:   { type: String, default: '0' },
    fxRateUsed:   { type: Number, default: 1 },
    fee: { type: String, default: '0' },
    method: String, // 'UPI', 'BANK', 'CRYPTO'
    destination: String, // legacy single field; details below preferred

    // Withdrawal destination details (one of these will be filled per method)
    upiId: String,                  // method=UPI: e.g. 'username@upi'
    bankAccountNumber: String,      // method=BANK
    bankIFSC: String,               // method=BANK
    bankAccountHolderName: String,  // method=BANK
    bankName: String,               // method=BANK (optional)
    cryptoAddress: String,          // method=CRYPTO
    cryptoNetwork: String,          // method=CRYPTO: e.g. 'ERC20', 'TRC20'

    // After admin pays out, they upload proof screenshot
    payoutProof: String,            // base64 data URL of payment proof
    payoutProofMimeType: String,
    payoutTxReference: String,      // bank/UPI reference of admin's outgoing payment
    payoutAt: Date,                 // timestamp when payout was made

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    approvedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // 4-eyes principle
    approvedAt: Date,
    rejectedReason: String,
    txReference: String,

    // ─── Finance auto-distribution (workload-balanced; NOT user ownership) ──
    // The WITHDRAWAL_OFFICER currently responsible for this request.
    assignedOfficerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedAt: Date,
    assignmentHistory: [{
      officerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null = system auto-assign
      at:        { type: Date, default: Date.now },
      reason:    String,
    }],
  },
  { timestamps: true }
);

// ── Auto-distribution hooks ───────────────────────────────────────────
// Every freshly-created PENDING deposit/withdrawal is workload-balanced to
// the least-loaded officer of the matching department. A post-save hook
// covers ALL creation paths (wallet / subscription / bonus) with zero
// duplication. Best-effort + idempotent (skips if already assigned), and
// deferred via setImmediate so it never blocks/breaks the create response.
const _autoAssignHook = (kind) => function (doc) {
  try {
    if (!doc || !doc.$locals || !doc.$locals.wasNew) return;
    if (doc.assignedOfficerId || doc.status !== 'PENDING') return;
    setImmediate(() => {
      require('../services/financeService')
        .autoAssign(kind, doc._id)
        .catch((e) => console.error(`[finance] auto-assign ${kind} failed:`, e.message));
    });
  } catch (_) { /* never let assignment break a money request */ }
};
depositSchema.pre('save', function (next) { this.$locals.wasNew = this.isNew; next(); });
depositSchema.post('save', _autoAssignHook('deposit'));
withdrawalSchema.pre('save', function (next) { this.$locals.wasNew = this.isNew; next(); });
withdrawalSchema.post('save', _autoAssignHook('withdrawal'));

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: String,
    action: { type: String, required: true, index: true },
    targetType: String, // 'USER', 'ORDER', 'INSTRUMENT', 'WITHDRAWAL', etc.
    targetId: String,
    metadata: mongoose.Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    createdAt: { type: Date, default: Date.now, immutable: true, index: true },
  },
  { timestamps: false }
);

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true }, // 'TRADE', 'MARGIN_CALL', 'DEPOSIT', etc.
    title: String,
    message: String,
    data: mongoose.Schema.Types.Mixed,
    channels: [String], // ['IN_APP', 'EMAIL', 'SMS', 'PUSH']
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = {
  Deposit: mongoose.model('Deposit', depositSchema),
  Withdrawal: mongoose.model('Withdrawal', withdrawalSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
  Notification: mongoose.model('Notification', notificationSchema),
};
