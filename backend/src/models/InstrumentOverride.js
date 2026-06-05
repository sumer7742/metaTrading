const mongoose = require('mongoose');

/**
 * Scheduled instrument-level overrides — temporary, time-windowed changes to
 * an instrument's leverage or fixed trade volume that apply ONLY to NEW
 * positions/orders opened during the window.
 *
 * An override is "active" when: enabled === true AND startAt <= now < endAt.
 * Expiry is computed on read (after endAt the row simply stops being active),
 * so no cron is required — though a sweep could flip `enabled` for tidiness.
 *
 * Overlap of *active* (enabled) windows for the same instrument is prevented
 * at the service layer. Existing open positions are never touched.
 */
const baseFields = {
  instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
  symbol:       { type: String, required: true, index: true },
  startAt:      { type: Date, required: true },
  endAt:        { type: Date, required: true },
  reason:       { type: String, default: '' },
  enabled:      { type: Boolean, default: true, index: true },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByName:{ type: String, default: '' },
};

const leverageOverrideSchema = new mongoose.Schema(
  {
    ...baseFields,
    leverage: { type: Number, required: true }, // e.g. 100 → 1:100 during the window
    // Snapshot of the instrument's normal leverage at creation (audit/UX).
    normalLeverage: { type: Number, default: null },
  },
  { timestamps: true }
);

const volumeOverrideSchema = new mongoose.Schema(
  {
    ...baseFields,
    volume: { type: String, required: true }, // forced lot size during the window
    normalVolume: { type: String, default: null },
  },
  { timestamps: true }
);

// "Active override for this instrument right now" — the hot lookup at order time.
leverageOverrideSchema.index({ instrumentId: 1, enabled: 1, startAt: 1, endAt: 1 });
volumeOverrideSchema.index({ instrumentId: 1, enabled: 1, startAt: 1, endAt: 1 });

module.exports = {
  InstrumentLeverageOverride: mongoose.model('InstrumentLeverageOverride', leverageOverrideSchema),
  InstrumentVolumeOverride:   mongoose.model('InstrumentVolumeOverride', volumeOverrideSchema),
};
