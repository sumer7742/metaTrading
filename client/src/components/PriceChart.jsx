import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { sma, ema, rsi, macd, bollinger, vwap, stochastic, atr, williamsR, cci, donchian, keltner } from '../utils/indicators';
import { useThemeStore } from '../store/theme';
import { useChartDrawings } from '../hooks/useChartDrawings';
import ChartDrawingToolbar from './ChartDrawingToolbar';

// ─── Theme palette helpers ───────────────────────────────────────────
// Resolve a CSS-variable RGB triplet into an `rgb(R, G, B)` string the
// chart library understands. Comma-separated form is used because some
// builds of lightweight-charts predate CSS Color Level 4 space-separated
// syntax — `rgb(15 15 18)` parses as transparent in those versions.
const cssVar = (name, fallback) => {
  if (typeof document === 'undefined') return fallback;
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (_) { /* document not ready */ }
  if (!v) return fallback;
  if (/^\d+\s+\d+\s+\d+$/.test(v)) return `rgb(${v.replace(/\s+/g, ', ')})`;
  return v;
};

const chartPalette = () => ({
  background: cssVar('--color-bg-card', '#1a2129'),
  text: cssVar('--color-text-secondary', '#9ca3af'),
  grid: cssVar('--color-border-subtle', '#232b35'),
  border: cssVar('--color-border-dark', '#2a323d'),
});

// TradingView-reference color palette — used across every chart type
// for visual consistency. Bull/bear/volume colours stay constant in
// both themes (green = up, red = down everywhere). Background, grid,
// border, text and crosshair flip with the theme via `tvCanvas()`.
const TV_COLORS = {
  background: '#FFFFFF',
  grid: 'rgba(17, 24, 39, 0.06)',
  border: 'rgba(17, 24, 39, 0.10)',
  text: '#6B7280',
  crosshair: 'rgba(17, 24, 39, 0.25)',
  up: '#00C853',
  down: '#FF3B57',
  volumeUp: 'rgba(0, 200, 83, 0.45)',
  volumeDown: 'rgba(255, 59, 87, 0.45)',
};

// Theme-aware canvas palette — only the surface-level tokens flip.
// The crosshair label chip also inverts so the time/price pill stays
// readable on whichever canvas colour is in play.
const tvCanvas = (theme) => (theme === 'dark'
  ? {
      background: '#0F1623',
      grid: 'rgba(255, 255, 255, 0.06)',
      border: 'rgba(255, 255, 255, 0.12)',
      text: '#94A3B8',
      crosshair: 'rgba(255, 255, 255, 0.30)',
      crosshairLabelBg: '#E5E7EB',
      crosshairLabelText: '#0F172A',
    }
  : {
      background: '#FFFFFF',
      grid: 'rgba(17, 24, 39, 0.06)',
      border: 'rgba(17, 24, 39, 0.10)',
      text: '#6B7280',
      crosshair: 'rgba(17, 24, 39, 0.25)',
      crosshairLabelBg: '#1F2937',
      crosshairLabelText: '#FFFFFF',
    });

// ─── Chart-type catalog ──────────────────────────────────────────────
// Each entry maps to a creator + an updater. The dropdown renders this
// list as-is so adding a new type only requires updating these helpers.
const CHART_TYPES = [
  { id: 'candles',       label: 'Candles',           glyph: <CandleGlyph /> },
  { id: 'bars',          label: 'Bars',              glyph: <BarsGlyph /> },
  { id: 'hollowCandles', label: 'Hollow Candles',    glyph: <HollowGlyph /> },
  { id: 'line',          label: 'Line',              glyph: <LineGlyph /> },
  { id: 'lineMarkers',   label: 'Line with Markers', glyph: <LineMarkersGlyph /> },
  { id: 'stepLine',      label: 'Step Line',         glyph: <StepLineGlyph /> },
  { id: 'area',          label: 'Area',              glyph: <AreaGlyph /> },
  { id: 'baseline',      label: 'Baseline',          glyph: <BaselineGlyph /> },
  { id: 'histogram',     label: 'Columns / Histogram', glyph: <HistogramGlyph /> },
  { id: 'heikinAshi',    label: 'Heikin Ashi',       glyph: <HeikinAshiGlyph /> },
];

// ─── Timeframe + gap-fill helpers ────────────────────────────────────
// All chart times are Unix SECONDS (lightweight-charts requirement).
// Gap-fill produces continuous buckets so 1m charts have one candle per
// minute — missing buckets get a flat carry-forward candle (O=H=L=C=prev
// close, volume=0) so the time axis never jumps.

const TF_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};
export const tfToSeconds = (tf) => TF_SECONDS[tf] || 60;

/** Snap a Unix-seconds timestamp down to the start of its timeframe bucket. */
export const bucketFloor = (sec, tfSec) => Math.floor(sec / tfSec) * tfSec;

// ─── Candle cache ──────────────────────────────────────────────────────
// Persists the last loaded candle batch per (symbol, timeframe) across
// chart re-mounts (page navigations, logout / login, theme toggles, …).
// Without this the chart shows a brief "empty" state every time the
// PriceChart component unmounts and re-mounts — users perceived this as
// "candle history gets deleted after logout". With it, the prior series
// renders instantly while fresh data loads from the server.
const CACHE_KEY = 'tradepro:candles:v1';
const _memCache = new Map();

function _cacheKey(symbol, timeframe) {
  return `${symbol}:${timeframe}`;
}
function readCachedCandles(symbol, timeframe) {
  const k = _cacheKey(symbol, timeframe);
  if (_memCache.has(k)) return _memCache.get(k);
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const entry = obj?.[k];
    if (!entry || !Array.isArray(entry)) return null;
    _memCache.set(k, entry);
    return entry;
  } catch (_) {
    return null;
  }
}
function writeCachedCandles(symbol, timeframe, candles) {
  if (!Array.isArray(candles) || candles.length === 0) return;
  const k = _cacheKey(symbol, timeframe);
  // Keep last 300 in cache to stay under localStorage's ~5MB budget if
  // the user browses many symbols.
  const trimmed = candles.slice(-300);
  _memCache.set(k, trimmed);
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[k] = trimmed;
    // Cap total cached symbol-tf pairs to ~40; FIFO eviction by key order.
    const keys = Object.keys(obj);
    if (keys.length > 40) {
      const drop = keys.slice(0, keys.length - 40);
      for (const d of drop) delete obj[d];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch (_) { /* quota / private mode — fall back to in-memory only */ }
}

/**
 * Walk a sorted+deduped candle array and insert carry-forward candles for
 * any missing bucket between consecutive entries. Input MUST already be
 * sorted ascending and free of duplicate times. Returns a new array.
 *
 * A "carry-forward" candle has O = H = L = C = prev.close and volume = 0
 * — visually a flat tick, which is the right semantic for "no trades this
 * minute" without inventing price movement.
 */
export function fillCandleGaps(candles, tfSec) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  // 1. Filter out null / invalid OHLC entries that would create visible
  //    gaps in the chart (lightweight-charts skips bars with NaN).
  const valid = candles.filter((c) =>
    c &&
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low)  && Number.isFinite(c.close)
  );
  if (valid.length === 0) return [];
  // 2. Snap every candle to its bucket and sort ascending — guards
  //    against backends that return unsorted data.
  const snapped = valid
    .map((c) => ({ ...c, time: bucketFloor(c.time, tfSec) }))
    .sort((a, b) => a.time - b.time);
  // 3. Dedupe: when two candles share a bucket, the LATER one wins
  //    (rolling-bar updates from the server).
  const deduped = [];
  for (const c of snapped) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === c.time) deduped[deduped.length - 1] = c;
    else deduped.push(c);
  }
  if (deduped.length < 2) return deduped;
  // 4. Carry-forward fill every missing bucket between consecutive
  //    candles so the time axis is fully contiguous (no white rail).
  const out = [deduped[0]];
  for (let i = 1; i < deduped.length; i++) {
    const prev = out[out.length - 1];
    const next = deduped[i];
    let t = prev.time + tfSec;
    while (t < next.time) {
      const c = prev.close;
      out.push({ time: t, open: c, high: c, low: c, close: c, volume: 0 });
      t += tfSec;
    }
    out.push(next);
  }
  return out;
}

// ─── Data converters ─────────────────────────────────────────────────

/** Map OHLC candles → line-series points using the close price. */
export function convertToLineData(candles) {
  return candles.map((c) => ({ time: c.time, value: Number(c.close) }));
}

/** Map OHLC candles → volume histogram points, color-coded bull/bear. */
export function convertToVolumeData(candles) {
  return candles.map((c) => ({
    time: c.time,
    value: Number(c.volume) || 0,
    color: c.close >= c.open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
  }));
}

/**
 * Convert raw OHLC candles to Heikin Ashi candles.
 *   HA close = (O + H + L + C) / 4
 *   HA open  = (prevHA.open + prevHA.close) / 2     (or (O+C)/2 for the first)
 *   HA high  = max(H, HA open, HA close)
 *   HA low   = min(L, HA open, HA close)
 * The smoothing lets users see trend continuation more cleanly.
 */
export function convertToHeikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const O = Number(c.open), H = Number(c.high), L = Number(c.low), C = Number(c.close);
    const haClose = (O + H + L + C) / 4;
    const prev = out[i - 1];
    const haOpen = prev ? (prev.open + prev.close) / 2 : (O + C) / 2;
    const haHigh = Math.max(H, haOpen, haClose);
    const haLow = Math.min(L, haOpen, haClose);
    out.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose });
  }
  return out;
}

/** Autoscale provider for OHLC-shaped series. Locks the y-axis onto the
 * very recent window (last ~40 candles) using raw min/max + a tiny
 * symmetric pad. The tight range is what gives the price axis its dense,
 * forex-style label spacing (e.g. 0.72260 / 0.72270 / 0.72279 / 0.72290 …)
 * — wider ranges force the library to coarsen the step.
 *
 * Extras (open LIMIT/STOP/SL/TP price lines) extend the range only
 * marginally so they remain visible without blowing the scale wide. */
// Autoscale provider — invoked by lightweight-charts whenever it needs to
// fit the price range to the visible candles. Library calls this with the
// `firstIdx` / `lastIdx` of the currently-visible range, so we always
// compute high/low from EXACTLY what the user is looking at — wherever
// they scroll the price axis follows. Padding is proportional and
// expressed as `margins` (pixels above/below the data range) so even
// during a sharp price spike the wicks stay well inside the viewport.
const makeAutoscaleProvider = (candlesRef, extraPricesRef, animStateRef, kickAnimRef, hysteresisRef) => (start, end) => {
  const data = candlesRef.current;
  if (!data || data.length < 2) return null;

  // The library passes firstIdx/lastIdx of the visible range — use them
  // if present, otherwise fall back to the last 100 candles (initial
  // mount, before timeScale settles).
  let firstIdx, lastIdx;
  if (typeof start === 'number' && typeof end === 'number') {
    firstIdx = Math.max(0, Math.floor(start));
    lastIdx  = Math.min(data.length - 1, Math.ceil(end));
  } else {
    firstIdx = Math.max(0, data.length - 100);
    lastIdx  = data.length - 1;
  }
  if (lastIdx < firstIdx) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const c = data[i];
    if (!c) continue;
    if (Number.isFinite(c.low)  && c.low  < lo) lo = c.low;
    if (Number.isFinite(c.high) && c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  // Always honour the latest candle's close so the live price line stays
  // inside the visible range even mid-tick.
  const last = data[data.length - 1];
  if (Number.isFinite(last?.close)) {
    lo = Math.min(lo, last.close);
    hi = Math.max(hi, last.close);
  }

  // Include user-placed price lines (SL/TP/LIMIT/STOP) but cap how far
  // they can stretch the scale — a far-away LIMIT shouldn't compress the
  // candle area to a sliver.
  const extras = extraPricesRef?.current;
  if (Array.isArray(extras) && extras.length) {
    const span0 = Math.max(hi - lo, 1e-9);
    const maxStretch = span0 * 0.40;
    for (const p of extras) {
      if (!Number.isFinite(p) || p <= 0) continue;
      if (p < lo) lo = Math.max(p, lo - maxStretch);
      if (p > hi) hi = Math.min(p, hi + maxStretch);
    }
  }

  // ── Hysteresis + soft animated interpolation ────────────────────────
  // We don't want the axis to twitch on every micro-tick. Instead we
  // keep a "committed" range (state.targetLo/Hi) with a deadband around
  // it (a fraction of the committed span). The raw visible range can
  // wander freely inside that deadband and the axis holds steady. Only
  // when it breaches the band — either by pushing past on a fresh
  // high/low, or by shrinking so far that the axis would look needlessly
  // zoomed-out — do we commit a new target and ease toward it over
  // ~260 ms (ease-out cubic).
  let outLo = lo;
  let outHi = hi;
  if (animStateRef && animStateRef.current) {
    const state = animStateRef.current;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const hysteresis = Math.max(0, Number(hysteresisRef?.current ?? 0.04));

    // First call → snap (no entry animation, no deadband yet)
    if (state.animLo == null || state.animHi == null) {
      state.animLo = lo;  state.animHi = hi;
      state.fromLo = lo;  state.fromHi = hi;
      state.targetLo = lo; state.targetHi = hi;
      state.startedAt = now;
      state.duration = 0;
    } else {
      // Deadband sized to the COMMITTED span — not the raw span. Using
      // the committed span keeps the threshold stable even while the
      // raw range jitters; using raw would let a brief spike inflate
      // the deadband and mask the very breach we're trying to detect.
      const targetSpan = Math.max(state.targetHi - state.targetLo, Math.abs(state.targetHi) * 1e-6, 1e-9);
      const deadband = targetSpan * hysteresis;
      const rawSpan = Math.max(hi - lo, 1e-9);

      // (a) Candle pushed above / below the committed band — must rescale.
      const upperBreach = hi > state.targetHi + deadband;
      const lowerBreach = lo < state.targetLo - deadband;
      // (b) Visible range has shrunk well inside the committed band
      // (e.g. a spike candle scrolled out of view). Re-zoom so the
      // candles don't sit in the middle of an oversized axis. Uses a
      // larger threshold (2× deadband) than (a) — shrinking is less
      // urgent than overflow, and a higher bar avoids ping-ponging
      // between zoom-in and zoom-out on choppy markets.
      const zoomedOutTooMuch = (targetSpan - rawSpan) > deadband * 2;

      if (upperBreach || lowerBreach || zoomedOutTooMuch) {
        state.fromLo = state.animLo;
        state.fromHi = state.animHi;
        state.targetLo = lo;
        state.targetHi = hi;
        state.startedAt = now;
        state.duration = 260;
        if (kickAnimRef && typeof kickAnimRef.current === 'function') {
          kickAnimRef.current();
        }
      }
    }

    // Advance the interpolation. Provider gets called many times per
    // second by the RAF loop while animating, so each call moves
    // animLo/animHi a step closer to the target.
    if (state.duration > 0) {
      const elapsed = now - state.startedAt;
      let t = elapsed >= state.duration ? 1 : Math.max(0, elapsed / state.duration);
      // ease-out cubic
      t = 1 - Math.pow(1 - t, 3);
      state.animLo = state.fromLo + (state.targetLo - state.fromLo) * t;
      state.animHi = state.fromHi + (state.targetHi - state.fromHi) * t;
      if (elapsed >= state.duration) {
        state.duration = 0;
        state.animLo = state.targetLo;
        state.animHi = state.targetHi;
      }
    }

    outLo = state.animLo;
    outHi = state.animHi;
  }

  // Defer to lightweight-charts' built-in pixel margins (driven by the
  // price scale's `scaleMargins`) for top/bottom whitespace. Returning a
  // small `margins.above/below` in PRICE units adds extra safety so wicks
  // never sit on the very top/bottom pixel even after the scaleMargins
  // calculation. Bumped to 6 % so big volatility spikes have headroom
  // before the next autoscale recompute catches them.
  const span = Math.max(outHi - outLo, Math.abs(outHi) * 1e-6, 1e-9);
  const safetyPad = span * 0.06;
  return {
    priceRange: { minValue: outLo, maxValue: outHi },
    margins: { above: safetyPad, below: safetyPad },
  };
};

/**
 * Create the appropriate lightweight-charts series for a given chart type.
 * Returns the series instance — the caller is responsible for storing the
 * reference and feeding it data (via updateSeriesData / updateSeriesPoint).
 *
 * IMPORTANT: callers MUST remove any previous main series before calling
 * this — otherwise the chart accumulates series and they fight for the
 * price scale.
 */
export function createSeriesByChartType(chart, chartType, candlesRef, extraPricesRef, animStateRef, kickAnimRef, hysteresisRef) {
  const autoscale = makeAutoscaleProvider(candlesRef, extraPricesRef, animStateRef, kickAnimRef, hysteresisRef);
  switch (chartType) {
    case 'bars':
      return chart.addBarSeries({
        upColor: TV_COLORS.up,
        downColor: TV_COLORS.down,
        thinBars: false,
        autoscaleInfoProvider: autoscale,
      });

    case 'hollowCandles':
      // Bullish bars: transparent body + green border (the "hollow" look).
      // Bearish bars: solid red body. Wicks always colored by direction.
      return chart.addCandlestickSeries({
        upColor: 'rgba(0,0,0,0)',
        downColor: TV_COLORS.down,
        borderUpColor: TV_COLORS.up,
        borderDownColor: TV_COLORS.down,
        wickUpColor: TV_COLORS.up,
        wickDownColor: TV_COLORS.down,
        autoscaleInfoProvider: autoscale,
      });

    case 'line':
      return chart.addLineSeries({
        color: '#1D4ED8',
        lineWidth: 2,
        lineType: 0, // simple
        priceLineVisible: true,
        crosshairMarkerVisible: true,
      });

    case 'lineMarkers':
      // Same as line; markers are placed via setMarkers in updateSeriesData.
      return chart.addLineSeries({
        color: '#1D4ED8',
        lineWidth: 2,
        lineType: 0,
        priceLineVisible: true,
        crosshairMarkerVisible: true,
      });

    case 'stepLine':
      // lineType=1 is WithSteps — values are connected by horizontal+vertical
      // segments rather than a smooth diagonal.
      return chart.addLineSeries({
        color: '#1D4ED8',
        lineWidth: 2,
        lineType: 1,
        priceLineVisible: true,
      });

    case 'area':
      return chart.addAreaSeries({
        topColor: 'rgba(29, 78, 216, 0.30)',
        bottomColor: 'rgba(29, 78, 216, 0.00)',
        lineColor: '#1D4ED8',
        lineWidth: 2,
      });

    case 'baseline':
      // baseValue is patched in updateSeriesData using the median close so the
      // top/bottom halves are visually balanced from the moment the chart loads.
      return chart.addBaselineSeries({
        baseValue: { type: 'price', price: 0 },
        topLineColor: TV_COLORS.up,
        topFillColor1: 'rgba(38, 166, 154, 0.30)',
        topFillColor2: 'rgba(38, 166, 154, 0.00)',
        bottomLineColor: TV_COLORS.down,
        bottomFillColor1: 'rgba(239, 83, 80, 0.00)',
        bottomFillColor2: 'rgba(239, 83, 80, 0.30)',
        lineWidth: 2,
      });

    case 'histogram':
      // Volume histogram on the main pane. Default formatter uses `volume`
      // which renders cleanly without currency symbols.
      return chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
      });

    case 'heikinAshi':
      // HA renders as candlesticks but on transformed OHLC data.
      return chart.addCandlestickSeries({
        upColor: TV_COLORS.up,
        downColor: TV_COLORS.down,
        borderUpColor: TV_COLORS.up,
        borderDownColor: TV_COLORS.down,
        wickUpColor: TV_COLORS.up,
        wickDownColor: TV_COLORS.down,
        autoscaleInfoProvider: autoscale,
      });

    case 'candles':
    default:
      return chart.addCandlestickSeries({
        upColor: TV_COLORS.up,
        downColor: TV_COLORS.down,
        borderUpColor: TV_COLORS.up,
        borderDownColor: TV_COLORS.down,
        wickUpColor: TV_COLORS.up,
        wickDownColor: TV_COLORS.down,
        autoscaleInfoProvider: autoscale,
      });
  }
}

/** Bulk-set the data for a series in the right shape for its chart type. */
export function updateSeriesData(series, chartType, candles) {
  if (!series) return;
  if (!candles || !candles.length) {
    try { series.setData([]); } catch (_) {}
    return;
  }
  try {
    switch (chartType) {
      case 'line':
      case 'stepLine':
      case 'area': {
        series.setData(convertToLineData(candles));
        break;
      }
      case 'lineMarkers': {
        series.setData(convertToLineData(candles));
        // Markers — placed at every candle. Small + subtle so they don't
        // overpower the line; brand-yellow keeps them on-theme.
        try {
          series.setMarkers(candles.map((c) => ({
            time: c.time,
            position: 'inBar',
            shape: 'circle',
            color: '#1D4ED8',
            size: 0.5,
          })));
        } catch (_) {}
        break;
      }
      case 'baseline': {
        series.setData(convertToLineData(candles));
        // Use median close as the baseline so the up/down fills feel balanced.
        const closes = candles.map((c) => c.close).filter(Number.isFinite).sort((a, b) => a - b);
        const median = closes[Math.floor(closes.length / 2)] ?? 0;
        try {
          series.applyOptions({ baseValue: { type: 'price', price: median } });
        } catch (_) {}
        break;
      }
      case 'histogram': {
        series.setData(convertToVolumeData(candles));
        break;
      }
      case 'heikinAshi': {
        series.setData(convertToHeikinAshi(candles));
        break;
      }
      case 'bars':
      case 'candles':
      case 'hollowCandles':
      default:
        series.setData(candles);
        break;
    }
  } catch (err) {
    console.warn('[PriceChart] setData failed:', err.message);
  }
}

/** Bulk-set the volume histogram from candle data, color-coded by direction. */
function _setVolumeData(volSeries, candles) {
  if (!volSeries || !candles?.length) return;
  try {
    volSeries.setData(
      candles.map((c) => ({
        time: c.time,
        value: Number(c.volume) || 0,
        color: c.close >= c.open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
      }))
    );
  } catch (_) {}
}

/** Push a single volume point on a tick. */
function _updateVolumePoint(volSeries, candle) {
  if (!volSeries || !candle) return;
  try {
    volSeries.update({
      time: candle.time,
      value: Number(candle.volume) || 0,
      color: candle.close >= candle.open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
    });
  } catch (_) {}
}

/** Recolor the series' built-in last-price line to match the current candle's direction. */
function _updateLastPriceLineColor(series, candles) {
  if (!series || !candles?.length) return;
  const last = candles[candles.length - 1];
  if (!last) return;
  const color = last.close >= last.open ? TV_COLORS.up : TV_COLORS.down;
  try { series.applyOptions({ priceLineColor: color }); } catch (_) {}
}

/** Incremental tick update for a single new/updated candle bucket. */
function updateSeriesPoint(series, chartType, point, allCandles) {
  if (!series) return;
  try {
    switch (chartType) {
      case 'line':
      case 'stepLine':
      case 'area':
      case 'baseline':
        series.update({ time: point.time, value: Number(point.close) });
        break;
      case 'lineMarkers':
        series.update({ time: point.time, value: Number(point.close) });
        // Refresh the marker set so the new candle gets one too.
        try {
          series.setMarkers(allCandles.map((c) => ({
            time: c.time,
            position: 'inBar',
            shape: 'circle',
            color: '#1D4ED8',
            size: 0.5,
          })));
        } catch (_) {}
        break;
      case 'histogram':
        series.update({
          time: point.time,
          value: Number(point.volume) || 0,
          color: point.close >= point.open ? TV_COLORS.volumeUp : TV_COLORS.volumeDown,
        });
        break;
      case 'heikinAshi': {
        // HA needs the previous HA candle, so recompute the full HA series and
        // update the latest point. O(N) but fine for ~500 candles per tick.
        const ha = convertToHeikinAshi(allCandles);
        const last = ha[ha.length - 1];
        if (last) series.update(last);
        break;
      }
      case 'bars':
      case 'candles':
      case 'hollowCandles':
      default:
        series.update(point);
        break;
    }
  } catch (err) {
    console.warn('[PriceChart] update() rejected:', err.message);
  }
}

const TF_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'];

const INDICATOR_DEFAULTS = {
  // Overlays on main chart
  ema12: false,
  ema26: false,
  ema50: false,
  ema200: false,
  sma20: false,
  sma50: false,
  sma200: false,
  bb: false,        // Bollinger Bands
  donchian: false,  // Donchian Channels
  keltner: false,   // Keltner Channels
  vwap: false,      // Volume-Weighted Average Price
  // Sub-panels
  volume: false,    // Volume histogram (separate pane below candles)
  rsi: false,
  macd: false,
  stoch: false,     // Stochastic
  atr: false,       // Average True Range
  wr: false,        // Williams %R
  cci: false,       // Commodity Channel Index
};

export default function PriceChart({
  symbol,
  timeframe,
  onTimeframeChange,
  livePrice,
  openOrders = [],
  positions = [],
  pendingPreview = null,
  pricePrecision = 2,
  // Optional account/instrument summary rendered as a top-right overlay
  // on the chart (matches the TradingView-reference layout).
  infoStrip = null,
  // Quick-trade chip support — when these props are supplied we render a
  // Sell / Spread / Buy mini-chip in the toolbar, just before the
  // Indicators dropdown. The chip drives the parent's order-side state.
  instrument = null,
  orderSide = null,
  onOrderSideChange = null,
  // When the dedicated order panel is open the chip duplicates its
  // BUY/SELL controls — hide it (with a smooth fade/collapse) so only
  // one set of trade buttons is on screen at a time, the way
  // TradingView and pro broker terminals behave.
  hideQuickTrade = false,
  // Optional chart-view controls — when provided we render expand /
  // fullscreen icons in the toolbar's right cluster (so they don't
  // overlap floating absolute-positioned buttons).
  expanded = false,
  onToggleExpand = null,
  fullscreen = false,
  onToggleFullscreen = null,
  // Hysteresis (deadband) for the y-axis autoscale, expressed as a
  // fraction of the currently-committed price span. The axis only
  // rescales when the visible high/low breaches the committed range by
  // more than this fraction — sub-threshold tick noise is absorbed so
  // the axis stays steady. 0.04 = 4 % feels close to TradingView.
  autoscaleHysteresis = 0.04,
  // Trade-Settings driven props — defaults stay backwards-compatible.
  showAlerts = true,      // 'Show on Chart > Price alerts' toggle (price-alert lines)
  showSignals = false,    // 'Show on Chart > Signals' — RSI-derived buy/sell arrows
  showHmr = false,        // 'Show on Chart > HMR periods' — high-momentum bars
  showCalendar = false,   // 'Show on Chart > Economic calendar' — event markers
  showPositions = true,   // header toggle state — drives the ON/OFF dot in status pill
  showTpSl = true,        // header toggle state — drives TP/SL chip in status pill
  showStopLimit = true,   // header toggle state — drives STP/LIM chip in status pill
  positionsCount = 0,     // total positions on this symbol (for the chip badge)
  ordersCount = 0,        // total pending orders on this symbol (for the chip badge)
  // Close-all — when provided + count > 0, renders a red "Close All" pill
  // in the chart's right toolbar that fires onCloseAll() with confirmation.
  openPositionsCount = 0,
  onCloseAll = null,
  calendarFilters = { high: true, medium: true, low: false, lowest: false },
  timeZone = 'local',     // 'local' | 'utc' | 'gmt'
  // ── Position pill action callbacks ──────────────────────────────────
  // Click on the pill body → opens the rich Edit TP/SL modal. Click on
  // the × button → closes the position / strips just that level.
  onPositionEdit = null,
  onPositionClose = null,
  onPositionRemoveSl = null,
  onPositionRemoveTp = null,
  // Drag-to-update — fires when the user drops a dragged SL / TP line
  // onto a new price (snapped to pricePrecision).
  onPositionUpdateSl = null,
  onPositionUpdateTp = null,
  // ── Pending-order pill action callbacks ─────────────────────────────
  // Mirror of the position callbacks but routed to /trading/orders/:id
  // so a LIMIT / STOP order shown on the chart gets the same draggable
  // pill UI: drag the entry line to re-price, drag from +TP / +SL to
  // attach a level, × to cancel / strip.
  onOrderEdit = null,
  onOrderCancel = null,
  onOrderUpdatePrice = null,   // (order, price, opts?) — drag entry line
  onOrderUpdateSl = null,
  onOrderUpdateTp = null,
  onOrderRemoveSl = null,
  onOrderRemoveTp = null,
}) {
  const containerRef = useRef(null);
  const rsiContainerRef = useRef(null);
  const macdContainerRef = useRef(null);
  const stochContainerRef = useRef(null);
  const atrContainerRef = useRef(null);
  const wrContainerRef = useRef(null);
  const cciContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);  // main series — type swaps but ref name stays
  const overlayRef = useRef({});
  const subPanelChartsRef = useRef({});
  const priceLinesRef = useRef(new Map());
  const candlesRef = useRef([]);
  // Live-price / instrument refs — synced via effects below so the drag
  // handler can always read the freshest values without resubscribing.
  // Without these refs the order-entry drag clamp would use the value
  // captured at drag start, which can be stale by the time the user
  // drops if the market moved during the drag.
  const livePriceRef = useRef(null);
  const instrumentRef = useRef(null);
  // Manual-scale locks. When the user drags the price (right) or time
  // (bottom) axis to stretch / compress it, lightweight-charts disables
  // its own autoscale. Our code re-applies `autoScale: true` on every
  // pan, zoom, and tick — which clobbers the manual stretch. These refs
  // gate those re-applies: while a manual lock is set, auto-refit calls
  // become no-ops. Right-click context menu items clear them on demand.
  const manualPriceScaleRef = useRef(false);
  const manualTimeScaleRef  = useRef(false);
  // Pixel-positioned HTML pills layered over each position's entry/SL/TP
  // line (TradingView-style). Keyed by line identifier; y = pixel offset
  // from the top of the chart container.
  const [positionPills, setPositionPills] = useState([]);
  // Live drag state for SL/TP lines. Non-null while the user is dragging
  // a pill — overrides the rAF-computed pill Y for that key and pushes
  // the new price to the underlying lightweight-charts price line on every
  // mousemove. Committed to the backend (via onPositionUpdate*) on drop.
  const [dragState, setDragState] = useState(null);
  // shape: { key, kind, position, y, price, color }
  // Right-click chart context menu — null when closed; { x, y } page
  // coords when open. Rendered as a floating panel near the cursor with
  // the standard set of scale-reset actions.
  const [chartCtxMenu, setChartCtxMenu] = useState(null);
  // Volume histogram series — lives on its own overlay price scale (bottom
  // 25% of the chart). Recreated together with the main series on chart-
  // type change so it doesn't survive into a chart type where it shouldn't.
  const volumeSeriesRef = useRef(null);
  // Holds the price levels of every active order / SL / TP / preview / live
  // line so the autoscale provider can include them in the y-axis range —
  // ensures user-placed price lines are always visible on the chart.
  const extraPricesRef = useRef([]);

  // Keep refs in sync with the latest props every render so the drag
  // handler always reads fresh livePrice / bid / ask, not the value at
  // drag start. Critical for the order-entry clamp — market can move
  // during a drag and we need to clamp against the current market, not
  // the price that was live when the user first grabbed the pill.
  livePriceRef.current = livePrice;
  instrumentRef.current = instrument;

  // Soft-animation state for the y-axis. `animLo/animHi` are the
  // currently-displayed range; `targetLo/targetHi` are where we're
  // easing toward. The autoscale provider reads/updates this on every
  // call; the RAF loop (kickAnimRef) keeps re-triggering the provider
  // until the ease completes.
  const animStateRef = useRef({
    animLo: null, animHi: null,
    fromLo: null, fromHi: null,
    targetLo: null, targetHi: null,
    startedAt: 0, duration: 0,
  });
  const animRafRef = useRef(null);
  const kickAnimRef = useRef(null);
  // Kept in sync with the `autoscaleHysteresis` prop so the autoscale
  // provider (a closure created once at series-construction time) always
  // reads the latest value without needing to be rebuilt.
  const hysteresisRef = useRef(autoscaleHysteresis);
  // Same pattern for `timeframe` — the chart-create effect runs once, but
  // its tick-mark formatter needs the current timeframe to decide between
  // a "HH:MM" tick (intraday) and a "DD Mon" tick (daily).
  const timeframeRef = useRef(timeframe);
  useEffect(() => { timeframeRef.current = timeframe; }, [timeframe]);
  // Same ref pattern for the user's selected timezone — formatters read
  // this on every call so axis labels update immediately when the user
  // flips Settings > Trading > Time Zone.
  const timeZoneRef = useRef(timeZone);
  useEffect(() => { timeZoneRef.current = timeZone; }, [timeZone]);

  const [indicators, setIndicators] = useState(INDICATOR_DEFAULTS);
  const [candles, setCandles] = useState([]);
  const [chartType, setChartType] = useState('candles');
  const [chartTypeOpen, setChartTypeOpen] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [timeframeOpen, setTimeframeOpen] = useState(false);
  const theme = useThemeStore((s) => s.theme);

  // Drawing tools — vertical toolbar + chart-click handlers + persistence.
  // The hook attaches itself to the existing chart/series refs and does not
  // touch any other rendering logic, so it can be added / removed safely.
  // ── Overlay markers driven by Settings (Signals / HMR / Calendar) ──
  // Computed from `candles` so they re-derive whenever new bars arrive.
  // Empty array when all overlays are off → no perf cost.
  const externalMarkers = useMemo(() => {
    if (!candles.length) return [];
    const out = [];

    // 1. Signals — RSI overbought (>70) / oversold (<30) crossovers.
    if (showSignals) {
      const closes = candles.map((c) => Number(c.close));
      const rsiVals = rsi(closes, 14);
      let prevR = null;
      for (let i = 0; i < candles.length; i++) {
        const r = rsiVals[i];
        if (r == null) { prevR = r; continue; }
        if (prevR != null) {
          // Cross down through 30 → bullish reversal (BUY)
          if (prevR <= 30 && r > 30) {
            out.push({
              time: candles[i].time, position: 'belowBar',
              color: '#10B981', shape: 'arrowUp', text: 'BUY',
            });
          }
          // Cross up through 70 → bearish reversal (SELL)
          if (prevR >= 70 && r < 70) {
            out.push({
              time: candles[i].time, position: 'aboveBar',
              color: '#EF4444', shape: 'arrowDown', text: 'SELL',
            });
          }
        }
        prevR = r;
      }
    }

    // 2. HMR — High Momentum Reversal: candles where |close - open| / open
    //    exceeds 1.5% AND magnitude beats the rolling 20-bar mean by >1.8×.
    if (showHmr) {
      const moves = candles.map((c) => Math.abs(Number(c.close) - Number(c.open)) / Math.max(Number(c.open), 1e-9));
      let rollingSum = 0;
      const N = 20;
      for (let i = 0; i < candles.length; i++) {
        rollingSum += moves[i];
        if (i >= N) rollingSum -= moves[i - N];
        if (i < N) continue;
        const mean = rollingSum / N;
        const m = moves[i];
        if (m > 0.015 && m > mean * 1.8) {
          const bullish = Number(candles[i].close) > Number(candles[i].open);
          out.push({
            time: candles[i].time,
            position: bullish ? 'belowBar' : 'aboveBar',
            color: bullish ? '#8B5CF6' : '#F59E0B',
            shape: 'circle',
            text: 'HMR',
          });
        }
      }
    }

    // 3. Economic Calendar — events for the active symbol's currencies,
    //    filtered by impact level. Anchored to the candle nearest the event.
    if (showCalendar && instrument) {
      // Lazy-require so the chart doesn't pull the calendar util on every load
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getCalendarEvents } = require('../utils/economicCalendar');
        const wantedImpacts = new Set();
        if (calendarFilters.high)   wantedImpacts.add('high');
        if (calendarFilters.medium) wantedImpacts.add('medium');
        if (calendarFilters.low)    wantedImpacts.add('low');
        if (calendarFilters.lowest) wantedImpacts.add('lowest');
        const myCurrencies = new Set([instrument.baseCurrency, instrument.quoteCurrency].filter(Boolean));
        const events = getCalendarEvents({ lookbackDays: 7, lookaheadDays: 7, max: 80 }) || [];
        const firstT = Number(candles[0].time);
        const lastT  = Number(candles[candles.length - 1].time);
        for (const ev of events) {
          if (!wantedImpacts.has(ev.impact)) continue;
          if (myCurrencies.size && ev.currency && !myCurrencies.has(ev.currency)) continue;
          const tSec = Math.floor(new Date(ev.date).getTime() / 1000);
          if (!Number.isFinite(tSec)) continue;
          // Only mark events that fall inside the loaded candle range.
          if (tSec < firstT || tSec > lastT) continue;
          // Snap to the nearest candle's time to avoid lightweight-charts
          // rejecting a non-matching time key.
          let nearest = candles[0].time;
          let bestDiff = Math.abs(Number(candles[0].time) - tSec);
          for (const c of candles) {
            const d = Math.abs(Number(c.time) - tSec);
            if (d < bestDiff) { bestDiff = d; nearest = c.time; }
          }
          const tint = ev.impact === 'high' ? '#DC2626' : ev.impact === 'medium' ? '#3B82F6' : '#9CA3AF';
          out.push({
            time: nearest,
            position: 'aboveBar',
            color: tint,
            shape: 'square',
            text: ev.code || 'EVT',
          });
        }
      } catch (_) { /* calendar util not available */ }
    }
    return out;
  }, [candles, showSignals, showHmr, showCalendar, instrument, calendarFilters.high, calendarFilters.medium, calendarFilters.low, calendarFilters.lowest]);

  const drawingControls = useChartDrawings({ chartRef, candleSeriesRef, containerRef, symbol, externalMarkers });

  // ─── 1. Initialize chart (no main series yet — handled by chartType effect) ─
  useEffect(() => {
    if (!containerRef.current) return;
    // Use the container's actual rendered height so the chart fills the
    // available space; fall back to 460 px if measurement isn't ready yet.
    const initialHeight = containerRef.current.clientHeight || 460;
    // Time-zone aware formatters — honour the user's "Trading > Time Zone"
    // setting (local/utc/gmt). lightweight-charts treats `time` as Unix
    // seconds in UTC by default; we re-render through Intl.DateTimeFormat
    // with the right timeZone option.
    //   'local' → browser default (omit timeZone option)
    //   'utc' / 'gmt' → 'UTC' (they're functionally equivalent for display)
    const _tzOpt = () => {
      const tz = timeZoneRef.current;
      return (tz === 'utc' || tz === 'gmt') ? { timeZone: 'UTC' } : {};
    };
    const _localTickFmt = (timeOrBusiness) => {
      const sec = typeof timeOrBusiness === 'number'
        ? timeOrBusiness
        : Math.floor(Date.UTC(timeOrBusiness.year, timeOrBusiness.month - 1, timeOrBusiness.day) / 1000);
      const d = new Date(sec * 1000);
      const tf = timeframeRef.current;
      const isIntradayTf = tf === '1m' || tf === '5m' || tf === '15m' || tf === '1h' || tf === '4h';
      if (isIntradayTf) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, ..._tzOpt() });
      }
      return d.toLocaleDateString([], { day: '2-digit', month: 'short', ..._tzOpt() });
    };
    const _localCrosshairFmt = (timeOrBusiness) => {
      const sec = typeof timeOrBusiness === 'number'
        ? timeOrBusiness
        : Math.floor(Date.UTC(timeOrBusiness.year, timeOrBusiness.month - 1, timeOrBusiness.day) / 1000);
      return new Date(sec * 1000).toLocaleString([], {
        day: '2-digit', month: 'short', year: 'numeric',
        ..._tzOpt(),
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    };
    const chart = createChart(containerRef.current, {
      // `autoSize: true` makes lightweight-charts attach its own
      // ResizeObserver and follow the container's box. This is the
      // reliable fix for "chart canvas keeps the expanded height after
      // collapsing back" — the library tracks shrinks and grows itself
      // instead of relying on our manual window-resize pings.
      autoSize: true,
      width: containerRef.current.clientWidth,
      height: initialHeight,
      localization: {
        locale: (typeof navigator !== 'undefined' && navigator.language) || 'en-US',
        timeFormatter: _localCrosshairFmt,
      },
      grid: {
        vertLines: { color: tvCanvas(theme).grid },
        horzLines: { color: tvCanvas(theme).grid },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: tvCanvas(theme).border,
        tickMarkFormatter: _localTickFmt,
        // ── Spacing
        barSpacing: 10,
        minBarSpacing: 3,
        rightOffset: 16,
        // ── Continuity guards — match TradingView's tight render flow so
        // missing intervals don't leave huge blank rails between candles.
        fixLeftEdge: true,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
        shiftVisibleRangeOnNewBar: true,
      },
      rightPriceScale: {
        borderColor: tvCanvas(theme).border,
        // Slightly more top breathing room (10 %) so big upward spikes
        // don't push wicks against the chart's top edge. Bottom keeps
        // 18% reserved for the volume row beneath the candles.
        autoScale: true,
        scaleMargins: { top: 0.10, bottom: 0.18 },
        mode: 0,                  // normal (not log, not percentage)
        entireTextOnly: true,
        alignLabels: true,
        ticksVisible: true,
      },
      crosshair: {
        mode: 1, // Magnet — snaps to OHLC values
        vertLine: {
          width: 1,
          color: tvCanvas(theme).crosshair,
          style: 2,
          labelBackgroundColor: tvCanvas(theme).crosshairLabelBg,
          labelVisible: true,
        },
        horzLine: {
          width: 1,
          color: tvCanvas(theme).crosshair,
          style: 2,
          labelBackgroundColor: tvCanvas(theme).crosshairLabelBg,
          labelVisible: true,
        },
      },
      layout: {
        background: { type: 'solid', color: tvCanvas(theme).background },
        textColor: tvCanvas(theme).text,
        // Slightly larger font sharper on retina; falls back gracefully
        // on regular displays.
        fontSize: 12,
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
      },
    });
    chartRef.current = chart;

    // ── Subscribe to visible-range changes so the Y axis re-fits on every
    // pan / zoom. lightweight-charts will call our autoscaleInfoProvider
    // again, which reads the new visible range and returns fresh high/low.
    // Debounced so a rapid drag doesn't fire dozens of applyOptions calls.
    //
    // Respects the manual-scale lock: if the user has dragged the right
    // axis to stretch / compress the Y scale (or the bottom axis for X),
    // we DON'T re-apply autoScale. The user's manual stretch persists
    // until they pick "Reset Y-Axis" / "Auto Fit" from the right-click
    // context menu (or drag the axis back themselves).
    let _refitTimer = null;
    const requestRefit = () => {
      if (manualPriceScaleRef.current) return;
      if (_refitTimer) cancelAnimationFrame(_refitTimer);
      _refitTimer = requestAnimationFrame(() => {
        try { candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true }); }
        catch (_) {}
      });
    };
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(requestRefit);
    } catch (_) { /* older lightweight-charts builds */ }

    // ── Y-axis animation loop ─────────────────────────────────────────
    // While the autoscale provider is interpolating between old and new
    // ranges, we need to repeatedly force lightweight-charts to re-call
    // the provider so each frame draws the next eased value. The loop
    // ticks at display refresh rate and stops itself the moment the
    // animState reports `duration === 0` (i.e. ease finished, range
    // snapped to target).
    kickAnimRef.current = () => {
      if (animRafRef.current != null) return; // already ticking
      if (manualPriceScaleRef.current) return; // user-locked, don't fight
      const tick = () => {
        animRafRef.current = null;
        const state = animStateRef.current;
        try {
          if (!manualPriceScaleRef.current) {
            candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
          }
        } catch (_) {}
        // If the provider still has ease time remaining, queue another
        // frame. (The provider zeros `duration` on the final step.)
        if (state && state.duration > 0) {
          animRafRef.current = requestAnimationFrame(tick);
        }
      };
      animRafRef.current = requestAnimationFrame(tick);
    };

    const resize = () => {
      if (chart && containerRef.current) {
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        const opts = {};
        if (w > 0) opts.width = w;
        if (h > 0) opts.height = h;
        if (Object.keys(opts).length) chart.applyOptions(opts);
      }
      Object.values(subPanelChartsRef.current).forEach((sc) => {
        if (sc?.chart && sc?.container) {
          const w = sc.container.clientWidth;
          if (w > 0) sc.chart.applyOptions({ width: w });
        }
      });
    };
    window.addEventListener('resize', resize);

    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(resize);
      ro.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      if (_refitTimer) cancelAnimationFrame(_refitTimer);
      if (animRafRef.current != null) {
        cancelAnimationFrame(animRafRef.current);
        animRafRef.current = null;
      }
      kickAnimRef.current = null;
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(requestRefit); } catch (_) {}
      for (const sc of Object.values(subPanelChartsRef.current)) {
        try { sc.chart?.remove(); } catch (_) {}
      }
      subPanelChartsRef.current = {};
      try { chart.remove(); } catch (_) {}
      chartRef.current = null;
      candleSeriesRef.current = null;
      overlayRef.current = {};
      priceLinesRef.current.clear();
    };
  }, []);

  // ─── 1b. Axis-drag detection + right-click context menu ─────────────
  // Detect when the user starts dragging the right (price) axis or the
  // bottom (time) axis — both are areas lightweight-charts itself
  // handles for scale stretching. When a drag starts in one of those
  // strips we set the corresponding manual lock so subsequent ticks /
  // visible-range changes / order-line updates DON'T snap the scale
  // back to fit.
  //
  // The same effect also wires the right-click context menu (open it,
  // close on outside click / escape).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Pixel widths of the axes — match the lightweight-charts defaults.
    // Slightly generous so a mousedown in the gutter still registers as
    // an axis drag rather than a chart-area click.
    const AXIS_HIT_PX = 70;     // right-axis hit zone (px)
    const TIME_HIT_PX = 36;     // bottom-axis hit zone (px)

    const onMouseDown = (e) => {
      if (e.button !== 0) return; // only left-button drags
      const rect = container.getBoundingClientRect();
      const xFromRight = rect.right - e.clientX;
      const yFromBottom = rect.bottom - e.clientY;
      const insideY = e.clientY >= rect.top && e.clientY <= rect.bottom;
      const insideX = e.clientX >= rect.left && e.clientX <= rect.right;
      if (xFromRight >= 0 && xFromRight < AXIS_HIT_PX && insideY) {
        manualPriceScaleRef.current = true;
      }
      if (yFromBottom >= 0 && yFromBottom < TIME_HIT_PX && insideX) {
        manualTimeScaleRef.current = true;
      }
    };

    const onContextMenu = (e) => {
      e.preventDefault();
      // Position the menu at the cursor; clamp to viewport so it doesn't
      // overflow the right edge (the menu renders right of `x`).
      const MENU_W = 220;
      const MENU_H = 220;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = Math.min(e.clientX, vw - MENU_W - 8);
      const y = Math.min(e.clientY, vh - MENU_H - 8);
      setChartCtxMenu({ x, y });
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('contextmenu', onContextMenu);
    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  // Close the context menu on Escape — outside clicks are handled by the
  // full-screen backdrop in the JSX below.
  useEffect(() => {
    if (!chartCtxMenu) return;
    const onKey = (e) => { if (e.key === 'Escape') setChartCtxMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chartCtxMenu]);

  // ─── 1c. Context-menu actions ────────────────────────────────────────
  // Each action clears the menu, optionally clears the relevant manual
  // lock, and forces a one-shot refit on the chart. We wrap in try/catch
  // because lightweight-charts can be mid-teardown when the user picks.
  const ctxRefreshScale = useCallback(() => {
    try { candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
    setChartCtxMenu(null);
  }, []);
  const ctxAutoFit = useCallback(() => {
    manualPriceScaleRef.current = false;
    manualTimeScaleRef.current  = false;
    try {
      chartRef.current?.timeScale().fitContent();
      candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
    } catch (_) {}
    setChartCtxMenu(null);
  }, []);
  const ctxResetY = useCallback(() => {
    manualPriceScaleRef.current = false;
    try { candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
    setChartCtxMenu(null);
  }, []);
  const ctxResetX = useCallback(() => {
    manualTimeScaleRef.current = false;
    try { chartRef.current?.timeScale().fitContent(); } catch (_) {}
    setChartCtxMenu(null);
  }, []);
  const ctxResetAll = useCallback(() => {
    manualPriceScaleRef.current = false;
    manualTimeScaleRef.current  = false;
    try {
      chartRef.current?.timeScale().fitContent();
      candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
      chartRef.current?.timeScale().scrollToRealTime();
    } catch (_) {}
    setChartCtxMenu(null);
  }, []);

  // ─── 2. Theme re-skin ────────────────────────────────────────────────
  // Re-paint BOTH the main chart and any open sub-panels (RSI / MACD)
  // when the theme toggles, so the canvas, grid, axes, and crosshair
  // labels all follow the app theme.
  useEffect(() => {
    const cv = tvCanvas(theme);
    try {
      chartRef.current?.applyOptions({
        layout: { background: { type: 'solid', color: cv.background }, textColor: cv.text },
        grid: { vertLines: { color: cv.grid }, horzLines: { color: cv.grid } },
        timeScale: { borderColor: cv.border },
        rightPriceScale: { borderColor: cv.border },
        crosshair: {
          vertLine: { color: cv.crosshair, labelBackgroundColor: cv.crosshairLabelBg },
          horzLine: { color: cv.crosshair, labelBackgroundColor: cv.crosshairLabelBg },
        },
      });
    } catch (_) {}
    const pal = chartPalette();
    for (const sc of Object.values(subPanelChartsRef.current)) {
      try {
        sc.chart?.applyOptions({
          layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
          grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
          timeScale: { borderColor: pal.border },
          rightPriceScale: { borderColor: pal.border },
        });
      } catch (_) {}
    }
  }, [theme]);

  // ─── 3. Main series swap on chart-type change ────────────────────────
  // Removes the old series (memory leak guard), wipes price lines (which
  // were attached to the old series and have to be recreated on the new
  // one — the price-lines effect below has chartType in its deps for that),
  // creates the new series, applies precision + existing data.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Tear down old main + volume series and price lines.
    if (candleSeriesRef.current) {
      try { chart.removeSeries(candleSeriesRef.current); } catch (_) {}
      candleSeriesRef.current = null;
    }
    if (volumeSeriesRef.current) {
      try { chart.removeSeries(volumeSeriesRef.current); } catch (_) {}
      volumeSeriesRef.current = null;
    }
    priceLinesRef.current.clear();

    const series = createSeriesByChartType(chart, chartType, candlesRef, extraPricesRef, animStateRef, kickAnimRef, hysteresisRef);
    candleSeriesRef.current = series;

    // Apply price precision matching the instrument, plus a dashed
    // last-price line in candle-direction color (updated dynamically per
    // tick below in the WS handler).
    const p = Math.max(0, Math.min(8, Number(pricePrecision) || 2));
    const minMove = Number(`1e-${p}`) || 0.01;
    try {
      if (chartType !== 'histogram') {
        series.applyOptions({
          priceFormat: { type: 'price', precision: p, minMove },
          priceLineVisible: true,
          priceLineStyle: 2, // dashed
          priceLineWidth: 1,
          priceLineColor: TV_COLORS.up,
        });
      }
    } catch (_) {}

    // Volume histogram is NOT auto-created here anymore — it's an opt-in
    // indicator that the user enables via the Indicators dropdown. The
    // dedicated `indicators.volume` effect below owns its lifecycle.

    // Re-paint with the data we already have so the chart isn't blank
    // until the next WS tick.
    if (candlesRef.current.length) {
      updateSeriesData(series, chartType, candlesRef.current);
      _setVolumeData(volumeSeriesRef.current, candlesRef.current);
      _updateLastPriceLineColor(series, candlesRef.current);
    }
  }, [chartType]);

  // ─── Volume indicator (toggleable) ─────────────────────────────────
  // Lives in the bottom 16% of the chart on its own overlay price scale.
  // Skipped when the main chart-type is already 'histogram' (volume IS
  // the main series there).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const wantVolume = indicators.volume && chartType !== 'histogram';

    // Tear down when toggled off or when the main chart switches to
    // 'histogram' (where a second volume pane would be redundant).
    if (!wantVolume) {
      if (volumeSeriesRef.current) {
        try { chart.removeSeries(volumeSeriesRef.current); } catch (_) {}
        volumeSeriesRef.current = null;
        // Restore the candle pane to full height by widening the main
        // price scale margin back to its default.
        try {
          chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
        } catch (_) {}
      }
      return;
    }

    // Toggled on — create the histogram and tighten the candle pane to
    // make room for it.
    if (!volumeSeriesRef.current) {
      try {
        const volSeries = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          color: TV_COLORS.volumeUp,
          lastValueVisible: false,
          priceLineVisible: false,
        });
        chart.priceScale('volume').applyOptions({
          // Top 84% = candles, bottom 16% = volume. Matches TradingView's
          // compact volume row.
          scaleMargins: { top: 0.84, bottom: 0 },
        });
        // Push the main pane's bottom margin up so candles don't overlap
        // the volume row. The next paint includes a smooth interpolation
        // via lightweight-charts' built-in transitions.
        try {
          chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.18 } });
        } catch (_) {}
        volumeSeriesRef.current = volSeries;
        // Backfill existing candles so the histogram isn't blank on enable.
        if (candlesRef.current.length) {
          _setVolumeData(volSeries, candlesRef.current);
        }
      } catch (_) { /* fail-safe */ }
    }
  }, [indicators.volume, chartType]);

  // Apply price precision when it changes (without recreating the series).
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    if (chartType === 'histogram') return; // volume formatter
    const p = Math.max(0, Math.min(8, Number(pricePrecision) || 2));
    const minMove = Number(`1e-${p}`) || 0.01;
    try {
      candleSeriesRef.current.applyOptions({
        priceFormat: { type: 'price', precision: p, minMove },
      });
    } catch (_) {}
  }, [pricePrecision, chartType]);

  // Keep the autoscale hysteresis ref synced with the prop so changes
  // take effect without rebuilding the chart series.
  useEffect(() => {
    const v = Number(autoscaleHysteresis);
    hysteresisRef.current = Number.isFinite(v) && v >= 0 ? v : 0.04;
  }, [autoscaleHysteresis]);

  // ─── 4. Load candles + subscribe to live updates ─────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    let cancelled = false;
    let unsub = null;

    // Symbol or timeframe just changed → reset the y-axis animation
    // state so the new range snaps in (instead of easing from the prior
    // symbol's price band, which would look wrong going from e.g. 2000
    // to 1.08).
    if (animStateRef.current) {
      animStateRef.current.animLo = null;
      animStateRef.current.animHi = null;
      animStateRef.current.targetLo = null;
      animStateRef.current.targetHi = null;
      animStateRef.current.duration = 0;
    }
    if (animRafRef.current != null) {
      cancelAnimationFrame(animRafRef.current);
      animRafRef.current = null;
    }

    // Render cached candles immediately (if any) so the chart never shows
    // a blank state on re-mount. Fresh data from the API replaces this
    // ~100–300ms later.
    const cached = readCachedCandles(symbol, timeframe);
    if (cached && cached.length > 0) {
      try {
        candlesRef.current = cached;
        setCandles(cached);
        updateSeriesData(candleSeriesRef.current, chartType, cached);
        _setVolumeData(volumeSeriesRef.current, cached);
        _updateLastPriceLineColor(candleSeriesRef.current, cached);
      } catch (_) { /* ignore */ }
    } else {
      // No cache → clear so we don't show stale data from the previous symbol.
      try {
        candleSeriesRef.current.setData([]);
        candlesRef.current = [];
      } catch (_) {}
      setCandles([]);
    }

    const load = async () => {
      try {
        const { data } = await api.get(`/instruments/${symbol}/candles`, {
          params: { timeframe, limit: 500 },
        });
        if (cancelled) return;
        const tfSec = tfToSeconds(timeframe);
        const raw = Array.isArray(data?.data) ? data.data : [];
        // Drop anything stamped beyond "now" (server-clock skew, bad
        // backfill, accidentally-future buckets) so the chart never shows
        // tomorrow's date.
        const nowSec = Math.floor(Date.now() / 1000);
        const formatted = raw
          .map((c) => {
            // Normalize to Unix SECONDS, then snap down to the bucket grid
            // so historical and live data share the same time keys.
            const rawSec = Math.floor(new Date(c.openTime).getTime() / 1000);
            return {
              time: bucketFloor(rawSec, tfSec),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume) || 0,
            };
          })
          .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && c.time <= nowSec)
          .sort((a, b) => a.time - b.time);
        // Dedupe by bucket time (latest wins).
        const deduped = [];
        for (const c of formatted) {
          const last = deduped[deduped.length - 1];
          if (last && last.time === c.time) deduped[deduped.length - 1] = c;
          else deduped.push(c);
        }
        // Carry-forward fill any missing buckets so the time axis is
        // continuous (no large gaps, no dashed candles from skipped minutes).
        const filled = fillCandleGaps(deduped, tfSec);
        console.log('[Chart] historical load', {
          symbol, timeframe, tfSec,
          rawCount: raw.length, dedupedCount: deduped.length, filledCount: filled.length,
          firstTime: filled[0]?.time, lastTime: filled[filled.length - 1]?.time,
        });
        candlesRef.current = filled;
        setCandles(filled);
        // Persist for instant rendering on the next mount (page nav, logout/login).
        writeCachedCandles(symbol, timeframe, filled);
        // Push to series in the chart-type-correct shape.
        updateSeriesData(candleSeriesRef.current, chartType, filled);
        _setVolumeData(volumeSeriesRef.current, filled);
        _updateLastPriceLineColor(candleSeriesRef.current, filled);
        try { candleSeriesRef.current.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
        try {
          // 120 candles × 8px barSpacing ≈ 960px of candle area —
          // matches the autoscale window (recent 100) with a small
          // lead-in so price-scale fit feels stable as new bars arrive.
          const visibleCount = 120;
          if (deduped.length > visibleCount && chartRef.current) {
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: deduped.length - visibleCount,
              to: deduped.length - 1,
            });
          } else if (chartRef.current) {
            chartRef.current.timeScale().fitContent();
          }
          // Pin to the latest candle so the chart always opens "at now",
          // never on a historical/yesterday bar.
          chartRef.current?.timeScale().scrollToRealTime();
        } catch (_) {}
      } catch (e) { /* ignore */ }
    };
    load();

    const tfSec = tfToSeconds(timeframe);

    unsub = wsClient.subscribe(`candles:${symbol}:${timeframe}`, (candle) => {
      if (!candleSeriesRef.current) return;
      // 1. Normalize raw tick time → Unix seconds.
      const rawSec = Math.floor(new Date(candle.openTime).getTime() / 1000);
      // 2. Snap to the bucket grid so a tick at e.g. 10:32:47 maps to the
      //    10:32:00 bucket on a 1m chart — never creates a stray timestamp.
      const bucketTime = bucketFloor(rawSec, tfSec);
      const point = {
        time: bucketTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume) || 0,
      };
      if (!Number.isFinite(point.time) || !Number.isFinite(point.close)) return;
      // Drop bogus future ticks (server clock skew, accidentally-future
      // openTime) — allow up to one full bucket ahead since the bucket's
      // start time is "now" but its close is one bucket in the future.
      const nowSec = Math.floor(Date.now() / 1000);
      if (point.time > nowSec + tfSec) {
        console.log('[Chart] tick dropped (future)', { rawTime: candle.openTime, normalizedTime: point.time, nowSec });
        return;
      }
      const lastInRef = candlesRef.current[candlesRef.current.length - 1];
      const lastTime = lastInRef?.time;
      // Drop late ticks that fall before the current open bucket.
      if (lastInRef && point.time < lastTime) {
        console.log('[Chart] tick dropped (late)', { rawTime: candle.openTime, normalizedTime: point.time, lastTime });
        return;
      }

      // Decide: update current bucket, append next bucket, or gap-fill +
      // append. Bulk-reset the series when fillers are added; single
      // .update() otherwise (cheaper, doesn't blink).
      let nextRef;
      let action;
      let bulkReset = false;
      if (lastInRef && lastTime === point.time) {
        // Same bucket — overwrite the working candle.
        nextRef = candlesRef.current.slice(0, -1).concat(point);
        action = 'update-current';
      } else if (lastInRef && point.time > lastTime + tfSec) {
        // Gap — carry-forward fill every missed bucket, then append.
        const fillers = [];
        const carryClose = lastInRef.close;
        for (let t = lastTime + tfSec; t < point.time; t += tfSec) {
          fillers.push({ time: t, open: carryClose, high: carryClose, low: carryClose, close: carryClose, volume: 0 });
        }
        nextRef = candlesRef.current.concat(fillers, point);
        action = `new-with-gap-fill(${fillers.length})`;
        bulkReset = true;
      } else {
        // Adjacent new bucket — just append.
        nextRef = candlesRef.current.concat(point);
        action = 'new';
      }
      candlesRef.current = nextRef;

      console.log('[Chart] tick', {
        rawTime: candle.openTime,
        normalizedTime: point.time,
        lastTime,
        action,
        close: point.close,
      });

      if (bulkReset) {
        // Filler candles need to enter the series too — bulk reset is the
        // safest path (single .update() can only push one point).
        updateSeriesData(candleSeriesRef.current, chartType, nextRef);
        _setVolumeData(volumeSeriesRef.current, nextRef);
      } else {
        updateSeriesPoint(candleSeriesRef.current, chartType, point, nextRef);
        _updateVolumePoint(volumeSeriesRef.current, point);
      }
      _updateLastPriceLineColor(candleSeriesRef.current, nextRef);
      setCandles(nextRef);
      // Persist the latest series so the next mount sees up-to-date history.
      writeCachedCandles(symbol, timeframe, nextRef);

      // Re-fit the Y axis on EVERY tick (not only when the user is at the
      // live edge). Volatility spikes that arrive while the user is
      // scrolled through history still adjust the price axis so the
      // candle they're looking at never clips. Auto-scroll horizontally
      // only when the user is already at the right edge — so historical
      // browsing isn't yanked back to live.
      //
      // Respects the user's manual scale: if they've stretched the right
      // axis, skip the autoScale re-apply so a new tick doesn't snap
      // their carefully chosen Y-zoom back to fit-all.
      try {
        const ts = chartRef.current?.timeScale();
        const range = ts?.getVisibleLogicalRange();
        const followingLive = range && range.to >= nextRef.length - 2;
        if (!manualPriceScaleRef.current) {
          candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
        }
        if (followingLive && !manualTimeScaleRef.current) ts.scrollToRealTime();
      } catch (_) { /* timeScale may not be ready */ }
    });

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [symbol, timeframe, chartType]);

  // Compute closes once per candles update
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);

  // ─── 5. EMA + SMA + Bollinger + VWAP overlays ───────────────────────
  // All overlay indicators share the same lifecycle pattern: create a
  // line series on toggle-on, remove it on toggle-off, refresh data
  // whenever candles change. Each entry below describes the series
  // metadata + a `compute` function that takes the live closes/candles
  // and returns aligned numeric values.
  useEffect(() => {
    if (!chartRef.current || !candles.length) return;

    const overlayConfigs = [
      // ── EMAs
      { key: 'ema12',  period: 12,  color: '#1D4ED8', title: 'EMA 12',  compute: () => ema(closes, 12) },
      { key: 'ema26',  period: 26,  color: '#60A5FA', title: 'EMA 26',  compute: () => ema(closes, 26) },
      { key: 'ema50',  period: 50,  color: '#A78BFA', title: 'EMA 50',  compute: () => ema(closes, 50) },
      { key: 'ema200', period: 200, color: '#F472B6', title: 'EMA 200', compute: () => ema(closes, 200) },
      // ── SMAs
      { key: 'sma20',  period: 20,  color: '#F59E0B', title: 'SMA 20',  compute: () => sma(closes, 20) },
      { key: 'sma50',  period: 50,  color: '#EAB308', title: 'SMA 50',  compute: () => sma(closes, 50) },
      { key: 'sma200', period: 200, color: '#DC2626', title: 'SMA 200', compute: () => sma(closes, 200) },
      // ── Bollinger Bands — 3 lines share the toggle key
      { key: 'bb',  subKey: 'bbU', color: '#0EA5E9', lineWidth: 1, title: 'BB Upper',  compute: () => bollinger(closes, 20, 2).upper },
      { key: 'bb',  subKey: 'bbM', color: '#0EA5E9', lineWidth: 1, lineStyle: 'dashed', title: 'BB Middle', compute: () => bollinger(closes, 20, 2).middle },
      { key: 'bb',  subKey: 'bbL', color: '#0EA5E9', lineWidth: 1, title: 'BB Lower',  compute: () => bollinger(closes, 20, 2).lower },
      // ── Donchian Channels — 3 lines (highest high / lowest low / midline)
      { key: 'donchian', subKey: 'dcU', color: '#10B981', lineWidth: 1, title: 'DC Upper',  compute: () => donchian(candles, 20).upper },
      { key: 'donchian', subKey: 'dcM', color: '#10B981', lineWidth: 1, lineStyle: 'dashed', title: 'DC Middle', compute: () => donchian(candles, 20).middle },
      { key: 'donchian', subKey: 'dcL', color: '#10B981', lineWidth: 1, title: 'DC Lower',  compute: () => donchian(candles, 20).lower },
      // ── Keltner Channels — EMA ± 2 × ATR
      { key: 'keltner', subKey: 'ktU', color: '#F97316', lineWidth: 1, title: 'KC Upper',  compute: () => keltner(candles, 20, 2, 10).upper },
      { key: 'keltner', subKey: 'ktM', color: '#F97316', lineWidth: 1, lineStyle: 'dashed', title: 'KC Middle', compute: () => keltner(candles, 20, 2, 10).middle },
      { key: 'keltner', subKey: 'ktL', color: '#F97316', lineWidth: 1, title: 'KC Lower',  compute: () => keltner(candles, 20, 2, 10).lower },
      // ── VWAP
      { key: 'vwap', color: '#7C3AED', lineWidth: 2, title: 'VWAP', compute: () => vwap(candles) },
    ];

    for (const cfg of overlayConfigs) {
      const enabled = indicators[cfg.key];
      const refKey = cfg.subKey || cfg.key;
      const exists = overlayRef.current[refKey];
      if (enabled && !exists) {
        const seriesOpts = {
          color: cfg.color,
          lineWidth: cfg.lineWidth || 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          title: cfg.title,
        };
        if (cfg.lineStyle === 'dashed') {
          // lightweight-charts LineStyle.Dashed = 1
          seriesOpts.lineStyle = 1;
        }
        const series = chartRef.current.addLineSeries(seriesOpts);
        overlayRef.current[refKey] = series;
      } else if (!enabled && exists) {
        try { chartRef.current.removeSeries(exists); } catch (_) {}
        delete overlayRef.current[refKey];
      }
      if (enabled && overlayRef.current[refKey]) {
        const values = cfg.compute();
        const data = candles
          .map((c, i) => (values[i] != null && Number.isFinite(values[i]) ? { time: c.time, value: values[i] } : null))
          .filter(Boolean);
        overlayRef.current[refKey].setData(data);
      }
    }
  }, [
    indicators.ema12, indicators.ema26, indicators.ema50, indicators.ema200,
    indicators.sma20, indicators.sma50, indicators.sma200,
    indicators.bb, indicators.donchian, indicators.keltner, indicators.vwap,
    candles, closes,
  ]);

  // ─── 6. RSI sub-panel ────────────────────────────────────────────────
  useEffect(() => {
    const enabled = indicators.rsi;
    const container = rsiContainerRef.current;
    if (!container) return;

    if (!enabled) {
      const existing = subPanelChartsRef.current.rsi;
      if (existing) {
        try { existing.chart.remove(); } catch (_) {}
        delete subPanelChartsRef.current.rsi;
      }
      return;
    }

    if (!subPanelChartsRef.current.rsi) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth,
        height: 120,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const series = chart.addLineSeries({ color: '#8b5cf6', lineWidth: 1.5, title: 'RSI 14' });
      const overbought = chart.addLineSeries({ color: '#ef4444', lineWidth: 1, lineStyle: 2 });
      const oversold = chart.addLineSeries({ color: '#10b981', lineWidth: 1, lineStyle: 2 });
      subPanelChartsRef.current.rsi = { chart, series, overbought, oversold, container };
    }

    const { series, overbought, oversold } = subPanelChartsRef.current.rsi;
    const values = rsi(closes, 14);
    const rsiData = candles.map((c, i) => (values[i] != null ? { time: c.time, value: values[i] } : null)).filter(Boolean);
    series.setData(rsiData);
    overbought.setData(rsiData.map((d) => ({ time: d.time, value: 70 })));
    oversold.setData(rsiData.map((d) => ({ time: d.time, value: 30 })));
  }, [indicators.rsi, candles, closes]);

  // ─── 6b. Stochastic sub-panel — %K + %D + 80/20 bands ────────────────
  useEffect(() => {
    const enabled = indicators.stoch;
    const container = stochContainerRef.current;
    if (!container) return;
    if (!enabled) {
      const existing = subPanelChartsRef.current.stoch;
      if (existing) { try { existing.chart.remove(); } catch (_) {} delete subPanelChartsRef.current.stoch; }
      return;
    }
    if (!subPanelChartsRef.current.stoch) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth, height: 120,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const k = chart.addLineSeries({ color: '#3B82F6', lineWidth: 1.5, title: '%K' });
      const d = chart.addLineSeries({ color: '#F97316', lineWidth: 1.5, title: '%D' });
      const overbought = chart.addLineSeries({ color: '#ef4444', lineWidth: 1, lineStyle: 2 });
      const oversold = chart.addLineSeries({ color: '#10b981', lineWidth: 1, lineStyle: 2 });
      subPanelChartsRef.current.stoch = { chart, k, d, overbought, oversold, container };
    }
    const { k: kS, d: dS, overbought, oversold } = subPanelChartsRef.current.stoch;
    const { k, d } = stochastic(candles, 14, 3);
    const kData = candles.map((c, i) => (k[i] != null ? { time: c.time, value: k[i] } : null)).filter(Boolean);
    const dData = candles.map((c, i) => (d[i] != null ? { time: c.time, value: d[i] } : null)).filter(Boolean);
    kS.setData(kData);
    dS.setData(dData);
    overbought.setData(kData.map((p) => ({ time: p.time, value: 80 })));
    oversold.setData(kData.map((p) => ({ time: p.time, value: 20 })));
  }, [indicators.stoch, candles, closes]);

  // ─── 6c. ATR sub-panel — single volatility line ──────────────────────
  useEffect(() => {
    const enabled = indicators.atr;
    const container = atrContainerRef.current;
    if (!container) return;
    if (!enabled) {
      const existing = subPanelChartsRef.current.atr;
      if (existing) { try { existing.chart.remove(); } catch (_) {} delete subPanelChartsRef.current.atr; }
      return;
    }
    if (!subPanelChartsRef.current.atr) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth, height: 110,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const series = chart.addLineSeries({ color: '#0EA5E9', lineWidth: 1.5, title: 'ATR 14' });
      subPanelChartsRef.current.atr = { chart, series, container };
    }
    const { series } = subPanelChartsRef.current.atr;
    const values = atr(candles, 14);
    series.setData(candles.map((c, i) => (values[i] != null ? { time: c.time, value: values[i] } : null)).filter(Boolean));
  }, [indicators.atr, candles, closes]);

  // ─── 6d. Williams %R sub-panel — single line + -20/-80 bands ─────────
  useEffect(() => {
    const enabled = indicators.wr;
    const container = wrContainerRef.current;
    if (!container) return;
    if (!enabled) {
      const existing = subPanelChartsRef.current.wr;
      if (existing) { try { existing.chart.remove(); } catch (_) {} delete subPanelChartsRef.current.wr; }
      return;
    }
    if (!subPanelChartsRef.current.wr) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth, height: 110,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const series = chart.addLineSeries({ color: '#DB2777', lineWidth: 1.5, title: 'W%R 14' });
      const overbought = chart.addLineSeries({ color: '#ef4444', lineWidth: 1, lineStyle: 2 });
      const oversold = chart.addLineSeries({ color: '#10b981', lineWidth: 1, lineStyle: 2 });
      subPanelChartsRef.current.wr = { chart, series, overbought, oversold, container };
    }
    const { series, overbought, oversold } = subPanelChartsRef.current.wr;
    const values = williamsR(candles, 14);
    const data = candles.map((c, i) => (values[i] != null ? { time: c.time, value: values[i] } : null)).filter(Boolean);
    series.setData(data);
    overbought.setData(data.map((p) => ({ time: p.time, value: -20 })));
    oversold.setData(data.map((p) => ({ time: p.time, value: -80 })));
  }, [indicators.wr, candles, closes]);

  // ─── 6e. CCI sub-panel — single line + ±100 bands ────────────────────
  useEffect(() => {
    const enabled = indicators.cci;
    const container = cciContainerRef.current;
    if (!container) return;
    if (!enabled) {
      const existing = subPanelChartsRef.current.cci;
      if (existing) { try { existing.chart.remove(); } catch (_) {} delete subPanelChartsRef.current.cci; }
      return;
    }
    if (!subPanelChartsRef.current.cci) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth, height: 110,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const series = chart.addLineSeries({ color: '#7C3AED', lineWidth: 1.5, title: 'CCI 20' });
      const overbought = chart.addLineSeries({ color: '#ef4444', lineWidth: 1, lineStyle: 2 });
      const oversold = chart.addLineSeries({ color: '#10b981', lineWidth: 1, lineStyle: 2 });
      subPanelChartsRef.current.cci = { chart, series, overbought, oversold, container };
    }
    const { series, overbought, oversold } = subPanelChartsRef.current.cci;
    const values = cci(candles, 20);
    const data = candles.map((c, i) => (values[i] != null ? { time: c.time, value: values[i] } : null)).filter(Boolean);
    series.setData(data);
    overbought.setData(data.map((p) => ({ time: p.time, value: 100 })));
    oversold.setData(data.map((p) => ({ time: p.time, value: -100 })));
  }, [indicators.cci, candles, closes]);

  // ─── 7. Symbol-scoped order/position filters ─────────────────────────
  const symbolOrders = useMemo(
    () => (openOrders || []).filter((o) => o.symbol === symbol),
    [openOrders, symbol]
  );
  const symbolPositions = useMemo(
    () => (positions || []).filter((p) => p.symbol === symbol),
    [positions, symbol]
  );

  // ─── 8. Price lines (orders / positions / live / preview) ────────────
  // chartType is in deps so the line set is re-applied on the new series
  // after a chart-type swap (priceLinesRef.current was cleared in #3).
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    // Histograms render volume on a different scale, so price lines drawn at
    // price levels would land off-axis and look broken — skip them.
    if (chartType === 'histogram') return;

    const desired = new Map();
    const fmt = (v) => Number(v).toFixed(Math.min(pricePrecision, 8));

    // Compact label format: 2-3 chars of action prefix only. The price
    // itself shows on the right axis via axisLabelVisible:true, so we
    // don't repeat it inside the chart area where it would overlap candles.
    for (const o of symbolOrders) {
      const sideColor = o.side === 'BUY' ? '#10b981' : '#ef4444';
      const sidePrefix = o.side === 'BUY' ? 'BUY' : 'SELL';
      if (o.type === 'LIMIT' && o.price) {
        desired.set(`order:${o._id}:limit`, {
          price: Number(o.price),
          color: sideColor,
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `${sidePrefix} LIM`,
        });
      } else if (o.type === 'STOP') {
        if (o.stopPrice) {
          desired.set(`order:${o._id}:trigger`, {
            price: Number(o.stopPrice),
            color: sideColor,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `${sidePrefix} STP`,
          });
        }
        if (o.price) {
          desired.set(`order:${o._id}:stoplimit`, {
            price: Number(o.price),
            color: sideColor,
            lineWidth: 1,
            lineStyle: 1,
            axisLabelVisible: false,
            title: 'STP-LIM',
          });
        }
      }
    }

    for (const p of symbolPositions) {
      // Entry / SL / TP lines — the price line itself is just a thin
      // colored stroke; the HTML pill rendered on top (see overlay
      // below) carries the qty + P&L + close ×.
      //
      // Colour scheme — chosen so entry never clashes with TP (green)
      // or SL (red), even when one of them sits adjacent on the chart:
      //   Entry BUY  → blue   (#3B82F6)
      //   Entry SELL → orange (#F97316)
      //   TP         → green  (#10b981)
      //   SL         → red    (#ef4444)
      if (p.entryPrice && Number(p.entryPrice) > 0) {
        const isBuy = p.side === 'BUY';
        desired.set(`pos:${p._id}:entry`, {
          price: Number(p.entryPrice),
          color: isBuy ? '#3B82F6' : '#F97316',
          lineWidth: 1,
          lineStyle: 0, // solid
          axisLabelVisible: true,
          title: '',
        });
      }
      if (p.stopLoss) {
        desired.set(`pos:${p._id}:sl`, {
          price: Number(p.stopLoss),
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        });
      }
      if (p.takeProfit) {
        desired.set(`pos:${p._id}:tp`, {
          price: Number(p.takeProfit),
          color: '#10b981',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        });
      }
    }

    if (livePrice && Number(livePrice) > 0) {
      desired.set('live:last', {
        price: Number(livePrice),
        color: '#14b8a6',
        lineWidth: 1,
        lineStyle: 1,
        axisLabelVisible: true,
        title: '',
      });
    }

    if (pendingPreview && pendingPreview.price && Number(pendingPreview.price) > 0) {
      desired.set('preview:form', {
        price: Number(pendingPreview.price),
        color: pendingPreview.side === 'BUY' ? '#10b981' : '#ef4444',
        lineWidth: 1,
        lineStyle: 1, // dotted
        axisLabelVisible: true,
        title: pendingPreview.side === 'BUY' ? '↺ BUY' : '↺ SELL',
      });
    }

    const live = priceLinesRef.current;
    for (const [key, line] of live.entries()) {
      const want = desired.get(key);
      if (!want) {
        try { series.removePriceLine(line); } catch (_) {}
        live.delete(key);
      }
    }
    for (const [key, opts] of desired.entries()) {
      const existing = live.get(key);
      if (existing) {
        try { existing.applyOptions(opts); } catch (_) {}
      } else {
        try {
          const pl = series.createPriceLine(opts);
          live.set(key, pl);
        } catch (_) {}
      }
    }
    // Refresh the prices the autoscale provider will include so user-placed
    // lines (LIMIT/STOP/SL/TP) are always inside the visible range, even
    // when far from the current market.
    extraPricesRef.current = [...desired.values()].map((o) => o.price);
    // Force the price scale to recompute now that the extras have changed.
    // Skip when the user has a manual scale lock — they don't want orders
    // or positions yanking their Y-zoom back to fit.
    if (!manualPriceScaleRef.current) {
      try { series.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
    }
  }, [symbolOrders, symbolPositions, livePrice, pendingPreview, pricePrecision, chartType]);

  useEffect(() => {
    return () => { priceLinesRef.current.clear(); };
  }, []);

  // ─── 8b. Position-pill overlay positions ────────────────────────────
  // Builds the descriptor list (one pill per entry / SL / TP line) and
  // recomputes pixel-Y on every chart event that can shift price → pixel:
  // pan, zoom, range refit, price changes. A rAF loop snapshot-diffs the
  // coordinates so we only re-render when something actually moved.
  const pillDescriptors = useMemo(() => {
    if (chartType === 'histogram') return [];
    const out = [];
    for (const p of symbolPositions) {
      if (p.entryPrice && Number(p.entryPrice) > 0) {
        out.push({ key: `pos:${p._id}:entry`, kind: 'entry', price: Number(p.entryPrice), position: p, target: 'position' });
      }
      if (p.stopLoss) {
        out.push({ key: `pos:${p._id}:sl`, kind: 'sl', price: Number(p.stopLoss), position: p, target: 'position' });
      }
      if (p.takeProfit) {
        out.push({ key: `pos:${p._id}:tp`, kind: 'tp', price: Number(p.takeProfit), position: p, target: 'position' });
      }
    }
    // Pending LIMIT / STOP orders — same pill UX. Entry price comes from
    // `price` (LIMIT) or `stopPrice` (STOP). The original order is kept
    // on `order` so cancel / modify callbacks have the raw record. We
    // also synthesize a position-shaped object on `position` so the same
    // PositionPill render path works without branching on every line.
    //
    // /orders/open returns PENDING *and* PARTIALLY_FILLED. Only PENDING
    // can be modified by the backend — drawing a draggable pill for a
    // PARTIALLY_FILLED order would let the user drag it and then hit
    // "Only PENDING orders can be modified" on drop. Skip those here.
    // STOP orders that have already triggered are also un-modifiable.
    for (const o of symbolOrders) {
      if (o.status && o.status !== 'PENDING') continue;
      if (o.type === 'STOP' && o.triggeredAt) continue;
      const entryPrice = o.type === 'STOP' ? Number(o.stopPrice) : Number(o.price);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      const pseudo = {
        _id: o._id,
        side: o.side,
        quantity: o.quantity,
        entryPrice,
        stopLoss: o.stopLoss,
        takeProfit: o.takeProfit,
        unrealizedPnl: '0',
        __orderType: o.type,
      };
      out.push({
        key: `order:${o._id}:entry`,
        kind: 'entry',
        price: entryPrice,
        position: pseudo,
        order: o,
        target: 'order',
      });
      if (o.stopLoss) {
        out.push({
          key: `order:${o._id}:sl`,
          kind: 'sl',
          price: Number(o.stopLoss),
          position: pseudo,
          order: o,
          target: 'order',
        });
      }
      if (o.takeProfit) {
        out.push({
          key: `order:${o._id}:tp`,
          kind: 'tp',
          price: Number(o.takeProfit),
          position: pseudo,
          order: o,
          target: 'order',
        });
      }
    }
    return out;
  }, [symbolPositions, symbolOrders, chartType]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || pillDescriptors.length === 0) {
      setPositionPills([]);
      return;
    }

    let lastSnap = '';
    const recompute = () => {
      const next = [];
      const snapParts = [];
      for (const d of pillDescriptors) {
        let y = null;
        try { y = series.priceToCoordinate(d.price); } catch (_) {}
        if (y == null || !Number.isFinite(y)) continue;
        next.push({ ...d, y });
        snapParts.push(`${d.key}:${y.toFixed(1)}`);
      }
      const snap = snapParts.join('|');
      if (snap !== lastSnap) {
        lastSnap = snap;
        setPositionPills(next);
      }
    };
    recompute();

    // Pan / zoom updates fire visible-range-change.
    const ts = chart.timeScale();
    const onChange = () => recompute();
    try { ts.subscribeVisibleTimeRangeChange(onChange); } catch (_) {}

    // Price-scale autoscale has no public event — poll via rAF. Cheap
    // because the diff-check skips state updates when nothing moved.
    let raf;
    const tick = () => {
      recompute();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      try { ts.unsubscribeVisibleTimeRangeChange(onChange); } catch (_) {}
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pillDescriptors, livePrice, chartType]);

  // Drag / click handler — invoked by every pill's mousedown.
  //   • SL/TP pill, pointer moved > CLICK_THRESHOLD pixels  → drag,
  //     converts pointer Y → price each frame, commits on drop.
  //   • Any pill, pointer barely moved (< threshold)        → click,
  //     opens the Edit TP/SL modal via onPositionEdit.
  // Pan/zoom is frozen for the duration of the gesture so a drag can't
  // be hijacked by chart scroll.
  const startPillDrag = useCallback((pill, evt, opts = {}) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container) return;

    evt.preventDefault();
    evt.stopPropagation();

    const rect = container.getBoundingClientRect();
    // immediate=true skips the click-vs-drag threshold and promotes
    // straight to a drag gesture. Used for the entry pill's quick-add
    // buttons — the user explicitly grabbed a +TP / +SL handle so we
    // shouldn't gate it behind 4 px of motion.
    const immediate = opts.immediate === true;
    const CLICK_THRESHOLD = 4; // px moved before we treat the gesture as a drag
    // Touch events expose clientX/Y on the first touch; mouse events have
    // them directly. Normalise once so the rest of the gesture works for
    // both pointer kinds.
    const pt = (e) => {
      const t = e.touches?.[0] || e.changedTouches?.[0];
      return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY };
    };
    const startPt = pt(evt);
    let didDrag = immediate;
    // Pending-order entry lines are draggable (re-price the LIMIT / STOP
    // trigger). Position entry lines are static — only SL/TP move.
    const isOrderEntry = pill.kind === 'entry' && pill.target === 'order';
    const draggable = pill.kind === 'sl' || pill.kind === 'tp' || isOrderEntry;

    // Drag overlay tint — matches the line stroke colour for each kind.
    const color = pill.kind === 'sl'
      ? '#ef4444'
      : pill.kind === 'tp'
        ? '#10b981'
        : (pill.position.side === 'BUY' ? '#3B82F6' : '#F97316');
    const step = Math.pow(10, -Math.min(8, Math.max(0, Number(pricePrecision) || 2)));
    const snap = (p) => Math.round(p / step) * step;

    // ── Order-side guard ────────────────────────────────────────────
    // Dragging a LIMIT or STOP order across the live market price would
    // cause the backend to fill it immediately (modifyOrder removes the
    // resting order, re-adds at the new price, and if the new price has
    // crossed market it gets matched right away — user perceives this as
    // "the order opened at live price instead of moving").
    //
    // Clamp the dragged price to the valid side of market for each
    // order type/side. Use bid/ask when available (tighter, more
    // accurate than lastPrice) and read everything via refs so a market
    // move mid-drag updates the clamp in real time. We leave a 3-tick
    // cushion so float-precision quirks and rapid ticks can't sneak the
    // order across the boundary:
    //   BUY  LIMIT → price < ask  (resting buy below offer)
    //   SELL LIMIT → price > bid  (resting sell above bid)
    //   BUY  STOP  → stopPrice > ask  (trigger if rises)
    //   SELL STOP  → stopPrice < bid  (trigger if falls)
    // SL/TP drags use a different guard (anchored to the entry price,
    // server-validated) so they stay untouched.
    const orderType = pill.order?.type || pill.position?.__orderType;
    const orderSide = pill.position?.side;
    const clampOrderPrice = (p) => {
      if (!isOrderEntry) return p;
      const inst = instrumentRef.current;
      const last = Number(livePriceRef.current);
      const askRaw = Number(inst?.ask);
      const bidRaw = Number(inst?.bid);
      const ask = Number.isFinite(askRaw) && askRaw > 0 ? askRaw : last;
      const bid = Number.isFinite(bidRaw) && bidRaw > 0 ? bidRaw : last;
      if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) return p;
      const cushion = step * 3;
      if (orderType === 'LIMIT') {
        if (orderSide === 'BUY')  return Math.min(p, ask - cushion);
        if (orderSide === 'SELL') return Math.max(p, bid + cushion);
      } else if (orderType === 'STOP') {
        if (orderSide === 'BUY')  return Math.max(p, ask + cushion);
        if (orderSide === 'SELL') return Math.min(p, bid - cushion);
      }
      return p;
    };

    // ── coordinateToPrice helper ────────────────────────────────────
    // Wraps lightweight-charts' coordinateToPrice with bounds clamping so
    // a drag past the top/bottom edge of the chart still produces a valid
    // price (clipped to the visible range).
    const coordinateToPrice = (clientY) => {
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      const p = series.coordinateToPrice(y);
      return { y, price: Number.isFinite(p) ? p : null };
    };

    // Magnetic snap to the nearest candle high / low within a small
    // tolerance band. Tolerance scales with the visible price range so
    // it stays useful on both BTC-sized prices and EURUSD-sized prices.
    const SNAP_FRACTION = 0.0015; // ~0.15% of visible range
    const candles = candlesRef.current || [];
    const visiblePxHigh = Number(series.coordinateToPrice(0)) || 0;
    const visiblePxLow  = Number(series.coordinateToPrice(rect.height)) || 0;
    const tol = Math.abs(visiblePxHigh - visiblePxLow) * SNAP_FRACTION;
    const magneticSnap = (p) => {
      if (!candles.length || !(tol > 0)) return p;
      let best = null;
      let bestDist = Infinity;
      // Only consider the last 60 candles — that's what's visible at
      // typical zooms and keeps the per-frame scan cheap.
      const start = Math.max(0, candles.length - 60);
      for (let i = start; i < candles.length; i++) {
        const c = candles[i];
        const h = Number(c.high);
        const l = Number(c.low);
        if (Number.isFinite(h)) {
          const d = Math.abs(p - h);
          if (d < bestDist) { bestDist = d; best = h; }
        }
        if (Number.isFinite(l)) {
          const d = Math.abs(p - l);
          if (d < bestDist) { bestDist = d; best = l; }
        }
      }
      return best != null && bestDist <= tol ? best : p;
    };

    // Throttled silent backend push — fires at most every LIVE_THROTTLE
    // ms while dragging so the order state stays in sync without
    // spamming the API or surfacing a toast per frame.
    const LIVE_THROTTLE = 250;
    let lastLiveAt = 0;
    let pendingLivePrice = null;
    let liveTimer = null;
    // Resolve the right backend callback based on what's being dragged.
    // Order entries reroute to onOrderUpdatePrice; SL/TP route to the
    // order or position variant depending on the descriptor target.
    const resolveCb = () => {
      if (isOrderEntry) return onOrderUpdatePrice;
      if (pill.target === 'order') {
        return pill.kind === 'sl' ? onOrderUpdateSl : onOrderUpdateTp;
      }
      return pill.kind === 'sl' ? onPositionUpdateSl : onPositionUpdateTp;
    };
    const liveCb = resolveCb();
    // Callback subject — order callbacks expect the raw order; position
    // callbacks expect the position object.
    const subject = pill.target === 'order' ? (pill.order || pill.position) : pill.position;
    // Skip live throttled pushes for order targets. The backend's
    // modifyOrder removes the LIMIT from the book and re-adds it per
    // request, so multiple in-flight PUTs during a drag can race the
    // matching engine and accidentally fill / cancel the order. Order
    // drags commit on drop only; position SL/TP drags are safe because
    // they don't touch the order book.
    const allowLive = pill.target !== 'order';
    const pushLive = (price) => {
      if (!allowLive || !liveCb) return;
      const now = Date.now();
      pendingLivePrice = price;
      const fire = () => {
        lastLiveAt = Date.now();
        liveTimer = null;
        try { liveCb(subject, pendingLivePrice, { live: true }); } catch (_) {}
      };
      if (now - lastLiveAt >= LIVE_THROTTLE) {
        fire();
      } else if (!liveTimer) {
        liveTimer = setTimeout(fire, LIVE_THROTTLE - (now - lastLiveAt));
      }
    };

    try { chart.applyOptions({ handleScroll: false, handleScale: false }); } catch (_) {}
    // Body-level cursor lock so the grabbing pointer persists even when
    // the mouse leaves the pill mid-drag.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    // Immediate mode: seed dragState now so the preview pill renders at
    // the grab origin before the first mousemove fires.
    if (immediate && draggable) {
      setDragState({ key: pill.key, kind: pill.kind, position: pill.position, order: pill.order || null, target: pill.target || 'position', y: pill.y, price: pill.price, color, snapped: false });
    }

    const onMove = (e) => {
      // Block touch scroll/zoom while the user is dragging the pill on mobile.
      if (e.cancelable && e.touches) { try { e.preventDefault(); } catch (_) {} }
      const cur = pt(e);
      const dx = cur.x - startPt.x;
      const dy = cur.y - startPt.y;
      // Promote to drag once the pointer moves past the click threshold.
      // Only SL/TP can actually be dragged — for the entry pill, motion
      // past the threshold simply cancels the would-be click.
      if (!didDrag && (Math.abs(dx) > CLICK_THRESHOLD || Math.abs(dy) > CLICK_THRESHOLD)) {
        didDrag = true;
        if (draggable) {
          setDragState({ key: pill.key, kind: pill.kind, position: pill.position, order: pill.order || null, target: pill.target || 'position', y: pill.y, price: pill.price, color, snapped: false });
        }
      }
      if (!didDrag || !draggable) return;
      const { y, price } = coordinateToPrice(cur.y);
      if (price == null) return;
      // Clamp to the valid side of market for order entry drags so the
      // user can't accidentally drag a LIMIT/STOP across live price and
      // trigger an immediate fill.
      const clamped = clampOrderPrice(price);
      const snappedPrice = magneticSnap(clamped);
      const snapped = snappedPrice !== clamped;
      const p = snap(snappedPrice);
      // After snap, the y position should reflect the (possibly clamped)
      // price so the pill visually stops at the live-price barrier even
      // when the cursor pushes past it. Re-derive y from p.
      let displayY = y;
      try {
        const recomputed = series.priceToCoordinate(p);
        if (Number.isFinite(recomputed)) displayY = recomputed;
      } catch (_) {}
      setDragState((curr) => curr ? { ...curr, y: displayY, price: p, snapped } : null);
      const line = priceLinesRef.current.get(pill.key);
      if (line) {
        try { line.applyOptions({ price: p }); } catch (_) {}
      }
      pushLive(p);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
      try { chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }

      if (didDrag && draggable) {
        // Drag drop — commit the new price (final, with toast).
        setDragState((curr) => {
          if (!curr) return null;
          const cb = resolveCb();
          // Re-clamp at drop time. Market can move between the last
          // mousemove and mouseup; without a final clamp the committed
          // price could have just crossed market in that tiny window.
          const finalPrice = snap(clampOrderPrice(curr.price));
          if (cb) cb(subject, finalPrice);
          return null;
        });
      } else if (!didDrag) {
        // Click — open the Edit TP/SL modal (or the order edit modal
        // when the pill belongs to a pending order).
        setDragState(null);
        if (pill.target === 'order') onOrderEdit?.(pill.order || pill.position);
        else onPositionEdit?.(pill.position);
      } else {
        setDragState(null);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
  }, [pricePrecision, livePrice, onPositionUpdateSl, onPositionUpdateTp, onPositionEdit,
      onOrderUpdatePrice, onOrderUpdateSl, onOrderUpdateTp, onOrderEdit]);

  // Entry-pill quick-add: user mousedowns on the inline "+TP" / "+SL"
  // handle inside the entry pill. We synthesize a pill descriptor at the
  // entry's pixel Y and reuse the SL/TP drag pipeline (drag → throttled
  // live push → drop commit). The synthetic pill key is namespaced with
  // `:new` so it never collides with an existing line; the ephemeral
  // preview is rendered separately below when dragState references it.
  // Works for both filled positions and pending orders — target/order are
  // threaded through so the drop commit hits the right backend endpoint.
  const startQuickAddDrag = useCallback((position, kind, evt, ctx = {}) => {
    const series = candleSeriesRef.current;
    if (!series || !position) return;
    const entryPrice = Number(position.entryPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    let entryY = null;
    try { entryY = series.priceToCoordinate(entryPrice); } catch (_) {}
    if (entryY == null || !Number.isFinite(entryY)) return;
    const target = ctx.target || 'position';
    const keyPrefix = target === 'order' ? 'order' : 'pos';
    const syntheticPill = {
      key: `${keyPrefix}:${position._id}:${kind}:new`,
      kind,                       // 'sl' | 'tp'
      position,
      order: ctx.order || null,
      target,
      y: entryY,
      price: entryPrice,
    };
    startPillDrag(syntheticPill, evt, { immediate: true });
  }, [startPillDrag]);

  // ─── 9. MACD sub-panel ───────────────────────────────────────────────
  useEffect(() => {
    const enabled = indicators.macd;
    const container = macdContainerRef.current;
    if (!container) return;

    if (!enabled) {
      const existing = subPanelChartsRef.current.macd;
      if (existing) {
        try { existing.chart.remove(); } catch (_) {}
        delete subPanelChartsRef.current.macd;
      }
      return;
    }

    if (!subPanelChartsRef.current.macd) {
      const pal = chartPalette();
      const chart = createChart(container, {
        width: container.clientWidth,
        height: 140,
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
      const histogram = chart.addHistogramSeries({ color: '#6b7280', title: 'Hist' });
      const macdLine = chart.addLineSeries({ color: '#2dd4bf', lineWidth: 1.5, title: 'MACD' });
      const signalLine = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, title: 'Signal' });
      subPanelChartsRef.current.macd = { chart, histogram, macdLine, signalLine, container };
    }

    const { histogram, macdLine, signalLine } = subPanelChartsRef.current.macd;
    const m = macd(closes, 12, 26, 9);
    const histData = candles
      .map((c, i) => m.histogram[i] != null ? { time: c.time, value: m.histogram[i], color: m.histogram[i] >= 0 ? '#10b981' : '#ef4444' } : null)
      .filter(Boolean);
    const macdData = candles.map((c, i) => m.macd[i] != null ? { time: c.time, value: m.macd[i] } : null).filter(Boolean);
    const sigData = candles.map((c, i) => m.signal[i] != null ? { time: c.time, value: m.signal[i] } : null).filter(Boolean);
    histogram.setData(histData);
    macdLine.setData(macdData);
    signalLine.setData(sigData);
  }, [indicators.macd, candles, closes]);

  const toggle = (key) => setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  const currentType = CHART_TYPES.find((t) => t.id === chartType) || CHART_TYPES[0];

  return (
    <div className="card overflow-visible h-full flex flex-col">
      {/* Premium header — chart type dropdown + indicator pills + timeframe */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-dark flex-wrap gap-2 bg-gradient-to-r from-bg-card to-bg-card/50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />

          {/* Chart-type dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setChartTypeOpen((o) => !o)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-dark bg-bg-panel hover:border-border-accent hover:bg-bg-hover text-xs font-semibold text-text-secondary hover:text-text-primary transition-colors"
              title="Chart type"
            >
              <span className="text-text-muted">{currentType.glyph}</span>
              <span>{currentType.label}</span>
              <span className={`text-text-muted text-[10px] transition-transform ${chartTypeOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {chartTypeOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setChartTypeOpen(false)} />
                <div className="absolute left-0 top-full mt-1.5 w-56 z-50 rounded-lg border border-border-dark bg-bg-card shadow-2xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-border-dark text-[10px] uppercase tracking-[0.15em] font-bold text-text-muted">
                    Chart Type
                  </div>
                  <div className="max-h-[420px] overflow-y-auto py-1">
                    {CHART_TYPES.map((t) => {
                      const active = t.id === chartType;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setChartType(t.id);
                            setChartTypeOpen(false);
                          }}
                          className={`w-full flex items-center gap-3 px-3 py-2 text-xs font-medium transition-colors ${
                            active
                              ? 'bg-primary-500/10 text-primary-500'
                              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                          }`}
                        >
                          <span className={active ? 'text-primary-500' : 'text-text-muted'}>{t.glyph}</span>
                          <span className="flex-1 text-left">{t.label}</span>
                          {active && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Indicators dropdown */}
          {(() => {
            const indicatorList = [
              { group: 'Moving Averages — EMA' },
              { key: 'ema12',  label: 'EMA 12',  color: '#1D4ED8' },
              { key: 'ema26',  label: 'EMA 26',  color: '#60A5FA' },
              { key: 'ema50',  label: 'EMA 50',  color: '#A78BFA' },
              { key: 'ema200', label: 'EMA 200', color: '#F472B6' },
              { group: 'Moving Averages — SMA' },
              { key: 'sma20',  label: 'SMA 20',  color: '#F59E0B' },
              { key: 'sma50',  label: 'SMA 50',  color: '#EAB308' },
              { key: 'sma200', label: 'SMA 200', color: '#DC2626' },
              { group: 'Channels & Bands' },
              { key: 'bb',       label: 'Bollinger Bands',   color: '#0EA5E9' },
              { key: 'donchian', label: 'Donchian Channels', color: '#10B981' },
              { key: 'keltner',  label: 'Keltner Channels',  color: '#F97316' },
              { group: 'Volume' },
              { key: 'volume',   label: 'Volume',            color: TV_COLORS.volumeUp },
              { key: 'vwap',     label: 'VWAP',              color: '#7C3AED' },
              { group: 'Oscillators (sub-panel)' },
              { key: 'rsi',      label: 'RSI',           color: '#8B5CF6' },
              { key: 'macd',     label: 'MACD',          color: '#2DD4BF' },
              { key: 'stoch',    label: 'Stochastic',    color: '#3B82F6' },
              { key: 'atr',      label: 'ATR',           color: '#0EA5E9' },
              { key: 'wr',       label: 'Williams %R',   color: '#DB2777' },
              { key: 'cci',      label: 'CCI',           color: '#7C3AED' },
            ];
            const activeCount = indicatorList.filter((i) => i.key && indicators[i.key]).length;
            return (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => { setIndicatorsOpen((o) => !o); setTimeframeOpen(false); setChartTypeOpen(false); }}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-md border border-border-dark bg-white text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 4 4 6-7" /></svg>
                  Indicators
                  {activeCount > 0 && (
                    <span className="text-[9px] font-bold px-1.5 py-px rounded-full bg-primary-500 text-white">{activeCount}</span>
                  )}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {indicatorsOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setIndicatorsOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-40 w-52 bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden max-h-[400px] overflow-y-auto">
                      {indicatorList.map((ind, idx) => {
                        if (ind.group) {
                          return (
                            <div key={`g-${idx}`} className="px-3 pt-2.5 pb-1 text-[9px] uppercase tracking-wider font-bold text-text-muted bg-bg-hover/40 border-b border-border-subtle">
                              {ind.group}
                            </div>
                          );
                        }
                        return (
                          <button
                            key={ind.key}
                            type="button"
                            onClick={() => toggle(ind.key)}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] hover:bg-bg-hover transition-colors text-left"
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: ind.color }} />
                              <span className="text-text-primary font-medium">{ind.label}</span>
                            </span>
                            <span
                              className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                                indicators[ind.key] ? 'bg-primary-500 border-primary-500' : 'bg-white border-border-dark'
                              }`}
                            >
                              {indicators[ind.key] && (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* Timeframe dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setTimeframeOpen((o) => !o); setIndicatorsOpen(false); setChartTypeOpen(false); }}
              className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-md border border-border-dark bg-white text-text-primary hover:bg-bg-hover transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
              {timeframe}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {timeframeOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setTimeframeOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-40 w-24 bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden">
                  {TF_OPTIONS.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => { onTimeframeChange(tf); setTimeframeOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-[12px] font-semibold transition-colors ${
                        tf === timeframe
                          ? 'bg-primary-500 text-white'
                          : 'text-text-primary hover:bg-bg-hover'
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right side — Sell / Spread / Buy quick-trade chip only. */}
        <div className="flex items-center gap-2 flex-wrap">
          {instrument && orderSide && onOrderSideChange && (() => {
            const last = Number(instrument.lastPrice) || 0;
            const half = Number(instrument.spreadValue || 0) / 2;
            const bid = instrument.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;
            const ask = instrument.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
            const spread = ask - bid;
            const prec = Math.min(instrument.pricePrecision || pricePrecision || 2, 5);
            // Outer wrapper handles the fade+collapse animation so the
            // chip melts away (rather than vanishing) when the order
            // panel opens. The negative right margin when hidden cancels
            // the parent flex `gap-2` so the remaining toolbar buttons
            // don't leave an 8 px ghost-gap where the chip used to sit.
            return (
              <div
                aria-hidden={hideQuickTrade}
                className={`overflow-hidden transition-all duration-200 ease-out ${
                  hideQuickTrade
                    ? 'opacity-0 max-w-0 -translate-x-1 -mr-2 pointer-events-none'
                    : 'opacity-100 max-w-[260px] translate-x-0'
                }`}
              >
                <div className="flex items-stretch h-8 rounded-md overflow-hidden border border-border-dark">
                  <button
                    type="button"
                    onClick={() => onOrderSideChange('SELL')}
                    title="Sell at bid"
                    tabIndex={hideQuickTrade ? -1 : 0}
                    className={`px-2.5 flex flex-col items-center justify-center gap-px font-bold leading-none transition-all ${
                      orderSide === 'SELL' ? 'bg-bear' : 'bg-bear/10 text-bear hover:bg-bear/20'
                    }`}
                    style={orderSide === 'SELL' ? { color: '#FFFFFF' } : undefined}
                  >
                    <span className="text-[8px] uppercase tracking-wider opacity-90">Sell</span>
                    <span className="font-mono text-[10px] tabular-nums">{bid.toFixed(prec)}</span>
                  </button>
                  <span className="px-2 flex items-center justify-center text-[10px] font-mono font-semibold text-text-secondary bg-bg-card border-x border-border-dark">
                    {spread.toFixed(prec)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOrderSideChange('BUY')}
                    title="Buy at ask"
                    tabIndex={hideQuickTrade ? -1 : 0}
                    className={`px-2.5 flex flex-col items-center justify-center gap-px font-bold leading-none transition-all ${
                      orderSide === 'BUY' ? 'bg-primary-500' : 'bg-primary-500/10 text-primary-600 hover:bg-primary-500/20'
                    }`}
                    style={orderSide === 'BUY' ? { color: '#FFFFFF' } : undefined}
                  >
                    <span className="text-[8px] uppercase tracking-wider opacity-90">Buy</span>
                    <span className="font-mono text-[10px] tabular-nums">{ask.toFixed(prec)}</span>
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Close-All — flat-everything panic button in the chart toolbar.
              Only renders when the parent provides onCloseAll and there's
              at least one open position. Confirms before firing. */}
          {onCloseAll && openPositionsCount > 0 && (
            <button
              type="button"
              onClick={onCloseAll}
              title={`Close all ${openPositionsCount} open position(s)`}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-bear/10 text-bear border border-bear/30 hover:bg-bear/20 text-[11px] font-bold tracking-wide transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" /><path d="M6 6l12 12" />
              </svg>
              Close All
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded bg-bear/20 text-bear text-[10px] font-extrabold tabular-nums">
                {openPositionsCount}
              </span>
            </button>
          )}

          {/* Expand / Fullscreen controls — moved into the toolbar from
              the floating overlay so they don't overlap the Sell/Buy chip. */}
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              title={expanded ? 'Show panels (E)' : 'Expand chart — hide panels (E)'}
              className="p-1.5 rounded-md border border-border-dark bg-white text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {expanded ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
              )}
            </button>
          )}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              title={fullscreen ? 'Exit fullscreen (F or Esc)' : 'Fullscreen chart (F)'}
              className="p-1.5 rounded-md border border-border-dark bg-white text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {fullscreen ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h6v2H5v4H3V3z" /><path d="M21 3v6h-2V5h-4V3h6z" /><path d="M3 21v-6h2v4h4v2H3z" /><path d="M21 21h-6v-2h4v-4h2v6z" /></svg>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Main chart canvas + top-right info-strip overlay.
          flex-1 + min-h-0 lets the chart container claim every remaining
          pixel under the toolbar instead of falling back to a 460 px tile. */}
      <div className="relative w-full flex-1 min-h-0" style={{ background: tvCanvas(theme).background }}>
        <div ref={containerRef} className="w-full h-full" />

        {/* ── Position pills overlay ─────────────────────────────────
            TradingView / Exness-style draggable labels rendered on top
            of the chart canvas. Each pill is centered on its price-line
            Y and shows: lot qty · live USD value · × close button.
            SL/TP pills are vertically draggable; on drop the snapped
            price is committed to the backend. */}
        {positionPills.length > 0 && (
          <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
            {positionPills.map((p) => {
              // Drag override — when the user is dragging this pill, the
              // rAF-computed y is stale; use the live drag y and price.
              const drag = dragState && dragState.key === p.key ? dragState : null;
              const y = drag ? drag.y : p.y;
              const overridePrice = drag ? drag.price : null;
              // For the entry pill, hide the inline +TP/+SL quick-add
              // handle once the level already exists (its real pill is
              // rendered separately below). Keeps the entry pill compact
              // and avoids two ways to drag the same level.
              const showQuickTp = p.kind === 'entry' && !p.position.takeProfit;
              const showQuickSl = p.kind === 'entry' && !p.position.stopLoss;
              const isOrder = p.target === 'order';
              return (
                <PositionPill
                  key={p.key}
                  y={y}
                  kind={p.kind}
                  position={p.position}
                  target={p.target}
                  pricePrecision={pricePrecision}
                  isDragging={!!drag}
                  snapped={!!(drag && drag.snapped)}
                  overridePrice={overridePrice}
                  showQuickTp={showQuickTp}
                  showQuickSl={showQuickSl}
                  onClose={() => {
                    if (p.kind === 'entry') {
                      if (isOrder) onOrderCancel?.(p.order || p.position);
                      else onPositionClose?.(p.position);
                    } else if (p.kind === 'sl') {
                      if (isOrder) onOrderRemoveSl?.(p.order || p.position);
                      else onPositionRemoveSl?.(p.position);
                    } else if (p.kind === 'tp') {
                      if (isOrder) onOrderRemoveTp?.(p.order || p.position);
                      else onPositionRemoveTp?.(p.position);
                    }
                  }}
                  onDragStart={(e) => startPillDrag(p, e)}
                  onQuickDragStart={(kind, e) => startQuickAddDrag(
                    p.position, kind, e,
                    { target: p.target, order: p.order },
                  )}
                />
              );
            })}
            {/* Ephemeral preview pill — rendered while the user is mid-drag
                on a quick-add gesture. dragState references a synthetic key
                (`:new` suffix) that isn't in positionPills, so we render a
                throwaway PositionPill that tracks the cursor until drop. */}
            {dragState && dragState.key.endsWith(':new') && (
              <PositionPill
                key={dragState.key}
                y={dragState.y}
                kind={dragState.kind}
                position={dragState.position}
                pricePrecision={pricePrecision}
                isDragging
                snapped={!!dragState.snapped}
                overridePrice={dragState.price}
                onClose={() => {}}
                onDragStart={() => {}}
                onQuickDragStart={() => {}}
              />
            )}
          </div>
        )}

        <ChartDrawingToolbar controls={drawingControls} />

        {/* Right-click chart context menu — TradingView-style. Theme-aware:
            white card on light, slate-900 on dark. A full-screen backdrop
            captures outside clicks. Each row is a single action; clicking
            invokes the corresponding handler + closes the menu. */}
        {chartCtxMenu && (
          <ChartContextMenu
            x={chartCtxMenu.x}
            y={chartCtxMenu.y}
            theme={theme}
            onClose={() => setChartCtxMenu(null)}
            onRefresh={ctxRefreshScale}
            onAutoFit={ctxAutoFit}
            onResetY={ctxResetY}
            onResetX={ctxResetX}
            onResetAll={ctxResetAll}
            manualY={manualPriceScaleRef.current}
            manualX={manualTimeScaleRef.current}
          />
        )}
        {drawingControls.measureReadout && (
          <div className="absolute top-2 right-2 z-20 px-3 py-2 rounded-lg bg-white/95 border border-border-dark text-[11px] font-mono shadow-card backdrop-blur-sm flex items-center gap-3">
            <span className="text-text-muted">Δ Price</span>
            <span className={`font-bold ${drawingControls.measureReadout.dPrice >= 0 ? 'text-bull' : 'text-bear'}`}>
              {drawingControls.measureReadout.dPrice >= 0 ? '+' : ''}{drawingControls.measureReadout.dPrice.toFixed(2)}
            </span>
            <span className={`font-bold ${drawingControls.measureReadout.dPct >= 0 ? 'text-bull' : 'text-bear'}`}>
              ({drawingControls.measureReadout.dPct >= 0 ? '+' : ''}{drawingControls.measureReadout.dPct.toFixed(2)}%)
            </span>
            <button type="button" onClick={drawingControls.clearMeasure} className="ml-1 text-text-muted hover:text-text-primary">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>
        )}
        {infoStrip && (
          <div className="pointer-events-none hidden md:flex absolute top-1 left-11 z-10 items-center gap-3 px-3 py-1.5 rounded-md bg-white/85 backdrop-blur-sm border border-border-dark text-[11px] font-medium tracking-wide shadow-card">
            {infoStrip.margin != null && (
              <span className="text-text-muted">
                Margin <span className="text-bull font-semibold">{infoStrip.margin}</span>
              </span>
            )}
            {infoStrip.leverage != null && (
              <span className="text-text-muted">
                Leverage <span className="text-indigo-400 font-semibold">{infoStrip.leverage}</span>
              </span>
            )}
            {infoStrip.brokerage != null && (
              <span className="text-text-muted">
                Brokerage <span className="text-pink-400 font-semibold">{infoStrip.brokerage}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* RSI sub-panel */}
      {indicators.rsi && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            RSI <span className="text-text-secondary">(14)</span>
          </div>
          <div ref={rsiContainerRef} className="w-full" />
        </div>
      )}

      {/* MACD sub-panel */}
      {indicators.macd && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            MACD <span className="text-text-secondary">(12, 26, 9)</span>
          </div>
          <div ref={macdContainerRef} className="w-full" />
        </div>
      )}

      {/* Stochastic sub-panel */}
      {indicators.stoch && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            STOCHASTIC <span className="text-text-secondary">(14, 3)</span>
          </div>
          <div ref={stochContainerRef} className="w-full" />
        </div>
      )}

      {/* ATR sub-panel */}
      {indicators.atr && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            ATR <span className="text-text-secondary">(14)</span>
          </div>
          <div ref={atrContainerRef} className="w-full" />
        </div>
      )}

      {/* Williams %R sub-panel */}
      {indicators.wr && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            WILLIAMS %R <span className="text-text-secondary">(14)</span>
          </div>
          <div ref={wrContainerRef} className="w-full" />
        </div>
      )}

      {/* CCI sub-panel */}
      {indicators.cci && (
        <div className="border-t border-border-dark">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold px-4 py-1.5 bg-bg-panel/50 border-b border-border-subtle">
            CCI <span className="text-text-secondary">(20)</span>
          </div>
          <div ref={cciContainerRef} className="w-full" />
        </div>
      )}
    </div>
  );
}

function IndButton({ active, onClick, color, children }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2.5 py-1 rounded-md border transition-all ${
        active
          ? 'border-transparent font-bold shadow-sm'
          : 'border-border-dark text-text-muted hover:text-text-primary hover:bg-bg-hover'
      }`}
      style={
        active
          ? { backgroundColor: color, color: '#0F0F12' }
          : undefined
      }
    >
      {children}
    </button>
  );
}

// ─── Inline glyphs for the chart-type dropdown ─────────────────────────
// Tiny SVG indicators (12×12) so the dropdown reads at a glance without
// pulling in an icon library. Fill `currentColor` so they tint with the
// surrounding text class (active=yellow, inactive=muted).
const G = (props) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props} />
);

function CandleGlyph() {
  return (
    <G>
      <line x1="6" y1="3" x2="6" y2="21" />
      <rect x="4" y="7" width="4" height="10" fill="currentColor" />
      <line x1="18" y1="2" x2="18" y2="22" />
      <rect x="16" y="10" width="4" height="8" fill="currentColor" opacity="0.3" />
    </G>
  );
}
function BarsGlyph() {
  return (
    <G>
      <line x1="6" y1="3" x2="6" y2="21" />
      <line x1="3" y1="8" x2="6" y2="8" />
      <line x1="6" y1="14" x2="9" y2="14" />
      <line x1="18" y1="3" x2="18" y2="21" />
      <line x1="15" y1="10" x2="18" y2="10" />
      <line x1="18" y1="18" x2="21" y2="18" />
    </G>
  );
}
function HollowGlyph() {
  return (
    <G>
      <line x1="6" y1="3" x2="6" y2="21" />
      <rect x="4" y="7" width="4" height="10" />
      <line x1="18" y1="2" x2="18" y2="22" />
      <rect x="16" y="10" width="4" height="8" fill="currentColor" opacity="0.3" />
    </G>
  );
}
function LineGlyph() {
  return <G><polyline points="3 17 9 11 14 14 21 6" /></G>;
}
function LineMarkersGlyph() {
  return (
    <G>
      <polyline points="3 17 9 11 14 14 21 6" />
      <circle cx="9" cy="11" r="1.4" fill="currentColor" />
      <circle cx="14" cy="14" r="1.4" fill="currentColor" />
      <circle cx="21" cy="6" r="1.4" fill="currentColor" />
    </G>
  );
}
function StepLineGlyph() {
  return <G><polyline points="3 18 8 18 8 12 14 12 14 7 21 7" /></G>;
}
function AreaGlyph() {
  return (
    <G>
      <polyline points="3 17 9 11 14 14 21 6" />
      <path d="M3 17 L9 11 L14 14 L21 6 L21 21 L3 21 Z" fill="currentColor" opacity="0.25" stroke="none" />
    </G>
  );
}
function BaselineGlyph() {
  return (
    <G>
      <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="2,2" />
      <polyline points="3 16 9 9 14 13 21 5" />
    </G>
  );
}
function HistogramGlyph() {
  return (
    <G>
      <rect x="4" y="14" width="3" height="6" fill="currentColor" />
      <rect x="9" y="9" width="3" height="11" fill="currentColor" />
      <rect x="14" y="12" width="3" height="8" fill="currentColor" />
      <rect x="19" y="6" width="3" height="14" fill="currentColor" />
    </G>
  );
}
function HeikinAshiGlyph() {
  return (
    <G>
      <line x1="6" y1="4" x2="6" y2="20" />
      <rect x="4" y="7" width="4" height="9" fill="currentColor" />
      <line x1="14" y1="6" x2="14" y2="22" />
      <rect x="12" y="10" width="4" height="8" fill="currentColor" opacity="0.4" />
    </G>
  );
}

// ─── Position pill (chart overlay) ────────────────────────────────────
//
// Floats over a price-line at the right edge of the chart (Exness /
// TradingView style). Three variants:
//   entry  → side colour (green/red) with live unrealized P&L · static
//   sl     → neon red,   hypothetical P&L if SL fires   · DRAGGABLE
//   tp     → neon green, hypothetical P&L if TP fires   · DRAGGABLE
/**
 * Floating right-click menu rendered above the chart canvas. Fixed-position
 * (page coords) so it can extend outside the chart container if the user
 * right-clicks near an edge. Backdrop captures outside clicks.
 *
 * Items mirror the spec exactly:
 *   - Refresh Scale         one-shot autoScale re-apply (doesn't clear locks)
 *   - Auto Fit Chart        clear locks + fitContent + autoScale
 *   - Reset Y-Axis Zoom     clear Y lock + autoScale
 *   - Reset X-Axis Zoom     clear X lock + fitContent
 *   - Reset All View        clear both locks + fitContent + scroll-to-now
 *
 * Active lock indicators are shown next to "Reset Y" / "Reset X" so the
 * user knows which axis they're currently controlling manually.
 */
function ChartContextMenu({
  x, y, theme,
  onClose, onRefresh, onAutoFit, onResetY, onResetX, onResetAll,
  manualY, manualX,
}) {
  const isDark = theme === 'dark';
  const card = isDark
    ? { bg: '#0F172A', bgHover: '#1E293B', border: '#334155', text: '#F1F5F9', muted: '#94A3B8', divider: '#1E293B' }
    : { bg: '#FFFFFF', bgHover: '#F1F5F9', border: '#E2E8F0', text: '#0F172A', muted: '#64748B', divider: '#E2E8F0' };

  return (
    <>
      {/* Backdrop — invisible full-screen click target that dismisses the
          menu on outside click without stealing scroll / keyboard events. */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="fixed z-50 rounded-xl py-1.5 font-medium text-[13px] shadow-2xl select-none"
        style={{
          left: x,
          top:  y,
          minWidth: 220,
          background: card.bg,
          border: `1px solid ${card.border}`,
          color: card.text,
          backdropFilter: 'blur(8px)',
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <CtxItem onClick={onRefresh} card={card} icon={<IconRefresh />}>
          Refresh Scale
        </CtxItem>
        <CtxItem onClick={onAutoFit} card={card} icon={<IconFit />}>
          Auto Fit Chart
        </CtxItem>
        <CtxDivider card={card} />
        <CtxItem onClick={onResetY} card={card} icon={<IconYAxis />} trailing={manualY ? <LockedDot card={card} /> : null}>
          Reset Y-Axis Zoom
        </CtxItem>
        <CtxItem onClick={onResetX} card={card} icon={<IconXAxis />} trailing={manualX ? <LockedDot card={card} /> : null}>
          Reset X-Axis Zoom
        </CtxItem>
        <CtxDivider card={card} />
        <CtxItem onClick={onResetAll} card={card} icon={<IconResetAll />} accent>
          Reset All View
        </CtxItem>
      </div>
    </>
  );
}

function CtxItem({ onClick, card, icon, accent, trailing, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-2 flex items-center gap-2.5 transition-colors text-left"
      onMouseEnter={(e) => { e.currentTarget.style.background = card.bgHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      style={{ color: accent ? '#3B82F6' : card.text }}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0" style={{ color: accent ? '#3B82F6' : card.muted }}>
        {icon}
      </span>
      <span className="flex-1">{children}</span>
      {trailing}
    </button>
  );
}

function CtxDivider({ card }) {
  return <div className="h-px mx-2 my-1" style={{ background: card.divider }} />;
}

function LockedDot({ card }) {
  // Tiny dot indicates the user has a manual lock on this axis.
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
      style={{ background: '#F59E0B22', color: '#F59E0B' }}
      title="Manual scale active"
    >
      Manual
    </span>
  );
}

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);
const IconFit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V3h4" /><path d="M21 7V3h-4" /><path d="M3 17v4h4" /><path d="M21 17v4h-4" />
    <rect x="7" y="7" width="10" height="10" rx="1" />
  </svg>
);
const IconYAxis = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4v16" /><path d="M4 8h4" /><path d="M4 14h4" /><path d="M4 20h4" />
  </svg>
);
const IconXAxis = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16" /><path d="M8 20v-4" /><path d="M14 20v-4" /><path d="M20 20v-4" />
  </svg>
);
const IconResetAll = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9" />
    <path d="M3 4v5h5" />
  </svg>
);

//
// Visual treatment:
//   • Glassmorphism pill: bg-white/95 + backdrop-blur
//   • On hover (or while dragging): horizontal glow line spans the chart
//     width at the pill's Y; pill itself gains a soft outer halo ring.
//   • SL/TP pill cursor: ns-resize. Pointer down anywhere on the pill
//     (except ×) starts a drag.
function PositionPill({
  y, kind, position, pricePrecision,
  target = 'position',
  isDragging = false,
  snapped = false,
  overridePrice = null,
  showQuickTp = false,
  showQuickSl = false,
  onClose,
  onDragStart,
  onQuickDragStart,
}) {
  const [hover, setHover] = useState(false);
  // Mount-in animation flag. Flips to `true` on the next frame so the
  // CSS transition has a real start state to animate from. Without the
  // rAF dodge React batches the initial render and the transition fires
  // with no delta. Animation runs once per pill key (i.e. once per
  // order creation), giving the TP/SL pill a soft slide-in on appear.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const qty = Number(position.quantity) || 0;
  const entry = Number(position.entryPrice) || 0;
  const isBuy = position.side === 'BUY';
  const isOrder = target === 'order';
  // Order entries are also draggable (re-price the LIMIT / STOP trigger).
  const draggable = kind === 'sl' || kind === 'tp' || (kind === 'entry' && isOrder);
  const active = hover || isDragging;

  // Resolve target price: while dragging, use the live override.
  let targetPrice;
  if (overridePrice != null) targetPrice = overridePrice;
  else if (kind === 'sl')  targetPrice = Number(position.stopLoss)   || 0;
  else if (kind === 'tp')  targetPrice = Number(position.takeProfit) || 0;
  else                     targetPrice = entry;

  // Colour scheme — keep entry/TP/SL visually distinct:
  //   Entry BUY  → blue   (#3B82F6) / glow #60A5FA
  //   Entry SELL → orange (#F97316) / glow #FB923C
  //   TP         → neon green (#10b981) / glow #34d399
  //   SL         → neon red   (#ef4444) / glow #f87171
  let color;
  let glowColor;
  let usd;
  if (kind === 'entry') {
    color     = isBuy ? '#3B82F6' : '#F97316';
    glowColor = isBuy ? '#60A5FA' : '#FB923C';
    usd = Number(position.unrealizedPnl) || 0;
  } else if (kind === 'sl') {
    color = '#ef4444';
    glowColor = '#f87171';
    usd = (isBuy ? targetPrice - entry : entry - targetPrice) * qty;
  } else {
    color = '#10b981';
    glowColor = '#34d399';
    usd = (isBuy ? targetPrice - entry : entry - targetPrice) * qty;
  }

  const qtyStr = qty.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const usdStr = `${usd >= 0 ? '+' : ''}${usd.toFixed(2)}`;
  const priceStr = targetPrice.toFixed(Math.min(8, Math.max(0, Number(pricePrecision) || 2)));
  // Short kind label that renders inside the pill. Entry pills keep their
  // existing qty-first layout for backwards compatibility, while SL/TP
  // pills lead with the label so users can tell them apart at a glance.
  // Pending-order entry pills also lead with a label (LIMIT / STOP) so
  // the user can distinguish them from filled-position entries.
  const labelStr = kind === 'sl'
    ? 'SL'
    : kind === 'tp'
      ? 'TP'
      : isOrder
        ? (position.__orderType === 'STOP' ? 'STOP' : 'LIMIT')
        : null;

  return (
    <>
      {/* Glow strip — soft horizontal line spanning the chart width.
          Renders only on hover/drag so the chart isn't visually noisy
          when nothing is interactive. */}
      {active && (
        <div
          className="absolute left-0 right-0 pointer-events-none"
          style={{
            top: `${y - 1}px`,
            height: '2px',
            background: glowColor,
            boxShadow: `0 0 8px ${glowColor}, 0 0 16px ${glowColor}80`,
            opacity: 0.85,
            transition: 'opacity 120ms ease-out',
          }}
        />
      )}

      {/* Live price chip on the right axis while dragging — TradingView
          shows the dragged level as a coloured axis label. */}
      {isDragging && (
        <div
          className="absolute pointer-events-none font-mono text-[11px] tabular-nums font-bold px-1.5 py-1 rounded-sm shadow-md keep-white"
          style={{
            top: `${y - 11}px`,
            right: '2px',
            background: color,
            color: '#FFFFFF',
          }}
        >
          {priceStr}
        </div>
      )}

      {/* The pill itself — compact, square corners, centered horizontally */}
      <div
        className="absolute pointer-events-auto select-none touch-none"
        style={{
          // Height ≈ 18px → offset by 9 to centre on the line.
          top: `${y - 9}px`,
          // Horizontally centered over the chart.
          left: '50%',
          // Mount-in animation: start slightly translated + faded, settle
          // into place on the next frame. Live drags suppress the spring
          // so the pill tracks the cursor 1:1.
          transform: `translateX(-50%) translateY(${mounted ? 0 : -4}px) ${active ? 'scale(1.02)' : 'scale(1)'}`,
          opacity: mounted ? 1 : 0,
          transformOrigin: 'center center',
          transition: isDragging
            ? 'none'
            : 'top 80ms ease-out, transform 220ms cubic-bezier(0.16,1,0.3,1), opacity 220ms ease-out',
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onMouseDown={(e) => onDragStart?.(e)}
        onTouchStart={(e) => onDragStart?.(e)}
      >
        {/* Outer group — splits the pill into two side-by-side chips:
              1. quick-add (+TP / +SL) — leads on the left so the user
                 can grab a level as soon as they spot the position.
              2. main info chip — price/qty · PnL · × close.
            A small gap between them prevents the +TP/+SL buttons from
            visually merging into the price segment. */}
        <div className="flex items-stretch gap-1.5 font-mono text-[10.5px] leading-none">
          {/* +TP — standalone draggable chip, green. mousedown stops
              propagation so the entry pill's own drag doesn't fire. */}
          {showQuickTp && (
            <button
              type="button"
              onMouseDown={(e) => { e.stopPropagation(); onQuickDragStart?.('tp', e); }}
              onTouchStart={(e) => { e.stopPropagation(); onQuickDragStart?.('tp', e); }}
              onClick={(e) => e.stopPropagation()}
              className="px-1.5 py-0.5 hover:brightness-110 transition-all flex items-center gap-0.5 keep-white"
              style={{
                background: '#10b981',
                color: '#FFFFFF',
                border: '1px solid #10b981',
                cursor: 'grab',
                boxShadow: '0 1px 3px rgba(16,185,129,0.25)',
              }}
              title="Drag down/up to set Take Profit"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
              <span className="text-[9px] font-extrabold tracking-wide">TP</span>
            </button>
          )}
          {/* +SL — standalone draggable chip, red. */}
          {showQuickSl && (
            <button
              type="button"
              onMouseDown={(e) => { e.stopPropagation(); onQuickDragStart?.('sl', e); }}
              onTouchStart={(e) => { e.stopPropagation(); onQuickDragStart?.('sl', e); }}
              onClick={(e) => e.stopPropagation()}
              className="px-1.5 py-0.5 hover:brightness-110 transition-all flex items-center gap-0.5 keep-white"
              style={{
                background: '#ef4444',
                color: '#FFFFFF',
                border: '1px solid #ef4444',
                cursor: 'grab',
                boxShadow: '0 1px 3px rgba(239,68,68,0.25)',
              }}
              title="Drag down/up to set Stop Loss"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
              <span className="text-[9px] font-extrabold tracking-wide">SL</span>
            </button>
          )}
          {/* Main info chip — label · price/qty · PnL · × close. */}
          <div
            className="flex items-stretch bg-white/85 backdrop-blur-md"
            style={{
              border: `1px solid ${snapped ? glowColor : color}`,
              color,
              cursor: isDragging
                ? 'grabbing'
                : draggable
                  ? 'grab'
                  : 'pointer',
              boxShadow: active
                ? `0 0 0 1px ${glowColor}55, 0 0 14px ${glowColor}66, 0 2px 8px rgba(0,0,0,0.12)`
                : '0 1px 3px rgba(0,0,0,0.10)',
              transition: 'box-shadow 120ms ease-out, border-color 120ms ease-out, background-color 120ms ease-out',
            }}
            title={draggable ? `${labelStr || ''} · drag to move · click to edit` : 'Click to edit · drag to move'}
          >
            {/* Lead label — TP/SL/LIMIT/STOP chip with coloured bg. */}
            {labelStr && (
              <span
                className="px-1.5 py-0.5 font-extrabold tracking-wide text-[10px] keep-white"
                style={{ background: color, color: '#FFFFFF' }}
              >
                {labelStr}
              </span>
            )}
            {/* Current price (when labeled) or qty (entry pill fallback). */}
            {labelStr ? (
              <span
                className="px-1.5 py-0.5 tabular-nums font-bold"
                style={{ borderLeft: `1px solid ${color}` }}
              >
                {priceStr}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 tabular-nums font-semibold">{qtyStr}</span>
            )}
            <span
              className="px-1.5 py-0.5 tabular-nums font-semibold"
              style={{ borderLeft: `1px solid ${color}` }}
            >
              {usdStr}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose?.(); }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="px-1.5 py-0.5 hover:bg-black/10 transition-colors flex items-center"
              style={{ borderLeft: `1px solid ${color}`, cursor: 'pointer' }}
              title={kind === 'entry' ? (isOrder ? 'Cancel order' : 'Close position') : `Remove ${labelStr || kind.toUpperCase()}`}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
