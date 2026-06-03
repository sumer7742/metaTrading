const mongoose = require('mongoose');

// A single symbol entry inside a watchlist. Stored as an embedded
// subdocument (not a separate collection) so loading a watchlist is one
// query and reordering is one atomic write — ideal for this read-heavy UI.
// Mongoose gives each item its own `_id`, which the FE/route layer uses as
// the stable itemId for remove/reorder/move/copy/pin operations.
const watchlistItemSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true },
    sortOrder: { type: Number, default: 0 },
    // Pinned items sort above unpinned ones regardless of sortOrder
    // (the "Pin to top" quick action).
    pinned: { type: Boolean, default: false },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const watchlistSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    // Emoji shown next to the name (⭐ 📈 🔥 💎 🚀). Plain string so any
    // glyph works without an enum to maintain.
    emoji: { type: String, default: '' },
    // Reserved for Phase-2 color tags; harmless to carry now.
    color: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
    // The auto-created "Favorites" list seeded from legacy localStorage
    // favorites. Used so migration is idempotent and delete can repoint.
    isDefault: { type: Boolean, default: false },
    items: { type: [watchlistItemSchema], default: [] },
  },
  { timestamps: true }
);

// Primary access pattern: "all of THIS user's lists, in display order".
watchlistSchema.index({ userId: 1, sortOrder: 1 });

module.exports = mongoose.model('Watchlist', watchlistSchema);
