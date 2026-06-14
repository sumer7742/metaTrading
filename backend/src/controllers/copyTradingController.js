/**
 * Copy-trading API controller.
 *
 * Routes (mounted at /api/copy-trading):
 *   GET    /leaderboard
 *   GET    /feed
 *   GET    /my-copies
 *   POST   /copy            { masterId, investment, riskLevel, syncSlTp?, followerAccountId? }
 *   POST   /pause           { relationId }
 *   POST   /resume          { relationId }
 *   POST   /stop            { relationId }
 *   GET    /profile/me
 *   PUT    /profile/me      { displayName?, avatarUrl?, bio?, isPublic?, riskBadge? }
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const copyTradingService = require('../services/copyTradingService');
const copyAnalytics      = require('../services/copyAnalyticsService');
const copyEarnings       = require('../services/copyEarningsService');
const TraderProfile      = require('../models/TraderProfile');
const CopyBox            = require('../models/CopyBox');

// A trader's analytics are visible to themselves, or to anyone if the target
// is public. When an accountId (box) is given, that specific box must be
// public; otherwise any public box (or legacy public profile) suffices.
async function assertViewable(userId, requesterId, accountId) {
  if (String(userId) === String(requesterId)) return;
  if (accountId) {
    const box = await CopyBox.exists({ accountId, isPublic: true });
    if (!box) throw new AppError('This copy box is private', 403, 'PROFILE_PRIVATE');
    return;
  }
  const [publicBox, profile] = await Promise.all([
    CopyBox.exists({ userId, isPublic: true }),
    TraderProfile.findOne({ userId }).select('isPublic').lean(),
  ]);
  if (!publicBox && !(profile && profile.isPublic)) {
    throw new AppError('This trader profile is private', 403, 'PROFILE_PRIVATE');
  }
}

const leaderboard = asyncHandler(async (req, res) => {
  const list = await copyTradingService.leaderboard({ limit: req.query.limit, excludeUserId: req.userId });
  sendSuccess(res, list);
});

const feed = asyncHandler(async (req, res) => {
  const items = await copyTradingService.feed({ limit: req.query.limit });
  sendSuccess(res, items);
});

const myCopies = asyncHandler(async (req, res) => {
  const items = await copyTradingService.listMyCopies(req.userId);
  sendSuccess(res, items);
});

const startCopy = asyncHandler(async (req, res) => {
  const { masterAccountId, investment, riskLevel, syncSlTp, followerAccountId } = req.body;
  if (!masterAccountId) throw new AppError('masterAccountId required', 400);
  if (!investment || Number(investment) <= 0) throw new AppError('Investment must be > 0', 400);
  try {
    const rel = await copyTradingService.startCopying({
      followerId: req.userId,
      masterAccountId,
      investment,
      riskLevel,
      syncSlTp,
      followerAccountId,
    });
    sendSuccess(res, rel, 201);
  } catch (e) {
    throw new AppError(e.message, 400);
  }
});

// ── Copy boxes (master = a specific trading account) ─────────────────
// All of the user's active accounts + whether each already has a box.
const eligibleAccounts = asyncHandler(async (req, res) => {
  sendSuccess(res, await copyTradingService.listEligibleAccounts(req.userId));
});

const myBoxes = asyncHandler(async (req, res) => {
  sendSuccess(res, await copyTradingService.listMyBoxes(req.userId));
});

const createBox = asyncHandler(async (req, res) => {
  const { accountId, displayName, bio, riskBadge, isPublic, performanceFeePercent } = req.body;
  if (!accountId) throw new AppError('accountId required', 400);
  try {
    const box = await copyTradingService.createBox({ userId: req.userId, accountId, displayName, bio, riskBadge, isPublic, performanceFeePercent });
    sendSuccess(res, box, 201);
  } catch (e) { throw new AppError(e.message, 400); }
});

const updateBox = asyncHandler(async (req, res) => {
  try {
    const box = await copyTradingService.updateBox({ userId: req.userId, boxId: req.params.id, ...req.body });
    sendSuccess(res, box);
  } catch (e) { throw new AppError(e.message, 400); }
});

const deleteBox = asyncHandler(async (req, res) => {
  try {
    await copyTradingService.deleteBox({ userId: req.userId, boxId: req.params.id });
    sendSuccess(res, { ok: true });
  } catch (e) { throw new AppError(e.message, 400); }
});

const setStatus = (status) => asyncHandler(async (req, res) => {
  const { relationId } = req.body;
  if (!relationId) throw new AppError('relationId required', 400);
  try {
    const rel = await copyTradingService.setStatus({
      followerId: req.userId,
      relationId,
      status,
    });
    sendSuccess(res, rel);
  } catch (e) { throw new AppError(e.message, 400); }
});

// ── Read-only trader analytics (profile dashboard). `accountId` query scopes
// the whole payload to a single copy box (per-account performance). ────────
const traderProfile = asyncHandler(async (req, res) => {
  const accountId = req.query.accountId || null;
  await assertViewable(req.params.userId, req.userId, accountId);
  sendSuccess(res, await copyAnalytics.getTraderAnalytics(req.params.userId, accountId));
});

const traderPositions = asyncHandler(async (req, res) => {
  const accountId = req.query.accountId || null;
  await assertViewable(req.params.userId, req.userId, accountId);
  sendSuccess(res, await copyAnalytics.getTraderOpenPositions(req.params.userId, accountId));
});

const traderHistory = asyncHandler(async (req, res) => {
  const accountId = req.query.accountId || null;
  await assertViewable(req.params.userId, req.userId, accountId);
  sendSuccess(res, await copyAnalytics.getTraderHistory(req.params.userId, {
    period: req.query.period, page: req.query.page, limit: req.query.limit,
    from: req.query.from, to: req.query.to, accountId,
  }));
});

const myProfile = asyncHandler(async (req, res) => {
  const profile = await copyTradingService.getOrCreateProfile(req.userId);
  sendSuccess(res, profile);
});

const updateMyProfile = asyncHandler(async (req, res) => {
  const allowed = ['displayName', 'avatarUrl', 'bio', 'isPublic', 'riskBadge'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];

  // Performance fee the master charges followers on profitable copied trades.
  // null / '' → fall back to the platform default. Any value is clamped to
  // the admin-configured [minFee, maxFee] range so masters can't overcharge.
  if ('performanceFeePercent' in req.body) {
    const raw = req.body.performanceFeePercent;
    if (raw === null || raw === '' || raw === undefined) {
      updates.performanceFeePercent = null;
    } else {
      let pct = Number(raw);
      if (!Number.isFinite(pct)) throw new AppError('performanceFeePercent must be a number', 400);
      const s = await copyEarnings.getFeeSettings();
      updates.performanceFeePercent = Math.max(s.minFee, Math.min(s.maxFee, pct));
    }
  }

  const profile = await TraderProfile.findOneAndUpdate(
    { userId: req.userId },
    updates,
    { new: true, upsert: true }
  );
  sendSuccess(res, profile);
});

// ── Master Trader Earnings (performance fee) ─────────────────────────
// The signed-in master's own earnings rollup, recent fee events, effective
// fee % and the platform fee bounds (so the profile editor can show limits).
const myEarnings = asyncHandler(async (req, res) => {
  const [summary, history, performanceFeePercent, settings] = await Promise.all([
    copyEarnings.getMasterEarnings(req.userId),
    copyEarnings.getMasterEarningsHistory(req.userId, { limit: req.query.limit }),
    copyEarnings.resolveFeePercent(req.userId),
    copyEarnings.getFeeSettings(),
  ]);
  sendSuccess(res, { summary, history, performanceFeePercent, settings });
});

// Leaderboard of top-earning masters (read-only analytics).
const topEarners = asyncHandler(async (req, res) => {
  sendSuccess(res, await copyEarnings.topEarners({ limit: req.query.limit }));
});

module.exports = {
  leaderboard,
  feed,
  myCopies,
  eligibleAccounts,
  myBoxes,
  createBox,
  updateBox,
  deleteBox,
  startCopy,
  pauseCopy:  setStatus('PAUSED'),
  resumeCopy: setStatus('ACTIVE'),
  stopCopy:   setStatus('STOPPED'),
  traderProfile,
  traderPositions,
  traderHistory,
  myProfile,
  updateMyProfile,
  myEarnings,
  topEarners,
};
