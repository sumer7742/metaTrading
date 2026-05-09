const express = require('express');
const c = require('../controllers/complianceController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All require auth
router.use(authenticate);

// KYC documents (multi-file upload as base64)
router.post('/kyc/documents', express.json({ limit: '15mb' }), c.uploadKycDocument);
router.get('/kyc/documents', c.listKycDocuments);

// Admin: stream a KYC file for review
router.get('/kyc/documents/:id/file', requireAdmin, c.streamKycFile);

// Withdrawal whitelist
router.get('/whitelist', c.listWhitelist);
router.post('/whitelist', c.addWhitelistEntry);
router.delete('/whitelist/:id', c.removeWhitelistEntry);

// Affiliate program
router.get('/affiliate/summary', c.affiliateSummary);
router.get('/affiliate/commissions', c.affiliateCommissions);

module.exports = router;
