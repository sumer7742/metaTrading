import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { ema, rsi, macd } from '../utils/indicators';
import { useThemeStore } from '../store/theme';

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
// for visual consistency. Centralised so a single tweak rolls everywhere.
const TV_COLORS = {
  background: '#131722',
  grid: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.1)',
  text: '#787b86',
  crosshair: 'rgba(255, 255, 255, 0.3)',
  up: '#26a69a',
  down: '#ef5350',
  volumeUp: 'rgba(38, 166, 154, 0.5)',
  volumeDown: 'rgba(239, 83, 80, 0.5)',
};

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
  if (!Array.isArray(candles) || candles.length < 2) return candles || [];
  const out = [candles[0]];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1];
    const next = candles[i];
    // Defensive: if `next` isn't aligned to the bucket grid, snap it down.
    const nextTime = bucketFloor(next.time, tfSec);
    let t = prev.time + tfSec;
    while (t < nextTime) {
      const c = prev.close;
      out.push({ time: t, open: c, high: c, low: c, close: c, volume: 0 });
      t += tfSec;
    }
    out.push({ ...next, time: nextTime });
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
const makeAutoscaleProvider = (candlesRef, extraPricesRef) => () => {
  const data = candlesRef.current;
  if (!data || data.length < 5) return null;
  // Short recent window — tracks live action and produces a small price
  // span, which is what the label-step heuristic latches onto.
  const recent = data.slice(-40);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of recent) {
    if (Number.isFinite(c.low) && c.low < lo) lo = c.low;
    if (Number.isFinite(c.high) && c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const last = data[data.length - 1];
  if (Number.isFinite(last?.close)) {
    lo = Math.min(lo, last.close);
    hi = Math.max(hi, last.close);
  }
  // Tiny symmetric pad so wicks don't kiss the top/bottom edge.
  const span = Math.max(hi - lo, Math.abs(hi) * 1e-6, 1e-9);
  const pad = span * 0.05;
  lo -= pad;
  hi += pad;
  // Pull in user-placed price lines, but cap the stretch so a distant
  // LIMIT can't ruin the tight scale that drives label density.
  const extras = extraPricesRef?.current;
  if (Array.isArray(extras) && extras.length) {
    const maxStretch = span * 0.10;
    for (const p of extras) {
      if (!Number.isFinite(p) || p <= 0) continue;
      if (p < lo) lo = Math.max(p, lo - maxStretch);
      if (p > hi) hi = Math.min(p, hi + maxStretch);
    }
  }
  return {
    priceRange: { minValue: lo, maxValue: hi },
    margins: { above: 0, below: 0 },
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
export function createSeriesByChartType(chart, chartType, candlesRef, extraPricesRef) {
  const autoscale = makeAutoscaleProvider(candlesRef, extraPricesRef);
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
        color: '#FCD535',
        lineWidth: 2,
        lineType: 0, // simple
        priceLineVisible: true,
        crosshairMarkerVisible: true,
      });

    case 'lineMarkers':
      // Same as line; markers are placed via setMarkers in updateSeriesData.
      return chart.addLineSeries({
        color: '#FCD535',
        lineWidth: 2,
        lineType: 0,
        priceLineVisible: true,
        crosshairMarkerVisible: true,
      });

    case 'stepLine':
      // lineType=1 is WithSteps — values are connected by horizontal+vertical
      // segments rather than a smooth diagonal.
      return chart.addLineSeries({
        color: '#FCD535',
        lineWidth: 2,
        lineType: 1,
        priceLineVisible: true,
      });

    case 'area':
      return chart.addAreaSeries({
        topColor: 'rgba(252, 213, 53, 0.30)',
        bottomColor: 'rgba(252, 213, 53, 0.00)',
        lineColor: '#FCD535',
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
            color: '#FCD535',
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
            color: '#FCD535',
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
  ema12: false,
  ema26: false,
  ema50: false,
  ema200: false,
  rsi: false,
  macd: false,
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
}) {
  const containerRef = useRef(null);
  const rsiContainerRef = useRef(null);
  const macdContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);  // main series — type swaps but ref name stays
  const overlayRef = useRef({});
  const subPanelChartsRef = useRef({});
  const priceLinesRef = useRef(new Map());
  const candlesRef = useRef([]);
  // Volume histogram series — lives on its own overlay price scale (bottom
  // 25% of the chart). Recreated together with the main series on chart-
  // type change so it doesn't survive into a chart type where it shouldn't.
  const volumeSeriesRef = useRef(null);
  // Holds the price levels of every active order / SL / TP / preview / live
  // line so the autoscale provider can include them in the y-axis range —
  // ensures user-placed price lines are always visible on the chart.
  const extraPricesRef = useRef([]);

  const [indicators, setIndicators] = useState(INDICATOR_DEFAULTS);
  const [candles, setCandles] = useState([]);
  const [chartType, setChartType] = useState('candles');
  const [chartTypeOpen, setChartTypeOpen] = useState(false);
  const theme = useThemeStore((s) => s.theme);

  // ─── 1. Initialize chart (no main series yet — handled by chartType effect) ─
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 460,
      layout: {
        // TradingView-default dark bg — keeps chart aesthetic consistent
        // regardless of app theme so candles read at full contrast.
        background: { type: 'solid', color: TV_COLORS.background },
        textColor: TV_COLORS.text,
      },
      grid: {
        vertLines: { color: TV_COLORS.grid },
        horzLines: { color: TV_COLORS.grid },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: TV_COLORS.border,
        // Tighter spacing matches TradingView reference — more candles
        // visible at a glance, less empty space.
        barSpacing: 8,
        minBarSpacing: 4,
        rightOffset: 12,
      },
      rightPriceScale: {
        borderColor: TV_COLORS.border,
        // Tight top margin (8%) + volume row reserved at the bottom 25%
        // gives candles ~67% of the height — matches the reference.
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.25 },
      },
      crosshair: {
        mode: 1, // Magnet — snaps to OHLC values
        vertLine: { width: 1, color: TV_COLORS.crosshair, style: 2, labelBackgroundColor: TV_COLORS.background },
        horzLine: { width: 1, color: TV_COLORS.crosshair, style: 2, labelBackgroundColor: TV_COLORS.background },
      },
    });
    chartRef.current = chart;

    const resize = () => {
      if (chart && containerRef.current) {
        const w = containerRef.current.clientWidth;
        if (w > 0) chart.applyOptions({ width: w });
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

  // ─── 2. Theme re-skin ────────────────────────────────────────────────
  // Main chart keeps the fixed TV-default canvas (#131722) regardless of
  // theme — chart aesthetic is intentionally constant. Sub-panels still
  // follow the app theme.
  useEffect(() => {
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

    const series = createSeriesByChartType(chart, chartType, candlesRef, extraPricesRef);
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

    // Volume histogram lives in the bottom 22% of the chart on its own
    // overlay price scale. Skip for the 'histogram' chart-type (where the
    // main series IS already volume).
    if (chartType !== 'histogram') {
      try {
        const volSeries = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          color: TV_COLORS.volumeUp,
        });
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.78, bottom: 0 },
        });
        volumeSeriesRef.current = volSeries;
      } catch (_) { /* fail-safe */ }
    }

    // Re-paint with the data we already have so the chart isn't blank
    // until the next WS tick.
    if (candlesRef.current.length) {
      updateSeriesData(series, chartType, candlesRef.current);
      _setVolumeData(volumeSeriesRef.current, candlesRef.current);
      _updateLastPriceLineColor(series, candlesRef.current);
    }
  }, [chartType]);

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

  // ─── 4. Load candles + subscribe to live updates ─────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    let cancelled = false;
    let unsub = null;

    // Clear stale data immediately on symbol/timeframe switch.
    try {
      candleSeriesRef.current.setData([]);
      candlesRef.current = [];
    } catch (_) {}
    setCandles([]);

    const load = async () => {
      try {
        const { data } = await api.get(`/instruments/${symbol}/candles`, {
          params: { timeframe, limit: 500 },
        });
        if (cancelled) return;
        const tfSec = tfToSeconds(timeframe);
        const raw = Array.isArray(data?.data) ? data.data : [];
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
          .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open))
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

      // Auto-scroll: if the latest bar is currently visible (user hasn't
      // panned away), keep it in view. Otherwise leave the user's chosen
      // scroll position untouched so live updates don't yank them back.
      try {
        const ts = chartRef.current?.timeScale();
        const range = ts?.getVisibleLogicalRange();
        if (range && range.to >= nextRef.length - 2) {
          ts.scrollToRealTime();
        }
      } catch (_) { /* timeScale may not be ready */ }
    });

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [symbol, timeframe, chartType]);

  // Compute closes once per candles update
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);

  // ─── 5. EMA overlays ─────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current || !candles.length) return;

    const emaConfigs = [
      { key: 'ema12', period: 12, color: '#fbbf24' },
      { key: 'ema26', period: 26, color: '#60a5fa' },
      { key: 'ema50', period: 50, color: '#a78bfa' },
      { key: 'ema200', period: 200, color: '#f472b6' },
    ];

    for (const cfg of emaConfigs) {
      const enabled = indicators[cfg.key];
      const exists = overlayRef.current[cfg.key];
      if (enabled && !exists) {
        const series = chartRef.current.addLineSeries({
          color: cfg.color,
          // 2px is the sweet spot — 1.5px disappeared against candles,
          // 3px over-emphasizes a derived line vs the actual price.
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          title: `EMA ${cfg.period}`,
        });
        overlayRef.current[cfg.key] = series;
      } else if (!enabled && exists) {
        try { chartRef.current.removeSeries(exists); } catch (_) {}
        delete overlayRef.current[cfg.key];
      }
      if (enabled && overlayRef.current[cfg.key]) {
        const values = ema(closes, cfg.period);
        const data = candles
          .map((c, i) => (values[i] != null ? { time: c.time, value: values[i] } : null))
          .filter(Boolean);
        overlayRef.current[cfg.key].setData(data);
      }
    }
  }, [indicators.ema12, indicators.ema26, indicators.ema50, indicators.ema200, candles, closes]);

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
      if (p.stopLoss) {
        desired.set(`pos:${p._id}:sl`, {
          price: Number(p.stopLoss),
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'SL',
        });
      }
      if (p.takeProfit) {
        desired.set(`pos:${p._id}:tp`, {
          price: Number(p.takeProfit),
          color: '#10b981',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'TP',
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
    try { series.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
  }, [symbolOrders, symbolPositions, livePrice, pendingPreview, pricePrecision, chartType]);

  useEffect(() => {
    return () => { priceLinesRef.current.clear(); };
  }, []);

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
    <div className="card overflow-visible">
      {/* Premium header — chart type dropdown + indicator pills + timeframe */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-dark flex-wrap gap-2 bg-gradient-to-r from-bg-card to-bg-card/50">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
          <span className="text-sm font-bold text-white">{symbol}</span>
          <span className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold ml-1">
            {timeframe}
          </span>

          {/* Chart-type dropdown */}
          <div className="relative ml-2">
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
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Indicator pills */}
          <div className="flex gap-1">
            <IndButton active={indicators.ema12} onClick={() => toggle('ema12')} color="#fbbf24">EMA 12</IndButton>
            <IndButton active={indicators.ema26} onClick={() => toggle('ema26')} color="#60a5fa">EMA 26</IndButton>
            <IndButton active={indicators.ema50} onClick={() => toggle('ema50')} color="#a78bfa">EMA 50</IndButton>
            <IndButton active={indicators.ema200} onClick={() => toggle('ema200')} color="#f472b6">EMA 200</IndButton>
            <IndButton active={indicators.rsi} onClick={() => toggle('rsi')} color="#8b5cf6">RSI</IndButton>
            <IndButton active={indicators.macd} onClick={() => toggle('macd')} color="#2dd4bf">MACD</IndButton>
          </div>
          {/* Timeframe segmented control */}
          <div className="flex items-center p-0.5 rounded-md border border-border-dark bg-bg-panel">
            {TF_OPTIONS.map((tf) => (
              <button
                key={tf}
                onClick={() => onTimeframeChange(tf)}
                className={`text-[11px] px-2.5 py-1 rounded transition-all ${
                  tf === timeframe
                    ? 'text-bg-dark font-bold shadow-md'
                    : 'text-text-muted hover:text-text-primary'
                }`}
                style={
                  tf === timeframe
                    ? { background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }
                    : undefined
                }
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main chart canvas + top-right info-strip overlay */}
      <div className="relative w-full" style={{ background: TV_COLORS.background }}>
        <div ref={containerRef} className="w-full" />
        {infoStrip && (
          <div className="pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-3 px-3 py-1.5 rounded-md bg-black/30 backdrop-blur-sm border border-white/5 text-[11px] font-medium tracking-wide">
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
