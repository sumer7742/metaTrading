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
