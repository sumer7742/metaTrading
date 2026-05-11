/**
 * Lightweight JSON logger — no external dep needed.
 *
 *   logger.info('Order placed', { userId, orderId })
 *   logger.warn('LP slow', { latencyMs })
 *   logger.error('Settle failed', { err: e.message, stack: e.stack })
 *
 * Outputs one JSON object per line to stdout/stderr so Datadog / Grafana
 * Loki / Cloudwatch / Splunk can ingest without a parser config.
 *
 * In `dev` (NODE_ENV !== 'production') logs are pretty-printed for
 * readability. In production they're compact JSON.
 *
 * Pass `req` as one of the fields and the request id + path are pulled
 * automatically — no need to thread reqId through every call site.
 */
const PRETTY = (process.env.NODE_ENV || 'development') !== 'production';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const _enrich = (fields) => {
  const out = { ...fields };
  if (out.req && typeof out.req === 'object') {
    out.reqId = out.req.id;
    out.path = out.req.path || out.req.url;
    out.userId = out.req.userId;
    delete out.req;
  }
  if (out.err instanceof Error) {
    out.errMessage = out.err.message;
    out.errStack = out.err.stack;
    delete out.err;
  }
  return out;
};

const _emit = (level, msg, fields = {}) => {
  if (LEVELS[level] < MIN) return;
  const rec = { ts: new Date().toISOString(), level, msg, ..._enrich(fields) };
  const line = JSON.stringify(rec);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (PRETTY) {
    const { ts, level: lvl, msg: m, ...rest } = rec;
    const extras = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    stream.write(`[${ts}] ${lvl.toUpperCase()} ${m}${extras}\n`);
  } else {
    stream.write(line + '\n');
  }
};

module.exports = {
  debug: (msg, fields) => _emit('debug', msg, fields),
  info:  (msg, fields) => _emit('info',  msg, fields),
  warn:  (msg, fields) => _emit('warn',  msg, fields),
  error: (msg, fields) => _emit('error', msg, fields),
};
