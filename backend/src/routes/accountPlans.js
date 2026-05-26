const express = require('express');
const c = require('../controllers/accountPlanController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Public — active plans only. Authenticated users see this on the
// Plans page + account-creation picker.
router.get('/', authenticate, c.listPublic);

// Admin — full CRUD, reorder, status, analytics.
router.get('/admin',                authenticate, requireAdmin, c.adminList);
router.get('/admin/analytics',      authenticate, requireAdmin, c.adminAnalytics);
router.post('/admin',               authenticate, requireAdmin, c.adminCreate);
router.put('/admin/:id',            authenticate, requireAdmin, c.adminUpdate);
router.delete('/admin/:id',         authenticate, requireAdmin, c.adminDelete);
router.patch('/admin/:id/status',   authenticate, requireAdmin, c.adminToggleStatus);
router.patch('/admin/order',        authenticate, requireAdmin, c.adminReorder);

module.exports = router;
