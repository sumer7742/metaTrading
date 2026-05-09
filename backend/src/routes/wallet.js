const express = require('express');
const c = require('../controllers/walletController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/balances', c.getBalances);
router.get('/ledger', c.getLedger);

router.post('/deposits', c.createDeposit);
router.get('/deposits', c.listDeposits);

router.post('/withdrawals', c.requestWithdrawal);
router.get('/withdrawals', c.listWithdrawals);

router.post('/transfers', c.internalTransfer);

module.exports = router;
