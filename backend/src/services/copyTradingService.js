/**
 * copyTradingService — copy-trading engine, scoped to COPY BOXES.
 *
 * A copy box is bound to ONE source trading account (CopyBox.accountId).
 * Followers subscribe to a box (CopyRelation.masterAccountId). Only trades
 * executed on that source account are mirrored to that box's followers —
 * trades on the master's other accounts are never copied.
 *
 * Three event hooks fired from the order flow:
 *   1. onMasterOrderFilled({ order, position }) — mirror to the box's followers
 *   2. onMasterPositionClosed({ position, realizedPnl }) — close every mirror
 *   3. onMasterSlTpChanged({ position }) — push SL/TP to mirrors
 *
 * Box management:
 *   - listEligibleAccounts(userId) — accounts that can become a box
 *   - createBox(...) / listMyBoxes / updateBox
 * Follower actions:
 *   - startCopying(...) / setStatus(...) / listMyCopies(userId)
 * Reads:
 *   - leaderboard() — public boxes
 *
 * Owner-level concerns (performance fee, Bonus-Wallet earnings) stay on the
 * user's TraderProfile so the existing earnings pipeline is untouched.
 */

const CopyRelation   = require('../models/CopyRelation');
const CopyTrade      = require('../models/CopyTrade');
const CopyBox        = require('../models/CopyBox');
const TraderProfile  = require('../models/TraderProfile');
const TradeFeedEvent = require('../models/TradeFeedEvent');
const Order          = require('../models/Order');
const Position       = require('../models/Position');
const TradingAccount = require('../models/TradingAccount');
const Instrument     = require('../models/Instrument');
const User           = require('../models/User');
const { ORDER_STATUS, POSITION_STATUS } = require('../config/constants');

const RISK_MULTIPLIER = { LOW: 0.5, MEDIUM: 1.0, HIGH: 1.5 };
const MIN_QTY_FALLBACK = 0.01;

// Human label for an account's plan/type (handles CUSTOM accounts).
const accountTypeLabel = (a) => (a?.accountType === 'CUSTOM' ? (a.customTypeName || 'CUSTOM') : (a?.accountType || ''));

// A box accepts NEW followers only while its source account is fully usable.
// Disabled / suspended / blocked / archived → no new subscriptions.
function accountAcceptsFollowers(acc) {
  if (!acc) return false;
  if (acc.isActive === false) return false;        // archived / removed
  if (acc.isTradingEnabled === false) return false; // ops/fraud freeze
  if (acc.status && acc.status !== 'ACTIVE') return false; // BLOCKED / SUSPENDED
  if (acc.planSuspendedAt) return false;            // plan downgrade suspension
  return true;
}

// Keep a box's denormalised follower count exact (count ACTIVE relations).
async function recountFollowers(masterAccountId) {
  if (!masterAccountId) return;
  const n = await CopyRelation.countDocuments({ masterAccountId, status: 'ACTIVE' });
  await CopyBox.updateOne({ accountId: masterAccountId }, { $set: { followers: n } });
}

// ── Owner profile (performance fee + earnings) ────────────────────────

async function getOrCreateProfile(userId, opts = {}) {
  let profile = await TraderProfile.findOne({ userId });
  if (!profile) {
    const user = await User.findById(userId).select('firstName lastName email').lean();
    profile = await TraderProfile.create({
      userId,
      displayName: opts.displayName
        || `${user?.firstName || ''} ${user?.lastName || ''}`.trim()
        || (user?.email?.split('@')[0]) || 'Trader',
      isPublic: !!opts.isPublic,
    });
  }
  return profile;
}

// ── Box management ────────────────────────────────────────────────────

// All of a user's active accounts + whether each already has a copy box.
async function listEligibleAccounts(userId) {
  const accounts = await TradingAccount.find({ userId, isActive: { $ne: false } })
    .select('accountNumber accountType customTypeName nickname baseCurrency isTradingEnabled status planSuspendedAt')
    .sort({ createdAt: 1 }).lean();
  const boxes = await CopyBox.find({ userId }).select('accountId isPublic').lean();
  const boxByAcc = new Map(boxes.map((b) => [String(b.accountId), b]));
  return accounts.map((a) => ({
    accountId: String(a._id),
    accountNumber: a.accountNumber,
    accountType: accountTypeLabel(a),
    nickname: a.nickname || '',
    baseCurrency: a.baseCurrency || 'USD',
    hasBox: boxByAcc.has(String(a._id)),
    isPublic: boxByAcc.get(String(a._id))?.isPublic || false,
    acceptsFollowers: accountAcceptsFollowers(a),
  }));
}

// Create (or update) the copy box for a specific source account.
async function createBox({ userId, accountId, displayName, bio, riskBadge, isPublic }) {
  const account = await TradingAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) throw new Error('Trading account not found');
  if (account.isActive === false) throw new Error('This account is inactive and cannot be a copy box.');

  // Ensure the owner has a TraderProfile (drives performance fee + earnings).
  const owner = await getOrCreateProfile(userId);

  const set = {
    userId,
    accountNumber: account.accountNumber,
    accountType: accountTypeLabel(account),
    ...(bio !== undefined ? { bio: String(bio).trim() } : {}),
    ...(riskBadge !== undefined ? { riskBadge } : {}),
    ...(isPublic !== undefined ? { isPublic: !!isPublic } : {}),
  };
  const setOnInsert = {};
  const trimmedName = displayName !== undefined ? String(displayName).trim() : '';
  // displayName must live in exactly ONE of $set / $setOnInsert (Mongo rejects
  // the same path in both). Provided name → always set it; otherwise only seed
  // a default on first insert (don't clobber an existing box's name).
  if (trimmedName) set.displayName = trimmedName;
  else setOnInsert.displayName = `${owner.displayName} · ${account.accountNumber}`;

  const update = { $set: set };
  if (Object.keys(setOnInsert).length) update.$setOnInsert = setOnInsert;

  const box = await CopyBox.findOneAndUpdate({ accountId }, update, { upsert: true, new: true });
  return box;
}

async function listMyBoxes(userId) {
  const boxes = await CopyBox.find({ userId }).sort({ createdAt: 1 }).lean();
  if (!boxes.length) return [];
  const accIds = boxes.map((b) => b.accountId);
  const accounts = await TradingAccount.find({ _id: { $in: accIds } })
    .select('isActive isTradingEnabled status planSuspendedAt').lean();
  const accById = new Map(accounts.map((a) => [String(a._id), a]));
  return boxes.map((b) => {
    const acc = accById.get(String(b.accountId));
    return {
      ...b,
      winRate: b.totalTrades ? (b.wins / b.totalTrades) * 100 : 0,
      acceptsFollowers: accountAcceptsFollowers(acc),
      accountActive: !!acc && acc.isActive !== false,
    };
  });
}

async function updateBox({ userId, boxId, displayName, bio, riskBadge, isPublic }) {
  const box = await CopyBox.findOne({ _id: boxId, userId });
  if (!box) throw new Error('Copy box not found');
  if (displayName !== undefined) box.displayName = String(displayName).trim();
  if (bio !== undefined) box.bio = String(bio).trim();
  if (riskBadge !== undefined) box.riskBadge = riskBadge;
  if (isPublic !== undefined) box.isPublic = !!isPublic;
  await box.save();
  return box;
}

// ── Master-side hooks ─────────────────────────────────────────────────

/**
 * Fan out a freshly-filled master order to the followers of the box bound to
 * the SOURCE account (order.accountId). Other accounts are never copied.
 */
async function onMasterOrderFilled({ order, position }) {
  if (!order || !position) return;
  if (position.status !== POSITION_STATUS.OPEN) return;

  // Only this account's box followers — scoped strictly by source account.
  const followers = await CopyRelation.find({
    masterAccountId: order.accountId,
    status: 'ACTIVE',
  }).lean();

  const box = await CopyBox.findOne({ accountId: order.accountId }).lean();
  const masterName = box?.displayName || 'Trader';

  // Feed event once per master action (only if this account is a box).
  if (box) {
    await TradeFeedEvent.create({
      masterId: order.userId,
      masterName,
      type:     'OPEN',
      symbol:   order.symbol,
      side:     order.side,
      qty:      String(order.quantity),
      price:    String(order.price || position.entryPrice || 0),
      note:     `${masterName} ${order.side === 'BUY' ? 'bought' : 'sold'} ${order.symbol}`,
    }).catch(() => {});
  }

  if (!followers.length) return;

  // Master equity = the SOURCE account's wallet balance (proportional base).
  const { Wallet } = require('../models/Wallet');
  const masterWallet = await Wallet.findOne({ userId: order.userId, accountId: order.accountId }).lean();
  const masterEquity = Math.max(1, Number(masterWallet?.balance || 0));

  const instrument = await Instrument.findById(order.instrumentId).lean();
  const lotStep = Number(instrument?.lotStep) || MIN_QTY_FALLBACK;

  for (const rel of followers) {
    try {
      const risk = RISK_MULTIPLIER[rel.riskLevel] || 1;
      const investment = Math.max(0, Number(rel.investment));
      const ratio = investment / masterEquity;
      const rawQty = Number(order.quantity) * ratio * risk;
      let qty = Math.floor(rawQty / lotStep) * lotStep;
      if (qty < lotStep) qty = lotStep;
      if (!Number.isFinite(qty) || qty <= 0) continue;

      const mirrorOrder = await Order.create({
        userId: rel.followerId,
        accountId: rel.followerAccountId,
        instrumentId: order.instrumentId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: 'MARKET',
        quantity: String(qty),
        leverage: order.leverage,
        stopLoss:   order.stopLoss   || undefined,
        takeProfit: order.takeProfit || undefined,
        status: ORDER_STATUS.PENDING,
      });

      const orderRouter = require('./orderRouter.service');
      const { settledOrder } = await orderRouter.routeOrder({ order: mirrorOrder, userId: rel.followerId });

      let mirrorPos = null;
      try {
        mirrorPos = await Position.findOne({
          userId: rel.followerId,
          accountId: rel.followerAccountId,
          symbol: order.symbol,
          status: POSITION_STATUS.OPEN,
        }).sort({ createdAt: -1 }).lean();
      } catch (_) {}

      await CopyTrade.create({
        relationId: rel._id,
        masterId: order.userId,
        masterAccountId: order.accountId,
        followerId: rel.followerId,
        masterOrderId: order._id,
        masterPositionId: position._id,
        followerOrderId: settledOrder?._id || mirrorOrder._id,
        followerPositionId: mirrorPos?._id,
        symbol: order.symbol,
        side: order.side,
        masterQty: String(order.quantity),
        followerQty: String(qty),
        multiplier: String(qty / Math.max(1e-12, Number(order.quantity))),
        status: 'OPEN',
      });

      await CopyRelation.updateOne({ _id: rel._id }, { $inc: { tradesCopied: 1 } });

      try {
        require('../websocket/server').notifyUser(String(rel.followerId), 'copytrading', {
          event: 'MIRROR_OPENED', masterAccountId: String(order.accountId), symbol: order.symbol, qty,
        });
      } catch (_) {}
    } catch (err) {
      console.error('[copyTrading] mirror open failed:', err.message);
      try {
        await CopyTrade.create({
          relationId: rel._id, masterId: order.userId, masterAccountId: order.accountId,
          followerId: rel.followerId, masterOrderId: order._id, masterPositionId: position._id,
          symbol: order.symbol, side: order.side, status: 'FAILED', closeReason: 'failed',
        });
      } catch (_) {}
    }
  }
}

/**
 * Master closed a position — close every linked follower mirror and roll up
 * the owning box's performance stats.
 */
async function onMasterPositionClosed({ position, realizedPnl }) {
  if (!position) return;

  const mirrors = await CopyTrade.find({ masterPositionId: position._id, status: 'OPEN' });

  // Box stats + feed (keyed by the SOURCE account).
  try {
    const box = await CopyBox.findOne({ accountId: position.accountId });
    if (box) {
      const pnl = Number(realizedPnl) || 0;
      box.totalTrades += 1;
      if (pnl > 0) box.wins += 1;
      box.cumulativePnl = String((Number(box.cumulativePnl) || 0) + pnl);
      const init = Math.max(1, Number(box.initialEquity));
      box.roiPct = (Number(box.cumulativePnl) / init) * 100;
      await box.save();

      const pctMove = position.entryPrice && position.closePrice
        ? (((Number(position.closePrice) - Number(position.entryPrice)) / Number(position.entryPrice)) * 100 * (position.side === 'BUY' ? 1 : -1))
        : null;
      await TradeFeedEvent.create({
        masterId: position.userId,
        masterName: box.displayName,
        type:    'CLOSE',
        symbol:  position.symbol,
        side:    position.side,
        qty:     String(position.quantity),
        price:   String(position.closePrice || position.entryPrice || 0),
        pnl:     String(pnl),
        pctMove: pctMove != null ? pctMove.toFixed(2) : null,
        note:    `${position.symbol} trade closed ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`,
      });
    }
  } catch (_) {}

  const copyEarnings = require('./copyEarningsService');

  for (const mirror of mirrors) {
    try {
      if (!mirror.followerPositionId) {
        mirror.status = 'CLOSED';
        mirror.closeReason = 'master_closed';
        mirror.closedAt = new Date();
        await mirror.save();
        continue;
      }
      const followerPos = await Position.findOneAndUpdate(
        { _id: mirror.followerPositionId, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'COPY_MASTER_CLOSED' } },
        { new: true }
      );
      if (!followerPos) {
        mirror.status = 'CLOSED';
        mirror.closeReason = 'already_closed';
        mirror.closedAt = new Date();
        try {
          const settled = await Position.findById(mirror.followerPositionId).select('realizedPnl').lean();
          if (settled && settled.realizedPnl != null) mirror.realizedPnl = String(settled.realizedPnl);
        } catch (_) {}
        await mirror.save();
        await copyEarnings.applyPerformanceFee(mirror);
        continue;
      }
      const oppositeSide = followerPos.side === 'BUY' ? 'SELL' : 'BUY';
      const sourcePositionSide = followerPos.positionSide || (followerPos.side === 'BUY' ? 'LONG' : 'SHORT');
      const closeOrd = await Order.create({
        userId: followerPos.userId,
        accountId: followerPos.accountId,
        instrumentId: followerPos.instrumentId,
        symbol: followerPos.symbol,
        side: oppositeSide,
        positionSide: sourcePositionSide,
        type: 'MARKET',
        quantity: followerPos.quantity,
        leverage: followerPos.leverage,
        status: ORDER_STATUS.PENDING,
        closeOnly: true,
        reduceOnly: true,
      });
      const orderRouter = require('./orderRouter.service');
      await orderRouter.routeOrder({ order: closeOrd, userId: followerPos.userId });

      mirror.status = 'CLOSED';
      mirror.closeReason = 'master_closed';
      mirror.closedAt = new Date();
      try {
        const settled = await Position.findById(mirror.followerPositionId).select('realizedPnl').lean();
        if (settled && settled.realizedPnl != null) mirror.realizedPnl = String(settled.realizedPnl);
      } catch (_) {}
      await mirror.save();

      await copyEarnings.applyPerformanceFee(mirror);

      try {
        require('../websocket/server').notifyUser(String(mirror.followerId), 'copytrading', {
          event: 'MIRROR_CLOSED', symbol: followerPos.symbol,
        });
      } catch (_) {}
    } catch (err) {
      console.error('[copyTrading] mirror close failed:', err.message);
    }
  }
}

async function onMasterSlTpChanged({ position }) {
  if (!position) return;
  const mirrors = await CopyTrade.find({ masterPositionId: position._id, status: 'OPEN' });
  for (const m of mirrors) {
    if (!m.followerPositionId) continue;
    try {
      const rel = await CopyRelation.findById(m.relationId).lean();
      if (!rel || rel.status !== 'ACTIVE' || !rel.syncSlTp) continue;
      await Position.updateOne(
        { _id: m.followerPositionId, status: POSITION_STATUS.OPEN },
        { $set: {
            stopLoss:   position.stopLoss   ? String(position.stopLoss)   : null,
            takeProfit: position.takeProfit ? String(position.takeProfit) : null,
          } }
      );
    } catch (_) {}
  }
}

// ── Public read APIs ─────────────────────────────────────────────────

// Leaderboard of PUBLIC copy boxes, each with its linked account + owner.
// `excludeUserId` hides the viewer's own boxes (they live in "My boxes" and
// you can't copy yourself).
async function leaderboard({ limit = 50, excludeUserId } = {}) {
  const q = { isPublic: true };
  if (excludeUserId) q.userId = { $ne: excludeUserId };
  const boxes = await CopyBox.find(q)
    .sort({ roiPct: -1, followers: -1, totalTrades: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
  if (!boxes.length) return [];

  const ownerIds = [...new Set(boxes.map((b) => String(b.userId)))];
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ownerIds } }).select('firstName lastName email').lean(),
    TraderProfile.find({ userId: { $in: ownerIds } }).select('userId performanceFeePercent').lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const profByUser = new Map(profiles.map((p) => [String(p.userId), p]));

  const copyEarnings = require('./copyEarningsService');
  const s = await copyEarnings.getFeeSettings();
  const effFee = (ownerId) => {
    if (!s.enabled) return 0;
    const p = profByUser.get(String(ownerId));
    let pct = p && p.performanceFeePercent != null ? Number(p.performanceFeePercent) : s.defaultFee;
    if (!Number.isFinite(pct)) pct = s.defaultFee;
    return Math.max(s.minFee, Math.min(s.maxFee, pct));
  };
  const ownerName = (u) => (u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email?.split('@')[0]) : 'Trader');

  return boxes.map((b) => ({
    ...b,
    winRate: b.totalTrades ? (b.wins / b.totalTrades) * 100 : 0,
    ownerName: ownerName(userById.get(String(b.userId))),
    performanceFeePercent: effFee(b.userId),
  }));
}

async function feed({ limit = 50 } = {}) {
  return TradeFeedEvent.find()
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

// ── Follower actions ─────────────────────────────────────────────────

async function startCopying({ followerId, masterAccountId, investment, riskLevel = 'MEDIUM', syncSlTp = true, followerAccountId }) {
  if (!masterAccountId) throw new Error('masterAccountId is required');
  const box = await CopyBox.findOne({ accountId: masterAccountId });
  if (!box) throw new Error('Copy box not found');
  if (String(box.userId) === String(followerId)) throw new Error('You cannot copy your own box');
  if (!box.isPublic) throw new Error('This copy box is private');

  // Source account must be live to accept NEW followers.
  const sourceAcc = await TradingAccount.findById(masterAccountId)
    .select('isActive isTradingEnabled status planSuspendedAt').lean();
  if (!accountAcceptsFollowers(sourceAcc)) {
    throw new Error('This copy box is not accepting new followers — the source account is disabled, suspended or archived.');
  }

  // Resolve follower account if not given.
  let accId = followerAccountId;
  if (!accId) {
    const acc = await TradingAccount.findOne({
      userId: followerId, isActive: true, accountType: { $nin: ['DEMO', 'VIRTUAL'] },
    }).sort({ createdAt: 1 });
    if (!acc) throw new Error('You need a live trading account to copy.');
    accId = acc._id;
  }
  const amount = String(Math.max(0, Number(investment) || 0));

  const rel = await CopyRelation.findOneAndUpdate(
    { followerId, masterAccountId },
    {
      $set: {
        masterId: box.userId,
        masterBoxId: box._id,
        investment: amount,
        riskLevel,
        syncSlTp: !!syncSlTp,
        followerAccountId: accId,
        status: 'ACTIVE',
        startedAt: new Date(),
        pausedAt: null,
        stoppedAt: null,
      },
    },
    { upsert: true, new: true }
  );

  await recountFollowers(masterAccountId);
  return rel;
}

async function setStatus({ followerId, relationId, status }) {
  if (!['ACTIVE', 'PAUSED', 'STOPPED'].includes(status)) throw new Error('Invalid status');
  const rel = await CopyRelation.findOne({ _id: relationId, followerId });
  if (!rel) throw new Error('Copy relation not found');
  rel.status = status;
  if (status === 'PAUSED')  rel.pausedAt  = new Date();
  if (status === 'STOPPED') rel.stoppedAt = new Date();
  if (status === 'ACTIVE')  { rel.pausedAt = null; rel.stoppedAt = null; }
  await rel.save();
  await recountFollowers(rel.masterAccountId);
  return rel;
}

async function listMyCopies(userId) {
  const relations = await CopyRelation.find({ followerId: userId }).lean();
  if (!relations.length) return [];

  const accIds = [...new Set(relations.map((r) => r.masterAccountId).filter(Boolean).map(String))];
  const boxes = await CopyBox.find({ accountId: { $in: accIds } }).lean();
  const boxByAcc = new Map(boxes.map((b) => [String(b.accountId), b]));

  const openTrades = await CopyTrade.find({
    relationId: { $in: relations.map((r) => r._id) },
    status: 'OPEN',
  }).lean();
  const tradesByRel = new Map();
  for (const t of openTrades) {
    const k = String(t.relationId);
    if (!tradesByRel.has(k)) tradesByRel.set(k, []);
    tradesByRel.get(k).push(t);
  }

  return relations.map((r) => {
    const box = boxByAcc.get(String(r.masterAccountId));
    return {
      ...r,
      master: box ? {
        displayName: box.displayName,
        accountNumber: box.accountNumber,
        accountType: box.accountType,
        riskBadge: box.riskBadge,
        roiPct: box.roiPct,
        userId: box.userId,
      } : null,
      openMirrors: tradesByRel.get(String(r._id)) || [],
    };
  });
}

module.exports = {
  getOrCreateProfile,
  // box management
  listEligibleAccounts,
  createBox,
  listMyBoxes,
  updateBox,
  // master hooks
  onMasterOrderFilled,
  onMasterPositionClosed,
  onMasterSlTpChanged,
  // read APIs
  leaderboard,
  feed,
  // follower actions
  startCopying,
  setStatus,
  listMyCopies,
};
