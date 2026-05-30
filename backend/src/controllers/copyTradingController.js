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
const TraderProfile      = require('../models/TraderProfile');

const leaderboard = asyncHandler(async (req, res) => {
  const list = await copyTradingService.leaderboard({ limit: req.query.limit });
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
  const { masterId, investment, riskLevel, syncSlTp, followerAccountId } = req.body;
  if (!masterId) throw new AppError('masterId required', 400);
  if (!investment || Number(investment) <= 0) throw new AppError('Investment must be > 0', 400);
  try {
    const rel = await copyTradingService.startCopying({
      followerId: req.userId,
      masterId,
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

const myProfile = asyncHandler(async (req, res) => {
  const profile = await copyTradingService.getOrCreateProfile(req.userId);
  sendSuccess(res, profile);
});

const updateMyProfile = asyncHandler(async (req, res) => {
  const allowed = ['displayName', 'avatarUrl', 'bio', 'isPublic', 'riskBadge'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  const profile = await TraderProfile.findOneAndUpdate(
    { userId: req.userId },
    updates,
    { new: true, upsert: true }
  );
  sendSuccess(res, profile);
});

module.exports = {
  leaderboard,
  feed,
  myCopies,
  startCopy,
  pauseCopy:  setStatus('PAUSED'),
  resumeCopy: setStatus('ACTIVE'),
  stopCopy:   setStatus('STOPPED'),
  myProfile,
  updateMyProfile,
};
