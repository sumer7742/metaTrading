import { useCallback, useEffect, useRef, useState } from 'react';
import { LineStyle } from 'lightweight-charts';

/**
 * Drawing-tools layer for lightweight-charts — Phase 1 + Phase 2.
 *
 * Tools supported:
 *   - crosshair  — default cursor, no drawing
 *   - magnet     — toggles chart crosshair to magnet mode (snaps to OHLC)
 *   - trendline  — 2 clicks → straight line
 *   - hline      — 1 click on a price → horizontal price line
 *   - text       — 1 click → prompt for text → marker label
 *   - measure    — 2 clicks → dashed line + readout (Δ price + Δ %)
 *   - fib        — 2 clicks → fibonacci retracement (0 / 23.6 / 38.2 / 50 / 61.8 / 78.6 / 100)
 *   - pitchfork  — 3 clicks → Andrews' Pitchfork (median + two parallels)
 *   - brush      — mouse-drag → freehand path
 *   - emoji      — 1 click → places the selected emoji marker
 *   - zoom       — applied immediately via button
 *
 * Drawings are persisted per-symbol in localStorage.
 */

const COLORS = {
  trendline: '#3B82F6',
  hline: '#3B82F6',
  text: '#0EA5E9',
  measure: '#F59E0B',
  brush: '#7C3AED',
  pitchforkMedian: '#EC4899',
  pitchforkParallel: '#EC4899',
};

// Standard Fibonacci retracement levels + colours.
const FIB_LEVELS = [
  { pct: 0,    color: '#6B7280' },
  { pct: 23.6, color: '#EF4444' },
  { pct: 38.2, color: '#F59E0B' },
  { pct: 50,   color: '#10B981' },
  { pct: 61.8, color: '#3B82F6' },
  { pct: 78.6, color: '#8B5CF6' },
  { pct: 100,  color: '#6B7280' },
];

const ONE_POINT_TOOLS  = new Set(['hline', 'text', 'emoji']);
const TWO_POINT_TOOLS  = new Set(['trendline', 'measure', 'fib']);
const THREE_POINT_TOOLS = new Set(['pitchfork']);
const DRAG_TOOLS       = new Set(['brush']);

const storeKey = (symbol) => `tradepro:drawings:${symbol || 'GLOBAL'}`;

const readPersisted = (symbol) => {
  try { return JSON.parse(localStorage.getItem(storeKey(symbol)) || '[]'); }
  catch (_) { return []; }
};
const writePersisted = (symbol, drawings) => {
  const slim = drawings.map(({ _handle, ...rest }) => rest);
  try { localStorage.setItem(storeKey(symbol), JSON.stringify(slim)); } catch (_) {}
};

export function useChartDrawings({ chartRef, candleSeriesRef, containerRef, symbol, externalMarkers = [] }) {
  const [activeTool, setActiveTool] = useState('crosshair');
  const [drawings, setDrawings] = useState(() => readPersisted(symbol));
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState([]); // points collected mid-drawing
  const [measureReadout, setMeasureReadout] = useState(null);
  const [selectedEmoji, setSelectedEmoji] = useState('🚀');

  // Handles indexed by drawing id — may be an array (fib = 7 series, pitchfork = 3)
  const handlesRef = useRef(new Map());

  // ── On symbol change, swap to that symbol's persisted set ─────────
  useEffect(() => {
    setDrawings(readPersisted(symbol));
    setPending([]);
    setMeasureReadout(null);
    handlesRef.current.forEach((h) => removeHandle(h));
    handlesRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // ── Persist drawings whenever they change ─────────────────────────
  useEffect(() => { writePersisted(symbol, drawings); }, [symbol, drawings]);

  // ── Magnet — flip the chart's crosshair mode (mode 1 = magnet) ────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.applyOptions({
        crosshair: { mode: activeTool === 'magnet' ? 1 : 0 },
      });
    } catch (_) {}
  }, [activeTool, chartRef]);

  const removeHandle = (handle) => {
    if (!handle) return;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const list = Array.isArray(handle) ? handle : [handle];
    for (const h of list) {
      try {
        if (h.kind === 'series' && chart && h.ref) chart.removeSeries(h.ref);
        if (h.kind === 'priceline' && series && h.ref) series.removePriceLine(h.ref);
      } catch (_) {}
    }
  };

  // ── Re-render every drawing onto the chart whenever drawings/hidden change ─
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    // 1. Wipe everything we previously rendered.
    handlesRef.current.forEach((h) => removeHandle(h));
    handlesRef.current.clear();

    if (hidden) {
      try { series.setMarkers([]); } catch (_) {}
      return;
    }

    // 2. Re-render.
    const markers = [];
    for (const d of drawings) {
      if (d.kind === 'trendline' || d.kind === 'measure') {
        try {
          const s = chart.addLineSeries({
            color: COLORS[d.kind],
            lineWidth: 2,
            lineStyle: d.kind === 'measure' ? LineStyle.Dashed : LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          const pts = [...d.points].sort((a, b) => a.time - b.time);
          s.setData(pts);
          handlesRef.current.set(d.id, { kind: 'series', ref: s });
        } catch (_) {}
      } else if (d.kind === 'hline') {
        try {
          const pl = series.createPriceLine({
            price: Number(d.price),
            color: COLORS.hline,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: d.title || '',
          });
          handlesRef.current.set(d.id, { kind: 'priceline', ref: pl });
        } catch (_) {}
      } else if (d.kind === 'text') {
        markers.push({
          time: d.time,
          position: 'aboveBar',
          color: COLORS.text,
          shape: 'arrowUp',
          text: d.text || 'Note',
        });
      } else if (d.kind === 'emoji') {
        markers.push({
          time: d.time,
          position: 'aboveBar',
          color: '#0EA5E9',
          shape: 'circle',
          text: d.emoji || '⭐',
        });
      } else if (d.kind === 'fib') {
        // Fibonacci — render one horizontal-ish line per level between the
        // two clicked points. Each level series gets two data points so the
        // line spans the full horizontal extent the user defined.
        const [p1, p2] = d.points;
        const lo = Math.min(p1.price, p2.price);
        const hi = Math.max(p1.price, p2.price);
        const tLo = Math.min(p1.time, p2.time);
        const tHi = Math.max(p1.time, p2.time);
        const handles = [];
        for (const lvl of FIB_LEVELS) {
          // 0% sits at the LOWER price, 100% at the HIGHER (TradingView-style).
          const priceAt = lo + (hi - lo) * (lvl.pct / 100);
          try {
            const s = chart.addLineSeries({
              color: lvl.color,
              lineWidth: 1,
              lineStyle: LineStyle.Solid,
              lastValueVisible: false,
              priceLineVisible: false,
              crosshairMarkerVisible: false,
              title: `${lvl.pct.toFixed(1)}%`,
            });
            s.setData([
              { time: tLo, value: priceAt },
              { time: tHi, value: priceAt },
            ]);
            handles.push({ kind: 'series', ref: s });
          } catch (_) {}
        }
        handlesRef.current.set(d.id, handles);
      } else if (d.kind === 'pitchfork') {
        // Andrews' Pitchfork — 3 points: A (anchor), B (upper handle), C (lower handle).
        //   Median: A → midpoint(B,C)
        //   Parallels: through B and C, same slope as median
        // We extend the lines to the right edge of the user's selected range.
        const [A, B, C] = d.points;
        const M = { time: (B.time + C.time) / 2, price: (B.price + C.price) / 2 };
        const dt = M.time - A.time;
        const dp = M.price - A.price;
        // Project each line out to the rightmost picked time + the median's own span,
        // so the fork visibly extends past point C in the trend direction.
        const tEnd = Math.max(A.time, B.time, C.time) + Math.abs(dt) * 0.8;
        const project = (start) => {
          if (dt === 0) return [{ time: start.time, value: start.price }, { time: tEnd, value: start.price }];
          const factor = (tEnd - start.time) / dt;
          return [
            { time: start.time, value: start.price },
            { time: tEnd, value: start.price + dp * factor },
          ];
        };
        const handles = [];
        try {
          // Median line — solid
          const med = chart.addLineSeries({
            color: COLORS.pitchforkMedian,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          med.setData([{ time: A.time, value: A.price }, { time: tEnd, value: A.price + dp * ((tEnd - A.time) / dt) }]);
          handles.push({ kind: 'series', ref: med });
          // Upper parallel (through B)
          const upper = chart.addLineSeries({
            color: COLORS.pitchforkParallel,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          upper.setData(project(B));
          handles.push({ kind: 'series', ref: upper });
          // Lower parallel (through C)
          const lower = chart.addLineSeries({
            color: COLORS.pitchforkParallel,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          lower.setData(project(C));
          handles.push({ kind: 'series', ref: lower });
        } catch (_) {}
        handlesRef.current.set(d.id, handles);
      } else if (d.kind === 'brush') {
        // Freehand path — render as one line series with all collected points.
        try {
          const s = chart.addLineSeries({
            color: COLORS.brush,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          const sorted = [...d.points].sort((a, b) => a.time - b.time);
          // Dedupe by time — lightweight-charts requires monotonic, unique time keys.
          const seen = new Set();
          const clean = sorted.filter((p) => {
            if (seen.has(p.time)) return false;
            seen.add(p.time);
            return Number.isFinite(p.time) && Number.isFinite(p.value);
          });
          if (clean.length >= 2) s.setData(clean);
          handlesRef.current.set(d.id, { kind: 'series', ref: s });
        } catch (_) {}
      }
    }
    // Merge in external markers (Signals / HMR / Economic Calendar
    // overlays from Trade Settings). Sort by time so lightweight-charts
    // gets a monotonic series — out-of-order markers get rejected.
    const merged = [...markers, ...(externalMarkers || [])]
      .filter((m) => m && Number.isFinite(Number(m.time)))
      .sort((a, b) => Number(a.time) - Number(b.time));
    try { series.setMarkers(merged); } catch (_) {}
  }, [drawings, hidden, symbol, chartRef, candleSeriesRef, externalMarkers]);

  // ── Chart click handler — collects points for active tool ─────────
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) return;

    const handler = (param) => {
      if (locked) return;
      if (DRAG_TOOLS.has(activeTool)) return; // brush handled via native mouse
      if (!param.point || !param.time) return;
      const price = series.coordinateToPrice(param.point.y);
      if (!Number.isFinite(price)) return;
      const time = param.time;
      const pt = { time, price };

      if (ONE_POINT_TOOLS.has(activeTool)) {
        if (activeTool === 'hline') {
          addDrawing({ kind: 'hline', price });
        } else if (activeTool === 'text') {
          const txt = window.prompt('Note text:');
          if (txt && txt.trim()) addDrawing({ kind: 'text', time, price, text: txt.trim() });
        } else if (activeTool === 'emoji') {
          addDrawing({ kind: 'emoji', time, price, emoji: selectedEmoji });
        }
        setActiveTool('crosshair');
        return;
      }

      if (TWO_POINT_TOOLS.has(activeTool)) {
        if (pending.length === 0) {
          setPending([pt]);
          return;
        }
        const [first] = pending;
        addDrawing({ kind: activeTool, points: [first, pt] });
        if (activeTool === 'measure') {
          const dPrice = pt.price - first.price;
          const dPct = first.price ? (dPrice / first.price) * 100 : 0;
          setMeasureReadout({ from: first, to: pt, dPrice, dPct });
        }
        setPending([]);
        setActiveTool('crosshair');
        return;
      }

      if (THREE_POINT_TOOLS.has(activeTool)) {
        if (pending.length < 2) {
          setPending([...pending, pt]);
          return;
        }
        addDrawing({ kind: activeTool, points: [...pending, pt] });
        setPending([]);
        setActiveTool('crosshair');
        return;
      }
    };

    chart.subscribeClick(handler);
    return () => { try { chart.unsubscribeClick(handler); } catch (_) {} };
  }, [activeTool, pending, locked, chartRef, candleSeriesRef, selectedEmoji]);

  // ── Brush — native mouse-drag on the chart container ──────────────
  // lightweight-charts only emits crosshair on hover, not while dragging
  // for drawing. We attach native pointer events on the container and
  // convert pixel → time + price using the chart's coordinate APIs.
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const el = containerRef?.current;
    if (!chart || !series || !el) return;
    if (activeTool !== 'brush' || locked) return;

    let drawing = false;
    let pts = [];

    const toChartCoords = (clientX, clientY) => {
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const time = chart.timeScale().coordinateToTime?.(x);
      const value = series.coordinateToPrice(y);
      if (!Number.isFinite(value)) return null;
      if (time == null) return null;
      return { time, value };
    };

    const onDown = (e) => {
      const p = toChartCoords(e.clientX, e.clientY);
      if (!p) return;
      drawing = true;
      pts = [p];
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!drawing) return;
      const p = toChartCoords(e.clientX, e.clientY);
      if (!p) return;
      // Skip duplicate times — lightweight-charts requires monotonic keys.
      const last = pts[pts.length - 1];
      if (last && p.time === last.time) return;
      pts.push(p);
    };
    const onUp = (e) => {
      if (!drawing) return;
      drawing = false;
      el.releasePointerCapture?.(e.pointerId);
      if (pts.length >= 2) {
        addDrawing({ kind: 'brush', points: pts });
      }
      pts = [];
      setActiveTool('crosshair');
    };
    const onCancel = () => {
      drawing = false;
      pts = [];
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    // Disable text-selection while brushing
    el.style.userSelect = 'none';
    el.style.cursor = 'crosshair';
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.style.userSelect = '';
      el.style.cursor = '';
    };
  }, [activeTool, locked, chartRef, candleSeriesRef, containerRef]);

  // ── Mutators ──────────────────────────────────────────────────────
  const addDrawing = useCallback((d) => {
    setDrawings((prev) => [
      ...prev,
      { id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...d },
    ]);
  }, []);
  const removeDrawing = useCallback((id) => {
    setDrawings((prev) => prev.filter((d) => d.id !== id));
  }, []);
  const clearAll = useCallback(() => {
    setDrawings([]);
    setPending([]);
    setMeasureReadout(null);
  }, []);

  // ── Zoom actions (button-driven) ──────────────────────────────────
  const zoomIn = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const r = ts.getVisibleLogicalRange?.();
    if (!r) return;
    const span = r.to - r.from;
    const next = span * 0.7;
    const mid = (r.from + r.to) / 2;
    try { ts.setVisibleLogicalRange({ from: mid - next / 2, to: mid + next / 2 }); } catch (_) {}
  }, [chartRef]);
  const zoomOut = useCallback(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const r = ts.getVisibleLogicalRange?.();
    if (!r) return;
    const span = r.to - r.from;
    const next = span * 1.4;
    const mid = (r.from + r.to) / 2;
    try { ts.setVisibleLogicalRange({ from: mid - next / 2, to: mid + next / 2 }); } catch (_) {}
  }, [chartRef]);
  const resetZoom = useCallback(() => {
    try { chartRef.current?.timeScale().fitContent(); } catch (_) {}
  }, [chartRef]);

  // Cancel mid-flight pending drawing (Escape key)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPending([]);
        setActiveTool('crosshair');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return {
    activeTool, setActiveTool,
    drawings, removeDrawing, clearAll,
    locked, setLocked,
    hidden, setHidden,
    pending,
    measureReadout, clearMeasure: () => setMeasureReadout(null),
    selectedEmoji, setSelectedEmoji,
    zoomIn, zoomOut, resetZoom,
  };
}
