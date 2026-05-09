/**
 * Simple in-memory TTL cache for hot reads.
 *
 * Use cases:
 *   - Instrument metadata (changes rarely, read every order)
 *   - User profile fragments
 *   - Active subscription tier per user
 *
 * NOT for:
 *   - Wallet balances (must always be fresh)
 *   - Open orders/positions (must always be fresh)
 *   - Anything money-related
 *
 * For multi-server: replace with Redis. The interface is the same.
 *
 * Capacity: limits total entries; evicts LRU when full.
 */

const DEFAULT_TTL_MS = 60 * 1000;       // 1 minute
const MAX_ENTRIES = 1000;

const store = new Map(); // key -> { value, expiresAt }

const get = (key) => {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  // Move to end (LRU)
  store.delete(key);
  store.set(key, entry);
  return entry.value;
};

const set = (key, value, ttlMs = DEFAULT_TTL_MS) => {
  // Enforce size limit (LRU eviction)
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const del = (key) => store.delete(key);
const clear = () => store.clear();
const size = () => store.size;

/**
 * Cache-aside pattern: try cache first, else fetch and cache.
 *
 * @example
 *   const inst = await cache.getOrFetch(`inst:${symbol}`, async () => {
 *     return Instrument.findOne({ symbol }).lean();
 *   }, 30 * 1000);
 */
const getOrFetch = async (key, fetchFn, ttlMs = DEFAULT_TTL_MS) => {
  const cached = get(key);
  if (cached !== null) return cached;
  const value = await fetchFn();
  if (value !== null && value !== undefined) {
    set(key, value, ttlMs);
  }
  return value;
};

/**
 * Invalidate a key or all keys with given prefix.
 */
const invalidatePrefix = (prefix) => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
};

module.exports = {
  get,
  set,
  del,
  clear,
  size,
  getOrFetch,
  invalidatePrefix,
};
