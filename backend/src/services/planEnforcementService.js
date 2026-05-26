/**
 * Plan enforcement — keeps the user's TradingAccount roster in sync with
 * their subscription plan's `maxAccounts` cap.
 *
 * Rules (per spec):
 *   - Downgrade (or payment-failed → FREE): keep the oldest N accounts
 *     active where N = plan.maxAccounts; mark the rest planSuspendedAt.
 *     Suspended accounts CANNOT open new orders but CAN still close
 *     positions and accept withdrawals.
 *   - Upgrade: lift suspension on previously-suspended accounts up to the
 *     new cap. Oldest-suspended-first so account stability is preserved.
 *   - Plans with maxAccounts === null (POSTPAID): unlimited, no suspension.
 *
 * The "oldest = kept" rule matches user expectation: their primary trading
 * account (signed-up first) is rarely the one they want to lose.
 */
const TradingAccount = require('../models/TradingAccount');

/**
 * Apply the plan's maxAccounts cap. Suspends excess (newest first), lifts
 * suspensions within new cap (oldest-suspended first). Idempotent — safe
 * to call repeatedly.
 *
 * @param {ObjectId|string} userId
 * @param {Object} plan         Subscription plan doc (lean or hydrated).
 * @param {string} [reason]     Suspension reason stamped on suspended rows.
 * @returns {Promise<{suspended: number, lifted: number, cap: number|null}>}
 */
async function enforce(userId, plan, reason = 'Plan downgrade — over plan limit') {
  const rawCap = plan?.limits?.maxAccounts;
  const unlimited = rawCap == null || rawCap < 0;
  const cap = unlimited ? Infinity : Number(rawCap);

  // Oldest-first so a tie-breaker on createdAt gives stable membership.
  const accounts = await TradingAccount.find({ userId, isActive: true })
    .sort({ createdAt: 1 })
    .select('_id accountNumber createdAt planSuspendedAt');

  const planCode = plan?.code || 'FREE';
  const suspensionReason = `${reason} (now on ${planCode})`;

  let suspended = 0;
  let lifted = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const shouldBeActive = i < cap; // first N stay active
    const isCurrentlySuspended = !!acc.planSuspendedAt;
    if (shouldBeActive && isCurrentlySuspended) {
      acc.planSuspendedAt = null;
      acc.planSuspendedReason = null;
      await acc.save();
      lifted++;
    } else if (!shouldBeActive && !isCurrentlySuspended) {
      acc.planSuspendedAt = new Date();
      acc.planSuspendedReason = suspensionReason;
      await acc.save();
      suspended++;
    }
  }

  return {
    suspended,
    lifted,
    cap: unlimited ? null : cap,
    total: accounts.length,
    planCode,
  };
}

/**
 * Lift every suspension on every account belonging to the user. Used as a
 * blanket reset (e.g. admin manual override). Normal upgrades should go
 * through enforce() so the cap is still respected.
 */
async function liftAll(userId, reason = 'Admin override') {
  const result = await TradingAccount.updateMany(
    { userId, planSuspendedAt: { $ne: null } },
    { $set: { planSuspendedAt: null, planSuspendedReason: null } }
  );
  return { lifted: result.modifiedCount || 0, reason };
}

/**
 * Returns true if the account is currently plan-suspended.
 * Treat as "trading disabled, withdrawal allowed".
 */
function isSuspended(account) {
  return !!(account && account.planSuspendedAt);
}

module.exports = { enforce, liftAll, isSuspended };
