/**
 * copyTradingService — minimal copy-trading engine.
 *
 * Three event hooks fired from the order flow:
 *   1. onMasterOrderFilled(order, position) — mirror to active followers
 *   2. onMasterPositionClosed(position, pnl) — close every mirror
 *   3. onMasterSlTpChanged(position) — push SL/TP proportionally to mirrors
 *
 * Plus public methods used by the controller:
 *   - leaderboard()           — sorted list of public TraderProfiles
 *   - startCopying(...)       — follower → master enrolment
 *   - pauseCopying / stopCopying / resumeCopying
 *   - listMyCopies(userId)    — follower dashboard
 *   - feed({ limit })         — recent TradeFeedEvents
 *
 * Design choices:
 *   • Follower orders are placed against the follower's own oldest
 *     active TradingAccount unless they pick a specific one at copy
 *     setup (CopyRelation.followerAccountId).
 *   • Proportional sizing: followerQty = masterQty × (investment /
 *     masterEquity) × riskMultiplier. Rounded to the instrument's
 *     lot step (defaults to 0.01) and floored at the minimum tradable
 *     size.
 *   • All mirrors go through orderRouter.routeOrder — same execution
 *     path as a manual order. No special engine.
 */

const CopyRelation   = require('../models/CopyRelation');
const CopyTrade      = require('../models/CopyTrade');
const TraderProfile  = require('../models/TraderProfile');
const TradeFeedEvent = require('../models/TradeFeedEvent');
const Order          = require('../models/Order');
const Position       = require('../models/Position');
const TradingAccount = require('../models/TradingAccount');
const Instrument     = require('../models/Instrument');
const User           = require('../models/User');
const { ORDER_STATUS, POSITION_STATUS } = require('../config/constants');
const { add, sub, mul, div, gt, gte, D } = require('../utils/decimal');

const RISK_MULTIPLIER = { LOW: 0.5, MEDIUM: 1.0, HIGH: 1.5 };
const MIN_QTY_FALLBACK = 0.01;

// ── Stat helpers ──────────────────────────────────────────────────────

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

// ── Master-side hooks (called from orderRouter / orderController) ─────

/**
 * Fan out a freshly-filled master order to every ACTIVE follower.
 * Best-effort: a single follower failure (insufficient margin, blocked
 * instrument) doesn't abort the rest.
 */
async function onMasterOrderFilled({ order, position }) {
  if (!order || !position) return;
  if (position.status !== POSITION_STATUS.OPEN) return;

  const followers = await CopyRelation.find({
    masterId: order.userId,
    status: 'ACTIVE',
  }).lean();
  if (!followers.length) return;

  // Emit the FEED event once per master action.
  const masterProfile = await TraderProfile.findOne({ userId: order.userId }).lean();
  const masterName = masterProfile?.displayName || 'Trader';
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

  // Master equity estimate — used as the proportional denominator. We
  // use their primary account balance + locked margin as a cheap proxy
  // for free equity. Bad approximation? Sure — but this is MVP.
  const masterAccount = await TradingAccount.findOne({
    userId: order.userId, isActive: true,
  }).sort({ createdAt: 1 }).lean();
  const { Wallet } = require('../models/Wallet');
  const masterWallet = masterAccount
    ? await Wallet.findOne({ userId: order.userId, accountId: masterAccount._id }).lean()
    : null;
  const masterEquity = Math.max(1, Number(masterWallet?.balance || 0));

  const instrument = await Instrument.findById(order.instrumentId).lean();
  const lotStep = Number(instrument?.lotStep) || MIN_QTY_FALLBACK;

  for (const rel of followers) {
    try {
      const risk = RISK_MULTIPLIER[rel.riskLevel] || 1;
      const investment = Math.max(0, Number(rel.investment));
      const ratio = investment / masterEquity;
      const rawQty = Number(order.quantity) * ratio * risk;
      // Snap to lot step and clamp to floor.
      let qty = Math.floor(rawQty / lotStep) * lotStep;
      if (qty < lotStep) qty = lotStep;

      if (!Number.isFinite(qty) || qty <= 0) continue;

      // Mirror order — same instrument, same side, scaled qty. Always
      // MARKET so the mirror fills now instead of waiting on triggers.
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
        // Inherit SL/TP scaled by the same ratio? Simpler — copy the raw
        // prices. The trader is following the master's risk plan.
        stopLoss:   order.stopLoss   || undefined,
        takeProfit: order.takeProfit || undefined,
        status: ORDER_STATUS.PENDING,
      });

      // Route via the same router the manual flow uses.
      const orderRouter = require('./orderRouter.service');
      const { settledOrder } = await orderRouter.routeOrder({
        order: mirrorOrder,
        userId: rel.followerId,
      });

      // Find the resulting OPEN position so we can link master ↔ mirror.
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

      await CopyRelation.updateOne(
        { _id: rel._id },
        { $inc: { tradesCopied: 1 } }
      );

      // Notify the follower via WS for the live "active copies" panel.
      try {
        const wsServer = require('../websocket/server');
        wsServer.notifyUser(String(rel.followerId), 'copytrading', {
          event: 'MIRROR_OPENED',
          masterId: order.userId,
          symbol: order.symbol,
          qty,
        });
      } catch (_) {}
    } catch (err) {
      console.error('[copyTrading] mirror open failed:', err.message);
      try {
        await CopyTrade.create({
          relationId: rel._id,
          masterId: order.userId,
          followerId: rel.followerId,
          masterOrderId: order._id,
          masterPositionId: position._id,
          symbol: order.symbol,
          side: order.side,
          status: 'FAILED',
          closeReason: 'failed',
        });
      } catch (_) {}
    }
  }
}

/**
 * Master closed a position — close every linked follower mirror.
 */
async function onMasterPositionClosed({ position, realizedPnl }) {
  if (!position) return;

  const mirrors = await CopyTrade.find({
    masterPositionId: position._id,
    status: 'OPEN',
  });
  if (mirrors.length === 0 && !position) return;

  // Feed event + master profile stats.
  try {
    const profile = await TraderProfile.findOne({ userId: position.userId });
    if (profile) {
      const pnl = Number(realizedPnl) || 0;
      profile.totalTrades += 1;
      if (pnl > 0) profile.wins += 1;
      profile.cumulativePnl = String((Number(profile.cumulativePnl) || 0) + pnl);
      const init = Math.max(1, Number(profile.initialEquity));
      profile.roiPct = (Number(profile.cumulativePnl) / init) * 100;
      await profile.save();

      const pctMove = position.entryPrice && position.exitPrice
        ? (((Number(position.exitPrice) - Number(position.entryPrice)) / Number(position.entryPrice)) * 100 * (position.side === 'BUY' ? 1 : -1))
        : null;
      await TradeFeedEvent.create({
        masterId: position.userId,
        masterName: profile.displayName,
        type:    pnl >= 0 ? 'CLOSE' : 'CLOSE',
        symbol:  position.symbol,
        side:    position.side,
        qty:     String(position.quantity),
        price:   String(position.exitPrice || position.entryPrice || 0),
        pnl:     String(pnl),
        pctMove: pctMove != null ? pctMove.toFixed(2) : null,
        note:    `${position.symbol} trade closed ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`,
      });
    }
  } catch (_) {}

  for (const mirror of mirrors) {
    try {
      if (!mirror.followerPositionId) {
        mirror.status = 'CLOSED';
        mirror.closeReason = 'master_closed';
        mirror.closedAt = new Date();
        await mirror.save();
        continue;
      }
      // Try the atomic OPEN→CLOSING claim that closePosition uses.
      const followerPos = await Position.findOneAndUpdate(
        { _id: mirror.followerPositionId, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'COPY_MASTER_CLOSED' } },
        { new: true }
      );
      if (!followerPos) {
        // Position already settled — just close the link.
        mirror.status = 'CLOSED';
        mirror.closeReason = 'already_closed';
        mirror.closedAt = new Date();
        await mirror.save();
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
      await mirror.save();

      try {
        const wsServer = require('../websocket/server');
        wsServer.notifyUser(String(mirror.followerId), 'copytrading', {
          event: 'MIRROR_CLOSED',
          symbol: followerPos.symbol,
        });
      } catch (_) {}
    } catch (err) {
      console.error('[copyTrading] mirror close failed:', err.message);
    }
  }
}

/**
 * Master changed SL/TP on a position — mirror the new prices onto each
 * linked follower position (raw prices, not scaled; the follower is
 * following the master's exact targets).
 */
async function onMasterSlTpChanged({ position }) {
  if (!position) return;
  const mirrors = await CopyTrade.find({
    masterPositionId: position._id,
    status: 'OPEN',
  });
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

async function leaderboard({ limit = 50 } = {}) {
  const list = await TraderProfile.find({ isPublic: true })
    .sort({ roiPct: -1, followers: -1, totalTrades: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
  return list.map((p) => ({
    ...p,
    winRate: p.totalTrades ? (p.wins / p.totalTrades) * 100 : 0,
  }));
}

async function feed({ limit = 50 } = {}) {
  return TradeFeedEvent.find()
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

// ── Follower actions ─────────────────────────────────────────────────

async function startCopying({ followerId, masterId, investment, riskLevel = 'MEDIUM', syncSlTp = true, followerAccountId }) {
  if (String(followerId) === String(masterId)) {
    throw new Error('You cannot copy yourself');
  }
  // Resolve follower account if not given.
  let accId = followerAccountId;
  if (!accId) {
    const acc = await TradingAccount.findOne({
      userId: followerId,
      isActive: true,
      accountType: { $nin: ['DEMO', 'VIRTUAL'] },
    }).sort({ createdAt: 1 });
    if (!acc) throw new Error('You need a live trading account to copy.');
    accId = acc._id;
  }
  const amount = String(Math.max(0, Number(investment) || 0));

  const rel = await CopyRelation.findOneAndUpdate(
    { followerId, masterId },
    {
      $set: {
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

  // Maintain denormalised follower count on master profile.
  await TraderProfile.updateOne(
    { userId: masterId },
    { $inc: { followers: 1 } },
    { upsert: false }
  );

  return rel;
}

async function setStatus({ followerId, relationId, status }) {
  if (!['ACTIVE', 'PAUSED', 'STOPPED'].includes(status)) {
    throw new Error('Invalid status');
  }
  const rel = await CopyRelation.findOne({ _id: relationId, followerId });
  if (!rel) throw new Error('Copy relation not found');
  rel.status = status;
  if (status === 'PAUSED')  rel.pausedAt  = new Date();
  if (status === 'STOPPED') rel.stoppedAt = new Date();
  if (status === 'ACTIVE')  { rel.pausedAt = null; rel.stoppedAt = null; }
  await rel.save();

  if (status === 'STOPPED') {
    await TraderProfile.updateOne(
      { userId: rel.masterId },
      { $inc: { followers: -1 } },
      { upsert: false }
    );
  }
  return rel;
}

async function listMyCopies(userId) {
  const relations = await CopyRelation.find({ followerId: userId }).lean();
  if (!relations.length) return [];
  const masterIds = [...new Set(relations.map((r) => String(r.masterId)))];
  const profiles = await TraderProfile.find({ userId: { $in: masterIds } }).lean();
  const profByUser = new Map(profiles.map((p) => [String(p.userId), p]));

  // Open mirror trades per relation
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

  return relations.map((r) => ({
    ...r,
    master: profByUser.get(String(r.masterId)) || null,
    openMirrors: tradesByRel.get(String(r.relationId)) || [],
  }));
}

module.exports = {
  getOrCreateProfile,
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
