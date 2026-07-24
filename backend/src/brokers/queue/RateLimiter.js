/**
 * RateLimiter — per-broker, per-category request governor.
 *
 * Every broker publishes different limits for different classes of API
 * (Dhan: 25 order requests/sec but only 5 quote requests/sec, plus daily
 * caps). Exceeding them gets an account throttled or suspended, so this is a
 * hard gate in front of EVERY outbound call — no adapter may bypass it.
 *
 * Design:
 *   - Sliding-window counters per (category × window). A request is admitted
 *     only when it fits inside EVERY configured window (sec/min/hour/day).
 *   - `acquire()` waits instead of failing: callers are already inside the
 *     OrderQueue, so back-pressure is the correct behaviour. It fails with
 *     RATE_LIMIT only if the wait would exceed `timeoutMs`.
 *   - Limiters are per-broker and independent: a Dhan burst can never throttle
 *     Upstox, and vice versa.
 *
 * Scope: in-process. With multiple API instances, set each instance's limits
 * to (broker limit / instance count) via env, or swap `_admit` for a Redis
 * Lua token bucket — the public interface does not change.
 */

const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const { RATE_CATEGORY } = require('../constants');

const WINDOWS = [
  { key: 'perSecond', ms: 1000 },
  { key: 'perMinute', ms: 60 * 1000 },
  { key: 'perHour', ms: 60 * 60 * 1000 },
  { key: 'perDay', ms: 24 * 60 * 60 * 1000 },
];

class SlidingWindow {
  constructor(windowMs, limit) {
    this.windowMs = windowMs;
    this.limit = limit;
    /** @type {number[]} monotonically increasing hit timestamps */
    this.hits = [];
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    // Hits are appended in order, so a single leading trim is enough.
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  /** ms until a slot frees up (0 = free now). */
  retryAfter(now) {
    this._prune(now);
    if (this.hits.length < this.limit) return 0;
    return Math.max(1, this.hits[0] + this.windowMs - now);
  }

  record(now) { this.hits.push(now); }

  used(now) { this._prune(now); return this.hits.length; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
  /**
   * @param {object} opts
   * @param {string} opts.broker
   * @param {object} opts.limits  { orders: {perSecond, perMinute, perDay}, data: {...}, default: {...} }
   */
  constructor({ broker, limits = {} } = {}) {
    this.broker = broker;
    this.limits = limits;
    /** @type {Map<string, SlidingWindow[]>} */
    this._windows = new Map();
    this._waiting = 0;
    this._admitted = 0;
    this._throttled = 0;
  }

  _limitsFor(category) {
    return this.limits[category] || this.limits[RATE_CATEGORY.DEFAULT] || { perSecond: 5 };
  }

  _windowsFor(category) {
    let w = this._windows.get(category);
    if (!w) {
      const cfg = this._limitsFor(category);
      w = WINDOWS
        .filter(({ key }) => Number(cfg[key]) > 0)
        .map(({ key, ms }) => new SlidingWindow(ms, Number(cfg[key])));
      // Always have at least one window so a misconfigured category can't
      // become an unlimited firehose.
      if (!w.length) w = [new SlidingWindow(1000, 5)];
      this._windows.set(category, w);
    }
    return w;
  }

  /**
   * Non-blocking check + reserve.
   * @returns {{ok: true} | {ok: false, retryAfterMs: number}}
   */
  tryAcquire(category = RATE_CATEGORY.DEFAULT) {
    const now = Date.now();
    const windows = this._windowsFor(category);
    let wait = 0;
    for (const w of windows) {
      const r = w.retryAfter(now);
      if (r > wait) wait = r;
    }
    if (wait > 0) {
      this._throttled++;
      return { ok: false, retryAfterMs: wait };
    }
    for (const w of windows) w.record(now);
    this._admitted++;
    return { ok: true };
  }

  /**
   * Blocking acquire with back-pressure.
   * @param {string} category
   * @param {object} [opts] { timeoutMs = 15000, signal }
   * @throws {BrokerError} RATE_LIMIT when the wait exceeds timeoutMs
   */
  async acquire(category = RATE_CATEGORY.DEFAULT, opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 15000;
    const deadline = Date.now() + timeoutMs;
    this._waiting++;
    try {
      for (;;) {
        if (opts.signal && opts.signal.aborted) {
          throw new BrokerError(ERROR_CODE.TIMEOUT, 'Request aborted while waiting for rate-limit slot.', { broker: this.broker });
        }
        const res = this.tryAcquire(category);
        if (res.ok) return true;

        const remaining = deadline - Date.now();
        if (res.retryAfterMs > remaining) {
          throw new BrokerError(
            ERROR_CODE.RATE_LIMIT,
            `${this.broker} rate limit reached for "${category}". Retry in ${Math.ceil(res.retryAfterMs / 1000)}s.`,
            { broker: this.broker, details: { category, retryAfterMs: res.retryAfterMs } }
          );
        }
        // +5ms so we wake just AFTER the window rolls, not on the boundary.
        await sleep(Math.min(res.retryAfterMs + 5, remaining));
      }
    } finally {
      this._waiting--;
    }
  }

  stats() {
    const now = Date.now();
    const categories = {};
    for (const [cat, windows] of this._windows) {
      categories[cat] = windows.map((w) => ({
        windowMs: w.windowMs,
        limit: w.limit,
        used: w.used(now),
      }));
    }
    return {
      broker: this.broker,
      waiting: this._waiting,
      admitted: this._admitted,
      throttled: this._throttled,
      categories,
    };
  }
}

/**
 * One limiter per broker. Limits come from the broker descriptor, with an env
 * override hook (`BROKER_RATELIMIT_<BROKER>_<CATEGORY>_PERSECOND`) so ops can
 * dial a broker down during an incident without a deploy.
 */
class RateLimiterRegistry {
  constructor() { this._byBroker = new Map(); }

  for(broker, limits) {
    const key = String(broker).toUpperCase();
    let limiter = this._byBroker.get(key);
    if (!limiter) {
      limiter = new RateLimiter({ broker: key, limits: _withEnvOverrides(key, limits || {}) });
      this._byBroker.set(key, limiter);
    }
    return limiter;
  }

  stats() { return [...this._byBroker.values()].map((l) => l.stats()); }
  reset() { this._byBroker.clear(); }
}

function _withEnvOverrides(broker, limits) {
  const out = JSON.parse(JSON.stringify(limits || {}));
  for (const category of Object.keys(out)) {
    for (const { key } of WINDOWS) {
      const envKey = `BROKER_RATELIMIT_${broker}_${category.toUpperCase()}_${key.toUpperCase()}`;
      const v = Number(process.env[envKey]);
      if (Number.isFinite(v) && v > 0) out[category][key] = v;
    }
  }
  return out;
}

module.exports = { RateLimiter, RateLimiterRegistry, SlidingWindow, registry: new RateLimiterRegistry() };
