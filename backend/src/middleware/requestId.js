/**
 * Request ID middleware — attaches a stable UUID to every request so logs,
 * metrics, and error reports can be correlated end-to-end.
 *
 *   - Honors an inbound `X-Request-Id` header so an upstream gateway can
 *     thread its own ID through (useful when sitting behind CloudFlare or
 *     an API gateway).
 *   - Otherwise generates a fresh v4 UUID.
 *   - Echoes the ID back in the response header so the client can quote it
 *     in bug reports.
 */
const { v4: uuidv4 } = require('uuid');

module.exports = function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const id = (typeof inbound === 'string' && inbound.length > 0 && inbound.length < 200)
    ? inbound
    : uuidv4();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};
