/**
 * Broker read-model cache (CQRS query side).
 *
 * Redis when REDIS_URL is set (shared across API instances), in-process Map
 * otherwise — same interface either way, so nothing above this file knows or
 * cares. A Redis outage degrades to the in-memory path instead of taking
 * portfolio endpoints down with it.
 *
 * WHAT IS CACHED (short TTLs — this is burst absorption, not a data store):
 *   funds       5s     positions 3s     holdings 30s
 *   orders      2s     quotes    1s     marketStatus 30s
 *
 * WHAT IS NEVER CACHED:
 *   credentials, order acknowledgements, anything write-side.
 *
 * Every cached key is namespaced by userId, so one user can never read
 * another's portfolio out of the cache.
 */

const logger = require('../../utils/logger');

const PREFIX = 'bkr';

const TTL = {
  funds: Number(process.env.BROKER_CACHE_TTL_FUNDS_MS) || 5000,
  positions: Number(process.env.BROKER_CACHE_TTL_POSITIONS_MS) || 3000,
  holdings: Number(process.env.BROKER_CACHE_TTL_HOLDINGS_MS) || 30000,
  orders: Number(process.env.BROKER_CACHE_TTL_ORDERS_MS) || 2000,
  history: Number(process.env.BROKER_CACHE_TTL_HISTORY_MS) || 60000,
  quotes: Number(process.env.BROKER_CACHE_TTL_QUOTES_MS) || 1000,
  marketStatus: Number(process.env.BROKER_CACHE_TTL_MARKET_MS) || 30000,
  instrument: Number(process.env.BROKER_CACHE_TTL_INSTRUMENT_MS) || 10 * 60 * 1000,
};

// ─── Backends ────────────────────────────────────────────────────────

class MemoryBackend {
  constructor() {
    this.store = new Map();
    this.max = Number(process.env.BROKER_CACHE_MAX_ENTRIES) || 5000;
  }

  async get(key) {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.store.delete(key); return null; }
    return e.value;
  }

  async set(key, value, ttlMs) {
    if (this.store.size >= this.max) {
      // Cheap eviction: drop the oldest insertion (Map preserves order).
      const first = this.store.keys().next().value;
      if (first) this.store.delete(first);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key) { this.store.delete(key); }

  async delPrefix(prefix) {
    for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
  }

  describe() { return { backend: 'memory', entries: this.store.size }; }
}

class RedisBackend {
  constructor(client) { this.client = client; this.healthy = true; }

  async get(key) {
    try {
      const raw = await this.client.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { this._degrade(e); return null; }
  }

  async set(key, value, ttlMs) {
    try {
      await this.client.set(key, JSON.stringify(value), 'PX', ttlMs);
    } catch (e) { this._degrade(e); }
  }

  async del(key) {
    try { await this.client.del(key); } catch (e) { this._degrade(e); }
  }

  async delPrefix(prefix) {
    try {
      // SCAN, never KEYS — KEYS blocks the Redis event loop.
      let cursor = '0';
      do {
        const [next, batch] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (batch.length) await this.client.del(...batch);
      } while (cursor !== '0');
    } catch (e) { this._degrade(e); }
  }

  _degrade(e) {
    if (this.healthy) {
      this.healthy = false;
      logger.warn('Broker cache: Redis error — serving uncached', { err: e });
      setTimeout(() => { this.healthy = true; }, 30000).unref();
    }
  }

  describe() { return { backend: 'redis', healthy: this.healthy }; }
}

let _backend = null;

function backend() {
  if (_backend) return _backend;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const Redis = require('ioredis');
      const client = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });
      client.on('error', (e) => logger.warn('Broker cache Redis connection error', { err: e }));
      _backend = new RedisBackend(client);
      logger.info('[broker] cache backend: redis');
      return _backend;
    } catch (e) {
      logger.warn('[broker] ioredis unavailable — using in-memory cache', { err: e });
    }
  }
  _backend = new MemoryBackend();
  return _backend;
}

// ─── Public API ──────────────────────────────────────────────────────

const key = (kind, userId, broker, suffix = '') =>
  `${PREFIX}:${kind}:${userId}:${broker}${suffix ? `:${suffix}` : ''}`;

const get = (k) => backend().get(k);
const set = (k, v, ttlMs) => backend().set(k, v, ttlMs);
const del = (k) => backend().del(k);

/**
 * Cache-aside with a `force` bypass (the UI's pull-to-refresh must always hit
 * the broker) and negative-result protection: `null`/`undefined` is not cached.
 */
async function getOrFetch(k, ttlMs, fetchFn, { force = false } = {}) {
  if (!force) {
    const hit = await get(k);
    if (hit !== null && hit !== undefined) return hit;
  }
  const value = await fetchFn();
  if (value !== null && value !== undefined) await set(k, value, ttlMs);
  return value;
}

/** Blow away every read model for a user+broker — called after any write. */
async function invalidateUser(userId, broker) {
  const b = backend();
  const kinds = ['funds', 'positions', 'holdings', 'orders', 'history'];
  await Promise.all(kinds.map((kind) => b.delPrefix(`${PREFIX}:${kind}:${userId}:${broker}`)));
}

const describe = () => ({ ...backend().describe(), ttl: TTL });

module.exports = { key, get, set, del, getOrFetch, invalidateUser, describe, TTL };
