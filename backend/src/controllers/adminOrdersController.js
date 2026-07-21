/**
 * Admin Orders Management — institutional dealing-desk controller.
 *
 * In this platform a FILLED order becomes a Position, so:
 *   • "Open Orders"   → Positions  (status OPEN)
 *   • "Pending Orders"→ Orders     (status PENDING / PARTIALLY_FILLED)
 *   • "Closed Orders" → Positions  (status CLOSED)
 *
 * Scope:
 *   • SUPER_ADMIN / ADMIN → platform-wide (monitor all activity)
 *   • MANAGER             → only their own users (managerId), view + SL/TP only
 *
 * Every mutation is written to the AuditLog (who / what / before → after / IP).
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Position = require('../models/Position');
const Trade = require('../models/Trade');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const User = require('../models/User');
const { AuditLog } = require('../models');
const orderRouter = require('../services/orderRouter.service');
const walletService = require('../services/walletService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { ORDER_TYPE, ORDER_STATUS, POSITION_STATUS, ROLES, ACCOUNT_TYPES } = require('../config/constants');
const { gt, mul, div, sub } = require('../utils/decimal');

/* ────────────────────────── helpers ────────────────────────── */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (v, d = 2) => { const p = 10 ** d; return Math.round((num(v) + Number.EPSILON) * p) / p; };
const isManage = (req) => req.user.role === ROLES.SUPER_ADMIN || req.user.role === ROLES.ADMIN;

function requireManage(req) {
  if (!isManage(req)) {
    throw new AppError('Managers cannot perform this action — view & SL/TP only.', 403, 'FORBIDDEN');
  }
}

// Resolve the end-user ids in the caller's scope.
//   SUPER_ADMIN → null  (no user filter — platform-wide)
//   ADMIN       → [ids] (their hierarchy subtree, by adminId)
//   MANAGER     → [ids] (only users whose managerId === manager)
async function scopeUserIds(req) {
  if (req.user.role === ROLES.MANAGER) {
    const users = await User.find({ managerId: req.user._id, role: ROLES.USER }).select('_id').lean();
    return users.map((u) => u._id);
  }
  if (req.user.role === ROLES.ADMIN) {
    const users = await User.find({ adminId: req.user._id }).select('_id').lean();
    return users.map((u) => u._id);
  }
  return null;
}

// Managers/Admins may only touch positions/orders belonging to their own users.
async function assertInScope(req, ownerUserId) {
  if (req.user.role === ROLES.MANAGER) {
    const ok = await User.exists({ _id: ownerUserId, managerId: req.user._id });
    if (!ok) throw new AppError('This order is outside your assigned users.', 403, 'FORBIDDEN');
  } else if (req.user.role === ROLES.ADMIN) {
    const ok = await User.exists({ _id: ownerUserId, adminId: req.user._id });
    if (!ok) throw new AppError('This order is outside your assigned users.', 403, 'FORBIDDEN');
  }
}

async function audit(req, action, targetId, metadata = {}) {
  try {
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role,
      action, targetType: 'ORDER', targetId: targetId != null ? String(targetId) : undefined,
      metadata, ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

// symbol → lastPrice (and meta) for a list of symbols.
async function priceMap(symbols) {
  const uniq = [...new Set(symbols.filter(Boolean))];
  if (!uniq.length) return new Map();
  const insts = await Instrument.find({ symbol: { $in: uniq } })
    .select('symbol lastPrice quoteCurrency pricePrecision').lean();
  return new Map(insts.map((i) => [i.symbol, i]));
}

const floatingPnl = (pos, mark) =>
  pos.side === 'BUY' ? (mark - num(pos.entryPrice)) * num(pos.quantity)
                     : (num(pos.entryPrice) - mark) * num(pos.quantity);

// Hydrate a list of positions/orders with user + account display fields.
async function attachOwners(rows) {
  const userIds = [...new Set(rows.map((r) => String(r.userId)))];
  const acctIds = [...new Set(rows.map((r) => String(r.accountId)))];
  const [users, accts] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('firstName lastName email userUid').lean(),
    TradingAccount.find({ _id: { $in: acctIds } }).select('accountNumber accountType baseCurrency').lean(),
  ]);
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const aMap = new Map(accts.map((a) => [String(a._id), a]));
  return { uMap, aMap };
}
const userName = (u) => (u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : '—');

/* ────────────── shared filter builders ────────────── */

// Resolve user search + account number/type + order-id into match fragments,
// merged with the caller's scope. Returns { filter, idExpr } — `filter` holds
// userId/accountId/_id constraints; `idExpr` is a raw $expr (order-id suffix
// match) to combine via applyExprs. An empty result is forced with a sentinel
// id so callers don't need a special null-check.
const EMPTY = '000000000000000000000000';
async function resolveFilters(req, scopeIds) {
  const filter = {};
  let idExpr = null;

  // ── user (id / email / name / uid), intersected with scope ──
  let userIdSet = scopeIds ? scopeIds.map(String) : null;
  const q = (req.query.user || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { userUid: rx }];
    if (/^[0-9a-fA-F]{24}$/.test(q)) or.push({ _id: q });
    const matched = await User.find({ $or: or }).select('_id').lean();
    const ids = matched.map((u) => String(u._id));
    userIdSet = userIdSet ? userIdSet.filter((id) => ids.includes(id)) : ids;
    if (!userIdSet.length) userIdSet = [EMPTY];
  }
  if (userIdSet) filter.userId = { $in: userIdSet };

  // ── account number + account type (intersected) ──
  let accIdSet = null;
  const accNo = (req.query.accountNumber || '').trim();
  if (accNo) {
    const acc = await TradingAccount.findOne({ accountNumber: accNo }).select('_id').lean();
    accIdSet = acc ? [String(acc._id)] : [EMPTY];
  }
  // Account-type filter — a specific tier, or the legacy __ALL_REAL__/__ALL_DEMO__.
  const acctType = (req.query.accountType || '').trim();
  if (acctType) {
    const typeQuery = acctType === '__ALL_REAL__'
      ? { accountType: { $nin: DEMO_TYPES } }
      : acctType === '__ALL_DEMO__'
        ? { accountType: { $in: DEMO_TYPES } }
        : { accountType: acctType.toUpperCase() };
    const accs = await TradingAccount.find(typeQuery).select('_id').lean();
    const typeIds = accs.map((a) => String(a._id));
    accIdSet = accIdSet ? accIdSet.filter((id) => typeIds.includes(id)) : typeIds;
    if (!accIdSet.length) accIdSet = [EMPTY];
  }

  // Separate Real / Demo mode filter — intersects with the above.
  const acctMode = (req.query.accountMode || '').trim().toLowerCase();
  if (acctMode === 'real' || acctMode === 'demo') {
    const modeQuery = acctMode === 'demo' ? { accountType: { $in: DEMO_TYPES } } : { accountType: { $nin: DEMO_TYPES } };
    const accs = await TradingAccount.find(modeQuery).select('_id').lean();
    const modeIds = accs.map((a) => String(a._id));
    accIdSet = accIdSet ? accIdSet.filter((id) => modeIds.includes(id)) : modeIds;
    if (!accIdSet.length) accIdSet = [EMPTY];
  }

  if (accIdSet) filter.accountId = { $in: accIdSet };

  // ── order / position id: full 24-hex → exact; else #XXXXXX ticket suffix ──
  const oidQ = (req.query.orderId || '').trim().replace(/^#/, '');
  if (oidQ) {
    if (/^[0-9a-fA-F]{24}$/.test(oidQ)) filter._id = oidQ;
    else idExpr = { $regexMatch: { input: { $toString: '$_id' }, regex: oidQ.replace(/[^0-9a-fA-F]/g, ''), options: 'i' } };
  }

  return { filter, idExpr };
}

// volume range on the stringified quantity field — returns a RAW aggregation
// condition (to be combined with other $expr conditions), or null.
function volumeExpr(req) {
  const min = req.query.minVolume != null && req.query.minVolume !== '' ? Number(req.query.minVolume) : null;
  const max = req.query.maxVolume != null && req.query.maxVolume !== '' ? Number(req.query.maxVolume) : null;
  if (min == null && max == null) return null;
  const conds = [];
  if (min != null) conds.push({ $gte: [{ $toDouble: '$quantity' }, min] });
  if (max != null) conds.push({ $lte: [{ $toDouble: '$quantity' }, max] });
  return conds.length === 1 ? conds[0] : { $and: conds };
}

// Merge raw $expr conditions onto a match object without clobbering.
function applyExprs(match, exprs) {
  const list = exprs.filter(Boolean);
  if (!list.length) return;
  match.$expr = list.length === 1 ? list[0] : { $and: list };
}

const pageOf = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
};

/* ────────────────────────── ACCOUNT TYPES (filter dropdown) ────────────────────────── */
// Real, current account tiers only — demo/legacy (DEMO / VIRTUAL / REAL /
// CUSTOM) are NOT listed individually; the "All Real" / "All Demo" group
// options in the dropdown cover them instead.
const DEMO_TYPES = ['DEMO', 'VIRTUAL'];
const HIDDEN_TYPES = new Set(['DEMO', 'VIRTUAL', 'REAL', 'CUSTOM']);
const accountTypes = asyncHandler(async (req, res) => {
  const AccountPlan = require('../models/AccountPlan');
  // Source the filter list from THREE places so a newly-created tier shows up
  // immediately (before any account uses it):
  //   1. the static enum (legacy backward-compat),
  //   2. the live AccountPlan catalogue (admin-created tiers — the real
  //      source of truth), and
  //   3. account types already present on real accounts.
  const [planCodes, inDb] = await Promise.all([
    AccountPlan.distinct('code', { isActive: true }),
    TradingAccount.distinct('accountType'),
  ]);
  const all = [...new Set([
    ...Object.values(ACCOUNT_TYPES),
    ...planCodes.filter(Boolean),
    ...inDb.filter(Boolean),
  ])].filter((t) => !HIDDEN_TYPES.has(t));
  sendSuccess(res, all);
});

/* ────────────────────────── SUMMARY CARDS ────────────────────────── */

const summary = asyncHandler(async (req, res) => {
  const scopeIds = await scopeUserIds(req);
  const posMatch = { status: POSITION_STATUS.OPEN };
  const ordMatch = { status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] } };
  const closedMatch = { status: POSITION_STATUS.CLOSED };
  if (scopeIds) { posMatch.userId = { $in: scopeIds }; ordMatch.userId = { $in: scopeIds }; closedMatch.userId = { $in: scopeIds }; }

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  // Aggregate open positions grouped by symbol/side/book so we can join price
  // once per symbol and derive notional + floating PnL exactly like the rest
  // of the platform ((mark-entry)*qty for BUY, inverse for SELL).
  const [grp, pendingCount, closedToday] = await Promise.all([
    Position.aggregate([
      { $match: posMatch },
      { $group: {
          _id: { symbol: '$symbol', side: '$side', book: '$book' },
          lots: { $sum: { $toDouble: '$quantity' } },
          entryQty: { $sum: { $multiply: [{ $toDouble: '$entryPrice' }, { $toDouble: '$quantity' }] } },
          margin: { $sum: { $toDouble: '$margin' } },
          positions: { $sum: 1 },
      } },
    ]),
    Order.countDocuments(ordMatch),
    Position.countDocuments({ ...closedMatch, closedAt: { $gte: startOfDay } }),
  ]);

  const prices = await priceMap(grp.map((g) => g._id.symbol));
  let openCount = 0, openLots = 0, floatPnl = 0, marginUsed = 0;
  let buyNotional = 0, sellNotional = 0, aExp = 0, bExp = 0;

  for (const g of grp) {
    const inst = prices.get(g._id.symbol) || {};
    const mark = num(inst.lastPrice);
    const notional = mark * g.lots;
    const pnl = g._id.side === 'BUY' ? (mark * g.lots - g.entryQty) : (g.entryQty - mark * g.lots);
    openCount += g.positions; openLots += g.lots; marginUsed += g.margin; floatPnl += pnl;
    if (g._id.side === 'BUY') buyNotional += notional; else sellNotional += notional;
    if (g._id.book === 'A_BOOK') aExp += notional; else bExp += notional;
  }

  sendSuccess(res, {
    totalOpenOrders: openCount,
    totalPendingOrders: pendingCount,
    totalClosedToday: closedToday,
    totalOpenVolume: round(openLots, 4),
    totalFloatingPnl: round(floatPnl, 2),
    totalMarginUsed: round(marginUsed, 2),
    netExposure: round(buyNotional - sellNotional, 2),
    aBookExposure: round(aExp, 2),
    bBookExposure: round(bExp, 2),
  });
});

// Resolve each row's DISPLAY fee category ('COMMISSION' | 'CHARGES') from its
// account fee type (+ instrument override). Returns _id → category. Used so a
// trade's single fee shows under exactly one column. Display metadata only.
async function feeCategoryMap(rows, aMap) {
  const out = new Map();
  if (!rows.length) return out;
  const accountFeeService = require('../services/accountFeeService');
  const symbols = [...new Set(rows.map((r) => r.symbol).filter(Boolean))];
  const insts = symbols.length
    ? await Instrument.find({ symbol: { $in: symbols } }).select('symbol commissionOverrides commissionType commissionPercent commissionPerTrade').lean()
    : [];
  const iMap = new Map(insts.map((i) => [i.symbol, i]));
  const cache = new Map();
  for (const r of rows) {
    const accountType = aMap.get(String(r.accountId))?.accountType;
    const key = `${accountType || ''}|${r.symbol}`;
    let cat = cache.get(key);
    if (cat === undefined) {
      try { cat = await accountFeeService.resolveFeeCategory({ account: { accountType }, instrument: iMap.get(r.symbol) }); }
      catch (_) { cat = 'COMMISSION'; }
      cache.set(key, cat);
    }
    out.set(String(r._id), cat);
  }
  return out;
}

/* ────────────────────────── OPEN ORDERS (positions) ────────────────────────── */

const openOrders = asyncHandler(async (req, res) => {
  const scopeIds = await scopeUserIds(req);
  const { page, limit, skip } = pageOf(req);
  const { filter, idExpr } = await resolveFilters(req, scopeIds);

  const match = { status: POSITION_STATUS.OPEN, ...filter };
  if (req.query.symbol) match.symbol = new RegExp(String(req.query.symbol), 'i');
  if (req.query.side) match.side = String(req.query.side).toUpperCase();
  if (req.query.book) match.book = String(req.query.book).toUpperCase();
  if (req.query.from || req.query.to) {
    match.openedAt = {};
    if (req.query.from) match.openedAt.$gte = new Date(req.query.from);
    if (req.query.to) match.openedAt.$lte = new Date(new Date(req.query.to).setHours(23, 59, 59, 999));
  }
  applyExprs(match, [idExpr, volumeExpr(req)]);

  const total = await Position.countDocuments(match);
  const rows = await Position.find(match).sort({ openedAt: -1 }).skip(skip).limit(limit).lean();
  const { uMap, aMap } = await attachOwners(rows);
  const prices = await priceMap(rows.map((r) => r.symbol));
  const catMap = await feeCategoryMap(rows, aMap);

  const items = rows.map((p) => {
    const inst = prices.get(p.symbol) || {};
    const mark = num(inst.lastPrice) || num(p.entryPrice);
    return {
      kind: 'position', _id: p._id,
      userId: p.userId, userName: userName(uMap.get(String(p.userId))), userUid: uMap.get(String(p.userId))?.userUid,
      accountId: p.accountId, accountNumber: aMap.get(String(p.accountId))?.accountNumber || '—',
      accountType: aMap.get(String(p.accountId))?.accountType || '—',
      symbol: p.symbol, side: p.side, positionSide: p.positionSide,
      volume: num(p.quantity), openPrice: num(p.entryPrice), currentPrice: mark,
      floatingPnl: round(floatingPnl(p, mark), 2),
      commission: num(p.commission), swap: num(p.swap),
      charges: round(num(p.commission) + num(p.swap), 2),
      feeCategory: catMap.get(String(p._id)) || 'COMMISSION',
      stopLoss: p.stopLoss != null ? num(p.stopLoss) : null,
      takeProfit: p.takeProfit != null ? num(p.takeProfit) : null,
      margin: num(p.margin), book: p.book, leverage: p.leverage,
      openTime: p.openedAt,
    };
  });
  sendSuccess(res, { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

/* ────────────────────────── PENDING ORDERS (orders) ────────────────────────── */

const pendingOrders = asyncHandler(async (req, res) => {
  const scopeIds = await scopeUserIds(req);
  const { page, limit, skip } = pageOf(req);
  const { filter, idExpr } = await resolveFilters(req, scopeIds);

  const match = { status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] }, ...filter };
  if (req.query.symbol) match.symbol = new RegExp(String(req.query.symbol), 'i');
  if (req.query.side) match.side = String(req.query.side).toUpperCase();
  if (req.query.orderType) match.type = String(req.query.orderType).toUpperCase();
  if (req.query.from || req.query.to) {
    match.createdAt = {};
    if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) match.createdAt.$lte = new Date(new Date(req.query.to).setHours(23, 59, 59, 999));
  }
  applyExprs(match, [idExpr, volumeExpr(req)]);

  const total = await Order.countDocuments(match);
  const rows = await Order.find(match).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
  const { uMap, aMap } = await attachOwners(rows);

  // A pending order carries no commission yet — it's only charged when the
  // order fills into a Position and that position is closed. So we surface an
  // ESTIMATE of the commission it will incur, using the account's fee model at
  // the order price (pnl=0). Charges = same estimate (no swap until held).
  // This is display-only; it does not change any stored value or charging logic.
  const accountFeeService = require('../services/accountFeeService');
  const symbols = [...new Set(rows.map((o) => o.symbol).filter(Boolean))];
  const instList = symbols.length ? await Instrument.find({ symbol: { $in: symbols } }).lean() : [];
  const iMap = new Map(instList.map((i) => [i.symbol, i]));

  const items = await Promise.all(rows.map(async (o) => {
    const acct = aMap.get(String(o.accountId));
    const inst = iMap.get(o.symbol);
    const px = o.price != null ? num(o.price) : (o.stopPrice != null ? num(o.stopPrice) : null);
    let commissionEst = 0;
    try {
      if (inst && acct && px != null && num(o.quantity) > 0) {
        commissionEst = round(num(await accountFeeService.computeCloseFee({
          account: { accountType: acct.accountType },
          instrument: inst,
          closeQty: num(o.quantity),
          closePrice: px,
          closePnl: 0,
        })), 2);
      }
    } catch (_) { commissionEst = 0; }
    let feeCat = 'COMMISSION';
    try { if (inst) feeCat = await accountFeeService.resolveFeeCategory({ account: { accountType: acct?.accountType }, instrument: inst }); } catch (_) { feeCat = 'COMMISSION'; }
    return {
      kind: 'order', _id: o._id,
      userId: o.userId, userName: userName(uMap.get(String(o.userId))), userUid: uMap.get(String(o.userId))?.userUid,
      accountId: o.accountId, accountNumber: aMap.get(String(o.accountId))?.accountNumber || '—',
      accountType: aMap.get(String(o.accountId))?.accountType || '—',
      symbol: o.symbol, side: o.side, orderType: o.type, status: o.status,
      entryPrice: o.price != null ? num(o.price) : (o.stopPrice != null ? num(o.stopPrice) : null),
      stopPrice: o.stopPrice != null ? num(o.stopPrice) : null,
      volume: num(o.quantity), filled: num(o.filledQuantity),
      stopLoss: o.stopLoss != null ? num(o.stopLoss) : null,
      takeProfit: o.takeProfit != null ? num(o.takeProfit) : null,
      commission: commissionEst,
      charges: commissionEst,
      commissionEstimated: true,
      feeCategory: feeCat,
      createdTime: o.createdAt,
    };
  }));
  sendSuccess(res, { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

/* ────────────────────────── CLOSED ORDERS (positions) ────────────────────────── */

const closedOrders = asyncHandler(async (req, res) => {
  const scopeIds = await scopeUserIds(req);
  const { page, limit, skip } = pageOf(req);
  const { filter, idExpr } = await resolveFilters(req, scopeIds);

  const match = { status: POSITION_STATUS.CLOSED, ...filter };
  if (req.query.symbol) match.symbol = new RegExp(String(req.query.symbol), 'i');
  if (req.query.side) match.side = String(req.query.side).toUpperCase();
  if (req.query.book) match.book = String(req.query.book).toUpperCase();
  // Status = how the trade closed (its close reason). Whitelisted so a bad
  // value can't inject an arbitrary field query.
  if (req.query.closeReason) {
    const VALID_CLOSE_REASONS = ['MANUAL', 'TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'MARGIN_STOPOUT', 'NEGATIVE_BALANCE'];
    const cr = String(req.query.closeReason).toUpperCase();
    if (VALID_CLOSE_REASONS.includes(cr)) match.closeReason = cr;
  }
  if (req.query.from || req.query.to) {
    match.closedAt = {};
    if (req.query.from) match.closedAt.$gte = new Date(req.query.from);
    if (req.query.to) match.closedAt.$lte = new Date(new Date(req.query.to).setHours(23, 59, 59, 999));
  }
  // Profit / loss filter on realized PnL (a real DB field for closed positions),
  // combined with the volume + order-id filters into a single $expr.
  let pnlExpr = null;
  if (req.query.pnl === 'profit') pnlExpr = { $gt: [{ $toDouble: '$realizedPnl' }, 0] };
  else if (req.query.pnl === 'loss') pnlExpr = { $lt: [{ $toDouble: '$realizedPnl' }, 0] };
  applyExprs(match, [pnlExpr, idExpr, volumeExpr(req)]);

  const total = await Position.countDocuments(match);
  const rows = await Position.find(match).sort({ closedAt: -1 }).skip(skip).limit(limit).lean();
  const { uMap, aMap } = await attachOwners(rows);
  const catMap = await feeCategoryMap(rows, aMap);

  const items = rows.map((p) => ({
    kind: 'position', _id: p._id,
    userId: p.userId, userName: userName(uMap.get(String(p.userId))), userUid: uMap.get(String(p.userId))?.userUid,
    accountId: p.accountId, accountNumber: aMap.get(String(p.accountId))?.accountNumber || '—',
    accountType: aMap.get(String(p.accountId))?.accountType || '—',
    symbol: p.symbol, side: p.side,
    volume: num(p.closedQuantity) > 0 ? num(p.closedQuantity) : num(p.quantity),
    openPrice: num(p.entryPrice), closePrice: num(p.closePrice),
    realizedPnl: round(num(p.realizedPnl), 2), commission: num(p.commission), swap: num(p.swap),
    charges: round(num(p.commission) + num(p.swap), 2),
    feeCategory: catMap.get(String(p._id)) || 'COMMISSION',
    book: p.book, closeReason: p.closeReason,
    openTime: p.openedAt, closeTime: p.closedAt,
  }));
  sendSuccess(res, { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

/* ────────────────────────── RISK MANAGEMENT ────────────────────────── */

const risk = asyncHandler(async (req, res) => {
  const scopeIds = await scopeUserIds(req);
  const posMatch = { status: POSITION_STATUS.OPEN };
  if (scopeIds) posMatch.userId = { $in: scopeIds };

  // Net exposure per instrument (B-book is the broker's own risk; A-book is
  // forwarded to LP so it's hedged). Long = BUY notional, Short = SELL notional.
  const grp = await Position.aggregate([
    { $match: posMatch },
    { $group: {
        _id: { symbol: '$symbol', side: '$side', book: '$book' },
        lots: { $sum: { $toDouble: '$quantity' } },
        entryQty: { $sum: { $multiply: [{ $toDouble: '$entryPrice' }, { $toDouble: '$quantity' }] } },
        positions: { $sum: 1 },
    } },
  ]);
  const prices = await priceMap(grp.map((g) => g._id.symbol));
  const bySym = {};
  for (const g of grp) {
    const inst = prices.get(g._id.symbol) || {};
    const mark = num(inst.lastPrice);
    const notional = mark * g.lots;
    const r = bySym[g._id.symbol] || (bySym[g._id.symbol] = {
      symbol: g._id.symbol, lastPrice: mark, longExposure: 0, shortExposure: 0,
      aBookNotional: 0, bBookNotional: 0, positions: 0,
    });
    if (g._id.side === 'BUY') r.longExposure += notional; else r.shortExposure += notional;
    if (g._id.book === 'A_BOOK') r.aBookNotional += notional; else r.bBookNotional += notional;
    r.positions += g.positions;
  }
  const exposures = Object.values(bySym).map((r) => {
    const net = r.longExposure - r.shortExposure;
    const hedged = Math.min(r.longExposure, r.shortExposure) * 2; // matched long/short
    const unhedged = Math.abs(net);
    const gross = r.longExposure + r.shortExposure;
    return {
      symbol: r.symbol, lastPrice: r.lastPrice,
      longExposure: round(r.longExposure), shortExposure: round(r.shortExposure),
      netExposure: round(net), hedgedVolume: round(hedged), unhedgedVolume: round(unhedged),
      aBookNotional: round(r.aBookNotional), bBookNotional: round(r.bBookNotional),
      positions: r.positions,
      direction: net > 0 ? 'NET LONG' : net < 0 ? 'NET SHORT' : 'BALANCED',
      hedgeRatio: gross > 0 ? round((hedged / gross) * 100, 1) : 0,
    };
  }).sort((a, b) => (Math.abs(b.netExposure)) - (Math.abs(a.netExposure)));

  // Floating PnL per account → top risky / largest loss & profit.
  const openPositions = await Position.find(posMatch)
    .select('accountId userId symbol side quantity entryPrice margin').lean();
  const acctAgg = {};
  for (const p of openPositions) {
    const inst = prices.get(p.symbol) || {};
    const mark = num(inst.lastPrice) || num(p.entryPrice);
    const a = acctAgg[String(p.accountId)] || (acctAgg[String(p.accountId)] = { accountId: p.accountId, userId: p.userId, floatingPnl: 0, margin: 0, positions: 0 });
    a.floatingPnl += floatingPnl(p, mark); a.margin += num(p.margin); a.positions += 1;
  }
  const acctList = Object.values(acctAgg);
  const acctIds = acctList.map((a) => a.accountId);
  const userIds = [...new Set(acctList.map((a) => String(a.userId)))];
  const [accts, users] = await Promise.all([
    TradingAccount.find({ _id: { $in: acctIds } }).select('accountNumber accountType').lean(),
    User.find({ _id: { $in: userIds } }).select('firstName lastName email').lean(),
  ]);
  const aMap = new Map(accts.map((a) => [String(a._id), a]));
  const uMap = new Map(users.map((u) => [String(u._id), u]));
  const decorate = (a) => ({
    accountId: a.accountId, accountNumber: aMap.get(String(a.accountId))?.accountNumber || '—',
    accountType: aMap.get(String(a.accountId))?.accountType, userName: userName(uMap.get(String(a.userId))),
    userId: a.userId, floatingPnl: round(a.floatingPnl), margin: round(a.margin), positions: a.positions,
  });
  const sorted = acctList.map(decorate);
  const largestLoss = [...sorted].filter((a) => a.floatingPnl < 0).sort((x, y) => x.floatingPnl - y.floatingPnl).slice(0, 10);
  const largestProfit = [...sorted].filter((a) => a.floatingPnl > 0).sort((x, y) => y.floatingPnl - x.floatingPnl).slice(0, 10);
  // "Risky" = biggest margin at work relative to floating loss.
  const topRisky = [...sorted].sort((x, y) => y.margin - x.margin).slice(0, 10);

  sendSuccess(res, { exposures, largestLoss, largestProfit, topRisky });
});

/* ────────────────────────── ORDER DETAIL DRAWER ────────────────────────── */

const detail = asyncHandler(async (req, res) => {
  const { kind, id } = req.params;
  const scopeIds = await scopeUserIds(req);

  if (kind === 'order') {
    const o = await Order.findById(id).lean();
    if (!o) throw new AppError('Order not found', 404);
    await assertInScope(req, o.userId);
    const [user, account, history, trades] = await Promise.all([
      User.findById(o.userId).select('firstName lastName email userUid').lean(),
      TradingAccount.findById(o.accountId).select('accountNumber accountType baseCurrency leverage').lean(),
      AuditLog.find({ targetType: 'ORDER', targetId: String(o._id) }).sort({ createdAt: -1 }).limit(50).lean(),
      Trade.find({ $or: [{ buyOrderId: o._id }, { sellOrderId: o._id }] }).sort({ executedAt: -1 }).limit(50).lean(),
    ]);
    const timeline = [
      { at: o.createdAt, event: 'Order created', detail: `${o.type} ${o.side} ${o.quantity} ${o.symbol}` },
      o.triggeredAt && { at: o.triggeredAt, event: 'Triggered', detail: o.triggeredPrice ? `@ ${o.triggeredPrice}` : '' },
      o.filledAt && { at: o.filledAt, event: 'Filled', detail: o.avgFillPrice ? `avg ${o.avgFillPrice}` : '' },
      o.cancelledAt && { at: o.cancelledAt, event: 'Cancelled', detail: o.rejectionReason || '' },
    ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at));
    return sendSuccess(res, { kind: 'order', order: o, user, account, timeline, history, trades });
  }

  // position
  const p = await Position.findById(id).lean();
  if (!p) throw new AppError('Position not found', 404);
  await assertInScope(req, p.userId);
  const [user, account, history, trades, stats, inst] = await Promise.all([
    User.findById(p.userId).select('firstName lastName email userUid createdAt').lean(),
    TradingAccount.findById(p.accountId).select('accountNumber accountType baseCurrency leverage internalNotes').lean(),
    AuditLog.find({ targetType: 'ORDER', targetId: String(p._id) }).sort({ createdAt: -1 }).limit(50).lean(),
    Trade.find({ symbol: p.symbol, $or: [{ buyAccountId: p.accountId }, { sellAccountId: p.accountId }] }).sort({ executedAt: -1 }).limit(20).lean(),
    userTradingStats(p.userId),
    Instrument.findById(p.instrumentId).select('symbol lastPrice pricePrecision').lean(),
  ]);
  const mark = num(inst?.lastPrice) || num(p.entryPrice);
  const live = { ...p, currentPrice: mark, floatingPnl: round(floatingPnl(p, mark), 2) };
  const timeline = [
    { at: p.openedAt, event: 'Position opened', detail: `${p.side} ${p.quantity} @ ${p.entryPrice}` },
    ...(history || []).map((h) => ({ at: h.createdAt, event: h.action, detail: JSON.stringify(h.metadata || {}) })),
    p.closedAt && { at: p.closedAt, event: 'Position closed', detail: `@ ${p.closePrice} · PnL ${p.realizedPnl}` },
  ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at));

  sendSuccess(res, { kind: 'position', position: live, user, account, timeline, history, trades, stats });
});

async function userTradingStats(userId) {
  const [open, closed, agg] = await Promise.all([
    Position.countDocuments({ userId, status: POSITION_STATUS.OPEN }),
    Position.countDocuments({ userId, status: POSITION_STATUS.CLOSED }),
    Position.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(String(userId)), status: POSITION_STATUS.CLOSED } },
      { $group: {
          _id: null,
          realized: { $sum: { $toDouble: '$realizedPnl' } },
          wins: { $sum: { $cond: [{ $gt: [{ $toDouble: '$realizedPnl' }, 0] }, 1, 0] } },
          n: { $sum: 1 },
      } },
    ]),
  ]);
  const a = agg[0] || { realized: 0, wins: 0, n: 0 };
  return {
    openPositions: open, closedPositions: closed,
    totalRealizedPnl: round(a.realized, 2),
    winRate: a.n > 0 ? round((a.wins / a.n) * 100, 1) : 0,
  };
}

/* ────────────────────────── ACTIONS ────────────────────────── */

// Modify SL/TP on an OPEN position. Allowed for managers (own users only).
const modifySLTP = asyncHandler(async (req, res) => {
  const { stopLoss, takeProfit } = req.body;
  const position = await Position.findById(req.params.id);
  if (!position) throw new AppError('Position not found', 404);
  if (position.status !== POSITION_STATUS.OPEN) throw new AppError('Position is not open', 400);
  await assertInScope(req, position.userId);

  const before = { stopLoss: position.stopLoss, takeProfit: position.takeProfit };
  if (stopLoss !== undefined) position.stopLoss = stopLoss == null || stopLoss === '' ? null : String(stopLoss);
  if (takeProfit !== undefined) position.takeProfit = takeProfit == null || takeProfit === '' ? null : String(takeProfit);
  await position.save();
  await audit(req, 'ADMIN_MODIFY_SLTP', position._id, {
    symbol: position.symbol, before, after: { stopLoss: position.stopLoss, takeProfit: position.takeProfit },
  });

  setImmediate(async () => {
    try { await require('../services/copyTradingService').onMasterSlTpChanged({ position }); } catch (_) {}
  });
  sendSuccess(res, { _id: position._id, stopLoss: position.stopLoss, takeProfit: position.takeProfit });
});

// Force-close an OPEN position at market (admin/super only). Mirrors the user
// close flow: claim OPEN→CLOSING, place opposite reduce-only market order,
// route through the configured execution path, roll back on failure.
const forceClose = asyncHandler(async (req, res) => {
  requireManage(req);
  const claimed = await Position.findOneAndUpdate(
    { _id: req.params.id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
    { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MANUAL' } },
    { new: true }
  );
  if (!claimed) {
    const ex = await Position.findById(req.params.id).lean();
    if (!ex) throw new AppError('Position not found', 404);
    if (ex.status === POSITION_STATUS.CLOSING) throw new AppError('Position is already settling', 409, 'ALREADY_SETTLING');
    if (ex.status === POSITION_STATUS.CLOSED) throw new AppError('Position is already closed', 409, 'ALREADY_CLOSED');
    throw new AppError('Position not found', 404);
  }

  const oppositeSide = claimed.side === 'BUY' ? 'SELL' : 'BUY';
  const sourcePositionSide = claimed.positionSide || (claimed.side === 'BUY' ? 'LONG' : 'SHORT');
  const order = await Order.create({
    userId: claimed.userId, accountId: claimed.accountId, instrumentId: claimed.instrumentId,
    symbol: claimed.symbol, side: oppositeSide, positionSide: sourcePositionSide,
    type: ORDER_TYPE.MARKET, quantity: claimed.quantity, leverage: claimed.leverage,
    status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
  });

  let result;
  try {
    const routed = await orderRouter.routeOrder({ order, userId: claimed.userId });
    result = routed.settledOrder;
  } catch (err) {
    await Position.updateOne(
      { _id: claimed._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.OPEN } }
    );
    throw err;
  }

  const closed = await Position.findById(claimed._id).lean();
  if (closed && closed.status === POSITION_STATUS.CLOSING && !closed.settled) {
    await Position.updateOne(
      { _id: claimed._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.OPEN } }
    );
    throw new AppError(result?.rejectionReason || 'Close order did not fill — please retry', 400, 'CLOSE_FAILED');
  }

  await audit(req, 'ADMIN_FORCE_CLOSE', claimed._id, {
    symbol: claimed.symbol, side: claimed.side, quantity: claimed.quantity,
    closePrice: closed?.closePrice, realizedPnl: closed?.realizedPnl,
  });

  setImmediate(async () => {
    try { await require('../services/copyTradingService').onMasterPositionClosed({ position: closed || claimed, realizedPnl: closed?.realizedPnl }); } catch (_) {}
  });
  try {
    const b = require('../websocket/server');
    b.notifyUser(String(claimed.userId), 'positions', { reason: 'POSITION_CLOSED', positionId: String(claimed._id) });
    b.notifyUser(String(claimed.userId), 'wallet', { reason: 'POSITION_SETTLEMENT', positionId: String(claimed._id) });
  } catch (_) {}

  sendSuccess(res, { position: closed });
});

// Reclassify a position's risk book (A_BOOK ↔ B_BOOK). This feeds the live
// exposure dashboard (B-book = broker risk, A-book = hedged/LP).
const transferBook = asyncHandler(async (req, res) => {
  requireManage(req);
  const target = String(req.body.book || '').toUpperCase();
  if (!['A_BOOK', 'B_BOOK'].includes(target)) throw new AppError('book must be A_BOOK or B_BOOK', 400);
  const position = await Position.findById(req.params.id);
  if (!position) throw new AppError('Position not found', 404);
  if (position.status !== POSITION_STATUS.OPEN) throw new AppError('Only open positions can be moved', 400);
  const before = position.book;
  if (before === target) return sendSuccess(res, { _id: position._id, book: target, unchanged: true });
  position.book = target;
  await position.save();
  await audit(req, 'ADMIN_TRANSFER_BOOK', position._id, { symbol: position.symbol, from: before, to: target });
  sendSuccess(res, { _id: position._id, book: target });
});

// Internal comment on a position (stored in the audit trail, surfaced in drawer).
const addComment = asyncHandler(async (req, res) => {
  requireManage(req);
  const note = String(req.body.note || '').trim();
  if (!note) throw new AppError('Comment is required', 400);
  const position = await Position.findById(req.params.id).select('_id symbol userId').lean();
  if (!position) throw new AppError('Position not found', 404);
  await audit(req, 'ADMIN_ORDER_COMMENT', position._id, { symbol: position.symbol, note });
  sendSuccess(res, { ok: true });
});

// Cancel a PENDING order (admin/super). Releases the unfilled margin.
const cancelPending = asyncHandler(async (req, res) => {
  requireManage(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) {
    throw new AppError('Order cannot be cancelled', 400);
  }
  await orderRouter.routeCancel({ order });
  if (gt(order.lockedMargin || '0', '0')) {
    const rawRemaining = sub(order.quantity, order.filledQuantity || '0');
    const remaining = gt(rawRemaining, '0') ? rawRemaining : '0';
    if (gt(remaining, '0')) {
      const releaseAmt = div(mul(order.lockedMargin, remaining), order.quantity);
      const account = await TradingAccount.findById(order.accountId);
      await walletService.releaseMargin({
        userId: order.userId, accountId: order.accountId,
        currency: account?.baseCurrency || 'USD', amount: releaseAmt,
        orderId: order._id, note: `Admin cancel: released ${releaseAmt} for unfilled ${remaining}`,
      });
    }
  }
  await audit(req, 'ADMIN_CANCEL_ORDER', order._id, { symbol: order.symbol, type: order.type, side: order.side, quantity: order.quantity });
  sendSuccess(res, { _id: order._id, status: 'CANCELLED' });
});

// Force-execute a PENDING limit/stop order immediately at market (admin/super).
const forceExecute = asyncHandler(async (req, res) => {
  requireManage(req);
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) {
    throw new AppError('Only pending orders can be force-executed', 400);
  }
  const prevType = order.type;
  order.type = ORDER_TYPE.MARKET;
  order.price = null; order.stopPrice = null;
  order.triggeredAt = new Date();
  await order.save();

  let result;
  try {
    const routed = await orderRouter.routeOrder({ order, userId: order.userId });
    result = routed.settledOrder;
  } catch (err) {
    throw new AppError(err.message || 'Force execute failed', 400, 'EXECUTE_FAILED');
  }
  await audit(req, 'ADMIN_FORCE_EXECUTE', order._id, { symbol: order.symbol, prevType, side: order.side, quantity: order.quantity });
  sendSuccess(res, { order: result });
});

// Modify a PENDING order's price / SL / TP (admin/super).
const modifyPending = asyncHandler(async (req, res) => {
  requireManage(req);
  const { price, stopPrice, stopLoss, takeProfit } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError('Order not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) {
    throw new AppError('Only pending orders can be modified', 400);
  }
  const before = { price: order.price, stopPrice: order.stopPrice, stopLoss: order.stopLoss, takeProfit: order.takeProfit };
  if (price !== undefined) order.price = price == null || price === '' ? null : String(price);
  if (stopPrice !== undefined) order.stopPrice = stopPrice == null || stopPrice === '' ? null : String(stopPrice);
  if (stopLoss !== undefined) order.stopLoss = stopLoss == null || stopLoss === '' ? null : String(stopLoss);
  if (takeProfit !== undefined) order.takeProfit = takeProfit == null || takeProfit === '' ? null : String(takeProfit);
  await order.save();
  await audit(req, 'ADMIN_MODIFY_ORDER', order._id, { symbol: order.symbol, before, after: { price: order.price, stopPrice: order.stopPrice, stopLoss: order.stopLoss, takeProfit: order.takeProfit } });
  sendSuccess(res, { _id: order._id });
});

/* ────────────────────────── BULK ACTIONS ────────────────────────── */

const bulk = asyncHandler(async (req, res) => {
  requireManage(req);
  const { action } = req.body;
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) throw new AppError('No ids provided', 400);
  if (ids.length > 200) throw new AppError('Too many items (max 200 per bulk action)', 400);

  const results = [];
  for (const id of ids) {
    try {
      if (action === 'close') {
        await forceCloseOne(req, id);
      } else if (action === 'cancel') {
        await cancelOne(req, id);
      } else if (action === 'moveBook') {
        await moveBookOne(req, id, String(req.body.book || '').toUpperCase());
      } else if (action === 'modifySLTP') {
        await modifySLTPOne(req, id, req.body.stopLoss, req.body.takeProfit);
      } else {
        throw new AppError(`Unknown bulk action: ${action}`, 400);
      }
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  await audit(req, 'ADMIN_BULK_ORDER_ACTION', null, { action, total: ids.length, succeeded: okCount });
  sendSuccess(res, { action, total: ids.length, succeeded: okCount, failed: ids.length - okCount, results });
});

/* ── internal single-item helpers reused by bulk (no req/res envelope) ── */

async function forceCloseOne(req, id) {
  const claimed = await Position.findOneAndUpdate(
    { _id: id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
    { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MANUAL' } }, { new: true }
  );
  if (!claimed) throw new AppError('Not open', 400);
  const order = await Order.create({
    userId: claimed.userId, accountId: claimed.accountId, instrumentId: claimed.instrumentId,
    symbol: claimed.symbol, side: claimed.side === 'BUY' ? 'SELL' : 'BUY',
    positionSide: claimed.positionSide || (claimed.side === 'BUY' ? 'LONG' : 'SHORT'),
    type: ORDER_TYPE.MARKET, quantity: claimed.quantity, leverage: claimed.leverage,
    status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
  });
  try {
    await orderRouter.routeOrder({ order, userId: claimed.userId });
  } catch (err) {
    await Position.updateOne({ _id: claimed._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } }, { $set: { status: POSITION_STATUS.OPEN } });
    throw err;
  }
  const closed = await Position.findById(claimed._id).lean();
  if (closed && closed.status === POSITION_STATUS.CLOSING && !closed.settled) {
    await Position.updateOne({ _id: claimed._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } }, { $set: { status: POSITION_STATUS.OPEN } });
    throw new AppError('Did not fill', 400);
  }
  await audit(req, 'ADMIN_FORCE_CLOSE', claimed._id, { symbol: claimed.symbol, bulk: true });
}

async function cancelOne(req, id) {
  const order = await Order.findById(id);
  if (!order) throw new AppError('Not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) throw new AppError('Not cancellable', 400);
  await orderRouter.routeCancel({ order });
  if (gt(order.lockedMargin || '0', '0')) {
    const rawRemaining = sub(order.quantity, order.filledQuantity || '0');
    const remaining = gt(rawRemaining, '0') ? rawRemaining : '0';
    if (gt(remaining, '0')) {
      const releaseAmt = div(mul(order.lockedMargin, remaining), order.quantity);
      const account = await TradingAccount.findById(order.accountId);
      await walletService.releaseMargin({ userId: order.userId, accountId: order.accountId, currency: account?.baseCurrency || 'USD', amount: releaseAmt, orderId: order._id, note: 'Admin bulk cancel' });
    }
  }
  await audit(req, 'ADMIN_CANCEL_ORDER', order._id, { symbol: order.symbol, bulk: true });
}

async function moveBookOne(req, id, target) {
  if (!['A_BOOK', 'B_BOOK'].includes(target)) throw new AppError('Invalid book', 400);
  const p = await Position.findById(id);
  if (!p) throw new AppError('Not found', 404);
  if (p.status !== POSITION_STATUS.OPEN) throw new AppError('Not open', 400);
  if (p.book === target) return;
  const from = p.book; p.book = target; await p.save();
  await audit(req, 'ADMIN_TRANSFER_BOOK', p._id, { symbol: p.symbol, from, to: target, bulk: true });
}

async function modifySLTPOne(req, id, stopLoss, takeProfit) {
  const p = await Position.findById(id);
  if (!p) throw new AppError('Not found', 404);
  if (p.status !== POSITION_STATUS.OPEN) throw new AppError('Not open', 400);
  if (stopLoss !== undefined) p.stopLoss = stopLoss == null || stopLoss === '' ? null : String(stopLoss);
  if (takeProfit !== undefined) p.takeProfit = takeProfit == null || takeProfit === '' ? null : String(takeProfit);
  await p.save();
  await audit(req, 'ADMIN_MODIFY_SLTP', p._id, { symbol: p.symbol, bulk: true });
}

module.exports = {
  accountTypes,
  summary, openOrders, pendingOrders, closedOrders, risk, detail,
  modifySLTP, forceClose, transferBook, addComment,
  cancelPending, forceExecute, modifyPending, bulk,
};
