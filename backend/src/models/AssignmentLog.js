const mongoose = require('mongoose');

/**
 * AssignmentLog — append-only history of every hierarchy assignment change
 * for a user (assign / reassign / unassign). Rows are NEVER updated or
 * deleted, so the full chain of custody (who owned this user, when, why,
 * and who changed it) is always reconstructable. This is separate from the
 * platform-wide AuditLog (which records the admin action); this table is
 * the user-centric ownership timeline used by the assignment UI.
 */
const assignmentLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: ['ASSIGN', 'REASSIGN', 'UNASSIGN'], required: true },

    // Ownership before/after the change (null = none).
    fromAdminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    toAdminId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fromManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    toManagerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Why + who.
    reason: { type: String, default: '' },
    notes:  { type: String, default: '' },
    actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    ip: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

assignmentLogSchema.index({ userId: 1, createdAt: -1 });
assignmentLogSchema.index({ actorId: 1, createdAt: -1 });

module.exports = mongoose.model('AssignmentLog', assignmentLogSchema);
