const mongoose = require('mongoose');

/**
 * Audit trail for every leverage-state change on a user account.
 *
 * Written by leverageService whenever:
 *   • Admin sets a customLeverage override
 *   • Admin clears an override (returns user to plan default)
 *   • Admin runs a bulk update
 *   • A plan change (upgrade / downgrade) shifts the effective leverage
 *
 * Read by the admin "Leverage history" modal so support can answer
 * "who lowered this user's leverage and when".
 *
 * Why a separate collection (not embedded in User.history[]): keeps the
 * User doc small + lets the log scale independently with TTL or archival
 * later. Indexed by userId + createdAt for fast per-user lookups.
 */
const leverageLogSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The actor that triggered the change. Null = system (plan upgrade,
    // expiry, etc.). Otherwise the admin's User _id.
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: {
      type: String,
      enum: ['SET_OVERRIDE', 'CLEAR_OVERRIDE', 'PLAN_CHANGE', 'BULK_UPDATE'],
      required: true,
    },
    // Snapshot the BEFORE / AFTER so the audit row is self-contained
    // and doesn't depend on joining the current User state to interpret.
    from: {
      effective:      { type: Number, default: null },
      customLeverage: { type: Number, default: null },
      planDefault:    { type: Number, default: null },
      source:         { type: String, default: null }, // 'admin' | '<plan_code>'
    },
    to: {
      effective:      { type: Number, default: null },
      customLeverage: { type: Number, default: null },
      planDefault:    { type: Number, default: null },
      source:         { type: String, default: null },
    },
    reason: { type: String, default: null },
    // For bulk updates — links rows from the same batch so admin can
    // see "this change was part of a 24-user mass adjustment".
    batchId: { type: String, default: null, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index: most lookups are "give me this user's last 50 changes".
leverageLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('LeverageLog', leverageLogSchema);
