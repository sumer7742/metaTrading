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
 * If the last existing candle for (symbol, tf) is more than one bucket
 * behind the incoming `currentBucket`, fill the gap with flat candles
 * (carry-forward last close). Prevents visible gaps between historical
 * seed data and the first live tick after the feed reconnects.
 *
 * Caps at MAX_BACKFILL buckets per call so a long downtime doesn't
 * generate thousands of fake candles in one tick.
 */
// 1500 buckets per call covers 25h on 1m, 5 days on 5m, ~3 months on 1h.
// First tick after a long downtime pays the cost of one big bulkWrite —
// trade-off for keeping the chart visually continuous.
const MAX_BACKFILL = 1500;

const _backfillGaps = async (symbol, tf, tfMs, currentBucketTs, fallbackClose) => {
  const last = await Candle.findOne({ symbol, timeframe: tf })
    .sort({ openTime: -1 })
    .limit(1)
    .lean();
  if (!last) return;
  const lastBucketTs = new Date(last.openTime).getTime();
  const gapBuckets = Math.floor((currentBucketTs - lastBucketTs) / tfMs) - 1;
  if (gapBuckets <= 0) return;
  const fillCount = Math.min(gapBuckets, MAX_BACKFILL);
  const flatPrice = String(last.close ?? fallbackClose);
  const flatPriceNum = Number(flatPrice);

  const ops = [];
  for (let i = 1; i <= fillCount; i++) {
    const openTime = new Date(lastBucketTs + i * tfMs);
    const closeTime = new Date(openTime.getTime() + tfMs);
    ops.push({
      updateOne: {
        filter: { symbol, timeframe: tf, openTime },
        update: {
          $setOnInsert: {
            symbol,
            timeframe: tf,
            openTime,
            closeTime,
            open: flatPrice,
            high: flatPrice,
            low: flatPrice,
            close: flatPrice,
            volume: '0',
          },
        },
        upsert: true,
      },
    });
    // Cheap guard against absurdly large flat blocks if data is corrupt.
    if (!Number.isFinite(flatPriceNum)) break;
  }
  if (ops.length) {
    try { await Candle.bulkWrite(ops, { ordered: false }); }
    catch (e) { /* duplicates expected on race — ignore */ }
  }
};

/**
 * Update candles for all timeframes for a single trade.
 *
 * Uses an atomic upsert (aggregation pipeline) so two concurrent ticks on
 * the same bucket can't both insert and produce an E11000 duplicate-key
 * error. Before the upsert we run a fast gap-backfill so the live candle
 * sits flush against the historical series with no visual hole.
 */
const updateCandlesForTrade = async ({ symbol, price, quantity, ts, timeframes }) => {
  const t = ts || Date.now();
  const priceNum = Number(price);
  const qtyNum = Number(quantity);
  const priceStr = String(price);

  // Optional subset of timeframes to write (e.g. options only need intraday TFs
  // — writing all 8 ×thousands of contracts overloads the box). Default = all.
  const tfEntries = timeframes && timeframes.length
    ? timeframes.filter((tf) => TF_MS[tf]).map((tf) => [tf, TF_MS[tf]])
    : Object.entries(TF_MS);

  for (const [tf, ms] of tfEntries) {
    const bucketTs = bucket(t, ms);
    const openTime = new Date(bucketTs);
    const closeTime = new Date(bucketTs + ms);

    // Backfill any missing buckets between the last existing candle and
    // the current one — keeps the chart visually continuous.
    await _backfillGaps(symbol, tf, ms, bucketTs, priceStr);

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
  const tfMs = TF_MS[timeframe];
  const rows = await Candle.find({ symbol, timeframe }).sort({ openTime: -1 }).limit(limit).lean();
  if (!tfMs) return rows;

  // No stored candles yet (e.g. an option that hasn't ticked, or market closed) —
  // synthesize a short flat series at the instrument's last price so the chart
  // isn't blank. Live ticks then build real candles on top.
  if (rows.length === 0) {
    const inst = await require('../models/Instrument').findOne({ symbol }).select('lastPrice').lean();
    const px = inst && Number(inst.lastPrice) > 0 ? String(inst.lastPrice) : null;
    if (!px) return rows;
    const cur = bucket(Date.now(), tfMs);
    const out = [];
    for (let i = 0; i < 60; i += 1) { // newest-first (desc), matching the normal return
      const ot = new Date(cur - i * tfMs);
      out.push({ symbol, timeframe, openTime: ot, closeTime: new Date(ot.getTime() + tfMs), open: px, high: px, low: px, close: px, volume: '0' });
    }
    return out;
  }

  // Forward-fill missing buckets with flat carry-forward candles. A real-time
  // feed only writes a candle when the price CHANGES (perf), so stable stretches
  // leave holes — without this the chart shows dashes-with-gaps instead of a
  // continuous series. In-memory only (no DB writes). The last real candle is
  // filled up to (not incl.) the current live bucket, which the WS feed owns.
  const FILL_CAP = 3000; // safety: never synthesize more than this per gap
  const asc = rows.slice().reverse();
  const out = [];
  for (let i = 0; i < asc.length; i += 1) {
    out.push(asc[i]);
    const curTs = new Date(asc[i].openTime).getTime();
    const nextTs = i + 1 < asc.length ? new Date(asc[i + 1].openTime).getTime() : bucket(Date.now(), tfMs);
    let gaps = Math.floor((nextTs - curTs) / tfMs) - 1;
    if (gaps <= 0) continue;
    if (gaps > FILL_CAP) gaps = FILL_CAP;
    const c = asc[i].close;
    for (let g = 1; g <= gaps; g += 1) {
      const ot = new Date(curTs + g * tfMs);
      out.push({ symbol, timeframe, openTime: ot, closeTime: new Date(ot.getTime() + tfMs), open: c, high: c, low: c, close: c, volume: '0' });
    }
  }
  return out.reverse(); // desc, matching the original contract
};

module.exports = { updateCandlesForTrade, getCandles, TF_MS };
