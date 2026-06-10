/**
 * Audit & Compliance controller — powers the Audit Manager dashboard.
 *
 * Read-only oversight + two write actions the role is allowed: flag a user and
 * submit an account-freeze request (the actual freeze is a SUPER_ADMIN action).
 * Everything is hierarchy-agnostic (audit sees the whole platform) and gated to
 * AUDIT_MANAGER + SUPER_ADMIN by the route layer.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Position = require('../models/Position');
const { Deposit, Withdrawal, AuditLog } = require('../models/index');
const { Wallet, WalletLedger } = require('../models/Wallet');
const { BonusWallet } = require('../models/BonusWallet');
const { KycDocument } = require('../models/Compliance');
const { FreezeRequest } = require('../models/Audit');
const TradingAccount = require('../models/TradingAccount');
const { asyncHandler, sendSuccess, AppError } = require('../utils/errors');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (f) => ({ $convert: { input: f, to: 'double', onError: 0, onNull: 0 } });
const nameOf = (u) => (u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : '—');
const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN', 'MANAGER', 'FINANCIAL_ADMIN', 'DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'];
const periodStart = (p) => {
  const d = new Date();
  if (p === 'daily') d.setDate(d.getDate() - 1);
  else if (p === 'monthly') d.setDate(d.getDate() - 30);
  else d.setDate(d.getDate() - 7); // weekly default
  return d;
};

// ── Overview: suspicious-activity summary ─────────────────────────────
const overview = asyncHandler(async (req, res) => {
  const since24 = new Date(Date.now() - 86400000);
  const [flagged, pendingFreezes, pendingKyc, ipGroups, depCount, wdCount, anomalies] = await Promise.all([
    User.countDocuments({ 'auditFlag.flagged': true }),
    FreezeRequest.countDocuments({ status: 'PENDING' }),
    User.countDocuments({ kycStatus: 'PENDING' }),
    User.aggregate([
      { $match: { lastLoginIp: { $nin: [null, ''] } } },
      { $group: { _id: '$lastLoginIp', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }, { $count: 'c' },
    ]),
    Deposit.countDocuments({ status: 'CONFIRMED', createdAt: { $gte: since24 } }),
    Withdrawal.countDocuments({ status: 'COMPLETED', createdAt: { $gte: since24 } }),
    Position.countDocuments({ status: 'CLOSED', $expr: { $gt: [{ $abs: num('$realizedPnl') }, 1000] } }),
  ]);
  sendSuccess(res, {
    flaggedUsers: flagged,
    pendingFreezeRequests: pendingFreezes,
    pendingKyc,
    sharedIpGroups: ipGroups[0]?.c || 0,
    deposits24h: depCount,
    withdrawals24h: wdCount,
    pnlAnomalies: anomalies,
  });
});

// ── Random deposit / withdrawal audits ────────────────────────────────
const randomDeposits = asyncHandler(async (req, res) => {
  const n = Math.min(50, Math.max(1, Number(req.query.n) || 10));
  const rows = await Deposit.aggregate([
    { $match: { status: req.query.status || 'CONFIRMED' } },
    { $sample: { size: n } },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
    { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
    { $project: { baseAmount: 1, currency: 1, amount: 1, method: 1, status: 1, txReference: 1, createdAt: 1, confirmedAt: 1, 'u.email': 1, 'u.firstName': 1, 'u.lastName': 1, 'u.userUid': 1, 'u._id': 1 } },
  ]);
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, amount: round2(r.baseAmount), currency: r.currency, method: r.method, status: r.status,
    txReference: r.txReference, at: r.confirmedAt || r.createdAt,
    user: { _id: r.u?._id, name: nameOf(r.u), email: r.u?.email, userUid: r.u?.userUid },
  })));
});

const randomWithdrawals = asyncHandler(async (req, res) => {
  const n = Math.min(50, Math.max(1, Number(req.query.n) || 10));
  const rows = await Withdrawal.aggregate([
    { $match: { status: req.query.status || 'COMPLETED' } },
    { $sample: { size: n } },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
    { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
    { $project: { baseAmount: 1, currency: 1, amount: 1, fee: 1, status: 1, createdAt: 1, 'u.email': 1, 'u.firstName': 1, 'u.lastName': 1, 'u.userUid': 1, 'u._id': 1 } },
  ]);
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, amount: round2(r.baseAmount), fee: round2(r.fee), currency: r.currency, status: r.status, at: r.createdAt,
    user: { _id: r.u?._id, name: nameOf(r.u), email: r.u?.email, userUid: r.u?.userUid },
  })));
});

// ── Multi-account detection (shared IP / phone) ───────────────────────
const multiAccount = asyncHandler(async (req, res) => {
  const by = req.query.by === 'phone' ? 'phone' : 'lastLoginIp';
  const groups = await User.aggregate([
    { $match: { [by]: { $nin: [null, ''] } } },
    { $group: { _id: `$${by}`, users: { $push: { _id: '$_id', name: { $concat: [{ $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] }] }, email: '$email', userUid: '$userUid', kyc: '$kycStatus', active: '$isActive' } }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 100 },
  ]);
  sendSuccess(res, groups.map((g) => ({ key: g._id, by, count: g.n, users: g.users })));
});

// ── Wash-trading suspicion (rapid round-trips) ────────────────────────
const washTrading = asyncHandler(async (req, res) => {
  const maxMs = (Number(req.query.minutes) || 5) * 60000;
  const rows = await Position.aggregate([
    { $match: { status: 'CLOSED', openedAt: { $ne: null }, closedAt: { $ne: null } } },
    { $addFields: { durMs: { $subtract: ['$closedAt', '$openedAt'] } } },
    { $match: { durMs: { $lte: maxMs } } },
    { $group: { _id: '$userId', rapidTrades: { $sum: 1 }, symbols: { $addToSet: '$symbol' }, pnl: { $sum: num('$realizedPnl') } } },
    { $match: { rapidTrades: { $gte: Number(req.query.min) || 5 } } },
    { $sort: { rapidTrades: -1 } },
    { $limit: 50 },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
  ]);
  sendSuccess(res, rows.map((r) => ({
    user: { _id: r._id, name: nameOf(r.u), email: r.u?.email, userUid: r.u?.userUid },
    rapidTrades: r.rapidTrades, symbols: r.symbols.length, netPnl: round2(r.pnl),
  })));
});

// ── Large profit / loss anomalies ─────────────────────────────────────
const pnlAnomalies = asyncHandler(async (req, res) => {
  const threshold = Number(req.query.threshold) || 1000;
  const rows = await Position.aggregate([
    { $match: { status: 'CLOSED' } },
    { $addFields: { pnl: num('$realizedPnl') } },
    { $match: { $expr: { $gt: [{ $abs: '$pnl' }, threshold] } } },
    { $sort: { pnl: -1 } },
    { $limit: 100 },
    { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
    { $unwind: { path: '$u', preserveNullAndEmptyArrays: true } },
    { $project: { symbol: 1, side: 1, quantity: 1, pnl: 1, closedAt: 1, 'u._id': 1, 'u.email': 1, 'u.firstName': 1, 'u.lastName': 1, 'u.userUid': 1 } },
  ]);
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, symbol: r.symbol, side: r.side, qty: Number(r.quantity), pnl: round2(r.pnl), at: r.closedAt,
    user: { _id: r.u?._id, name: nameOf(r.u), email: r.u?.email, userUid: r.u?.userUid },
  })));
});

// ── Bonus abuse signals (bonus credited, little/no trading) ───────────
const bonusAbuse = asyncHandler(async (req, res) => {
  const wallets = await BonusWallet.aggregate([
    { $addFields: { bal: num('$balance') } },
    { $match: { bal: { $gt: 0 } } },
    { $sort: { bal: -1 } },
    { $limit: 100 },
  ]);
  const ids = wallets.map((w) => w.userId);
  const [users, tradeAgg] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('email firstName lastName userUid kycStatus isActive').lean(),
    Position.aggregate([{ $match: { userId: { $in: ids }, status: 'CLOSED' } }, { $group: { _id: '$userId', trades: { $sum: 1 } } }]),
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const tMap = new Map(tradeAgg.map((t) => [String(t._id), t.trades]));
  sendSuccess(res, wallets.map((w) => {
    const u = uMap.get(String(w.userId)); const trades = tMap.get(String(w.userId)) || 0;
    return { user: { _id: w.userId, name: nameOf(u), email: u?.email, userUid: u?.userUid }, bonusBalance: round2(w.bal), trades, suspect: trades === 0 };
  }));
});

// ── KYC verification review queue ─────────────────────────────────────
const kycReview = asyncHandler(async (req, res) => {
  const status = req.query.status || 'PENDING';
  const users = await User.find({ kycStatus: status })
    .select('email firstName lastName userUid kycStatus country phone createdAt').sort({ createdAt: -1 }).limit(200).lean();
  const docs = await KycDocument.aggregate([{ $match: { userId: { $in: users.map((u) => u._id) } } }, { $group: { _id: '$userId', docs: { $sum: 1 } } }]);
  const dMap = new Map(docs.map((d) => [String(d._id), d.docs]));
  sendSuccess(res, users.map((u) => ({
    _id: u._id, name: nameOf(u), email: u.email, userUid: u.userUid, kyc: u.kycStatus, country: u.country, phone: u.phone, docs: dMap.get(String(u._id)) || 0, at: u.createdAt,
  })));
});

// ── Manager / Admin activity audit (from AuditLog) ────────────────────
const activity = asyncHandler(async (req, res) => {
  const q = { actorRole: { $in: STAFF_ROLES } };
  if (req.query.action) q.action = req.query.action;
  if (req.query.role) q.actorRole = req.query.role;
  const rows = await AuditLog.find(q).sort({ createdAt: -1 }).limit(200)
    .populate('actorId', 'email firstName lastName userUid').lean();
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, action: r.action, actorRole: r.actorRole, actor: nameOf(r.actorId), actorEmail: r.actorId?.email,
    targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, ip: r.ip, at: r.createdAt,
  })));
});

// ── Manual balance-adjustment audit ───────────────────────────────────
const balanceAdjustments = asyncHandler(async (req, res) => {
  const rows = await AuditLog.find({ action: 'BALANCE_ADJUSTMENT' }).sort({ createdAt: -1 }).limit(200)
    .populate('actorId', 'email firstName lastName').lean();
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, by: nameOf(r.actorId), byEmail: r.actorId?.email, actorRole: r.actorRole,
    amount: round2(r.metadata?.amount), reason: r.metadata?.reason, targetId: r.targetId, at: r.createdAt,
  })));
});

// ── Deep user inspection ──────────────────────────────────────────────
const inspectUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .select('-passwordHash -twoFactorSecret').lean();
  if (!user) throw new AppError('User not found', 404);
  const [accounts, wallets, positions, deposits, withdrawals, kycDocs, sharedIp] = await Promise.all([
    TradingAccount.find({ userId: user._id }).lean(),
    Wallet.find({ userId: user._id }).lean(),
    Position.find({ userId: user._id, status: 'CLOSED' }).sort({ closedAt: -1 }).limit(20).lean(),
    Deposit.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
    Withdrawal.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
    KycDocument.find({ userId: user._id }).select('docType status createdAt').lean(),
    user.lastLoginIp ? User.find({ lastLoginIp: user.lastLoginIp, _id: { $ne: user._id } }).select('email userUid firstName lastName').limit(20).lean() : [],
  ]);

  // Wallet balance verification: recorded balance vs sum of its ledger.
  const walletChecks = [];
  for (const w of wallets) {
    const led = await WalletLedger.aggregate([{ $match: { walletId: w._id } }, { $group: { _id: null, sum: { $sum: num('$amount') } } }]);
    const expected = round2(led[0]?.sum || 0);
    const recorded = round2(w.balance);
    walletChecks.push({ currency: w.currency, recorded, expected, ok: Math.abs(recorded - expected) < 0.01 });
  }

  sendSuccess(res, {
    user: {
      _id: user._id, name: nameOf(user), email: user.email, userUid: user.userUid, phone: user.phone, country: user.country,
      kyc: user.kycStatus, isActive: user.isActive, role: user.role, userGroup: user.userGroup,
      lastLoginAt: user.lastLoginAt, lastLoginIp: user.lastLoginIp, createdAt: user.createdAt, auditFlag: user.auditFlag || null,
    },
    accounts: accounts.map((a) => ({ _id: a._id, accountNumber: a.accountNumber, accountType: a.accountType, status: a.status, leverage: a.leverage })),
    walletChecks,
    devices: (user.refreshTokens || []).map((t) => ({ device: t.deviceInfo, at: t.createdAt })),
    sharedIpUsers: sharedIp.map((u) => ({ _id: u._id, name: nameOf(u), email: u.email, userUid: u.userUid })),
    trades: positions.map((p) => ({ symbol: p.symbol, side: p.side, qty: Number(p.quantity), pnl: round2(p.realizedPnl), openedAt: p.openedAt, closedAt: p.closedAt })),
    deposits: deposits.map((d) => ({ amount: round2(d.baseAmount), status: d.status, method: d.method, at: d.createdAt })),
    withdrawals: withdrawals.map((w) => ({ amount: round2(w.baseAmount), status: w.status, at: w.createdAt })),
    kycDocs: kycDocs.map((k) => ({ docType: k.docType, status: k.status, at: k.createdAt })),
  });
});

// ── Flag / unflag a user ──────────────────────────────────────────────
const flagUser = asyncHandler(async (req, res) => {
  const { reason, category } = req.body;
  if (!reason || !String(reason).trim()) throw new AppError('reason is required', 400);
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  user.auditFlag = { flagged: true, reason: String(reason).trim(), category: category || 'OTHER', flaggedByEmail: req.user.email, flaggedAt: new Date() };
  await user.save();
  await AuditLog.create({ actorId: req.user._id, actorRole: req.user.role, action: 'AUDIT_FLAG', targetType: 'USER', targetId: String(user._id), metadata: { reason, category } });
  sendSuccess(res, { flagged: true });
});

const unflagUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new AppError('User not found', 404);
  user.auditFlag = { flagged: false };
  await user.save();
  await AuditLog.create({ actorId: req.user._id, actorRole: req.user.role, action: 'AUDIT_UNFLAG', targetType: 'USER', targetId: String(user._id) });
  sendSuccess(res, { flagged: false });
});

const flaggedUsers = asyncHandler(async (req, res) => {
  const rows = await User.find({ 'auditFlag.flagged': true })
    .select('email firstName lastName userUid kycStatus isActive auditFlag').sort({ 'auditFlag.flaggedAt': -1 }).limit(200).lean();
  sendSuccess(res, rows.map((u) => ({ _id: u._id, name: nameOf(u), email: u.email, userUid: u.userUid, kyc: u.kycStatus, active: u.isActive, flag: u.auditFlag })));
});

// ── Account freeze requests ───────────────────────────────────────────
const createFreezeRequest = asyncHandler(async (req, res) => {
  const { userId, reason, category } = req.body;
  if (!userId || !mongoose.isValidObjectId(userId)) throw new AppError('valid userId required', 400);
  if (!reason || !String(reason).trim()) throw new AppError('reason is required', 400);
  const target = await User.findById(userId).select('_id').lean();
  if (!target) throw new AppError('User not found', 404);
  const existing = await FreezeRequest.findOne({ userId, status: 'PENDING' });
  if (existing) throw new AppError('A pending freeze request already exists for this user', 409);
  const fr = await FreezeRequest.create({ userId, reason: String(reason).trim(), category: category || 'OTHER', requestedByEmail: req.user.email });
  sendSuccess(res, { _id: fr._id });
});

const listFreezeRequests = asyncHandler(async (req, res) => {
  const q = {}; if (req.query.status) q.status = req.query.status;
  const rows = await FreezeRequest.find(q).sort({ createdAt: -1 }).limit(200)
    .populate('userId', 'email firstName lastName userUid isActive').lean();
  sendSuccess(res, rows.map((r) => ({
    _id: r._id, status: r.status, reason: r.reason, category: r.category, requestedBy: r.requestedByEmail,
    reviewedBy: r.reviewedByEmail, reviewNote: r.reviewNote, at: r.createdAt, reviewedAt: r.reviewedAt,
    user: { _id: r.userId?._id, name: nameOf(r.userId), email: r.userId?.email, userUid: r.userId?.userUid, active: r.userId?.isActive },
  })));
});

// Approve/reject — SUPER_ADMIN only (approving actually freezes the account).
const reviewFreezeRequest = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') throw new AppError('Only Super Admin can action freeze requests', 403, 'FORBIDDEN');
  const { decision, note } = req.body; // 'APPROVE' | 'REJECT'
  const fr = await FreezeRequest.findById(req.params.id);
  if (!fr) throw new AppError('Request not found', 404);
  if (fr.status !== 'PENDING') throw new AppError('Request already reviewed', 409);
  fr.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  fr.reviewedByEmail = req.user.email; fr.reviewedAt = new Date(); fr.reviewNote = note || '';
  await fr.save();
  if (fr.status === 'APPROVED') {
    await User.updateOne({ _id: fr.userId }, { $set: { isActive: false } });
    await AuditLog.create({ actorId: req.user._id, actorRole: req.user.role, action: 'ACCOUNT_FROZEN', targetType: 'USER', targetId: String(fr.userId), metadata: { reason: fr.reason, freezeRequestId: String(fr._id) } });
  }
  sendSuccess(res, { status: fr.status });
});

// ── Daily / Weekly / Monthly audit report ─────────────────────────────
const report = asyncHandler(async (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'weekly';
  const since = periodStart(period);
  const range = { $gte: since };
  const [dep, wd, newUsers, newFlags, freezes, adjustments, kycApproved, kycRejected] = await Promise.all([
    Deposit.aggregate([{ $match: { status: 'CONFIRMED', createdAt: range } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: num('$baseAmount') } } }]),
    Withdrawal.aggregate([{ $match: { status: 'COMPLETED', createdAt: range } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: num('$baseAmount') } } }]),
    User.countDocuments({ createdAt: range }),
    User.countDocuments({ 'auditFlag.flagged': true, 'auditFlag.flaggedAt': range }),
    FreezeRequest.countDocuments({ createdAt: range }),
    AuditLog.aggregate([{ $match: { action: 'BALANCE_ADJUSTMENT', createdAt: range } }, { $group: { _id: null, n: { $sum: 1 }, sum: { $sum: num('$metadata.amount') } } }]),
    AuditLog.countDocuments({ action: 'KYC_APPROVED', createdAt: range }),
    AuditLog.countDocuments({ action: 'KYC_REJECTED', createdAt: range }),
  ]);
  sendSuccess(res, {
    period, from: since, to: new Date(),
    deposits: { count: dep[0]?.n || 0, amount: round2(dep[0]?.sum || 0) },
    withdrawals: { count: wd[0]?.n || 0, amount: round2(wd[0]?.sum || 0) },
    newUsers,
    newFlags,
    freezeRequests: freezes,
    balanceAdjustments: { count: adjustments[0]?.n || 0, amount: round2(adjustments[0]?.sum || 0) },
    kycApproved, kycRejected,
  });
});

module.exports = {
  overview, randomDeposits, randomWithdrawals, multiAccount, washTrading, pnlAnomalies, bonusAbuse,
  kycReview, activity, balanceAdjustments, inspectUser, flagUser, unflagUser, flaggedUsers,
  createFreezeRequest, listFreezeRequests, reviewFreezeRequest, report,
};
