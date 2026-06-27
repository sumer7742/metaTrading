const RecommendedMarket = require('../models/RecommendedMarket');
const Instrument = require('../models/Instrument');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

/**
 * Recommended-markets controller.
 *
 * Public:
 *   GET  /api/instruments/recommended        → ordered active symbols (strip + selector)
 * Admin (under /api/admin, requireAdmin):
 *   GET    /recommended-markets              → full ordered list (enriched)
 *   POST   /recommended-markets              → add a symbol (appends to the end)
 *   PUT    /recommended-markets/reorder      → persist a new order
 *   DELETE /recommended-markets/:id          → remove a symbol
 */

const SORT = { sortOrder: 1, createdAt: 1 };

// Push a refresh signal so connected clients (ticker strip + market selector)
// re-pull immediately — genuine real-time, on top of the client's focus/poll
// safety net. Best-effort; never let a broadcast failure break the request.
const _broadcast = () => {
  try { require('../websocket/server').publish('recommended:refresh', { at: Date.now() }); } catch (_) { /* */ }
};

// ── Public: ordered active recommended symbols ────────────────────────────
// Only returns entries whose instrument still exists AND is active, so a
// deactivated / deleted instrument silently drops out of the strip & selector.
const publicList = asyncHandler(async (req, res) => {
  const recs = await RecommendedMarket.find({ isActive: true }).sort(SORT).lean();
  if (!recs.length) return sendSuccess(res, []);

  const symbols = recs.map((r) => r.symbol);
  const live = await Instrument.find({ symbol: { $in: symbols }, isActive: true })
    .select('symbol').lean();
  const liveSet = new Set(live.map((i) => i.symbol));

  const out = recs
    .filter((r) => liveSet.has(r.symbol))
    .map((r) => ({ symbol: r.symbol, sortOrder: r.sortOrder }));
  sendSuccess(res, out);
});

// ── Admin: full list (active + inactive), enriched for the management grid ──
const adminList = asyncHandler(async (req, res) => {
  const recs = await RecommendedMarket.find().sort(SORT).lean();
  const symbols = recs.map((r) => r.symbol);
  const insts = await Instrument.find({ symbol: { $in: symbols } })
    .select('symbol name category baseCurrency quoteCurrency isActive').lean();
  const bySym = new Map(insts.map((i) => [i.symbol, i]));

  const out = recs.map((r) => {
    const i = bySym.get(r.symbol);
    return {
      id: r._id,
      symbol: r.symbol,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      name: (i && i.name) || r.symbol,
      category: (i && i.category) || null,
      baseCurrency: (i && i.baseCurrency) || null,
      quoteCurrency: (i && i.quoteCurrency) || null,
      instrumentActive: !!(i && i.isActive),
      missing: !i, // instrument no longer exists in the catalog
    };
  });
  sendSuccess(res, out);
});

// ── Admin: add a market ───────────────────────────────────────────────────
// Validates the instrument exists. Re-activates a soft-removed entry instead of
// creating a duplicate, and appends to the end of the order.
const adminCreate = asyncHandler(async (req, res) => {
  const symbol = String(req.body.symbol || '').toUpperCase().trim();
  if (!symbol) throw new AppError('symbol is required', 400, 'SYMBOL_REQUIRED');

  const inst = await Instrument.findOne({ symbol }).select('symbol isActive').lean();
  if (!inst) throw new AppError(`No instrument found for "${symbol}"`, 404, 'INSTRUMENT_NOT_FOUND');

  const existing = await RecommendedMarket.findOne({ symbol });
  if (existing && existing.isActive) {
    throw new AppError(`${symbol} is already recommended`, 409, 'ALREADY_RECOMMENDED');
  }

  const last = await RecommendedMarket.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean();
  const nextOrder = (last ? last.sortOrder : -1) + 1;

  let doc;
  if (existing) {
    existing.isActive = true;
    existing.sortOrder = nextOrder;
    doc = await existing.save();
  } else {
    doc = await RecommendedMarket.create({ symbol, sortOrder: nextOrder, isActive: true });
  }
  _broadcast();
  sendSuccess(res, { id: doc._id, symbol: doc.symbol, sortOrder: doc.sortOrder, isActive: doc.isActive }, 201);
});

// ── Admin: persist a new order ────────────────────────────────────────────
// Body { order: [id, id, …] } — sortOrder follows the array index.
const adminReorder = asyncHandler(async (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  if (!order.length) throw new AppError('order array is required', 400, 'ORDER_REQUIRED');

  const ops = order.map((id, idx) => ({
    updateOne: { filter: { _id: id }, update: { $set: { sortOrder: idx } } },
  }));
  await RecommendedMarket.bulkWrite(ops, { ordered: false });
  _broadcast();

  const recs = await RecommendedMarket.find().sort(SORT).lean();
  sendSuccess(res, recs.map((r) => ({ id: r._id, symbol: r.symbol, sortOrder: r.sortOrder, isActive: r.isActive })));
});

// ── Admin: remove a market (hard delete — can always be re-added) ──────────
const adminRemove = asyncHandler(async (req, res) => {
  const doc = await RecommendedMarket.findByIdAndDelete(req.params.id);
  if (!doc) throw new AppError('Recommended market not found', 404, 'NOT_FOUND');
  _broadcast();
  sendSuccess(res, { id: req.params.id });
});

module.exports = { publicList, adminList, adminCreate, adminReorder, adminRemove };
