/**
 * Generic key/value system settings — single source of truth for platform-
 * wide toggles that admin needs to change at runtime.
 *
 * Current keys in use:
 *   routingMode          'A_BOOK' | 'B_BOOK'   — global order routing
 *   defaultLpProvider    'OANDA' | 'BINANCE' | 'CUSTOM_LP'  — LP used when A_BOOK
 *
 * Cached in-process via `services/systemSettings.service.js` so the hot
 * order path doesn't hit Mongo on every order.
 */
const mongoose = require('mongoose');

const systemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: mongoose.Schema.Types.Mixed,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemSetting', systemSettingSchema);
