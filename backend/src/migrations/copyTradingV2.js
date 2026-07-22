/**
 * Copy-Trading v2 migration — investment-wallet → account-based.
 *
 * For every CopyRelation:
 *   1. Release any held "investment" allocation back to the account's free
 *      balance (v2 funds mirrors from the account directly — no separate hold).
 *   2. Back-fill the new lot/settings fields from the old risk model so existing
 *      sessions keep working (no data loss, no duplicate sessions).
 *
 * Idempotent: re-running only releases holds that still have heldAmount > 0.
 *
 *   node backend/src/migrations/copyTradingV2.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const CopyRelation = require('../models/CopyRelation');
  const TradingAccount = require('../models/TradingAccount');
  const walletService = require('../services/walletService');

  const rels = await CopyRelation.find({});
  let released = 0, releasedAmt = 0, backfilled = 0;

  for (const rel of rels) {
    // 1) Release the leftover investment hold back to free balance.
    const held = Number(rel.heldAmount || 0);
    if (held > 0) {
      const acc = await TradingAccount.findById(rel.followerAccountId).select('baseCurrency').lean();
      const currency = acc?.baseCurrency || 'USD';
      try {
        await walletService.releaseMargin({
          userId: rel.followerId, accountId: rel.followerAccountId, currency,
          amount: String(held), orderId: rel._id, note: 'Copy v2 migration: release investment hold',
        });
        released++; releasedAmt += held;
      } catch (e) {
        console.warn('  release failed for', String(rel._id), '-', e.message);
      }
      rel.heldAmount = '0';
    }

    // 2) Back-fill the new lot-based settings from the old risk model.
    if (['LOW', 'MEDIUM', 'HIGH'].includes(rel.riskLevel)) rel.lotMode = rel.riskLevel;
    else if (!rel.lotMode) rel.lotMode = 'MEDIUM';
    // Old CUSTOM was a *multiplier* → carry it as lotMultiplier on a MEDIUM base.
    if (rel.riskLevel === 'CUSTOM' && Number(rel.customMultiplier) > 0) {
      rel.lotMode = 'MEDIUM';
      rel.lotMultiplier = Number(rel.customMultiplier);
    }
    rel.copySL = rel.syncSlTp !== false;
    rel.copyTP = rel.syncSlTp !== false;
    rel.investment = '0';
    await rel.save();
    backfilled++;
  }

  console.log(`\n✓ Copy-trading v2 migration complete.`);
  console.log(`  relations processed : ${backfilled}`);
  console.log(`  holds released      : ${released} (≈ ${releasedAmt.toFixed(2)} in account currency)`);
  await mongoose.disconnect();
})().catch((e) => { console.error('MIGRATION ERROR:', e.message); process.exit(1); });
