const mongoose = require('mongoose');

const marginCallSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    type: { type: String, enum: ['MARGIN_CALL', 'STOP_OUT', 'NEGATIVE_BALANCE'], required: true },
    marginLevel: String, // % at the time of event
    equity: String,
    usedMargin: String,
    triggeredAt: { type: Date, default: Date.now, index: true },
    actionTaken: String, // 'NOTIFICATION_SENT', 'POSITION_LIQUIDATED', 'BALANCE_RESET'
    closedPositionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Position' }],
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: false }
);

module.exports = mongoose.model('MarginCall', marginCallSchema);
