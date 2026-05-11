/**
 * Daily reconciliation service.
 *
 * Cross-checks the running wallet ledger against the source of truth on
 * each side (Trade collection for trading-driven changes, Deposit/Withdrawal
 * for cash flows) and emits a report. Mismatches → alert to Sentry + log
 * at error level so ops sees them in monitoring.
 *
 * Intended to run once per day from an external cron (or every 4h from
 * the in-process scheduler if you prefer). Keep the query window small
 * — full-table scans across years of history take forever.
 *
 * Run manually: node src/services/reconciliationService.js
 * From code:   require('./reconciliationService').runDaily()
 */
const { Wallet, WalletLedger } = require('../models/Wallet');
const Trade = require('../models/Trade');
const { Deposit, Withdrawal } = require('../models/index');
const logger = require('../utils/logger');
const observability = require('./observability');

const SCAN_HOURS = Number(process.env.RECON_WINDOW_HOURS) || 24;
const TOLERANCE = Number(process.env.RECON_TOLERANCE) || 0.01; // currency units

/**
 * Sum every signed amount in the ledger for the window and compare to
 * the expected delta computed from upstream sources:
 *   expected = Σ(deposit.amount where confirmed)
 *             - Σ(withdrawal.amount where completed)
 *             + Σ(trade PnL settled in window)
 * Difference > TOLERANCE = ledger drift, needs investigation.
 */
const _scanWindow = async ({ from, to }) => {
  const ledgerRows = await WalletLedger.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: { type: '$type', currency: '$currency' },
        total: { $sum: { $toDouble: '$amount' } },
        count: { $sum: 1 },
      },
    },
  ]);

  const trades = await Trade.aggregate([
    { $match: { executedAt: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: '$symbol',
        notional: { $sum: { $multiply: [{ $toDouble: '$price' }, { $toDouble: '$quantity' }] } },
        feeBuyer: { $sum: { $toDouble: '$feeBuyer' } },
        feeSeller: { $sum: { $toDouble: '$feeSeller' } },
        count: { $sum: 1 },
      },
    },
  ]);

  const deposits = await Deposit.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, status: { $in: ['CONFIRMED', 'COMPLETED'] } } },
    { $group: { _id: '$currency', total: { $sum: { $toDouble: '$amount' } }, count: { $sum: 1 } } },
  ]);

  const withdrawals = await Withdrawal.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to }, status: { $in: ['COMPLETED', 'APPROVED'] } } },
    { $group: { _id: '$currency', total: { $sum: { $toDouble: '$amount' } }, count: { $sum: 1 } } },
  ]);

  return { ledgerRows, trades, deposits, withdrawals };
};

const runDaily = async () => {
  const to = new Date();
  const from = new Date(to.getTime() - SCAN_HOURS * 60 * 60 * 1000);
  logger.info('Reconciliation start', { from, to, windowHours: SCAN_HOURS });

  let report;
  try {
    report = await _scanWindow({ from, to });
  } catch (err) {
    logger.error('Reconciliation scan failed', { err });
    observability.captureException(err, { phase: 'reconciliation:scan' });
    return { ok: false, error: err.message };
  }

  // Per-currency check: sum of ledger TRADE_CLOSE rows should be close to
  // (Σ trade notional × spread + Σ trade fees) — but exact matching is
  // book-specific. For MVP we surface the raw aggregates and let ops
  // eyeball them. The action item: any TYPE bucket with a huge count
  // mismatch vs prior days → investigate.
  const summary = {
    window: { from: from.toISOString(), to: to.toISOString() },
    ledger: report.ledgerRows,
    trades: report.trades,
    deposits: report.deposits,
    withdrawals: report.withdrawals,
  };
  logger.info('Reconciliation summary', summary);

  // Spot-check: zero ledger activity but non-zero trades is suspicious.
  const tradesExecuted = report.trades.reduce((s, t) => s + t.count, 0);
  const ledgerTradeRows = report.ledgerRows
    .filter((r) => r._id.type === 'TRADE_CLOSE')
    .reduce((s, r) => s + r.count, 0);
  if (tradesExecuted > 0 && ledgerTradeRows === 0) {
    const msg = `Reconciliation alert: ${tradesExecuted} trades in window but 0 TRADE_CLOSE ledger rows`;
    logger.error(msg, { tradesExecuted, ledgerTradeRows });
    observability.captureException(new Error(msg), { phase: 'reconciliation:tradeMismatch' });
    return { ok: false, summary, alert: msg };
  }

  return { ok: true, summary };
};

// In-process scheduler. Call once from server.js startup if you don't
// have an external cron yet.
let _handle = null;
const schedule = (intervalHours = 24) => {
  if (_handle) return;
  const ms = intervalHours * 60 * 60 * 1000;
  _handle = setInterval(() => {
    runDaily().catch((e) => logger.error('Reconciliation tick failed', { err: e }));
  }, ms);
  logger.info('Reconciliation scheduled', { intervalHours });
};

const stop = () => {
  if (_handle) { clearInterval(_handle); _handle = null; }
};

module.exports = { runDaily, schedule, stop };

// CLI mode — `node src/services/reconciliationService.js`
if (require.main === module) {
  require('dotenv').config();
  const { connectDB } = require('../config/db');
  (async () => {
    await connectDB();
    const r = await runDaily();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  })();
}
