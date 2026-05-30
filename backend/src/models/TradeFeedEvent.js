const mongoose = require('mongoose');

/**
 * TradeFeedEvent — Instagram-style activity row. One entry per
 * notable master action (open / close / SL-TP edit / follower count
 * jump). Cheap to fetch in reverse-chronological order, capped at
 * the most recent N rows for the FE.
 */
const tradeFeedEventSchema = new mongoose.Schema(
  {
    masterId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    masterName: String,
    type:       { type: String, enum: ['OPEN', 'CLOSE', 'TP_HIT', 'SL_HIT', 'FOLLOWED'], required: true, index: true },
    symbol:     String,
    side:       String,
    qty:        String,
    price:      String,
    pnl:        String,            // signed string-decimal, set on CLOSE / *_HIT
    pctMove:    String,            // % move on the trade, set on CLOSE
    note:       String,            // human-readable preformatted note for the FE
    createdAt:  { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

tradeFeedEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TradeFeedEvent', tradeFeedEventSchema);
