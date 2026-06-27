const mongoose = require('mongoose');

/**
 * RecommendedMarket — the admin-curated "Recommended" market set.
 *
 * Drives BOTH the top ticker strip and the "Recommended" tab in the client's
 * market selector. There are NO hard-coded showcase symbols anywhere — the
 * strip renders exactly these rows, in `sortOrder`, so an admin reorder /
 * add / remove is reflected end-to-end.
 *
 *   symbol     instrument symbol (must match an Instrument.symbol)
 *   sortOrder  ascending display order (drag-and-drop in the admin)
 *   isActive   soft on/off without losing the configured position
 */
const recommendedMarketSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    sortOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }, // createdAt / updatedAt
);

module.exports = mongoose.model('RecommendedMarket', recommendedMarketSchema);
