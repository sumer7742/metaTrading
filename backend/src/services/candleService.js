const Candle = require('../models/Candle');
const broadcaster = require('../websocket/server');

const TF_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

const bucket = (ts, tfMs) => Math.floor(ts / tfMs) * tfMs;

/**
 * Update candles for all timeframes for a single trade.
 *
 * Uses an atomic upsert (aggregation pipeline) so two concurrent ticks on
 * the same bucket can't both insert and produce an E11000 duplicate-key
 * error. The pipeline:
 *   - sets `open` only if the doc is new (preserves the bucket's first price)
 *   - always overwrites `close` (latest price wins)
 *   - $max/$min on `high`/`low` against the prior value
 *   - $add on `volume` against the prior value
 */
const updateCandlesForTrade = async ({ symbol, price, quantity, ts }) => {
  const t = ts || Date.now();
  const priceNum = Number(price);
  const qtyNum = Number(quantity);
  const priceStr = String(price);

  for (const [tf, ms] of Object.entries(TF_MS)) {
    const openTime = new Date(bucket(t, ms));
    const closeTime = new Date(openTime.getTime() + ms);

    const candle = await Candle.findOneAndUpdate(
      { symbol, timeframe: tf, openTime },
      [
        {
          $set: {
            // First trade in the bucket wins for `open`; subsequent ticks keep it.
            open: { $ifNull: ['$open', priceStr] },
            close: priceStr,
            // closeTime is set on insert; preserve thereafter.
            closeTime: { $ifNull: ['$closeTime', closeTime] },
            high: {
              $toString: {
                $max: [priceNum, { $toDouble: { $ifNull: ['$high', priceStr] } }],
              },
            },
            low: {
              $toString: {
                $min: [priceNum, { $toDouble: { $ifNull: ['$low', priceStr] } }],
              },
            },
            volume: {
              $toString: {
                $add: [qtyNum, { $toDouble: { $ifNull: ['$volume', '0'] } }],
              },
            },
          },
        },
      ],
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    broadcaster.broadcastCandle(symbol, tf, {
      symbol,
      timeframe: tf,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  }
};

const getCandles = async (symbol, timeframe, limit = 500) => {
  return Candle.find({ symbol, timeframe }).sort({ openTime: -1 }).limit(limit).lean();
};

module.exports = { updateCandlesForTrade, getCandles, TF_MS };
