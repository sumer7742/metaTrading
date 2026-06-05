const express = require('express');
const c = require('../controllers/copyTradingController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Public-feel reads (still authenticated so we can stamp "✓ following" hints later)
router.get('/leaderboard', authenticate, c.leaderboard);
router.get('/feed',        authenticate, c.feed);

// Read-only trader analytics dashboard (privacy-gated in the controller).
router.get('/trader/:userId',           authenticate, c.traderProfile);
router.get('/trader/:userId/positions', authenticate, c.traderPositions);
router.get('/trader/:userId/history',   authenticate, c.traderHistory);

// Follower dashboard + actions
router.get('/my-copies',  authenticate, c.myCopies);
router.post('/copy',      authenticate, c.startCopy);
router.post('/pause',     authenticate, c.pauseCopy);
router.post('/resume',    authenticate, c.resumeCopy);
router.post('/stop',      authenticate, c.stopCopy);

// Master profile (the user's own profile)
router.get('/profile/me', authenticate, c.myProfile);
router.put('/profile/me', authenticate, c.updateMyProfile);

// Master Trader Earnings (performance fee)
router.get('/earnings/me',  authenticate, c.myEarnings);
router.get('/earnings/top', authenticate, c.topEarners);

module.exports = router;
