/**
 * copyEarningsService — Master Trader Earnings (performance fee).
 *
 * When a copied trade closes IN PROFIT, the master earns a configurable
 * percentage of the FOLLOWER'S realized profit:
 *
 *     masterFee        = realizedProfit × feePercent / 100
 *     followerNetProfit = realizedProfit − masterFee
 *
 * The follower already received the FULL realized profit via the unchanged
 * settlement engine, so we make the platform net-correct with a single
 * post-settlement transfer:
 *
 *     follower trading account  −= masterFee   (account currency)
 *     master Main Wallet        += masterFee   (converted to USD)
 *
 * This is purely ADDITIVE — execution, settlement, margin, wallet engines
 * and followerAccountId selection are never touched. Existing copy trading
 * keeps working unchanged when the fee system is disabled or set to 0%.
 *
 * Safety guarantees:
 *   • No fee on losses or breakeven (realizedProfit must be > 0).
 *   • No double charging — one CopyTradeEarnings row per follower position
 *     (unique index) + dedupeKey on both the debit and the master credit.
 *   • Master is credited ONLY if the follower was successfully debited; if
 *     the credit then fails, the follower debit is refunded (no money lost).
 *   • Full audit trail (CopyTradeEarnings row + AuditLog entry).
 */
const mongoose          = require('mongoose');
const CopyTradeEarnings = require('../models/CopyTradeEarnings');
const TraderProfile     = require('../models/TraderProfile');
const Position          = require('../models/Position');
const Wallet            = require('../models/Wallet');
const { AuditLog }      = require('../models');
const walletService     = require('./walletService');
const bonusWalletService= require('./bonusWalletService');
const subscriptionWalletService = require('./subscriptionWalletService'); // "Main Wallet"
const currencyService   = require('./currencyService');
const systemSettings    = require('./systemSettings.service');
const { WALLET_TX_TYPE, POSITION_STATUS } = require('../config/constants');
const { add, sub, mul, div, gt } = require('../utils/decimal');

const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const round2s = (x) => round2(x).toFixed(2);

/** Read the admin-configurable fee settings (cached in systemSettings). */
async function getFeeSettings() {
  const [enabled, def, min, max] = await Promise.all([
    systemSettings.getSetting('copyTrading.enabled'),
    systemSettings.getSetting('copyTrading.defaultPerformanceFee'),
    systemSettings.getSetting('copyTrading.minFee'),
    systemSettings.getSetting('copyTrading.maxFee'),
  ]);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled:    enabled !== false,
    defaultFee: num(def, 20),
    minFee:     num(min, 0),
    maxFee:     num(max, 50),
  };
}

/**
 * Effective fee percent for a master: their own override (if set) or the
 * platform default, always clamped to [minFee, maxFee]. Returns 0 when the
 * system is disabled.
 */
async function resolveFeePercent(masterId, settings) {
  const s = settings || (await getFeeSettings());
  if (!s.enabled) return 0;
  const profile = await TraderProfile.findOne({ userId: masterId })
    .select('performanceFeePercent').lean();
  let pct = profile && profile.performanceFeePercent != null
    ? Number(profile.performanceFeePercent)
    : s.defaultFee;
  if (!Number.isFinite(pct)) pct = s.defaultFee;
  return Math.max(s.minFee, Math.min(s.maxFee, pct));
}

/**
 * Settle a PROFITABLE copy-trade close.
 *
 * Settlement (untouched) already credited the follower's FULL realized P&L
 * to their trading account. For a profitable close we redistribute that
 * profit additively — without touching execution / sync / margin / routing:
 *
 *   follower trading account  −= realizedProfit       (remove profit; margin stays)
 *   master  Main Wallet       += masterFee   (USD)    (performance fee, if any)
 *   follower MAIN  Wallet      += followerNet (USD)    (realizedProfit − masterFee)
 *
 * So follower copy-trading PROFIT lands in the MAIN WALLET, not the trading
 * account. Losses / breakeven are left exactly as the engine settled them
 * (no fee, no movement — the loss stays applied to the trading account).
 *
 * Idempotent: the CopyTradeEarnings row (unique followerPositionId) is the
 * claim/lock — created BEFORE any money moves, removed if the move fails so
 * a later retry can re-settle. Never throws into the copy-close flow.
 *
 * @param {object} mirror  a CopyTrade document (master + follower + position ids)
 * @returns {Promise<CopyTradeEarnings|null>}
 */
async function settleCopyTradeProfit(mirror) {
  try {
    if (!mirror || !mirror.followerPositionId) return null;

    // ── Idempotency fast-path: settle each follower position once. ──
    const already = await CopyTradeEarnings
      .findOne({ followerPositionId: mirror.followerPositionId })
      .select('_id').lean();
    if (already) return null;

    // Need a fully-settled follower position with a known realized PnL.
    const pos = await Position.findById(mirror.followerPositionId).lean();
    if (!pos || pos.status !== POSITION_STATUS.CLOSED) return null;

    const realized = Number(pos.realizedPnl);
    if (!Number.isFinite(realized) || realized <= 0) return null; // LOSS/breakeven → untouched

    // ── Compute the split (follower account currency). Fee may be 0. ──
    const settings = await getFeeSettings();
    const feePercent = settings.enabled ? await resolveFeePercent(mirror.masterId, settings) : 0;

    const realizedStr = String(pos.realizedPnl);
    const feeAmount = feePercent > 0 ? round2s(mul(realizedStr, div(String(feePercent), '100'))) : '0.00';
    const netAmount = round2s(sub(realizedStr, feeAmount)); // follower net (account ccy)

    const wallet = await Wallet
      .findOne({ userId: mirror.followerId, accountId: pos.accountId })
      .select('currency').lean();
    const currency = (wallet && wallet.currency) || 'USD';

    // ── Convert each leg to USD (Bonus Wallet + Main Wallet are USD). ──
    const feeConv = gt(feeAmount, '0') ? await currencyService.toBase(currency, Number(feeAmount)) : { baseAmount: 0, rate: 1 };
    const netConv = await currencyService.toBase(currency, Number(netAmount));
    const feeUsd = round2(feeConv.baseAmount);
    const netUsd = round2(netConv.baseAmount);
    const fxRate = Number(netConv.rate || feeConv.rate) || 1;

    // Only move the legs that survive USD rounding; sub-cent dust stays put.
    let debitAcct = '0';
    if (feeUsd > 0) debitAcct = add(debitAcct, feeAmount);
    if (netUsd > 0) debitAcct = add(debitAcct, netAmount);
    if (!gt(debitAcct, '0')) return null;

    const posId = String(mirror.followerPositionId);

    // ── Claim the settlement (unique index = no double settle). ──
    let claim;
    try {
      claim = await CopyTradeEarnings.create({
        masterId:           mirror.masterId,
        followerId:         mirror.followerId,
        relationId:         mirror.relationId,
        copyTradeId:        mirror._id,
        masterPositionId:   mirror.masterPositionId,
        followerPositionId: mirror.followerPositionId,
        symbol:             pos.symbol,
        currency,
        realizedProfit:     realizedStr,
        feePercent,
        feeAmount,
        feeAmountUsd:       feeUsd,
        followerNetProfit:  netAmount,
        followerNetUsd:     netUsd,
        fxRate,
      });
    } catch (err) {
      if (err && (err.code === 11000 || err.code === 11001)) return null; // already settled
      throw err;
    }

    // ── 1) Remove the profit from the follower's trading account. ──
    try {
      await walletService.debit({
        userId:        mirror.followerId,
        accountId:     pos.accountId,
        currency,
        amount:        debitAcct,
        type:          WALLET_TX_TYPE.FEE,
        referenceType: 'copy_profit_settlement',
        referenceId:   mirror._id,
        dedupeKey:     `copysettle:${posId}`,
        note:          `Copy profit → Main Wallet · ${pos.symbol}`,
      });
    } catch (err) {
      // Could not move the profit out — unclaim so a retry can try again.
      console.error('[copyEarnings] profit debit failed:', err.message);
      await CopyTradeEarnings.deleteOne({ _id: claim._id }).catch(() => {});
      return null;
    }

    // ── 2) Credit master fee (Bonus Wallet) + follower net (Main Wallet). ──
    let masterCredited = false;
    try {
      if (feeUsd > 0) {
        // Master performance fee → master's MAIN WALLET (subscription wallet).
        await subscriptionWalletService.credit({
          userId:     mirror.masterId,
          amount:     round2s(feeUsd),
          reason:     'COPY_PERFORMANCE_FEE',
          note:       `Copy earnings ${feePercent}% · ${pos.symbol}`,
          paymentRef: `copyfee:${posId}`,
        });
        masterCredited = true;
      }
      if (netUsd > 0) {
        await subscriptionWalletService.credit({
          userId:     mirror.followerId,
          amount:     round2s(netUsd),
          reason:     'COPY_PROFIT',
          note:       `Copy trade profit · ${pos.symbol}${feePercent > 0 ? ` (net of ${feePercent}% fee)` : ''}`,
          paymentRef: `copynet:${posId}`,
        });
      }
    } catch (err) {
      // Compensate so nothing is lost, then unclaim for a possible retry.
      console.error('[copyEarnings] credit failed — compensating:', err.message);
      if (masterCredited) {
        try { await subscriptionWalletService.debit({ userId: mirror.masterId, amount: round2s(feeUsd), reason: 'ADMIN_DEBIT', note: 'Reverse copy fee (settlement failed)' }); } catch (_) {}
      }
      try {
        await walletService.credit({
          userId: mirror.followerId, accountId: pos.accountId, currency,
          amount: debitAcct, type: WALLET_TX_TYPE.FEE,
          referenceType: 'copy_profit_settlement_refund', referenceId: mirror._id,
          dedupeKey: `copysettle:${posId}:refund`, note: `Refund — settlement failed · ${pos.symbol}`,
        });
      } catch (_) {}
      await CopyTradeEarnings.deleteOne({ _id: claim._id }).catch(() => {});
      return null;
    }

    // ── 3) Audit + notify (best-effort). ──
    try {
      await AuditLog.create({
        actorId:    mirror.followerId,
        actorRole:  'SYSTEM',
        action:     'COPY_PROFIT_SETTLEMENT',
        targetType: 'COPY_EARNINGS',
        targetId:   String(claim._id),
        metadata: {
          masterId:          String(mirror.masterId),
          symbol:            pos.symbol,
          currency,
          realizedProfit:    realizedStr,
          feePercent,
          feeAmount,         feeAmountUsd: feeUsd,
          followerNetProfit: netAmount, followerNetUsd: netUsd,
          destination:       'MAIN_WALLET',
        },
      });
    } catch (_) {}
    try {
      const wsServer = require('../websocket/server');
      if (feeUsd > 0) wsServer.notifyUser(String(mirror.masterId), 'copytrading', { event: 'EARNINGS', symbol: pos.symbol, feeUsd, feePercent });
      wsServer.notifyUser(String(mirror.followerId), 'copytrading', { event: 'PROFIT_CREDITED', symbol: pos.symbol, amountUsd: netUsd, wallet: 'MAIN' });
    } catch (_) {}

    return claim;
  } catch (err) {
    console.error('[copyEarnings] settleCopyTradeProfit error:', err.message);
    return null; // never let settlement routing break the copy-close flow
  }
}

/**
 * What a follower would pay on a hypothetical profit — used for the
 * pre-copy disclosure ("on a $100 profit: master earns $X, you keep $Y").
 */
async function previewFee(masterId, sampleProfit = 100) {
  const feePercent = await resolveFeePercent(masterId);
  const profit = Number(sampleProfit) || 0;
  const masterFee = round2(profit * feePercent / 100);
  return {
    feePercent,
    sampleProfit: round2(profit),
    masterFee,
    followerNet: round2(profit - masterFee),
  };
}

/** Earnings rollup for a master dashboard (USD). */
async function getMasterEarnings(masterId) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await CopyTradeEarnings.aggregate([
    // Records exist for every profitable settlement; only fee-bearing ones
    // count as master earnings.
    { $match: { masterId: oid(masterId), feeAmountUsd: { $gt: 0 } } },
    { $group: {
        _id:   null,
        total: { $sum: '$feeAmountUsd' },
        today: { $sum: { $cond: [{ $gte: ['$createdAt', startToday] }, '$feeAmountUsd', 0] } },
        month: { $sum: { $cond: [{ $gte: ['$createdAt', startMonth] }, '$feeAmountUsd', 0] } },
        count: { $sum: 1 },
        avgFeePercent: { $avg: '$feePercent' },
    } },
  ]);
  const t = rows[0] || {};
  return {
    total: round2(t.total || 0),
    today: round2(t.today || 0),
    month: round2(t.month || 0),
    count: t.count || 0,
    avgFeePercent: round2(t.avgFeePercent || 0),
  };
}

/** Recent earning events for a master (audit/history view). */
async function getMasterEarningsHistory(masterId, { limit = 50 } = {}) {
  return CopyTradeEarnings.find({ masterId })
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

/** Top earning masters (platform analytics). */
async function topEarners({ limit = 20 } = {}) {
  const rows = await CopyTradeEarnings.aggregate([
    { $match: { feeAmountUsd: { $gt: 0 } } },
    { $group: { _id: '$masterId', total: { $sum: '$feeAmountUsd' }, trades: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: Math.min(100, Math.max(1, Number(limit) || 20)) },
  ]);
  const profiles = await TraderProfile
    .find({ userId: { $in: rows.map((r) => r._id) } })
    .select('userId displayName avatarUrl').lean();
  const byId = new Map(profiles.map((p) => [String(p.userId), p]));
  return rows.map((r) => ({
    masterId:    String(r._id),
    displayName: byId.get(String(r._id))?.displayName || '',
    avatarUrl:   byId.get(String(r._id))?.avatarUrl || '',
    totalEarnings: round2(r.total),
    trades:      r.trades,
  }));
}

/** Platform-wide performance-fee revenue (admin analytics). */
async function platformRevenue() {
  const rows = await CopyTradeEarnings.aggregate([
    { $match: { feeAmountUsd: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$feeAmountUsd' }, count: { $sum: 1 } } },
  ]);
  const t = rows[0] || {};
  return { totalRevenue: round2(t.total || 0), feeEvents: t.count || 0 };
}

module.exports = {
  getFeeSettings,
  resolveFeePercent,
  settleCopyTradeProfit,
  // Back-compat alias — the copy engine's close hook calls this name; it now
  // performs the full profit settlement (fee + profit → Main Wallet).
  applyPerformanceFee: settleCopyTradeProfit,
  previewFee,
  getMasterEarnings,
  getMasterEarningsHistory,
  topEarners,
  platformRevenue,
};
