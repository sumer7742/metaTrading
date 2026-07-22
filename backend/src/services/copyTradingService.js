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
  // Count DISTINCT followers (a follower may now hold several copies of the
  // same master across different accounts — that's still one follower).
  const ids = await CopyRelation.distinct('followerId', { masterAccountId, status: 'ACTIVE' });
  await CopyBox.updateOne({ accountId: masterAccountId }, { $set: { followers: ids.length } });
}

// ── Copy allocation hold ───────────────────────────────────────────────
// Reserve (lock) the follower's investment on their funding account so it is a
// real "cut" from free balance AND a funds check (lockMargin throws when the
// follower lacks the free balance). Released when the copy is stopped.
async function _holdAllocation(rel, amount) {
  const amt = String(Math.max(0, Number(amount) || 0));
  if (!(Number(amt) > 0)) return '0';
  const walletService = require('./walletService');
  const fAcc = await TradingAccount.findById(rel.followerAccountId).select('baseCurrency').lean();
  const currency = fAcc?.baseCurrency || 'USD';
  await walletService.lockMargin({
    userId: rel.followerId, accountId: rel.followerAccountId, currency,
    amount: amt, orderId: rel._id, note: 'Copy allocation',
  });
  return amt;
}

async function _releaseAllocation(rel) {
  const held = String(rel.heldAmount || '0');
  if (!(Number(held) > 0)) return;
  const walletService = require('./walletService');
  const fAcc = await TradingAccount.findById(rel.followerAccountId).select('baseCurrency').lean();
  const currency = fAcc?.baseCurrency || 'USD';
  try {
    await walletService.releaseMargin({
      userId: rel.followerId, accountId: rel.followerAccountId, currency,
      amount: held, orderId: rel._id, note: 'Copy allocation released',
    });
  } catch (_) { /* best-effort */ }
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
  // DEMO / VIRTUAL accounts can't be a copy source — followers mirror REAL
  // trades, so practice accounts are never eligible to become a master box.
  const accounts = await TradingAccount.find({ userId, isActive: { $ne: false }, accountType: { $nin: ['DEMO', 'VIRTUAL'] } })
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

// Clamp a raw per-box fee input to the admin [minFee, maxFee] range.
//   undefined → returns undefined (caller leaves the field untouched)
//   '' / null → returns null      (clears the override → fall back to default)
//   number    → clamped number
async function clampBoxFee(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return null;
  const s = await require('./copyEarningsService').getFeeSettings();
  return Math.max(s.minFee, Math.min(s.maxFee, pct));
}

// Create (or update) the copy box for a specific source account.
async function createBox({ userId, accountId, displayName, bio, riskBadge, isPublic, performanceFeePercent }) {
  const account = await TradingAccount.findOne({ _id: accountId, userId }).lean();
  if (!account) throw new Error('Trading account not found');
  if (account.isActive === false) throw new Error('This account is inactive and cannot be a copy box.');
  // DEMO / VIRTUAL accounts can't be a copy source — followers mirror REAL trades.
  if (['DEMO', 'VIRTUAL'].includes(account.accountType)) {
    throw new Error('Demo / practice accounts cannot become a copy source.');
  }

  // Ensure the owner has a TraderProfile (drives performance fee + earnings).
  const owner = await getOrCreateProfile(userId);

  const feeVal = await clampBoxFee(performanceFeePercent);
  const set = {
    userId,
    accountNumber: account.accountNumber,
    accountType: accountTypeLabel(account),
    ...(bio !== undefined ? { bio: String(bio).trim() } : {}),
    ...(riskBadge !== undefined ? { riskBadge } : {}),
    ...(isPublic !== undefined ? { isPublic: !!isPublic } : {}),
    ...(feeVal !== undefined ? { performanceFeePercent: feeVal } : {}),
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
  const boxes = await CopyBox.find({ userId, archived: { $ne: true } }).sort({ createdAt: 1 }).lean();
  if (!boxes.length) return [];
  const accIds = boxes.map((b) => b.accountId);
  const [accounts, profile, feeS] = await Promise.all([
    TradingAccount.find({ _id: { $in: accIds } }).select('isActive isTradingEnabled status planSuspendedAt').lean(),
    TraderProfile.findOne({ userId }).select('performanceFeePercent').lean(),
    require('./copyEarningsService').getFeeSettings(),
  ]);
  const accById = new Map(accounts.map((a) => [String(a._id), a]));
  const profileFee = profile && profile.performanceFeePercent != null ? Number(profile.performanceFeePercent) : null;
  const clamp = (pct) => Math.max(feeS.minFee, Math.min(feeS.maxFee, pct));
  return boxes.map((b) => {
    const acc = accById.get(String(b.accountId));
    // Effective fee for display: box override → profile → platform default.
    let effPct = b.performanceFeePercent != null ? Number(b.performanceFeePercent)
      : (profileFee != null ? profileFee : feeS.defaultFee);
    if (!Number.isFinite(effPct)) effPct = feeS.defaultFee;
    return {
      ...b,
      winRate: b.totalTrades ? (b.wins / b.totalTrades) * 100 : 0,
      acceptsFollowers: accountAcceptsFollowers(acc),
      accountActive: !!acc && acc.isActive !== false,
      // `performanceFeePercent` (raw, may be null = "default") stays for editing;
      // `effectivePerformanceFee` is the resolved % actually charged.
      effectivePerformanceFee: feeS.enabled ? clamp(effPct) : 0,
    };
  });
}

async function updateBox({ userId, boxId, displayName, bio, riskBadge, isPublic, performanceFeePercent }) {
  const box = await CopyBox.findOne({ _id: boxId, userId });
  if (!box) throw new Error('Copy box not found');
  if (displayName !== undefined) box.displayName = String(displayName).trim();
  if (bio !== undefined) box.bio = String(bio).trim();
  if (riskBadge !== undefined) box.riskBadge = riskBadge;
  if (isPublic !== undefined) box.isPublic = !!isPublic;
  const feeVal = await clampBoxFee(performanceFeePercent);
  if (feeVal !== undefined) box.performanceFeePercent = feeVal;
  await box.save();
  return box;
}

// "Delete" a copy box → ARCHIVE it (soft delete). The record + its lifetime
// stats are kept for history; it's hidden from the owner's active list and the
// leaderboard. Active/paused followers are STOPPED cleanly first (their already-
// open mirrored trades stay open until they close on their own).
async function deleteBox({ userId, boxId }) {
  const box = await CopyBox.findOne({ _id: boxId, userId });
  if (!box) throw new Error('Copy box not found');
  const affected = await CopyRelation.find({ masterAccountId: box.accountId, status: { $in: ['ACTIVE', 'PAUSED'] } });
  for (const r of affected) {
    await _releaseAllocation(r);
    r.heldAmount = '0';
    r.status = 'STOPPED';
    r.stoppedAt = new Date();
    await r.save();
  }
  box.archived = true;
  box.archivedAt = new Date();
  box.isPublic = false; // never discoverable while archived
  await box.save();
  await recountFollowers(box.accountId);
  return { ok: true, archived: true };
}

// Bring an archived box back to the active list (stays PRIVATE until the owner
// re-publishes it). Followers were stopped on archive and don't auto-resume.
async function restoreBox({ userId, boxId }) {
  const box = await CopyBox.findOne({ _id: boxId, userId });
  if (!box) throw new Error('Copy box not found');
  box.archived = false;
  box.archivedAt = null;
  await box.save();
  return box;
}

// Permanently remove an archived box (history wiped). Only archived boxes can
// be purged — guards against accidental hard-deletes of live boxes.
async function purgeBox({ userId, boxId }) {
  const box = await CopyBox.findOne({ _id: boxId, userId });
  if (!box) throw new Error('Copy box not found');
  if (!box.archived) throw new Error('Archive the box first before deleting it permanently');
  await CopyBox.deleteOne({ _id: box._id });
  return { ok: true };
}

// Archived boxes for the history view.
async function listArchivedBoxes(userId) {
  const boxes = await CopyBox.find({ userId, archived: true }).sort({ archivedAt: -1 }).lean();
  return boxes.map((b) => ({
    ...b,
    winRate: b.totalTrades ? (b.wins / b.totalTrades) * 100 : 0,
  }));
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

  // Lot-based sizing (v2): the follower's lot is derived from the MASTER's lot
  // and their own lot settings — no master-equity / investment ratio needed.
  const instrument = await Instrument.findById(order.instrumentId).lean();
  const lotStep = Number(instrument?.lotStep) || MIN_QTY_FALLBACK;
  // Reference price for sizing + margin. No live price → we cannot safely size
  // or margin-check the mirror, so we skip the fan-out entirely for this fill.
  const refPrice = Number(instrument?.lastPrice || 0);
  if (!(refPrice > 0)) {
    console.warn('[copyTrading] no live price for', order.symbol, '— skipping mirror fan-out');
    return;
  }

  const walletService = require('./walletService');
  const orderRouter = require('./orderRouter.service');

  for (const rel of followers) {
    let currency = 'USD';
    let lockedAmt = 0;
    let mirrorOrder = null;
    try {
      // ── Lot-based sizing ────────────────────────────────────────────────
      //   baseLot = CUSTOM ? fixed customLot : masterLot × {LOW:.5,MEDIUM:1,HIGH:1.5}
      //   finalLot = clamp(baseLot × lotMultiplier × riskMultiplier, step, maxLot)
      const preset = RISK_MULTIPLIER[rel.lotMode] || 1;
      const baseLot = rel.lotMode === 'CUSTOM'
        ? Math.max(0, Number(rel.customLot) || 0)
        : Number(order.quantity) * preset;
      let lot = baseLot * (Number(rel.lotMultiplier) || 1) * (Number(rel.riskMultiplier) || 1);
      if (rel.maxLot != null && Number(rel.maxLot) > 0) lot = Math.min(lot, Number(rel.maxLot));
      let qty = Math.floor(lot / lotStep) * lotStep;
      if (qty < lotStep) qty = lotStep;
      if (!Number.isFinite(qty) || qty <= 0) continue;

      // Respect "Maximum open trades" — skip new copies once the cap is hit.
      if (rel.maxOpenTrades != null && Number(rel.maxOpenTrades) > 0) {
        const openCount = await CopyTrade.countDocuments({ relationId: rel._id, status: 'OPEN' });
        if (openCount >= Number(rel.maxOpenTrades)) continue;
      }

      // Destination account currency — used for margin locking below.
      const fAcc = await TradingAccount.findById(rel.followerAccountId).select('baseCurrency').lean();
      currency = fAcc?.baseCurrency || 'USD';

      // Required margin = (newly-opened qty × price) / leverage — mirrors the
      // normal placeOrder math. An existing opposite position reduces the new
      // exposure (that overlap is just closing, no margin needed).
      const lev = Number(order.leverage) || 1;
      let openQty = qty;
      const existingPos = await Position.findOne({
        accountId: rel.followerAccountId, symbol: order.symbol, status: POSITION_STATUS.OPEN,
      }).select('side quantity').lean();
      if (existingPos && existingPos.side !== order.side) {
        const exQty = Number(existingPos.quantity) || 0;
        openQty = exQty >= qty ? 0 : (qty - exQty);
      }
      const marginAmount = openQty > 0 ? (openQty * refPrice) / lev : 0;

      mirrorOrder = await Order.create({
        userId: rel.followerId,
        accountId: rel.followerAccountId,
        instrumentId: order.instrumentId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: 'MARKET',
        quantity: String(qty),
        leverage: order.leverage,
        stopLoss:   rel.copySL ? (order.stopLoss   || undefined) : undefined,
        takeProfit: rel.copyTP ? (order.takeProfit || undefined) : undefined,
        status: ORDER_STATUS.PENDING,
      });

      // ── Fund the trade margin from the DESTINATION account (v2) ──
      // No separate copy wallet: the mirror locks margin from the follower's
      // chosen trading account's own free balance, exactly like a normal trade.
      // If the account can't cover it, REJECT this mirror (advisory only — we
      // never touch the master or the other mirrors).
      if (marginAmount > 0) {
        try {
          await walletService.lockMargin({
            userId: rel.followerId,
            accountId: rel.followerAccountId,
            currency,
            amount: String(marginAmount),
            orderId: mirrorOrder._id,
            note: `Copy margin for ${order.side} ${order.symbol}`,
          });
          lockedAmt = marginAmount;
          mirrorOrder.lockedMargin = String(marginAmount);
          await mirrorOrder.save();
        } catch (lockErr) {
          // Destination account lacks free margin → reject this mirror only.
          mirrorOrder.status = ORDER_STATUS.REJECTED;
          mirrorOrder.rejectionReason = lockErr.message;
          await mirrorOrder.save();
          await CopyTrade.create({
            relationId: rel._id, masterId: order.userId, masterAccountId: order.accountId,
            followerId: rel.followerId, masterOrderId: order._id, masterPositionId: position._id,
            symbol: order.symbol, side: order.side, status: 'FAILED', closeReason: 'insufficient_margin',
          }).catch(() => {});
          try {
            require('../websocket/server').notifyUser(String(rel.followerId), 'copytrading', {
              event: 'MIRROR_REJECTED', reason: 'insufficient_margin', symbol: order.symbol,
            });
          } catch (_) {}
          continue; // skip routing — allocation can't fund it
        }
      }

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
      // Routing/other failure AFTER we locked margin on the mirror order →
      // release it back to the destination account's free balance.
      if (lockedAmt > 0 && mirrorOrder) {
        try {
          await walletService.releaseMargin({
            userId: rel.followerId, accountId: rel.followerAccountId, currency,
            amount: String(lockedAmt), orderId: mirrorOrder._id, note: 'Copy mirror failed',
          });
        } catch (_) {}
      }
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
  const walletService = require('./walletService');

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
      // v2: the engine releases this position's margin back to the account's
      // free balance on settle — there's no allocation to return it to.
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
      if (!rel || rel.status !== 'ACTIVE') continue;
      // Honor the per-toggle Copy SL / Copy TP settings.
      const $set = {};
      if (rel.copySL) $set.stopLoss   = position.stopLoss   ? String(position.stopLoss)   : null;
      if (rel.copyTP) $set.takeProfit = position.takeProfit ? String(position.takeProfit) : null;
      if (!Object.keys($set).length) continue;
      await Position.updateOne(
        { _id: m.followerPositionId, status: POSITION_STATUS.OPEN },
        { $set }
      );
    } catch (_) {}
  }
}

// ── Public read APIs ─────────────────────────────────────────────────

// Leaderboard of PUBLIC copy boxes, each with its linked account + owner.
// `excludeUserId` hides the viewer's own boxes (they live in "My boxes" and
// you can't copy yourself).
async function leaderboard({ limit = 50, excludeUserId } = {}) {
  const q = { isPublic: true, archived: { $ne: true } };
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
  // Per-box fee → owner profile fee → platform default (clamped).
  const effFee = (box) => {
    if (!s.enabled) return 0;
    let pct = box.performanceFeePercent != null ? Number(box.performanceFeePercent) : null;
    if (pct == null) {
      const p = profByUser.get(String(box.userId));
      pct = p && p.performanceFeePercent != null ? Number(p.performanceFeePercent) : s.defaultFee;
    }
    if (!Number.isFinite(pct)) pct = s.defaultFee;
    return Math.max(s.minFee, Math.min(s.maxFee, pct));
  };
  const ownerName = (u) => (u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email?.split('@')[0]) : 'Trader');

  return boxes.map((b) => ({
    ...b,
    winRate: b.totalTrades ? (b.wins / b.totalTrades) * 100 : 0,
    ownerName: ownerName(userById.get(String(b.userId))),
    performanceFeePercent: effFee(b),
  }));
}

async function feed({ limit = 50 } = {}) {
  return TradeFeedEvent.find()
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

// ── Follower actions ─────────────────────────────────────────────────

// Validate + clamp the follower's lot / risk settings. Shared by start + edit.
function sanitizeLotSettings(s = {}) {
  const out = {};
  const mode = String(s.lotMode || 'MEDIUM').toUpperCase();
  out.lotMode = ['LOW', 'MEDIUM', 'HIGH', 'CUSTOM'].includes(mode) ? mode : 'MEDIUM';
  if (out.lotMode === 'CUSTOM') {
    const cl = Number(s.customLot);
    if (!Number.isFinite(cl) || cl <= 0) throw new Error('Enter a custom lot size greater than 0');
    out.customLot = Math.min(1000, cl);
  } else {
    out.customLot = null;
  }
  const posOr = (v, def, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(max, n) : def; };
  out.lotMultiplier  = posOr(s.lotMultiplier, 1, 100);
  out.riskMultiplier = posOr(s.riskMultiplier, 1, 100);
  out.maxLot = (s.maxLot == null || s.maxLot === '') ? null : (Math.max(0, Number(s.maxLot) || 0) || null);
  out.maxOpenTrades = (s.maxOpenTrades == null || s.maxOpenTrades === '') ? null : (Math.max(0, Math.floor(Number(s.maxOpenTrades) || 0)) || null);
  out.copySL = s.copySL !== undefined ? !!s.copySL : true;
  out.copyTP = s.copyTP !== undefined ? !!s.copyTP : true;
  out.copyPending = !!s.copyPending;
  return out;
}

// Resolve/validate the destination trading account (must be the follower's own
// live account). Returns its _id.
async function _resolveDestAccount(followerId, followerAccountId) {
  if (followerAccountId) {
    const dest = await TradingAccount.findOne({ _id: followerAccountId, userId: followerId })
      .select('accountType isActive').lean();
    if (!dest) throw new Error('Destination account not found');
    if (['DEMO', 'VIRTUAL'].includes(dest.accountType)) throw new Error('Choose a live (real) account to copy into.');
    if (dest.isActive === false) throw new Error('That account is inactive.');
    return dest._id;
  }
  const acc = await TradingAccount.findOne({
    userId: followerId, isActive: true, accountType: { $nin: ['DEMO', 'VIRTUAL'] },
  }).sort({ createdAt: 1 });
  if (!acc) throw new Error('You need a live trading account to copy.');
  return acc._id;
}

/**
 * Start (or resume) copying a master box into one of the follower's OWN trading
 * accounts. No investment wallet — sizing is lot-based, funding comes from the
 * destination account. One session per (follower, masterAccount): a STOPPED
 * session is RESUMED in place (no duplicate); an ACTIVE/PAUSED one is blocked.
 */
async function startCopying({ followerId, masterAccountId, followerAccountId, ...settings }) {
  if (!masterAccountId) throw new Error('masterAccountId is required');
  const box = await CopyBox.findOne({ accountId: masterAccountId });
  if (!box) throw new Error('Copy box not found');
  if (String(box.userId) === String(followerId)) throw new Error('You cannot copy your own box');
  if (!box.isPublic) throw new Error('This copy box is private');

  const sourceAcc = await TradingAccount.findById(masterAccountId)
    .select('isActive isTradingEnabled status planSuspendedAt').lean();
  if (!accountAcceptsFollowers(sourceAcc)) {
    throw new Error('This copy box is not accepting new followers — the source account is disabled, suspended or archived.');
  }

  const accId = await _resolveDestAccount(followerId, followerAccountId);
  const lot = sanitizeLotSettings(settings);

  const existing = await CopyRelation.findOne({ followerId, masterAccountId });
  if (existing && existing.status !== 'STOPPED') {
    throw new Error('You are already copying this trader. Edit or resume it from "My copies".');
  }

  const doc = {
    followerId, masterId: box.userId, masterAccountId, masterBoxId: box._id,
    followerAccountId: accId, ...lot,
    status: 'ACTIVE', startedAt: new Date(), pausedAt: null, stoppedAt: null,
  };

  // Resume the STOPPED session in place (keeps history/analytics) — no duplicate.
  const rel = existing ? Object.assign(existing, doc) : new CopyRelation(doc);
  await rel.save();

  await recountFollowers(masterAccountId);
  return rel;
}

/**
 * Close every OPEN copied position for a relation (used by Stop / Change-account
 * when the follower chooses "close automatically"). Best-effort per position.
 */
async function closeCopyPositions(rel) {
  const open = await CopyTrade.find({ relationId: rel._id, status: 'OPEN' }).lean();
  if (!open.length) return { closed: 0 };
  const orderRouter = require('./orderRouter.service');
  let closed = 0;
  for (const ct of open) {
    if (!ct.followerPositionId) continue;
    try {
      const claimed = await Position.findOneAndUpdate(
        { _id: ct.followerPositionId, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MANUAL' } }, { new: true }
      );
      if (!claimed) continue;
      const closeOrder = await Order.create({
        userId: rel.followerId, accountId: rel.followerAccountId, instrumentId: claimed.instrumentId,
        symbol: claimed.symbol, side: claimed.side === 'BUY' ? 'SELL' : 'BUY',
        positionSide: claimed.positionSide || (claimed.side === 'BUY' ? 'LONG' : 'SHORT'),
        type: 'MARKET', quantity: claimed.quantity, leverage: claimed.leverage,
        status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
      });
      await orderRouter.routeOrder({ order: closeOrder, userId: rel.followerId });
      closed++;
    } catch (e) {
      console.error('[copyTrading] close copied position failed:', e.message);
      await Position.updateOne(
        { _id: ct.followerPositionId, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.OPEN } }
      ).catch(() => {});
    }
  }
  return { closed };
}

/**
 * Pause / resume / stop. PAUSE stops new copies but keeps open positions.
 * STOP (status STOPPED) optionally closes open positions; the row is preserved
 * so it can be resumed later with the same config + history.
 */
async function setStatus({ followerId, relationId, status, closePositions = false }) {
  if (!['ACTIVE', 'PAUSED', 'STOPPED'].includes(status)) throw new Error('Invalid status');
  const rel = await CopyRelation.findOne({ _id: relationId, followerId });
  if (!rel) throw new Error('Copy relation not found');

  if (status === 'STOPPED' && closePositions) {
    await closeCopyPositions(rel).catch((e) => console.error('[copyTrading] stop-close failed:', e.message));
  }

  rel.status = status;
  if (status === 'PAUSED')  rel.pausedAt  = new Date();
  if (status === 'STOPPED') rel.stoppedAt = new Date();
  if (status === 'ACTIVE')  { rel.pausedAt = null; rel.stoppedAt = null; if (!rel.startedAt) rel.startedAt = new Date(); }
  await rel.save();
  await recountFollowers(rel.masterAccountId);
  return rel;
}

/**
 * Change the DESTINATION account. If closePositions is true, the open copied
 * positions on the OLD account are closed first; otherwise they stay open and
 * only FUTURE copies route to the new account.
 */
async function changeAccount({ followerId, relationId, newAccountId, closePositions = false }) {
  const rel = await CopyRelation.findOne({ _id: relationId, followerId });
  if (!rel) throw new Error('Copy relation not found');
  const destId = await _resolveDestAccount(followerId, newAccountId);
  if (String(rel.followerAccountId) === String(destId)) return rel; // no-op
  if (closePositions) await closeCopyPositions(rel).catch((e) => console.error('[copyTrading] change-account close failed:', e.message));
  rel.followerAccountId = destId;
  await rel.save();
  return rel;
}

/** Edit an existing copy relation (settings + optional account change). */
async function editCopy({ followerId, relationId, followerAccountId, closePositions, ...settings }) {
  const rel = await CopyRelation.findOne({ _id: relationId, followerId });
  if (!rel) throw new Error('Copy relation not found');
  if (followerAccountId && String(followerAccountId) !== String(rel.followerAccountId)) {
    await changeAccount({ followerId, relationId, newAccountId: followerAccountId, closePositions: !!closePositions });
    rel.followerAccountId = followerAccountId;
  }
  const merged = sanitizeLotSettings({ ...rel.toObject(), ...settings });
  Object.assign(rel, merged);
  await rel.save();
  return rel;
}

/**
 * Balance preview for the copy dialog: current balance of the chosen account,
 * a recommended balance, and a low-balance warning flag. ADVISORY ONLY — copying
 * is never blocked on this.
 */
async function getCopyPreview({ followerId, followerAccountId, masterAccountId }) {
  const acc = await TradingAccount.findOne({ _id: followerAccountId, userId: followerId })
    .select('baseCurrency accountType').lean();
  if (!acc) throw new Error('Account not found');
  const currency = acc.baseCurrency || 'USD';
  const { Wallet } = require('../models/Wallet');
  const w = await Wallet.findOne({ userId: followerId, accountId: followerAccountId, currency }).lean();
  const currentBalance = Number(w?.balance || 0);
  const recommendedBalance = await _recommendedBalance(currency);
  return {
    currency,
    currentBalance: Number(currentBalance.toFixed(2)),
    recommendedBalance: Number(recommendedBalance.toFixed(2)),
    lowBalance: currentBalance < recommendedBalance,
  };
}

// Advisory "recommended balance" floor so future mirrors have margin headroom.
async function _recommendedBalance(currency) {
  const floorUsd = 700;
  if (currency === 'INR') {
    try { return Number(await require('./currencyService').fromBase('INR', floorUsd)); } catch { return floorUsd * 90; }
  }
  return floorUsd;
}

async function listMyCopies(userId) {
  const relations = await CopyRelation.find({ followerId: userId }).lean();
  if (!relations.length) return [];

  const accIds = [...new Set(relations.map((r) => r.masterAccountId).filter(Boolean).map(String))];
  const boxes = await CopyBox.find({ accountId: { $in: accIds } }).lean();
  const boxByAcc = new Map(boxes.map((b) => [String(b.accountId), b]));

  // Funding (follower) accounts — so the UI can distinguish multiple copies of
  // the same master that land in different accounts.
  const fAccIds = [...new Set(relations.map((r) => r.followerAccountId).filter(Boolean).map(String))];
  const fAccs = fAccIds.length ? await TradingAccount.find({ _id: { $in: fAccIds } }).select('accountNumber accountType nickname').lean() : [];
  const fAccById = new Map(fAccs.map((a) => [String(a._id), a]));

  const openTrades = await CopyTrade.find({
    relationId: { $in: relations.map((r) => r._id) },
    status: 'OPEN',
  }).lean();

  // Live "Running PnL" + an accurate open-count. A mirror's CopyTrade can linger
  // in status OPEN after its follower position has already closed OUTSIDE the
  // master-close path — a manual close from the trade screen, or the Stop /
  // Change-account "close automatically" flow (closeCopyPositions). Those paths
  // don't touch the CopyTrade, so we drive BOTH the running P&L and the "open"
  // count off the REAL position status, and lazily self-heal stale mirrors.
  //
  // Running PnL = mark-to-market floating P&L (mark = instrument.lastPrice)
  // summed per relation — same formula the risk engine / dashboard use, and
  // recomputed fresh (the stored Position.unrealizedPnl is only cron-flushed and
  // CopyRelation.runningPnl is never written).
  const runningByRel = new Map();
  const liveOpenByRel = new Map();
  const posIds = openTrades.map((t) => t.followerPositionId).filter(Boolean);
  if (posIds.length) {
    const positions = await Position.find({ _id: { $in: posIds } })
      .select('side quantity entryPrice instrumentId status').lean();
    const posById = new Map(positions.map((p) => [String(p._id), p]));
    const openInstIds = [...new Set(positions
      .filter((p) => p.status === POSITION_STATUS.OPEN)
      .map((p) => String(p.instrumentId)))];
    const insts = openInstIds.length
      ? await Instrument.find({ _id: { $in: openInstIds } }).select('lastPrice').lean() : [];
    const priceById = new Map(insts.map((i) => [String(i._id), Number(i.lastPrice) || 0]));

    const stale = [];
    for (const t of openTrades) {
      const p = posById.get(String(t.followerPositionId));
      const k = String(t.relationId);
      if (p && p.status === POSITION_STATUS.OPEN) {
        const entry = Number(p.entryPrice) || 0;
        const mark = priceById.get(String(p.instrumentId)) || entry;
        const qty = Number(p.quantity) || 0;
        const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
        runningByRel.set(k, (runningByRel.get(k) || 0) + pnl);
        if (!liveOpenByRel.has(k)) liveOpenByRel.set(k, []);
        liveOpenByRel.get(k).push(t);
      } else {
        // Follower position already closed (or gone) → this CopyTrade is stale.
        stale.push(t);
      }
    }
    // Heal stale mirrors in the background — never block the read.
    if (stale.length) setImmediate(() => _reconcileClosedMirrors(stale).catch(() => {}));
  }

  return relations.map((r) => {
    const box = boxByAcc.get(String(r.masterAccountId));
    const fAcc = fAccById.get(String(r.followerAccountId));
    return {
      ...r,
      runningPnl: Number((runningByRel.get(String(r._id)) || 0).toFixed(2)),
      followerAccountNumber: fAcc?.accountNumber || null,
      followerAccountType: fAcc?.accountType || null,
      master: box ? {
        displayName: box.displayName,
        accountNumber: box.accountNumber,
        accountType: box.accountType,
        riskBadge: box.riskBadge,
        roiPct: box.roiPct,
        userId: box.userId,
      } : null,
      openMirrors: liveOpenByRel.get(String(r._id)) || [],
    };
  });
}

/**
 * Self-heal mirrors whose follower position closed OUTSIDE the master-close path
 * (manual close from the trade screen, or Stop / Change-account "close
 * automatically"). Those paths close the position but leave the CopyTrade OPEN,
 * which skews the "open" count, analytics and performance-fee settlement. We mark
 * the CopyTrade CLOSED (with the realized PnL) and run the (idempotent)
 * performance fee so earnings + analytics stay correct. Best-effort per mirror.
 */
async function _reconcileClosedMirrors(mirrors) {
  const copyEarnings = require('./copyEarningsService');
  for (const m of mirrors) {
    try {
      const doc = await CopyTrade.findOne({ _id: m._id, status: 'OPEN' });
      if (!doc) continue; // already healed (concurrent read / master-close hook)
      let reason = 'follower_closed';
      if (doc.followerPositionId) {
        const pos = await Position.findById(doc.followerPositionId)
          .select('status realizedPnl closeReason').lean();
        if (pos) {
          if (pos.status !== POSITION_STATUS.CLOSED) continue; // still settling — next pass
          if (pos.realizedPnl != null) doc.realizedPnl = String(pos.realizedPnl);
          if (pos.closeReason === 'COPY_MASTER_CLOSED') reason = 'master_closed';
          else if (pos.closeReason) reason = String(pos.closeReason).toLowerCase();
        }
      }
      doc.status = 'CLOSED';
      doc.closeReason = reason;
      doc.closedAt = new Date();
      await doc.save();
      await copyEarnings.applyPerformanceFee(doc).catch(() => {});
    } catch (_) { /* best-effort self-heal */ }
  }
}

module.exports = {
  getOrCreateProfile,
  // box management
  listEligibleAccounts,
  createBox,
  listMyBoxes,
  updateBox,
  deleteBox,
  restoreBox,
  purgeBox,
  listArchivedBoxes,
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
  editCopy,
  changeAccount,
  closeCopyPositions,
  getCopyPreview,
  listMyCopies,
};
