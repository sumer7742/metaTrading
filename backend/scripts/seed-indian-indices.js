/**
 * seed-indian-indices.js — create/refresh the Indian INDEX spot instruments
 * (NIFTY 50, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX). Idempotent — safe to
 * re-run; never clobbers a live lastPrice. Run inside the backend container so
 * it inherits MONGODB_URI:
 *
 *   docker compose exec backend node scripts/seed-indian-indices.js
 *
 * After it runs, the live feed (Upstox/Yahoo) starts ticking these tiles
 * automatically during market hours — no feed change needed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ensureIndianIndices } = require('../src/services/indianIndices');

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);
  try {
    const r = await ensureIndianIndices();
    console.log(`[indices] ensured ${r.total} index spots → inserted ${r.inserted}, updated ${r.updated}`);
    console.log(`[indices] symbols: ${r.symbols.join(', ')}`);
    console.log('[indices] Live values will populate within seconds while NSE/BSE is open.');
  } catch (e) {
    console.error('[indices] failed:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
