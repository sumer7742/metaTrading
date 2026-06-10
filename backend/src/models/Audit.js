const mongoose = require('mongoose');

/**
 * Account freeze request — raised by the Audit Manager (read-only role, so it
 * cannot freeze directly) for a SUPER_ADMIN / ADMIN to review and action.
 * Approving sets the user's `isActive` to false (login + trading blocked).
 */
const freezeRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true },
    category: { type: String, default: 'OTHER' },
    requestedByEmail: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    reviewedByEmail: String,
    reviewedAt: Date,
    reviewNote: String,
  },
  { timestamps: true }
);
freezeRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = {
  FreezeRequest: mongoose.model('FreezeRequest', freezeRequestSchema),
};
