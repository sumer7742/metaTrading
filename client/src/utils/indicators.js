/**
 * Technical indicators (doc §7.11).
 * All functions take an array of close prices (numbers) and a period,
 * returning an array of indicator values aligned to the input (null for warmup).
 */

export const sma = (closes, period) => {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    sum += closes[i] - closes[i - period];
    out[i] = sum / period;
  }
  return out;
};

export const ema = (closes, period) => {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
};

/**
 * RSI (Relative Strength Index) — Wilder's smoothing.
 * Returns values in 0..100. Periods commonly 14.
 */
export const rsi = (closes, period = 14) => {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
};

/**
 * MACD = EMA(fast) - EMA(slow); signal = EMA(MACD, signalPeriod); histogram = MACD - signal.
 * Standard params: fast=12, slow=26, signal=9.
 */
export const macd = (closes, fast = 12, slow = 26, signalPeriod = 9) => {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null
  );
  // For signal line, need MACD values that aren't null
  const macdNonNull = macdLine.map((v) => v == null ? 0 : v);
  const signalLine = ema(macdNonNull, signalPeriod);
  // Mask signal output where macd was null
  const signal = signalLine.map((v, i) => (macdLine[i] == null ? null : v));
  const histogram = macdLine.map((m, i) => (m != null && signal[i] != null ? m - signal[i] : null));
  return { macd: macdLine, signal, histogram };
};

/**
 * Bollinger Bands — middle = SMA(period); upper/lower = middle ± stddev × σ(period).
 * Standard params: period=20, stddev=2.
 * Returns { middle, upper, lower } each aligned to the closes input.
 */
export const bollinger = (closes, period = 20, stddev = 2) => {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i];
    if (mean == null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mean + stddev * sd;
    lower[i] = mean - stddev * sd;
  }
  return { middle, upper, lower };
};

/**
 * VWAP (Volume-Weighted Average Price) — cumulative typical-price × volume / cumulative volume.
 * Resets daily (every new UTC day), so intraday VWAP behaves like a TradingView session VWAP.
 * Input expects an array of candles { time, high, low, close, volume }.
 */
export const vwap = (candles) => {
  const out = new Array(candles.length).fill(null);
  let cumPv = 0;
  let cumV = 0;
  let prevDay = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // Reset on day boundary so each session has its own VWAP.
    const tSec = typeof c.time === 'number' ? c.time : 0;
    const day = Math.floor(tSec / 86400);
    if (day !== prevDay) {
      cumPv = 0;
      cumV = 0;
      prevDay = day;
    }
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const v = Number(c.volume) || 0;
    cumPv += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPv / cumV : null;
  }
  return out;
};

/**
 * Stochastic Oscillator — %K = 100 × (close - lowestLow) / (highestHigh - lowestLow);
 * %D = SMA(%K, dPeriod). Standard params: kPeriod=14, dPeriod=3.
 * Returns { k, d } aligned to the candles input. Values in 0..100.
 */
export const stochastic = (candles, kPeriod = 14, dPeriod = 3) => {
  const k = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const h = Number(candles[j].high);
      const l = Number(candles[j].low);
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const close = Number(candles[i].close);
    k[i] = hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
  }
  const d = sma(k.map((v) => v == null ? 0 : v), dPeriod);
  // Mask leading nulls
  for (let i = 0; i < kPeriod - 1 + dPeriod - 1; i++) d[i] = null;
  return { k, d };
};

/**
 * ATR (Average True Range) — Wilder's smoothing.
 * Input expects an array of candles { high, low, close }. Standard period=14.
 */
export const atr = (candles, period = 14) => {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  // True Range for each bar (TR_0 uses high-low only since there's no prev close)
  const trs = new Array(candles.length).fill(0);
  trs[0] = Number(candles[0].high) - Number(candles[0].low);
  for (let i = 1; i < candles.length; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const pc = Number(candles[i - 1].close);
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Seed with simple average of the first `period` TRs
  let prev = 0;
  for (let i = 0; i < period; i++) prev += trs[i];
  prev /= period;
  out[period - 1] = prev;
  // Wilder smoothing afterwards
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
};

/**
 * Williams %R — (highestHigh - close) / (highestHigh - lowestLow) × -100.
 * Standard period=14. Values in [-100, 0]. -20 = overbought, -80 = oversold.
 */
export const williamsR = (candles, period = 14) => {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = Number(candles[j].high);
      const l = Number(candles[j].low);
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const close = Number(candles[i].close);
    out[i] = hh === ll ? -50 : ((hh - close) / (hh - ll)) * -100;
  }
  return out;
};

/**
 * CCI (Commodity Channel Index) — (typicalPrice - SMA(tp)) / (0.015 × meanDeviation).
 * Standard period=20. Values typically -100 to +100; beyond signals overbought/oversold.
 */
export const cci = (candles, period = 20) => {
  const out = new Array(candles.length).fill(null);
  const tps = candles.map((c) => (Number(c.high) + Number(c.low) + Number(c.close)) / 3);
  const smaTp = sma(tps, period);
  for (let i = period - 1; i < candles.length; i++) {
    const mean = smaTp[i];
    if (mean == null) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tps[j] - mean);
    const meanDev = dev / period;
    out[i] = meanDev === 0 ? 0 : (tps[i] - mean) / (0.015 * meanDev);
  }
  return out;
};

/**
 * Donchian Channels — highest high + lowest low over `period`, plus their midline.
 * Standard period=20. Returns { upper, middle, lower }.
 */
export const donchian = (candles, period = 20) => {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  const middle = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const h = Number(candles[j].high);
      const l = Number(candles[j].low);
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    upper[i] = hh;
    lower[i] = ll;
    middle[i] = (hh + ll) / 2;
  }
  return { upper, middle, lower };
};

/**
 * Keltner Channels — middle = EMA(close, period); bands = middle ± multiplier × ATR.
 * Standard params: period=20, multiplier=2, atrPeriod=10.
 * Returns { upper, middle, lower }.
 */
export const keltner = (candles, period = 20, multiplier = 2, atrPeriod = 10) => {
  const closes = candles.map((c) => Number(c.close));
  const middle = ema(closes, period);
  const atrVals = atr(candles, atrPeriod);
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (middle[i] != null && atrVals[i] != null) {
      upper[i] = middle[i] + multiplier * atrVals[i];
      lower[i] = middle[i] - multiplier * atrVals[i];
    }
  }
  return { upper, middle, lower };
};
