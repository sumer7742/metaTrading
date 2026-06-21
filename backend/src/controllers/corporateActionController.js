const CorporateAction = require('../models/CorporateAction');
const Instrument = require('../models/Instrument');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

// List corporate actions (optional ?symbol= / ?applied=true|false).
const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.symbol) filter.symbol = String(req.query.symbol).toUpperCase();
  if (req.query.applied === 'true' || req.query.applied === 'false') filter.applied = req.query.applied === 'true';
  const items = await CorporateAction.find(filter).sort({ exDate: -1 }).limit(200).lean();
  sendSuccess(res, items);
});

// Create one. SPLIT/BONUS need ratioFrom+ratioTo; DIVIDEND needs amount (per share).
// Applied automatically by the background worker on/after exDate.
const create = asyncHandler(async (req, res) => {
  const { symbol, type, ratioFrom, ratioTo, amount, exDate, note } = req.body;
  if (!symbol || !type || !exDate) throw new AppError('symbol, type, exDate required', 400);
  if (!['SPLIT', 'BONUS', 'DIVIDEND'].includes(type)) throw new AppError('type must be SPLIT, BONUS or DIVIDEND', 400);

  const sym = String(symbol).toUpperCase();
  const inst = await Instrument.findOne({ symbol: sym }).lean();
  if (!inst) throw new AppError(`Unknown instrument ${sym}`, 404);

  if (type === 'DIVIDEND') {
    if (!(Number(amount) > 0)) throw new AppError('amount (per share) > 0 required for DIVIDEND', 400);
  } else if (!(Number(ratioFrom) > 0) || !(Number(ratioTo) > 0)) {
    throw new AppError('ratioFrom and ratioTo (> 0) required for SPLIT/BONUS', 400);
  }

  const ca = await CorporateAction.create({
    symbol: sym, type,
    ratioFrom: Number(ratioFrom) || 1,
    ratioTo: Number(ratioTo) || 1,
    amount: amount != null ? String(amount) : '0',
    exDate: new Date(exDate),
    note: note || '',
    createdBy: req.userId || null,
  });
  sendSuccess(res, ca, 201);
});

// Delete a not-yet-applied action.
const remove = asyncHandler(async (req, res) => {
  const ca = await CorporateAction.findById(req.params.id);
  if (!ca) throw new AppError('Corporate action not found', 404);
  if (ca.applied) throw new AppError('Cannot delete an already-applied corporate action', 400);
  await ca.deleteOne();
  sendSuccess(res, { deleted: true });
});

module.exports = { list, create, remove };
