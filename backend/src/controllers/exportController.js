const Order = require('../models/Order');
const Trade = require('../models/Trade');
const Position = require('../models/Position');
const { WalletLedger } = require('../models/Wallet');
const { asyncHandler } = require('../utils/errors');
const { applyDateRange } = require('../utils/dateRange');

/**
 * Tiny CSV serializer. Escapes quotes and wraps fields containing commas/quotes/newlines.
 */
const toCsv = (rows, columns) => {
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((row) => columns.map((c) => escape(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','));
  return [header, ...lines].join('\n');
};

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
};

const exportOrderHistory = asyncHandler(async (req, res) => {
  const { from, to, symbol, status, accountId } = req.query;
  const filter = { userId: req.userId };
  if (accountId) filter.accountId = accountId;   // scoped by userId above → safe
  if (symbol) filter.symbol = symbol.toUpperCase();
  if (status) filter.status = status;
  // Inclusive of the whole `to` day (fixes From==To returning nothing).
  applyDateRange(filter, 'createdAt', from, to);
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

  const csv = toCsv(orders, [
    { label: 'Date', value: (o) => new Date(o.createdAt).toISOString() },
    { label: 'Symbol', value: 'symbol' },
    { label: 'Side', value: 'side' },
    { label: 'Type', value: 'type' },
    { label: 'Quantity', value: 'quantity' },
    { label: 'Filled Quantity', value: 'filledQuantity' },
    { label: 'Price', value: 'price' },
    { label: 'Avg Fill Price', value: 'avgFillPrice' },
    { label: 'Stop Loss', value: 'stopLoss' },
    { label: 'Take Profit', value: 'takeProfit' },
    { label: 'Leverage', value: 'leverage' },
    { label: 'Routing', value: 'routing' },
    { label: 'Status', value: 'status' },
  ]);
  sendCsv(res, `orders_${Date.now()}.csv`, csv);
});

const exportClosedPositions = asyncHandler(async (req, res) => {
  const { from, to, accountId } = req.query;
  const filter = { userId: req.userId, status: 'CLOSED' };
  if (accountId) filter.accountId = accountId;   // scoped by userId above → safe
  // Inclusive of the whole `to` day (fixes From==To returning nothing).
  applyDateRange(filter, 'closedAt', from, to);
  const positions = await Position.find(filter).sort({ closedAt: -1 }).limit(5000).lean();
  const csv = toCsv(positions, [
    { label: 'Opened', value: (p) => new Date(p.openedAt).toISOString() },
    { label: 'Closed', value: (p) => p.closedAt ? new Date(p.closedAt).toISOString() : '' },
    { label: 'Symbol', value: 'symbol' },
    { label: 'Side', value: 'side' },
    { label: 'Quantity', value: 'quantity' },
    { label: 'Entry Price', value: 'entryPrice' },
    { label: 'Close Price', value: 'closePrice' },
    { label: 'Leverage', value: 'leverage' },
    { label: 'Realized P&L', value: 'realizedPnl' },
  ]);
  sendCsv(res, `positions_${Date.now()}.csv`, csv);
});

const exportLedger = asyncHandler(async (req, res) => {
  const { from, to, accountId } = req.query;
  const filter = { userId: req.userId };
  if (accountId) filter.accountId = accountId;
  // Inclusive of the whole `to` day (fixes From==To returning nothing).
  applyDateRange(filter, 'createdAt', from, to);
  const entries = await WalletLedger.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
  const csv = toCsv(entries, [
    { label: 'Date', value: (e) => new Date(e.createdAt).toISOString() },
    { label: 'Type', value: 'type' },
    { label: 'Currency', value: 'currency' },
    { label: 'Amount', value: 'amount' },
    { label: 'Balance After', value: 'balanceAfter' },
    { label: 'Reference Type', value: 'referenceType' },
    { label: 'Note', value: 'note' },
  ]);
  sendCsv(res, `ledger_${Date.now()}.csv`, csv);
});

module.exports = { exportOrderHistory, exportClosedPositions, exportLedger };
