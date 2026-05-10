import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { ema, rsi, macd } from '../utils/indicators';
import { useThemeStore } from '../store/theme';

// Resolve a CSS-variable RGB triplet (e.g. "26 26 31") into an `rgb(...)`
// string the chart library understands. Reads live, so each call returns the
// CURRENT theme's value — important for re-applying on theme toggle.
//
// Comma-separated rgb(R, G, B) form is used because lightweight-charts'
// color parser predates CSS Color Level 4 space-separated syntax — a value
// like `rgb(15 15 18)` parses as black/transparent in some builds and
// crashes the chart constructor with a vague error.
const cssVar = (name, fallback) => {
  if (typeof document === 'undefined') return fallback;
  let v = '';
  try {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (_) { /* document not ready, fall back */ }
  if (!v) return fallback;
  // If value is a triplet ("R G B"), convert to legacy comma form.
  if (/^\d+\s+\d+\s+\d+$/.test(v)) {
    return `rgb(${v.replace(/\s+/g, ', ')})`;
  }
  return v;
};

const chartPalette = () => ({
  background: cssVar('--color-bg-card', '#1a2129'),
  text: cssVar('--color-text-secondary', '#9ca3af'),
  grid: cssVar('--color-border-subtle', '#232b35'),
  border: cssVar('--color-border-dark', '#2a323d'),
});

const TF_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Indicator presets — user can toggle on/off. Each adds one or more line series.
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
}) {
  const containerRef = useRef(null);
  const rsiContainerRef = useRef(null);
  const macdContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const overlayRef = useRef({}); // { ema12: series, ... }
  const subPanelChartsRef = useRef({}); // { rsi, macd }
  // Map of priceLine ID → priceLine instance, so we can diff/remove cleanly.
  // Key format: "<kind>:<id>:<role>" e.g. "order:abc123:trigger", "pos:xyz:sl".
  const priceLinesRef = useRef(new Map());
  // Latest candles snapshot — read by the series' autoscaleInfoProvider closure.
  // Lives in a ref because the provider is created once at chart-init time
  // but needs the most recent data on every paint.
  const candlesRef = useRef([]);

  const [indicators, setIndicators] = useState(INDICATOR_DEFAULTS);
  const [candles, setCandles] = useState([]);
  const theme = useThemeStore((s) => s.theme);

  // Initialize main chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const pal = chartPalette();
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 400,
      layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
      grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      // Wider bars + a small right-side margin so live candles don't hug the
      // edge. Default barSpacing is 6px which makes 500 candles look squished
      // on a normal-width chart; 10px gives a TradingView-like density.
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: pal.border,
        barSpacing: 10,
        rightOffset: 8,
      },
      rightPriceScale: { borderColor: pal.border },
      crosshair: { mode: 1 },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      borderUpColor: '#10b981', borderDownColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
      // Default auto-scale fits everything including price-lines and one-off
      // bad-tick wicks, which can squash candles into a sliver. Clip to the
      // 1st–99th percentile of recent candle highs/lows so a single outlier
      // doesn't blow up the y-axis.
      autoscaleInfoProvider: (original) => {
        const data = candlesRef.current;
        if (!data || data.length < 5) return original();
        const lows = data.map((c) => c.low).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
        const highs = data.map((c) => c.high).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
        if (!lows.length || !highs.length) return original();
        const lo = lows[Math.floor(lows.length * 0.01)];
        const hi = highs[Math.min(highs.length - 1, Math.ceil(highs.length * 0.99))];
        // Always include the most recent close so the live tick stays in view.
        const last = data[data.length - 1];
        return {
          priceRange: {
            minValue: Math.min(lo, last.close),
            maxValue: Math.max(hi, last.close),
          },
          margins: { above: 20, below: 20 },
        };
      },
    });
    chartRef.current = chart;
    candleSeriesRef.current = series;

    const resize = () => {
      if (chart && containerRef.current) {
        const w = containerRef.current.clientWidth;
        // Only apply when width is meaningful — a hidden parent (display:none
        // or a stacked tab) has clientWidth=0, which collapses the chart.
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

    // ResizeObserver catches container size changes from layout reflows
    // (sidebar collapse, responsive grid swap, modal open) that don't fire
    // a window resize event — without it the chart stays at its initial
    // width forever in those cases.
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(resize);
      ro.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      // Dispose any sub-panel (RSI/MACD) charts that were created. Pre-fix
      // these only got cleaned up when the user toggled the indicator off;
      // navigating away with an indicator active leaked the chart object
      // and its DOM listeners every time.
      for (const sc of Object.values(subPanelChartsRef.current)) {
        try { sc.chart?.remove(); } catch (_) { /* already disposed */ }
      }
      subPanelChartsRef.current = {};
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      overlayRef.current = {};
      priceLinesRef.current.clear();
    };
  }, []);

  // Re-apply chart palette when the theme toggles. Without this, switching
  // dark→light leaves the chart with a dark background while the rest of
  // the app turns light. We also re-skin any sub-panel charts in flight
  // (RSI/MACD) the same way.
  useEffect(() => {
    const pal = chartPalette();
    try {
      chartRef.current?.applyOptions({
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
      });
    } catch (_) { /* main chart not ready */ }
    for (const sc of Object.values(subPanelChartsRef.current)) {
      try {
        sc.chart?.applyOptions({
          layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
          grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
          timeScale: { borderColor: pal.border },
          rightPriceScale: { borderColor: pal.border },
        });
      } catch (_) { /* sub-panel disposed */ }
    }
  }, [theme]);

  // Match price-axis precision to the instrument so EURUSD shows 1.17852
  // instead of being rounded to 1.18, and BTC stays at 2 decimals.
  // minMove of 10^-precision is what lightweight-charts uses to round
  // y-axis labels and crosshair readouts.
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const p = Math.max(0, Math.min(8, Number(pricePrecision) || 2));
    const minMove = Number(`1e-${p}`) || 0.01;
    try {
      candleSeriesRef.current.applyOptions({
        priceFormat: { type: 'price', precision: p, minMove },
      });
    } catch (_) { /* series not ready */ }
  }, [pricePrecision]);

  // Load candles + subscribe to live updates
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    let cancelled = false;
    let unsub = null;

    // Clear old data immediately on symbol/timeframe switch so the chart
    // doesn't show stale candles from the previous symbol while the new
    // historical fetch is in flight.
    try {
      candleSeriesRef.current.setData([]);
      candlesRef.current = [];
    } catch (_) { /* chart not ready yet */ }
    setCandles([]);

    const load = async () => {
      try {
        const { data } = await api.get(`/instruments/${symbol}/candles`, {
          params: { timeframe, limit: 500 },
        });
        if (cancelled) return;
        const raw = Array.isArray(data?.data) ? data.data : [];
        // Map → numeric form, drop bad rows, and guarantee strictly-ascending
        // time order. lightweight-charts throws if `setData` receives a
        // non-monotonic series, and dedupe protects against the candle service
        // rarely emitting two rows for the same bucket.
        const formatted = raw
          .map((c) => ({
            time: Math.floor(new Date(c.openTime).getTime() / 1000),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
          }))
          .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open))
          .sort((a, b) => a.time - b.time);
        // Dedupe consecutive same-time points (latest wins).
        const deduped = [];
        for (const c of formatted) {
          const last = deduped[deduped.length - 1];
          if (last && last.time === c.time) deduped[deduped.length - 1] = c;
          else deduped.push(c);
        }
        candleSeriesRef.current.setData(deduped);
        candlesRef.current = deduped;
        setCandles(deduped);
        // Force the price scale to reapply autoscaleInfoProvider against the
        // freshly-loaded data; otherwise the chart can hold the previous
        // symbol's range until the next tick.
        try { candleSeriesRef.current.priceScale().applyOptions({ autoScale: true }); } catch (_) {}
        // Default viewport: show the last ~90 candles (TradingView-style
        // density). Without this, the chart fits all 500 candles into view
        // and each bar collapses to 1-2px wide. The rightOffset:8 in the
        // time-scale options gives the live candle a few empty bars of
        // breathing room on the right.
        try {
          const visibleCount = 90;
          if (deduped.length > visibleCount && chartRef.current) {
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: deduped.length - visibleCount,
              to: deduped.length - 1,
            });
          } else if (chartRef.current) {
            chartRef.current.timeScale().fitContent();
          }
        } catch (_) { /* time-scale not ready yet */ }
      } catch (e) {
        // ignore
      }
    };
    load();

    unsub = wsClient.subscribe(`candles:${symbol}:${timeframe}`, (candle) => {
      if (!candleSeriesRef.current) return;
      const point = {
        time: Math.floor(new Date(candle.openTime).getTime() / 1000),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      };
      // Guard against bad inputs and out-of-order ticks. lightweight-charts
      // throws "Value is null" or "Cannot update oldest data" when fed a
      // point whose time predates the latest in the series — happens when
      // a stale tick lands after a faster newer one (e.g. across a feed
      // failover).
      if (!Number.isFinite(point.time) || !Number.isFinite(point.close)) return;
      const lastInRef = candlesRef.current[candlesRef.current.length - 1];
      if (lastInRef && point.time < lastInRef.time) return;

      try {
        candleSeriesRef.current.update(point);
      } catch (err) {
        // Defensive: if lightweight-charts still rejects (e.g. internal
        // state diverged from candlesRef), don't crash the whole chart —
        // log once and keep the previous good frame.
        console.warn('[PriceChart] update() rejected:', err.message);
        return;
      }
      setCandles((prev) => {
        const last = prev[prev.length - 1];
        const next = last && last.time === point.time
          ? [...prev.slice(0, -1), point]
          : [...prev, point];
        candlesRef.current = next;
        return next;
      });
    });

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [symbol, timeframe]);

  // Compute closes once per candles update
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);

  // Manage EMA overlay series
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
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: `EMA ${cfg.period}`,
        });
        overlayRef.current[cfg.key] = series;
      } else if (!enabled && exists) {
        chartRef.current.removeSeries(exists);
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

  // RSI sub-panel
  useEffect(() => {
    const enabled = indicators.rsi;
    const container = rsiContainerRef.current;
    if (!container) return;

    if (!enabled) {
      const existing = subPanelChartsRef.current.rsi;
      if (existing) {
        existing.chart.remove();
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
      // Reference lines at 30 and 70
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

  // Filter inputs to the symbol shown on this chart (parent passes everything).
  const symbolOrders = useMemo(
    () => (openOrders || []).filter((o) => o.symbol === symbol),
    [openOrders, symbol]
  );
  const symbolPositions = useMemo(
    () => (positions || []).filter((p) => p.symbol === symbol),
    [positions, symbol]
  );

  // Reconcile price lines on the candle series whenever the inputs change.
  // We compute the desired set, diff against the live set, and add/remove only
  // the changed ones — TradingView Lightweight charts has no "setAll" API.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    const desired = new Map(); // key → { price, options }
    const fmt = (v) => Number(v).toFixed(Math.min(pricePrecision, 8));

    // 1) Pending LIMIT orders → solid line at limit price
    // 2) Pending STOP orders → dashed line at stopPrice; optional dotted at limit
    for (const o of symbolOrders) {
      const sideColor = o.side === 'BUY' ? '#10b981' : '#ef4444';
      if (o.type === 'LIMIT' && o.price) {
        desired.set(`order:${o._id}:limit`, {
          price: Number(o.price),
          color: sideColor,
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `${o.side} LIMIT ${fmt(o.price)}`,
        });
      } else if (o.type === 'STOP') {
        if (o.stopPrice) {
          desired.set(`order:${o._id}:trigger`, {
            price: Number(o.stopPrice),
            color: sideColor,
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: `${o.side} STOP ${fmt(o.stopPrice)}`,
          });
        }
        if (o.price) {
          desired.set(`order:${o._id}:stoplimit`, {
            price: Number(o.price),
            color: sideColor,
            lineWidth: 1,
            lineStyle: 1, // dotted
            axisLabelVisible: false,
            title: `STOP-LIM ${fmt(o.price)}`,
          });
        }
      }
    }

    // 3) Open positions → SL (red), TP (green). Entry line intentionally
    //    omitted to keep the chart uncluttered; entry price stays visible
    //    in the positions table.
    for (const p of symbolPositions) {
      if (p.stopLoss) {
        desired.set(`pos:${p._id}:sl`, {
          price: Number(p.stopLoss),
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `SL ${fmt(p.stopLoss)}`,
        });
      }
      if (p.takeProfit) {
        desired.set(`pos:${p._id}:tp`, {
          price: Number(p.takeProfit),
          color: '#10b981',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `TP ${fmt(p.takeProfit)}`,
        });
      }
    }

    // 4) Live last price — subtle teal dotted line on the right axis
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

    // 5) Pending order preview from OrderForm — only when user is typing
    if (pendingPreview && pendingPreview.price && Number(pendingPreview.price) > 0) {
      desired.set('preview:form', {
        price: Number(pendingPreview.price),
        color: pendingPreview.side === 'BUY' ? '#10b981' : '#ef4444',
        lineWidth: 2,
        lineStyle: 1, // dotted to distinguish from a placed order
        axisLabelVisible: true,
        title: `↺ ${pendingPreview.side} ${pendingPreview.type}`,
      });
    }

    // Diff: remove keys no longer desired, add new ones, update price-shifted ones
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
        // applyOptions accepts the same shape; cheap update path.
        try { existing.applyOptions(opts); } catch (_) {}
      } else {
        try {
          const pl = series.createPriceLine(opts);
          live.set(key, pl);
        } catch (_) {}
      }
    }
  }, [symbolOrders, symbolPositions, livePrice, pendingPreview, pricePrecision]);

  // Cleanup all price lines when the component unmounts (chart.remove already
  // disposes them, but if we ever swap series we want a clean ref).
  useEffect(() => {
    return () => {
      priceLinesRef.current.clear();
    };
  }, []);

  // MACD sub-panel
  useEffect(() => {
    const enabled = indicators.macd;
    const container = macdContainerRef.current;
    if (!container) return;

    if (!enabled) {
      const existing = subPanelChartsRef.current.macd;
      if (existing) {
        existing.chart.remove();
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

  return (
    <div className="card overflow-hidden">
      {/* Premium chart header — symbol pill on the left, indicator pills +
          timeframe segmented control on the right. Gradient inset on the
          bottom border so the header reads as "lifted" off the chart. */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-dark flex-wrap gap-2 bg-gradient-to-r from-bg-card to-bg-card/50">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
          <span className="text-sm font-bold text-white">{symbol}</span>
          <span className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold ml-1">
            {timeframe}
          </span>
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
          {/* Timeframe segmented control — single border-wrapped group with
              an active pill that pops in yellow */}
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

      {/* Main candlestick chart */}
      <div ref={containerRef} className="w-full" />

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
