const Watchlist = require('../models/Watchlist');
const Instrument = require('../models/Instrument');
const User = require('../models/User');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

// ─── Symbol validation cache ─────────────────────────────────────────
// Watchlist add/bulk-add validate every symbol against the active
// instrument catalogue. Hitting Mongo per symbol on a 50-symbol bulk add
// is wasteful since the catalogue changes rarely. We cache the active
// symbol set + a symbol→category map for a short TTL (the category lets us
// stamp each watchlist item with its instrument type at add-time).
let _symCache = { set: null, byCat: null, at: 0 };
const SYM_TTL_MS = 60 * 1000;

async function activeSymbolCatalog() {
  if (_symCache.set && Date.now() - _symCache.at < SYM_TTL_MS) return _symCache;
  const docs = await Instrument.find({ isActive: true }).select('symbol category').lean();
  _symCache = {
    set: new Set(docs.map((d) => d.symbol)),
    byCat: new Map(docs.map((d) => [d.symbol, String(d.category || '').toUpperCase()])),
    at: Date.now(),
  };
  return _symCache;
}

const norm = (s) => String(s || '').trim().toUpperCase();

// Shape a watchlist doc for the FE: expose itemCount and keep items in the
// canonical render order (pinned first, then sortOrder ascending).
function serialize(doc) {
  const w = doc.toObject ? doc.toObject() : doc;
  const items = [...(w.items || [])].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });
  return { ...w, items, itemCount: items.length };
}

// Load a watchlist owned by the caller or throw 404. Centralises the
// ownership check so no route can read/mutate another user's list.
async function ownedOrThrow(id, userId) {
  const wl = await Watchlist.findOne({ _id: id, userId });
  if (!wl) throw new AppError('Watchlist not found', 404, 'NOT_FOUND');
  return wl;
}

// ─── Watchlist CRUD ──────────────────────────────────────────────────

const list = asyncHandler(async (req, res) => {
  const [lists, user] = await Promise.all([
    Watchlist.find({ userId: req.userId }).sort({ sortOrder: 1, createdAt: 1 }),
    User.findById(req.userId).select('lastSelectedWatchlistId').lean(),
  ]);
  sendSuccess(res, {
    watchlists: lists.map(serialize),
    lastSelectedWatchlistId: user?.lastSelectedWatchlistId || null,
  });
});

const create = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new AppError('name required', 400);
  if (name.length > 40) throw new AppError('name too long (max 40)', 400);

  const dupe = await Watchlist.findOne({
    userId: req.userId,
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  }).lean();
  if (dupe) throw new AppError('A watchlist with that name already exists', 409, 'DUPLICATE');

  const last = await Watchlist.findOne({ userId: req.userId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
  const wl = await Watchlist.create({
    userId: req.userId,
    name,
    emoji: String(req.body.emoji || '').slice(0, 8),
    color: String(req.body.color || ''),
    isDefault: !!req.body.isDefault,
    sortOrder: (last?.sortOrder ?? -1) + 1,
    items: [],
  });
  sendSuccess(res, serialize(wl), 201);
});

const update = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw new AppError('name cannot be empty', 400);
    if (name.length > 40) throw new AppError('name too long (max 40)', 400);
    const dupe = await Watchlist.findOne({
      _id: { $ne: wl._id },
      userId: req.userId,
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).lean();
    if (dupe) throw new AppError('A watchlist with that name already exists', 409, 'DUPLICATE');
    wl.name = name;
  }
  if (req.body.emoji !== undefined) wl.emoji = String(req.body.emoji).slice(0, 8);
  if (req.body.color !== undefined) wl.color = String(req.body.color);
  await wl.save();

  // Optionally remember this as the last-selected list (FE sends this on switch).
  if (req.body.setLastSelected) {
    await User.updateOne({ _id: req.userId }, { lastSelectedWatchlistId: wl._id });
  }
  sendSuccess(res, serialize(wl));
});

// PATCH /watchlists/last-selected — lightweight "remember which list is open".
const setLastSelected = asyncHandler(async (req, res) => {
  const { watchlistId } = req.body;
  if (watchlistId) await ownedOrThrow(watchlistId, req.userId); // ownership
  await User.updateOne({ _id: req.userId }, { lastSelectedWatchlistId: watchlistId || null });
  sendSuccess(res, { ok: true });
});

const remove = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  // Protection: never delete the user's final watchlist — there must
  // always be at least one (typically Favorites) to land on.
  const total = await Watchlist.countDocuments({ userId: req.userId });
  if (total <= 1) {
    throw new AppError('At least one watchlist must exist', 400, 'LAST_WATCHLIST');
  }
  await wl.deleteOne();

  // If the deleted list was the remembered last-selected, repoint to the
  // first remaining list so the next login opens something valid.
  const user = await User.findById(req.userId).select('lastSelectedWatchlistId');
  if (user && String(user.lastSelectedWatchlistId) === String(wl._id)) {
    const next = await Watchlist.findOne({ userId: req.userId }).sort({ sortOrder: 1 }).select('_id').lean();
    user.lastSelectedWatchlistId = next?._id || null;
    await user.save();
  }
  sendSuccess(res, { ok: true });
});

const duplicate = asyncHandler(async (req, res) => {
  const src = await ownedOrThrow(req.params.id, req.userId);
  const last = await Watchlist.findOne({ userId: req.userId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
  const copy = await Watchlist.create({
    userId: req.userId,
    name: `${src.name} copy`.slice(0, 40),
    emoji: src.emoji,
    color: src.color,
    isDefault: false,
    sortOrder: (last?.sortOrder ?? -1) + 1,
    items: src.items.map((it) => ({
      symbol: it.symbol,
      type: it.type || '',
      sortOrder: it.sortOrder,
      pinned: it.pinned,
      addedAt: new Date(),
    })),
  });
  sendSuccess(res, serialize(copy), 201);
});

// POST /watchlists/reorder — body { orderedIds: [...] }. All ids must
// belong to the caller; we bulk-write the new sortOrder by array index.
const reorder = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : [];
  if (!ids.length) throw new AppError('orderedIds required', 400);
  const owned = await Watchlist.find({ _id: { $in: ids }, userId: req.userId }).select('_id').lean();
  if (owned.length !== ids.length) throw new AppError('One or more watchlists not found', 404, 'NOT_FOUND');
  await Watchlist.bulkWrite(
    ids.map((id, i) => ({ updateOne: { filter: { _id: id, userId: req.userId }, update: { sortOrder: i } } }))
  );
  sendSuccess(res, { ok: true });
});

// ─── Items ───────────────────────────────────────────────────────────

const listItems = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  sendSuccess(res, serialize(wl).items);
});

// Validate + dedupe a batch of raw symbols against the active catalogue.
// Returns { symbol, type } for each symbol not already present in the list,
// in input order. `type` is the instrument's category (STOCK/CRYPTO/…) so
// the caller can stamp it onto the stored item.
async function resolveNewSymbols(rawSymbols, wl) {
  const { set: valid, byCat } = await activeSymbolCatalog();
  const existing = new Set(wl.items.map((it) => it.symbol));
  const seen = new Set();
  const out = [];
  for (const raw of rawSymbols) {
    const sym = norm(raw);
    if (!sym || seen.has(sym) || existing.has(sym)) continue;
    if (!valid.has(sym)) throw new AppError(`Unknown or inactive symbol: ${sym}`, 404, 'UNKNOWN_SYMBOL');
    seen.add(sym);
    out.push({ symbol: sym, type: byCat.get(sym) || '' });
  }
  return out;
}

const addItem = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  const sym = norm(req.body.symbol);
  if (!sym) throw new AppError('symbol required', 400);
  const toAdd = await resolveNewSymbols([sym], wl);
  if (toAdd.length) {
    let next = wl.items.reduce((m, it) => Math.max(m, it.sortOrder ?? 0), -1) + 1;
    wl.items.push({ symbol: toAdd[0].symbol, type: toAdd[0].type, sortOrder: next, pinned: false, addedAt: new Date() });
    await wl.save();
  }
  sendSuccess(res, serialize(wl), 201);
});

// POST /watchlists/:id/items/bulk — body { symbols: [...] }. Single
// validated write for scanners / import / multi-select add.
const bulkAddItems = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  const symbols = Array.isArray(req.body.symbols) ? req.body.symbols : [];
  if (!symbols.length) throw new AppError('symbols[] required', 400);
  const toAdd = await resolveNewSymbols(symbols, wl);
  let next = wl.items.reduce((m, it) => Math.max(m, it.sortOrder ?? 0), -1) + 1;
  for (const it of toAdd) {
    wl.items.push({ symbol: it.symbol, type: it.type, sortOrder: next++, pinned: false, addedAt: new Date() });
  }
  await wl.save();
  sendSuccess(res, serialize(wl), 201);
});

const removeItem = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  const item = wl.items.id(req.params.itemId);
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND');
  item.deleteOne();
  await wl.save();
  sendSuccess(res, serialize(wl));
});

// POST /watchlists/:id/items/reorder — body { orderedItemIds: [...] }.
// Reorders within the unpinned/pinned groups; the serializer keeps pinned
// items rendered first regardless, so pinning never breaks DnD order.
const reorderItems = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  const ids = Array.isArray(req.body.orderedItemIds) ? req.body.orderedItemIds : [];
  if (!ids.length) throw new AppError('orderedItemIds required', 400);
  const pos = new Map(ids.map((id, i) => [String(id), i]));
  wl.items.forEach((it) => {
    if (pos.has(String(it._id))) it.sortOrder = pos.get(String(it._id));
  });
  await wl.save();
  sendSuccess(res, serialize(wl));
});

const pinItem = asyncHandler(async (req, res) => {
  const wl = await ownedOrThrow(req.params.id, req.userId);
  const item = wl.items.id(req.params.itemId);
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND');
  item.pinned = req.body.pinned !== undefined ? !!req.body.pinned : !item.pinned;
  await wl.save();
  sendSuccess(res, serialize(wl));
});

// Move / copy a symbol to another of the caller's lists. Copy preserves the
// source item; move removes it afterwards. Both validate ownership of the
// target and dedupe within the target.
async function transferItem(req, { keepSource }) {
  const src = await ownedOrThrow(req.params.id, req.userId);
  const item = src.items.id(req.params.itemId);
  if (!item) throw new AppError('Item not found', 404, 'NOT_FOUND');
  const target = await ownedOrThrow(req.body.targetWatchlistId, req.userId);
  if (String(target._id) === String(src._id)) throw new AppError('Source and target are the same', 400);

  if (!target.items.some((it) => it.symbol === item.symbol)) {
    const next = target.items.reduce((m, it) => Math.max(m, it.sortOrder ?? 0), -1) + 1;
    target.items.push({ symbol: item.symbol, type: item.type || '', sortOrder: next, pinned: false, addedAt: new Date() });
    await target.save();
  }
  if (!keepSource) {
    item.deleteOne();
    await src.save();
  }
  return { src, target };
}

const moveItem = asyncHandler(async (req, res) => {
  const { src, target } = await transferItem(req, { keepSource: false });
  sendSuccess(res, { source: serialize(src), target: serialize(target) });
});

const copyItem = asyncHandler(async (req, res) => {
  const { src, target } = await transferItem(req, { keepSource: true });
  sendSuccess(res, { source: serialize(src), target: serialize(target) });
});

module.exports = {
  list, create, update, setLastSelected, remove, duplicate, reorder,
  listItems, addItem, bulkAddItems, removeItem, reorderItems, pinItem, moveItem, copyItem,
};
