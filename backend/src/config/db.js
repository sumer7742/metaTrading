const mongoose = require('mongoose');
const dns = require('dns');

// Some Windows machines have a stale 127.0.0.1 DNS entry (from a VPN or proxy
// that's no longer running) which makes Node's c-ares resolver fail with
// `querySrv ECONNREFUSED` on mongodb+srv:// URIs. Force a healthy resolver list.
const ensureDnsResolvers = () => {
  try {
    const current = dns.getServers();
    const onlyLoopback = current.length === 0 || current.every((s) => s === '127.0.0.1' || s === '::1');
    if (onlyLoopback) {
      const fallback = ['1.1.1.1', '8.8.8.8', '1.0.0.1', '8.8.4.4'];
      dns.setServers(fallback);
      console.log(`[DB] DNS resolvers were ${JSON.stringify(current)} — switched to ${JSON.stringify(fallback)}`);
    }
  } catch (e) {
    console.warn('[DB] Could not adjust DNS resolvers:', e.message);
  }
};

/**
 * MongoDB connection with production-grade pooling.
 *
 * maxPoolSize: 50 — handles up to 50 concurrent DB operations.
 * minPoolSize: 5 — keeps at least 5 connections warm.
 * socketTimeoutMS: 45000 — kills hung sockets after 45s.
 * serverSelectionTimeoutMS: 10000 — fail fast if MongoDB is down.
 */
const connectDB = async () => {
  ensureDnsResolvers();

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[DB] MONGODB_URI is not set in .env');
    process.exit(1);
  }

  const opts = {
    maxPoolSize: 50,
    minPoolSize: 5,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 10000,
    retryWrites: true,
    heartbeatFrequencyMS: 10000,
  };

  try {
    const conn = await mongoose.connect(uri, opts);
    console.log(`[DB] MongoDB connected: ${conn.connection.host} (pool: 5-50)`);

    if (process.env.NODE_ENV !== 'production') {
      mongoose.set('debug', false);
    }

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] MongoDB disconnected — auto-reconnect attempting');
    });
    mongoose.connection.on('reconnected', () => {
      console.log('[DB] MongoDB reconnected');
    });
  } catch (err) {
    // Friendlier diagnostics for the most common Atlas/SRV failure modes.
    const code = err && (err.code || err.cause?.code);
    if (code === 'ECONNREFUSED' && /querySrv/i.test(err.message || '')) {
      console.error('[DB] DNS SRV lookup refused. Likely a bad system DNS server.');
      console.error('[DB] Quick fixes:');
      console.error('  1) Set Wi-Fi DNS to 1.1.1.1 / 8.8.8.8 in Windows network settings.');
      console.error('  2) Or replace mongodb+srv:// in .env with the long mongodb:// host list from Atlas.');
      console.error('  3) Or run a local mongo:  MONGODB_URI=mongodb://localhost:27017/trading_platform');
    } else if (code === 'ENOTFOUND') {
      console.error('[DB] Host not found — check internet / VPN / firewall.');
    } else if (/Authentication failed/i.test(err.message || '')) {
      console.error('[DB] Auth failed — check MongoDB user/password in MONGODB_URI.');
    } else if (/IP that isn't whitelisted|not allowed to connect/i.test(err.message || '')) {
      console.error('[DB] Atlas IP whitelist — add your IP in Atlas → Network Access.');
    }
    console.error('[DB] Connection error:', err.message);
    process.exit(1);
  }
};

module.exports = { connectDB };
