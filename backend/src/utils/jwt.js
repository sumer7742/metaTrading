const jwt = require('jsonwebtoken');

/**
 * Fail-fast at startup if either secret is missing — without this,
 * `jwt.sign(payload, undefined)` throws on the first auth request and the
 * error is buried in the request stack instead of the boot logs.
 *
 * Call once from server.js so a misconfigured deployment never starts
 * silently and only blows up when the first user tries to log in.
 */
const assertSecrets = () => {
  const missing = [];
  if (!process.env.JWT_ACCESS_SECRET) missing.push('JWT_ACCESS_SECRET');
  if (!process.env.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET');
  if (missing.length) {
    throw new Error(
      `Required JWT env vars not set: ${missing.join(', ')}. ` +
      `Add them to .env before starting the server.`
    );
  }
};

const signAccessToken = (payload, opts = {}) =>
  jwt.sign(payload, process.env.JWT_ACCESS_SECRET, {
    expiresIn: opts.expiresIn || process.env.JWT_ACCESS_EXPIRES || '15m',
  });

const signRefreshToken = (payload) =>
  jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
  });

const verifyAccessToken = (token) => jwt.verify(token, process.env.JWT_ACCESS_SECRET);
const verifyRefreshToken = (token) => jwt.verify(token, process.env.JWT_REFRESH_SECRET);

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, assertSecrets };
