/**
 * OrderQueue — every outbound broker request passes through here.
 *
 *   Broker Queue → Rate Limiter → Broker Adapter
 *
 * Nothing calls an adapter directly. That guarantees:
 *   - broker API limits are never exceeded (the limiter gates each dequeue),
 *   - a burst of orders degrades into a queue instead of a wall of 429s,
 *   - retries are uniform and observable across all brokers,
 *   - cancels/exits jump ahead of new entries (priority).
 *
 * Ordering: strict FIFO **within a priority level** (insertion sequence is the
 * tiebreaker), higher priority first. A retried task keeps its original
 * sequence number, so it re-enters ahead of tasks queued after it rather than
 * going to the back of the line.
 *
 * Retries: only for errors flagged retryable (rate limit / timeout / network /
 * broker offline) with exponential backoff + jitter. Deterministic rejections
 * (margin, quantity, invalid token) are never retried.
 *
 * ⚠️ Retry safety for PLACE orders: every place request carries a
 * clientOrderId that the broker echoes back (Dhan `correlationId`). After a
 * timeout the caller reconciles by clientOrderId before accepting a retry
 * result, so a network-level double-send cannot create two live orders. See
 * services/broker/brokerOrder.service.js.
 */

const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const { PRIORITY, RATE_CATEGORY } = require('../constants');
const logger = require('../../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class QueuedTask {
  constructor(fn, opts, seq) {
    this.fn = fn;
    this.seq = seq;
    this.priority = opts.priority != null ? opts.priority : PRIORITY.NORMAL;
    this.category = opts.category || RATE_CATEGORY.DEFAULT;
    this.label = opts.label || 'task';
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 2;
    this.timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30000;
    this.meta = opts.meta || {};
    this.attempts = 0;
    this.enqueuedAt = Date.now();
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class OrderQueue {
  /**
   * @param {object} opts
   * @param {string} opts.broker
   * @param {import('./RateLimiter').RateLimiter} opts.rateLimiter
   * @param {number} [opts.concurrency=4]   parallel in-flight requests
   * @param {number} [opts.maxQueueSize=1000]
   * @param {number} [opts.baseBackoffMs=250]
   * @param {number} [opts.maxBackoffMs=8000]
   */
  constructor({ broker, rateLimiter, concurrency, maxQueueSize, baseBackoffMs, maxBackoffMs } = {}) {
    this.broker = String(broker || '').toUpperCase();
    this.rateLimiter = rateLimiter;
    this.concurrency = Number(concurrency) > 0 ? Number(concurrency) : 4;
    this.maxQueueSize = Number(maxQueueSize) > 0 ? Number(maxQueueSize) : 1000;
    this.baseBackoffMs = Number(baseBackoffMs) > 0 ? Number(baseBackoffMs) : 250;
    this.maxBackoffMs = Number(maxBackoffMs) > 0 ? Number(maxBackoffMs) : 8000;

    /** @type {QueuedTask[]} sorted: priority desc, seq asc */
    this._queue = [];
    this._running = 0;
    this._seq = 0;
    this._draining = false;
    this._stats = { enqueued: 0, completed: 0, failed: 0, retried: 0, rejected: 0, totalWaitMs: 0 };
    this._listeners = [];
  }

  /** Subscribe to lifecycle events for metrics/audit: fn(event, payload). */
  on(fn) { if (typeof fn === 'function') this._listeners.push(fn); }

  _emit(event, payload) {
    for (const fn of this._listeners) {
      try { fn(event, payload); } catch (_) { /* a listener must never break the queue */ }
    }
  }

  /**
   * Submit work. Resolves with the task's return value, rejects with a
   * BrokerError.
   *
   * @param {() => Promise<any>} fn
   * @param {object} [opts] { priority, category, label, maxRetries, timeoutMs, meta }
   */
  enqueue(fn, opts = {}) {
    if (typeof fn !== 'function') throw new Error('OrderQueue.enqueue: fn must be a function');
    if (this._draining) {
      return Promise.reject(new BrokerError(
        ERROR_CODE.BROKER_OFFLINE,
        'Server is shutting down — order not submitted.',
        { broker: this.broker }
      ));
    }
    if (this._queue.length >= this.maxQueueSize) {
      this._stats.rejected++;
      return Promise.reject(new BrokerError(
        ERROR_CODE.QUEUE_OVERFLOW,
        `${this.broker} request queue is full (${this.maxQueueSize}). Try again shortly.`,
        { broker: this.broker }
      ));
    }

    const task = new QueuedTask(fn, opts, this._seq++);
    this._insert(task);
    this._stats.enqueued++;
    this._emit('enqueued', { broker: this.broker, label: task.label, priority: task.priority, depth: this._queue.length, meta: task.meta });
    setImmediate(() => this._pump());
    return task.promise;
  }

  /** Priority-ordered insert; FIFO within a priority level. */
  _insert(task) {
    let lo = 0;
    let hi = this._queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = this._queue[mid];
      const before = t.priority > task.priority || (t.priority === task.priority && t.seq < task.seq);
      if (before) lo = mid + 1; else hi = mid;
    }
    this._queue.splice(lo, 0, task);
  }

  _pump() {
    while (this._running < this.concurrency && this._queue.length) {
      const task = this._queue.shift();
      this._running++;
      this._run(task).finally(() => {
        this._running--;
        if (this._queue.length) setImmediate(() => this._pump());
      });
    }
  }

  async _run(task) {
    task.attempts++;
    const waitedMs = Date.now() - task.enqueuedAt;
    try {
      // Gate 2: rate limiter. Waits for a slot; throws RATE_LIMIT if the wait
      // would exceed the task's own timeout budget.
      if (this.rateLimiter) {
        await this.rateLimiter.acquire(task.category, { timeoutMs: task.timeoutMs });
      }

      this._emit('started', { broker: this.broker, label: task.label, attempt: task.attempts, waitedMs, meta: task.meta });
      const startedAt = Date.now();
      const result = await task.fn({ attempt: task.attempts, broker: this.broker });
      const durationMs = Date.now() - startedAt;

      this._stats.completed++;
      this._stats.totalWaitMs += waitedMs;
      this._emit('completed', { broker: this.broker, label: task.label, attempt: task.attempts, waitedMs, durationMs, meta: task.meta });
      task.resolve(result);
    } catch (rawErr) {
      const err = BrokerError.from(rawErr, this.broker);
      const canRetry = err.retryable && task.attempts <= task.maxRetries && !this._draining;

      if (canRetry) {
        this._stats.retried++;
        const backoff = this._backoff(task.attempts, err);
        this._emit('retry', {
          broker: this.broker, label: task.label, attempt: task.attempts,
          code: err.code, backoffMs: backoff, meta: task.meta,
        });
        logger.warn('Broker request retry', {
          broker: this.broker, label: task.label, attempt: task.attempts,
          code: err.code, backoffMs: backoff,
        });
        await sleep(backoff);
        // Re-queue keeping the ORIGINAL seq so it doesn't lose its place.
        this._insert(task);
        setImmediate(() => this._pump());
        return;
      }

      this._stats.failed++;
      this._emit('failed', { broker: this.broker, label: task.label, attempt: task.attempts, code: err.code, meta: task.meta });
      task.reject(err);
    }
  }

  /** Exponential backoff with ±25% jitter; rate limits wait a little longer. */
  _backoff(attempt, err) {
    const base = err && err.code === ERROR_CODE.RATE_LIMIT ? this.baseBackoffMs * 4 : this.baseBackoffMs;
    const raw = Math.min(base * 2 ** (attempt - 1), this.maxBackoffMs);
    const jitter = raw * 0.25 * (Math.random() * 2 - 1);
    return Math.max(50, Math.round(raw + jitter));
  }

  stats() {
    return {
      broker: this.broker,
      depth: this._queue.length,
      running: this._running,
      concurrency: this.concurrency,
      ...this._stats,
      avgWaitMs: this._stats.completed ? Math.round(this._stats.totalWaitMs / this._stats.completed) : 0,
    };
  }

  /** Stop accepting work and wait for in-flight tasks (graceful shutdown). */
  async drain(timeoutMs = 10000) {
    this._draining = true;
    const deadline = Date.now() + timeoutMs;
    while ((this._running > 0 || this._queue.length > 0) && Date.now() < deadline) {
      await sleep(50);
    }
    // Anything still queued never reached the broker — fail it explicitly so
    // callers (and the DB) record FAILED rather than hanging forever.
    for (const task of this._queue.splice(0)) {
      task.reject(new BrokerError(ERROR_CODE.BROKER_OFFLINE, 'Server shut down before the order was sent.', { broker: this.broker }));
    }
    return this.stats();
  }
}

/** One queue per broker — brokers never share back-pressure. */
class OrderQueueRegistry {
  constructor() { this._byBroker = new Map(); }

  for(broker, opts = {}) {
    const key = String(broker).toUpperCase();
    let q = this._byBroker.get(key);
    if (!q) {
      q = new OrderQueue({
        broker: key,
        rateLimiter: opts.rateLimiter,
        concurrency: Number(process.env[`BROKER_QUEUE_${key}_CONCURRENCY`]) || opts.concurrency,
        maxQueueSize: Number(process.env[`BROKER_QUEUE_${key}_MAX`]) || opts.maxQueueSize,
        baseBackoffMs: opts.baseBackoffMs,
        maxBackoffMs: opts.maxBackoffMs,
      });
      this._byBroker.set(key, q);
    }
    return q;
  }

  stats() { return [...this._byBroker.values()].map((q) => q.stats()); }

  async drainAll(timeoutMs = 10000) {
    return Promise.all([...this._byBroker.values()].map((q) => q.drain(timeoutMs)));
  }
}

module.exports = { OrderQueue, OrderQueueRegistry, PRIORITY, registry: new OrderQueueRegistry() };
