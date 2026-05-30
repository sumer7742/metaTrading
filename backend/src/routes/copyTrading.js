const express = require('express');
const c = require('../controllers/copyTradingController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Public-feel reads (still authenticated so we can stamp "✓ following" hints later)
router.get('/leaderboard', authenticate, c.leaderboard);
router.get('/feed',        authenticate, c.feed);

// Follower dashboard + actions
router.get('/my-copies',  authenticate, c.myCopies);
router.post('/copy',      authenticate, c.startCopy);
router.post('/pause',     authenticate, c.pauseCopy);
router.post('/resume',    authenticate, c.resumeCopy);
router.post('/stop',      authenticate, c.stopCopy);

// Master profile (the user's own profile)
router.get('/profile/me', authenticate, c.myProfile);
router.put('/profile/me', authenticate, c.updateMyProfile);

module.exports = router;
