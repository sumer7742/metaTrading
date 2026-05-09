const PriceAlert = require('../models/PriceAlert');
const Instrument = require('../models/Instrument');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

const list = asyncHandler(async (req, res) => {
  const filter = { userId: req.userId };
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.active === 'false') filter.isActive = false;
  const alerts = await PriceAlert.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, alerts);
});

const create = asyncHandler(async (req, res) => {
  const { symbol, direction, targetPrice, note, repeatable } = req.body;
  if (!symbol || !direction || !targetPrice) {
    throw new AppError('symbol, direction, targetPrice required', 400);
  }
  if (!['ABOVE', 'BELOW'].includes(direction)) throw new AppError('Invalid direction', 400);
  const inst = await Instrument.findOne({ symbol: symbol.toUpperCase(), isActive: true });
  if (!inst) throw new AppError('Instrument not found', 404);

  const alert = await PriceAlert.create({
    userId: req.userId,
    symbol: inst.symbol,
    direction,
    targetPrice: String(targetPrice),
    note,
    repeatable: !!repeatable,
  });
  sendSuccess(res, alert, 201);
});

const remove = asyncHandler(async (req, res) => {
  const alert = await PriceAlert.findOneAndDelete({ _id: req.params.id, userId: req.userId });
  if (!alert) throw new AppError('Alert not found', 404);
  sendSuccess(res, { ok: true });
});

const toggle = asyncHandler(async (req, res) => {
  const alert = await PriceAlert.findOne({ _id: req.params.id, userId: req.userId });
  if (!alert) throw new AppError('Alert not found', 404);
  alert.isActive = !alert.isActive;
  if (alert.isActive) {
    alert.triggeredAt = null;
    alert.triggeredPrice = null;
  }
  await alert.save();
  sendSuccess(res, alert);
});

module.exports = { list, create, remove, toggle };
