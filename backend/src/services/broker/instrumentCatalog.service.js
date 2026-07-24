/**
 * instrumentCatalog.service.js — broker-neutral instrument metadata.
 *
 * Pre-trade validation needs lot size, freeze quantity and circuit limits.
 * Those are properties of the INSTRUMENT (set by the exchange), not of any
 * broker — so they must not come from an adapter, or the validation rules
 * would silently change when a user switches broker.
 *
 * Source of truth is the platform's existing `Instrument` collection, which
 * the current instrument-sync jobs already populate. Access here is strictly
 * READ-ONLY: nothing in the broker module writes to the catalogue, and the
 * forex/crypto rows are never touched or reinterpreted.
 *
 * Adapters ask this service for the broker token they need (`tokenFor`), which
 * is the only broker-aware call — and it just picks the right provider column.
 */

const Instrument = require('../../models/Instrument');
const { BrokerError, ERROR_CODE } = require('../../brokers/base/BrokerError');

const TTL_MS = Number(process.env.BROKER_CACHE_TTL_INSTRUMENT_MS) || 10 * 60 * 1000;
const MAX_ENTRIES = 20000;

const PROJECTION = 'symbol name exchange segment category instrumentToken upstoxKey isin lotSize tickSize '
  + 'freezeQty upperCircuit lowerCircuit externalProvider isActive expiryDate underlying strike optionType';

/** @type {Map<string, {value: object|null, at: number}>} */
const _cache = new Map();

const _key = (symbol, exchange, provider) =>
  `${String(symbol).toUpperCase()}|${String(exchange || '*').toUpperCase()}|${String(provider || '*').toUpperCase()}`;

function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) { _cache.delete(key); return undefined; }
  return e.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= MAX_ENTRIES) {
    const first = _cache.keys().next().value;
    if (first) _cache.delete(first);
  }
  _cache.set(key, { value, at: Date.now() });
}

const _numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function _shape(doc) {
  if (!doc) return null;
  return {
    symbol: doc.symbol,
    name: doc.name || null,
    exchange: doc.exchange || null,
    segment: doc.segment || null,
    category: doc.category || null,
    isin: doc.isin || null,
    // Provider token as stored on the catalogue row (e.g. the Dhan security id
    // when the row was imported from Dhan). Adapters decide what to do with it.
    instrumentToken: doc.instrumentToken != null ? String(doc.instrumentToken) : null,
    provider: doc.externalProvider || null,
    lotSize: _numOrNull(doc.lotSize),
    tickSize: _numOrNull(doc.tickSize),
    freezeQty: _numOrNull(doc.freezeQty),
    upperCircuit: _numOrNull(doc.upperCircuit),
    lowerCircuit: _numOrNull(doc.lowerCircuit),
    expiryDate: doc.expiryDate || null,
    underlying: doc.underlying || null,
    strike: _numOrNull(doc.strike),
    optionType: doc.optionType || null,
  };
}

/**
 * Look up an instrument.
 *
 * @param {object} q
 * @param {string} q.symbol
 * @param {string} [q.exchange]  narrows a symbol listed on several exchanges
 * @param {string} [q.provider]  prefer a row imported from this feed (e.g. 'DHAN')
 * @returns {Promise<object|null>}
 */
async function lookup({ symbol, exchange, provider } = {}) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const ex = exchange ? String(exchange).toUpperCase() : null;
  const key = _key(sym, ex, provider);

  const cached = _cacheGet(key);
  if (cached !== undefined) return cached;

  const base = { symbol: sym, isActive: true };
  let doc = null;

  // 1. Exact match on the preferred provider (its token is the one an adapter
  //    can actually use).
  if (provider) {
    doc = await Instrument.findOne(ex ? { ...base, exchange: ex, externalProvider: provider } : { ...base, externalProvider: provider })
      .select(PROJECTION).lean();
  }
  // 2. Any row on the named exchange.
  if (!doc && ex) {
    doc = await Instrument.findOne({ ...base, exchange: ex }).select(PROJECTION).lean();
  }
  // 3. Symbol alone — only when unambiguous. A symbol listed on both NSE and
  //    BSE must not be silently routed to the wrong venue.
  if (!doc && !ex) {
    const candidates = await Instrument.find(base).select(PROJECTION).limit(2).lean();
    doc = candidates.length === 1 ? candidates[0] : null;
  }

  const shaped = _shape(doc);
  _cacheSet(key, shaped);
  return shaped;
}

/**
 * Like `lookup()` but throws SYMBOL_NOT_FOUND — for paths that cannot proceed
 * without the instrument.
 */
async function require_({ symbol, exchange, provider, broker } = {}) {
  const inst = await lookup({ symbol, exchange, provider });
  if (!inst) {
    throw new BrokerError(
      ERROR_CODE.SYMBOL_NOT_FOUND,
      `"${symbol}"${exchange ? ` on ${exchange}` : ''} is not in the instrument catalogue.`,
      { broker: broker || null, details: { symbol, exchange } }
    );
  }
  return inst;
}

/**
 * The broker token for an instrument (Dhan security id, Upstox key, …).
 * Returns null when the catalogue has no token for that provider — the caller
 * decides whether that is fatal.
 */
async function tokenFor({ symbol, exchange, provider }) {
  const inst = await lookup({ symbol, exchange, provider });
  if (!inst) return null;
  if (provider === 'UPSTOX' && inst.upstoxKey) return inst.upstoxKey;
  return inst.instrumentToken;
}

const clearCache = () => _cache.clear();

module.exports = { lookup, require: require_, tokenFor, clearCache };
