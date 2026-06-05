/**
 * instrumentOverrideService — scheduled per-instrument leverage & volume
 * overrides. Resolves the effective leverage / fixed volume for a NEW order,
 * enriches the instrument API, and provides admin CRUD (with overlap
 * prevention, validation and an audit trail).
 *
 * Safety contract: these ONLY influence new orders/positions. Existing
 * positions, margin on open trades, and historical data are never touched.
 */
const { InstrumentLeverageOverride, InstrumentVolumeOverride } = require('../models/InstrumentOverride');
const Instrument = require('../models/Instrument');
const { AuditLog } = require('../models');
const { AppError } = require('../utils/errors');
const { D, gt } = require('../utils/decimal');

const oid = (v) => String(v);

// ── Status helper ────────────────────────────────────────────────────
function statusOf(ov, at = new Date()) {
  if (!ov.enabled) return 'disabled';
  const s = new Date(ov.startAt).getTime();
  const e = new Date(ov.endAt).getTime();
  const now = at.getTime();
  if (now < s) return 'upcoming';
  if (now >= e) return 'expired';
  return 'active';
}
const withStatus = (ov, at) => ({ ...ov, status: statusOf(ov, at) });

// ── Active-override resolvers (hot path at order time) ────────────────
async function getActiveLeverageOverride(instrumentId, at = new Date()) {
  return InstrumentLeverageOverride.findOne({
    instrumentId, enabled: true, startAt: { $lte: at }, endAt: { $gt: at },
  }).sort({ startAt: -1 }).lean();
}
async function getActiveVolumeOverride(instrumentId, at = new Date()) {
  return InstrumentVolumeOverride.findOne({
    instrumentId, enabled: true, startAt: { $lte: at }, endAt: { $gt: at },
  }).sort({ startAt: -1 }).lean();
}

/** Effective instrument leverage cap for a new order. */
async function getEffectiveLeverage(instrument, at = new Date()) {
  const normal = Number(instrument.maxLeverage) || 0;
  const ov = await getActiveLeverageOverride(instrument._id, at);
  if (ov && Number(ov.leverage) > 0) {
    return { value: Number(ov.leverage), isOverride: true, override: ov, normal };
  }
  return { value: normal, isOverride: false, override: null, normal };
}

/** Effective fixed volume for a new order (schedule beats static setting). */
async function getEffectiveFixedVolume(instrument, at = new Date()) {
  const ov = await getActiveVolumeOverride(instrument._id, at);
  if (ov && gt(String(ov.volume), '0')) {
    return { enabled: true, value: String(ov.volume), source: 'schedule', override: ov, endAt: ov.endAt };
  }
  if (instrument.fixedVolumeEnabled && gt(String(instrument.fixedVolumeValue || '0'), '0')) {
    return { enabled: true, value: String(instrument.fixedVolumeValue), source: 'fixed', override: null, endAt: null };
  }
  return { enabled: false, value: null, source: null, override: null, endAt: null };
}

/**
 * Batch-enrich a list of plain instrument docs with active overrides so the
 * client can render indicators + lock the volume input. No N+1.
 */
async function attachActiveOverrides(instruments, at = new Date()) {
  if (!instruments.length) return instruments;
  const ids = instruments.map((i) => i._id);
  const [levs, vols] = await Promise.all([
    InstrumentLeverageOverride.find({ instrumentId: { $in: ids }, enabled: true, startAt: { $lte: at }, endAt: { $gt: at } }).lean(),
    InstrumentVolumeOverride.find({ instrumentId: { $in: ids }, enabled: true, startAt: { $lte: at }, endAt: { $gt: at } }).lean(),
  ]);
  const levBy = new Map(); levs.forEach((o) => { if (!levBy.has(oid(o.instrumentId))) levBy.set(oid(o.instrumentId), o); });
  const volBy = new Map(); vols.forEach((o) => { if (!volBy.has(oid(o.instrumentId))) volBy.set(oid(o.instrumentId), o); });

  return instruments.map((i) => {
    const lo = levBy.get(oid(i._id));
    const vo = volBy.get(oid(i._id));
    const normalLev = Number(i.maxLeverage) || 0;
    const fixedVolume = vo && gt(String(vo.volume), '0')
      ? { enabled: true, value: String(vo.volume), source: 'schedule', endAt: vo.endAt, reason: vo.reason }
      : (i.fixedVolumeEnabled && gt(String(i.fixedVolumeValue || '0'), '0')
        ? { enabled: true, value: String(i.fixedVolumeValue), source: 'fixed', endAt: null, reason: '' }
        : { enabled: false, value: null, source: null, endAt: null });
    return {
      ...i,
      effectiveLeverage: lo && Number(lo.leverage) > 0 ? Number(lo.leverage) : normalLev,
      leverageOverride: lo
        ? { leverage: Number(lo.leverage), normalLeverage: normalLev, startAt: lo.startAt, endAt: lo.endAt, reason: lo.reason }
        : null,
      fixedVolume,
    };
  });
}

// ── Validation + overlap ─────────────────────────────────────────────
function _validateWindow(startAt, endAt) {
  const s = new Date(startAt), e = new Date(endAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new AppError('Invalid start/end date', 400, 'OVERRIDE_BAD_DATE');
  if (e.getTime() <= s.getTime()) throw new AppError('End time must be after start time', 400, 'OVERRIDE_BAD_WINDOW');
  return { s, e };
}

async function _assertNoOverlap(Model, instrumentId, s, e, excludeId) {
  // Only ENABLED windows conflict (disabled schedules can overlap freely).
  const q = { instrumentId, enabled: true, startAt: { $lt: e }, endAt: { $gt: s } };
  if (excludeId) q._id = { $ne: excludeId };
  const clash = await Model.findOne(q).lean();
  if (clash) {
    throw new AppError(
      `Overlapping active override exists for this instrument (${new Date(clash.startAt).toISOString()} → ${new Date(clash.endAt).toISOString()}). Disable it or pick a non-overlapping window.`,
      409, 'OVERRIDE_OVERLAP'
    );
  }
}

async function _resolveInstrument(symbol) {
  const inst = await Instrument.findOne({ symbol: String(symbol || '').toUpperCase() }).lean();
  if (!inst) throw new AppError('Instrument not found', 404, 'INSTRUMENT_NOT_FOUND');
  return inst;
}

async function _audit(actor, action, inst, metadata) {
  try {
    await AuditLog.create({
      actorId: actor?.actorId, actorRole: actor?.actorRole || 'ADMIN',
      action, targetType: 'INSTRUMENT', targetId: String(inst._id),
      metadata: { symbol: inst.symbol, ...metadata }, ip: actor?.ip,
    });
  } catch (_) { /* audit best-effort */ }
}

// ── Leverage override CRUD ───────────────────────────────────────────
async function listLeverageOverrides(symbol) {
  const inst = await _resolveInstrument(symbol);
  const at = new Date();
  const rows = await InstrumentLeverageOverride.find({ instrumentId: inst._id })
    .sort({ startAt: 1 }).lean();
  return { instrument: { _id: inst._id, symbol: inst.symbol, maxLeverage: inst.maxLeverage }, overrides: rows.map((r) => withStatus(r, at)) };
}

async function createLeverageOverride({ symbol, leverage, startAt, endAt, reason, enabled = true }, actor) {
  const inst = await _resolveInstrument(symbol);
  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev < 1) throw new AppError('Override leverage must be ≥ 1', 400, 'OVERRIDE_BAD_LEVERAGE');
  const { s, e } = _validateWindow(startAt, endAt);
  if (enabled) await _assertNoOverlap(InstrumentLeverageOverride, inst._id, s, e);

  const doc = await InstrumentLeverageOverride.create({
    instrumentId: inst._id, symbol: inst.symbol, leverage: Math.round(lev),
    normalLeverage: Number(inst.maxLeverage) || null,
    startAt: s, endAt: e, reason: reason || '', enabled: !!enabled,
    createdBy: actor?.actorId, createdByName: actor?.actorName || '',
  });
  await _audit(actor, 'INSTRUMENT_LEVERAGE_OVERRIDE_CREATE', inst, {
    overrideId: String(doc._id), overrideLeverage: doc.leverage, normalLeverage: doc.normalLeverage,
    startAt: s, endAt: e, reason: doc.reason,
  });
  return withStatus(doc.toObject(), new Date());
}

async function updateLeverageOverride(id, updates, actor) {
  const doc = await InstrumentLeverageOverride.findById(id);
  if (!doc) throw new AppError('Override not found', 404);
  const next = {
    leverage: updates.leverage != null ? Number(updates.leverage) : doc.leverage,
    startAt: updates.startAt != null ? updates.startAt : doc.startAt,
    endAt: updates.endAt != null ? updates.endAt : doc.endAt,
    enabled: updates.enabled != null ? !!updates.enabled : doc.enabled,
  };
  if (!Number.isFinite(next.leverage) || next.leverage < 1) throw new AppError('Override leverage must be ≥ 1', 400);
  const { s, e } = _validateWindow(next.startAt, next.endAt);
  if (next.enabled) await _assertNoOverlap(InstrumentLeverageOverride, doc.instrumentId, s, e, doc._id);

  doc.leverage = Math.round(next.leverage);
  doc.startAt = s; doc.endAt = e; doc.enabled = next.enabled;
  if (updates.reason != null) doc.reason = updates.reason;
  await doc.save();
  const inst = await Instrument.findById(doc.instrumentId).lean();
  await _audit(actor, 'INSTRUMENT_LEVERAGE_OVERRIDE_UPDATE', inst || { _id: doc.instrumentId, symbol: doc.symbol }, {
    overrideId: String(doc._id), overrideLeverage: doc.leverage, startAt: s, endAt: e, enabled: doc.enabled, reason: doc.reason,
  });
  return withStatus(doc.toObject(), new Date());
}

async function deleteLeverageOverride(id, actor) {
  const doc = await InstrumentLeverageOverride.findByIdAndDelete(id);
  if (!doc) throw new AppError('Override not found', 404);
  await _audit(actor, 'INSTRUMENT_LEVERAGE_OVERRIDE_DELETE', { _id: doc.instrumentId, symbol: doc.symbol }, {
    overrideId: String(doc._id), overrideLeverage: doc.leverage, startAt: doc.startAt, endAt: doc.endAt,
  });
  return { deleted: true };
}

// ── Volume override CRUD (optional schedule) ─────────────────────────
async function listVolumeOverrides(symbol) {
  const inst = await _resolveInstrument(symbol);
  const at = new Date();
  const rows = await InstrumentVolumeOverride.find({ instrumentId: inst._id }).sort({ startAt: 1 }).lean();
  return {
    instrument: { _id: inst._id, symbol: inst.symbol, fixedVolumeEnabled: inst.fixedVolumeEnabled, fixedVolumeValue: inst.fixedVolumeValue },
    overrides: rows.map((r) => withStatus(r, at)),
  };
}

function _normVolume(inst, volume) {
  if (!gt(String(volume), '0')) throw new AppError('Volume must be > 0', 400, 'OVERRIDE_BAD_VOLUME');
  // Respect instrument precision.
  const prec = Number.isFinite(Number(inst.quantityPrecision)) ? Number(inst.quantityPrecision) : 4;
  const rounded = D(String(volume)).toDecimalPlaces ? D(String(volume)).toDecimalPlaces(prec).toString() : String(volume);
  if (inst.minOrderSize && D(rounded).lt(D(inst.minOrderSize))) {
    throw new AppError(`Volume below instrument minimum (${inst.minOrderSize})`, 400, 'OVERRIDE_BELOW_MIN');
  }
  if (inst.maxOrderSize && D(rounded).gt(D(inst.maxOrderSize))) {
    throw new AppError(`Volume above instrument maximum (${inst.maxOrderSize})`, 400, 'OVERRIDE_ABOVE_MAX');
  }
  return rounded;
}

async function createVolumeOverride({ symbol, volume, startAt, endAt, reason, enabled = true }, actor) {
  const inst = await _resolveInstrument(symbol);
  const vol = _normVolume(inst, volume);
  const { s, e } = _validateWindow(startAt, endAt);
  if (enabled) await _assertNoOverlap(InstrumentVolumeOverride, inst._id, s, e);

  const doc = await InstrumentVolumeOverride.create({
    instrumentId: inst._id, symbol: inst.symbol, volume: vol,
    normalVolume: inst.fixedVolumeValue || null,
    startAt: s, endAt: e, reason: reason || '', enabled: !!enabled,
    createdBy: actor?.actorId, createdByName: actor?.actorName || '',
  });
  await _audit(actor, 'INSTRUMENT_VOLUME_OVERRIDE_CREATE', inst, {
    overrideId: String(doc._id), overrideVolume: vol, startAt: s, endAt: e, reason: doc.reason,
  });
  return withStatus(doc.toObject(), new Date());
}

async function updateVolumeOverride(id, updates, actor) {
  const doc = await InstrumentVolumeOverride.findById(id);
  if (!doc) throw new AppError('Override not found', 404);
  const inst = await Instrument.findById(doc.instrumentId).lean();
  const next = {
    volume: updates.volume != null ? updates.volume : doc.volume,
    startAt: updates.startAt != null ? updates.startAt : doc.startAt,
    endAt: updates.endAt != null ? updates.endAt : doc.endAt,
    enabled: updates.enabled != null ? !!updates.enabled : doc.enabled,
  };
  const vol = _normVolume(inst || {}, next.volume);
  const { s, e } = _validateWindow(next.startAt, next.endAt);
  if (next.enabled) await _assertNoOverlap(InstrumentVolumeOverride, doc.instrumentId, s, e, doc._id);

  doc.volume = vol; doc.startAt = s; doc.endAt = e; doc.enabled = next.enabled;
  if (updates.reason != null) doc.reason = updates.reason;
  await doc.save();
  await _audit(actor, 'INSTRUMENT_VOLUME_OVERRIDE_UPDATE', inst || { _id: doc.instrumentId, symbol: doc.symbol }, {
    overrideId: String(doc._id), overrideVolume: vol, startAt: s, endAt: e, enabled: doc.enabled, reason: doc.reason,
  });
  return withStatus(doc.toObject(), new Date());
}

async function deleteVolumeOverride(id, actor) {
  const doc = await InstrumentVolumeOverride.findByIdAndDelete(id);
  if (!doc) throw new AppError('Override not found', 404);
  await _audit(actor, 'INSTRUMENT_VOLUME_OVERRIDE_DELETE', { _id: doc.instrumentId, symbol: doc.symbol }, {
    overrideId: String(doc._id), overrideVolume: doc.volume, startAt: doc.startAt, endAt: doc.endAt,
  });
  return { deleted: true };
}

module.exports = {
  statusOf,
  getActiveLeverageOverride,
  getActiveVolumeOverride,
  getEffectiveLeverage,
  getEffectiveFixedVolume,
  attachActiveOverrides,
  listLeverageOverrides,
  createLeverageOverride,
  updateLeverageOverride,
  deleteLeverageOverride,
  listVolumeOverrides,
  createVolumeOverride,
  updateVolumeOverride,
  deleteVolumeOverride,
};
