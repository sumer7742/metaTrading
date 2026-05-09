const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const { Wallet } = require('../models/Wallet');
const { D, add, sub, mul, div, gt, lt, gte } = require('../utils/decimal');

/**
 * Compute account-level metrics:
 *  Equity = Balance + sum(unrealized P&L of open positions)
 *  Used Margin = sum(position.margin)
 *  Free Margin = Equity - Used Margin
 *  Margin Level % = (Equity / Used Margin) * 100
 */
const calculateAccountMetrics = async (userId, accountId, baseCurrency = 'USD') => {
  const wallet = await Wallet.findOne({ userId, accountId, currency: baseCurrency });
  const balance = wallet ? wallet.balance : '0';

  const positions = await Position.find({ accountId, status: 'OPEN' });
  let usedMargin = '0';
  let unrealizedPnl = '0';

  for (const p of positions) {
    const inst = await Instrument.findById(p.instrumentId);
    const markPrice = inst?.lastPrice || p.entryPrice;
    const pnl =
      p.side === 'BUY'
        ? mul(sub(markPrice, p.entryPrice), p.quantity)
        : mul(sub(p.entryPrice, markPrice), p.quantity);
    p.unrealizedPnl = pnl; // not saving here to avoid heavy writes; persist via cron
    unrealizedPnl = add(unrealizedPnl, pnl);
    usedMargin = add(usedMargin, p.margin || '0');
  }

  const equity = add(balance, unrealizedPnl);
  const freeMargin = sub(equity, usedMargin);
  const marginLevel = gt(usedMargin, '0') ? mul(div(equity, usedMargin), '100') : '0';

  return { balance, equity, usedMargin, freeMargin, unrealizedPnl, marginLevel, positions };
};

/**
 * Check if account requires margin call or stop-out.
 * Returns { marginCall: bool, stopOut: bool, level: string }
 */
const checkMarginStatus = async (userId, accountId) => {
  const callLevel = Number(process.env.DEFAULT_MARGIN_CALL_LEVEL || 80);
  const stopLevel = Number(process.env.DEFAULT_STOP_OUT_LEVEL || 50);

  const m = await calculateAccountMetrics(userId, accountId);
  if (gt(m.usedMargin, '0')) {
    const lvl = Number(m.marginLevel);
    return {
      marginCall: lvl <= callLevel && lvl > stopLevel,
      stopOut: lvl <= stopLevel,
      level: m.marginLevel,
    };
  }
  return { marginCall: false, stopOut: false, level: m.marginLevel };
};

module.exports = { calculateAccountMetrics, checkMarginStatus };
