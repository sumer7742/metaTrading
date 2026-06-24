/**
 * import-mcx-futures.js — import MCX commodity futures (GOLD/SILVER/CRUDEOIL/…)
 * from Dhan. Near-expiry only; deactivates old. Pair with map-upstox-fno.js for
 * live prices (Upstox MCX_FO).
 *
 *   docker compose exec backend node scripts/import-mcx-futures.js
 *   DHAN_SYNC_MCX=GOLD,SILVER,CRUDEOIL node scripts/import-mcx-futures.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { syncMcxFutures } = require('../src/services/mcxSync');

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);
  const r = await syncMcxFutures();
  console.log('[mcx]', r);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
