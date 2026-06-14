const mongoose = require('mongoose');

/**
 * Global Alert — an important announcement an Admin / Super Admin pushes to
 * users as a blocking, centered popup. Targeting, a display window, priority
 * styling, optional acknowledgement and repeat-display are all configurable.
 *
 * Hierarchy scope: a Super Admin's alert is platform-wide (scopeAdminId=null);
 * an Admin's alert reaches ONLY that admin's own subtree (scopeAdminId=self),
 * matching the platform-wide rule that an admin never affects other admins'
 * users.
 */
const globalAlertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true }, // rich text (sanitized HTML)
    priority: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], default: 'INFO', index: true },

    // Target audience.
    //   ALL  → every customer (role USER) in scope
    //   ROLE → users whose role ∈ targetRoles
    //   USER → users whose _id ∈ targetUserIds
    targetType: { type: String, enum: ['ALL', 'ROLE', 'USER'], default: 'ALL', index: true },
    targetRoles: [{ type: String }],
    targetUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Display window — null = open-ended on that side.
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },

    requireAcknowledgement: { type: Boolean, default: true },
    // When true the alert re-appears every session even after acknowledgement;
    // when false it is shown once and suppressed after the user clicks OK.
    repeatDisplay: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },

    // Hierarchy scope owner. null = platform-wide (Super Admin); otherwise the
    // creating admin's _id — the alert only reaches users under that admin.
    scopeAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Hot path: the user "pending alerts" lookup filters active alerts within the
// display window.
globalAlertSchema.index({ isActive: 1, startAt: 1, endAt: 1 });

module.exports = mongoose.model('GlobalAlert', globalAlertSchema);
