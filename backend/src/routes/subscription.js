const express = require('express');
const c = require('../controllers/subscriptionController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Public list
router.get('/plans', c.listPlans);

// User
router.get('/me', authenticate, c.mySubscription);
router.post('/subscribe', authenticate, c.subscribe);
router.post('/cancel', authenticate, c.cancel);

// Admin
router.get('/admin/plans', authenticate, requireAdmin, c.adminListPlans);
router.post('/admin/plans', authenticate, requireAdmin, c.adminCreatePlan);
router.put('/admin/plans/:id', authenticate, requireAdmin, c.adminUpdatePlan);
router.post('/admin/grant', authenticate, requireAdmin, c.adminGrant);

module.exports = router;
