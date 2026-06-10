import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Interactive drawing-tools engine for lightweight-charts.
 *
 * Instead of (mis)using price-lines / line-series — which can't be dragged,
 * selected, extended or rendered correctly while panning — every drawing is
 * painted onto a dedicated <canvas> overlaid on the chart. Anchors are stored
 * in chart space ({ logical, time, price }) and re-projected to pixels on every
 * pan / zoom / resize, so drawings stay glued to the chart like a real terminal.
 *
 * Tools: crosshair (select/move/delete), trendline, hline, fib, pitchfork,
 * brush, text, emoji, measure, magnet. Drawings persist per-symbol.
 *
 * Public API (the `controls` object) is unchanged so the toolbar + PriceChart
 * need no edits.
 */

const COLORS = {
  trendline: '#3B82F6',
  hline: '#3B82F6',
  text: '#0EA5E9',
  emoji: '#0EA5E9',
  measure: '#F59E0B',
  brush: '#7C3AED',
  pitchfork: '#EC4899',
  select: '#FACC15',
};
const FIB_LEVELS = [
  { pct: 0, color: '#6B7280' },
  { pct: 23.6, color: '#EF4444' },
  { pct: 38.2, color: '#F59E0B' },
  { pct: 50, color: '#10B981' },
  { pct: 61.8, color: '#3B82F6' },
  { pct: 78.6, color: '#8B5CF6' },
  { pct: 100, color: '#6B7280' },
];

const ONE_POINT_TOOLS = new Set(['hline', 'text', 'emoji']);
const TWO_POINT_TOOLS = new Set(['trendline', 'measure', 'fib']);
const THREE_POINT_TOOLS = new Set(['pitchfork']);
const HIT_TOL = 6; // px

const VERSION = 'v2';
const storeKey = (symbol) => `tradepro:drawings:${VERSION}:${symbol || 'GLOBAL'}`;
const readPersisted = (symbol) => {
  try { return JSON.parse(localStorage.getItem(storeKey(symbol)) || '[]'); } catch { return []; }
};
const writePersisted = (symbol, drawings) => {
  try { localStorage.setItem(storeKey(symbol), JSON.stringify(drawings)); } catch { /* quota */ }
};

// ── geometry helpers ──────────────────────────────────────────────────
const distToSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

export function useChartDrawings({ chartRef, candleSeriesRef, containerRef, symbol, externalMarkers = [] }) {
  const [activeTool, setActiveTool] = useState('crosshair');
  const [drawings, setDrawings] = useState(() => readPersisted(symbol));
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState([]);     // anchors collected mid-draw
  const [selectedId, setSelectedId] = useState(null);
  const [measureReadout, setMeasureReadout] = useState(null);
  const [selectedEmoji, setSelectedEmoji] = useState('🚀');

  // Refs mirror state for the canvas/event code (avoids re-binding listeners).
  const overlayRef = useRef(null);
  const ctxRef = useRef(null);
  const drawingsRef = useRef(drawings);
  const pendingRef = useRef(pending);
  const hoverRef = useRef(null);        // {x,y} cursor for rubber-band preview
  const dragRef = useRef(null);         // { id, snap:[{x,y}], preview }
  const brushRef = useRef(null);        // { points:[anchor] }
  const selectedRef = useRef(selectedId);
  const hiddenRef = useRef(hidden);
  const lockedRef = useRef(locked);
  const toolRef = useRef(activeTool);
  const emojiRef = useRef(selectedEmoji);
  drawingsRef.current = drawings;
  pendingRef.current = pending;
  selectedRef.current = selectedId;
  hiddenRef.current = hidden;
  lockedRef.current = locked;
  toolRef.current = activeTool;
  emojiRef.current = selectedEmoji;

  // ── coordinate helpers ──
  const xOf = useCallback((anc) => {
    const chart = chartRef.current; if (!chart) return null;
    const ts = chart.timeScale();
    let x = anc.time != null ? ts.timeToCoordinate(anc.time) : null;
    if ((x == null || !Number.isFinite(x)) && anc.logical != null) x = ts.logicalToCoordinate(anc.logical);
    return Number.isFinite(x) ? x : null;
  }, [chartRef]);
  const yOf = useCallback((price) => {
    const s = candleSeriesRef.current; if (!s) return null;
    const y = s.priceToCoordinate(price);
    return Number.isFinite(y) ? y : null;
  }, [candleSeriesRef]);
  const anchorFromXY = useCallback((x, y) => {
    const chart = chartRef.current, s = candleSeriesRef.current;
    if (!chart || !s) return null;
    const ts = chart.timeScale();
    const price = s.coordinateToPrice(y);
    if (!Number.isFinite(price)) return null;
    const logical = ts.coordinateToLogical(x);
    let time = null; try { time = ts.coordinateToTime(x); } catch { time = null; }
    return { logical: Number.isFinite(logical) ? logical : null, time: time ?? null, price };
  }, [chartRef, candleSeriesRef]);

  // ── persistence + symbol swap ──
  useEffect(() => { writePersisted(symbol, drawings); }, [symbol, drawings]);
  useEffect(() => {
    setDrawings(readPersisted(symbol));
    setPending([]); setSelectedId(null); setMeasureReadout(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // ── magnet → chart crosshair mode ──
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    try { chart.applyOptions({ crosshair: { mode: activeTool === 'magnet' ? 1 : 0 } }); } catch { /* */ }
  }, [activeTool, chartRef]);

  // ── external markers (Signals / HMR / Calendar) stay on the series ──
  useEffect(() => {
    const s = candleSeriesRef.current; if (!s) return;
    const merged = (externalMarkers || [])
      .filter((m) => m && Number.isFinite(Number(m.time)))
      .sort((a, b) => Number(a.time) - Number(b.time));
    try { s.setMarkers(merged); } catch { /* */ }
  }, [externalMarkers, candleSeriesRef, symbol]);

  // ── render one drawing ──
  const drawOne = useCallback((ctx, d, paneW, selected) => {
    const stroke = (color, width, dash) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); };
    const handle = (x, y) => { ctx.fillStyle = COLORS.select; ctx.beginPath(); ctx.rect(x - 3, y - 3, 6, 6); ctx.fill(); };

    if (d.kind === 'hline') {
      const y = yOf(d.price); if (y == null) return;
      stroke(selected ? COLORS.select : COLORS.hline, selected ? 2 : 1.5);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke();
      // price tag
      const label = Number(d.price).toLocaleString(undefined, { maximumFractionDigits: 6 });
      ctx.font = '11px ui-monospace, monospace';
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = COLORS.hline; ctx.fillRect(paneW - tw, y - 8, tw, 16);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, paneW - tw + 4, y);
      if (selected) handle(paneW / 2, y);
      return;
    }
    if (d.kind === 'trendline' || d.kind === 'measure') {
      const x1 = xOf(d.a), y1 = yOf(d.a.price), x2 = xOf(d.b), y2 = yOf(d.b.price);
      if ([x1, y1, x2, y2].some((v) => v == null)) return;
      stroke(selected ? COLORS.select : COLORS[d.kind], 2, d.kind === 'measure' ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (d.kind === 'measure') {
        const dP = d.b.price - d.a.price, dPct = d.a.price ? (dP / d.a.price) * 100 : 0;
        const txt = `${dP >= 0 ? '+' : ''}${dP.toFixed(2)} (${dPct >= 0 ? '+' : ''}${dPct.toFixed(2)}%)`;
        ctx.font = 'bold 11px ui-sans-serif, system-ui';
        const tw = ctx.measureText(txt).width + 10;
        const mx = (x1 + x2) / 2 - tw / 2, my = Math.min(y1, y2) - 20;
        ctx.fillStyle = dP >= 0 ? '#10b981' : '#ef4444'; ctx.fillRect(mx, my, tw, 16);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(txt, mx + 5, my + 8);
      }
      if (selected) { handle(x1, y1); handle(x2, y2); }
      return;
    }
    if (d.kind === 'fib') {
      const x1 = xOf(d.a), x2 = xOf(d.b);
      if (x1 == null || x2 == null) return;
      const lo = Math.min(d.a.price, d.b.price), hi = Math.max(d.a.price, d.b.price);
      const xa = Math.min(x1, x2), xb = Math.max(x1, x2);
      ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
      for (const lvl of FIB_LEVELS) {
        const price = lo + (hi - lo) * (lvl.pct / 100);
        const y = yOf(price); if (y == null) continue;
        stroke(selected ? COLORS.select : lvl.color, 1);
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        ctx.fillStyle = lvl.color; ctx.fillText(`${lvl.pct}%  ${price.toFixed(2)}`, xa + 4, y - 6);
      }
      if (selected) { const ya = yOf(d.a.price), yb = yOf(d.b.price); if (ya != null) handle(x1, ya); if (yb != null) handle(x2, yb); }
      return;
    }
    if (d.kind === 'pitchfork') {
      const A = d.a, B = d.b, C = d.c;
      const ax = xOf(A), ay = yOf(A.price), bx = xOf(B), by = yOf(B.price), cx = xOf(C), cy = yOf(C.price);
      if ([ax, ay, bx, by, cx, cy].some((v) => v == null)) return;
      const mx = (bx + cx) / 2, my = (by + cy) / 2;
      const dx = mx - ax, dy = my - ay;
      const ext = (sx, sy) => {
        if (dx === 0) return [sx, paneW]; // vertical-ish guard handled below
        const f = (paneW - sx) / dx;
        return [paneW, sy + dy * f];
      };
      stroke(selected ? COLORS.select : COLORS.pitchfork, 2);
      const [mex, mey] = ext(ax, ay); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(mex, mey); ctx.stroke();
      stroke(selected ? COLORS.select : COLORS.pitchfork, 1);
      const [ux, uy] = ext(bx, by); ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ux, uy); ctx.stroke();
      const [lx, ly] = ext(cx, cy); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lx, ly); ctx.stroke();
      if (selected) { handle(ax, ay); handle(bx, by); handle(cx, cy); }
      return;
    }
    if (d.kind === 'brush') {
      stroke(selected ? COLORS.select : COLORS.brush, 2);
      ctx.beginPath();
      let started = false;
      for (const p of d.points) {
        const x = xOf(p), y = yOf(p.price);
        if (x == null || y == null) continue;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }
    if (d.kind === 'text' || d.kind === 'emoji') {
      const x = xOf(d.a), y = yOf(d.a.price);
      if (x == null || y == null) return;
      if (d.kind === 'emoji') {
        ctx.font = '18px serif'; ctx.textBaseline = 'middle';
        ctx.fillText(d.emoji || '⭐', x - 9, y);
        if (selected) { stroke(COLORS.select, 1); ctx.strokeRect(x - 12, y - 12, 24, 24); }
      } else {
        ctx.font = 'bold 12px ui-sans-serif, system-ui';
        const tw = ctx.measureText(d.text || 'Note').width + 10;
        ctx.fillStyle = selected ? COLORS.select : COLORS.text; ctx.fillRect(x, y - 9, tw, 18);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(d.text || 'Note', x + 5, y);
      }
    }
  }, [xOf, yOf]);

  // ── full redraw ──
  const redraw = useCallback(() => {
    const canvas = overlayRef.current, ctx = ctxRef.current, chart = chartRef.current;
    if (!canvas || !ctx || !chart) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (hiddenRef.current) return;
    let paneW = w; try { paneW = chart.timeScale().width() || w; } catch { paneW = w; }

    for (const d of drawingsRef.current) {
      const use = dragRef.current && dragRef.current.id === d.id ? dragRef.current.preview : d;
      drawOne(ctx, use, paneW, d.id === selectedRef.current);
    }
    if (brushRef.current && brushRef.current.points.length) {
      drawOne(ctx, { kind: 'brush', points: brushRef.current.points }, paneW, false);
    }
    // rubber-band preview while collecting points
    const pend = pendingRef.current, hov = hoverRef.current, tool = toolRef.current;
    if (pend.length && hov && (TWO_POINT_TOOLS.has(tool) || THREE_POINT_TOOLS.has(tool))) {
      const cur = anchorFromXY(hov.x, hov.y);
      if (cur) {
        if (tool === 'fib') drawOne(ctx, { kind: 'fib', a: pend[0], b: cur }, paneW, false);
        else if (tool === 'pitchfork' && pend.length === 2) drawOne(ctx, { kind: 'pitchfork', a: pend[0], b: pend[1], c: cur }, paneW, false);
        else drawOne(ctx, { kind: tool === 'measure' ? 'measure' : 'trendline', a: pend[0], b: cur }, paneW, false);
      }
    }
  }, [chartRef, drawOne, anchorFromXY]);

  // ── hit-test (topmost first) ──
  const hitTest = useCallback((x, y) => {
    const list = drawingsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (d.kind === 'hline') { const yy = yOf(d.price); if (yy != null && Math.abs(y - yy) <= HIT_TOL) return d; }
      else if (d.kind === 'trendline' || d.kind === 'measure') {
        const x1 = xOf(d.a), y1 = yOf(d.a.price), x2 = xOf(d.b), y2 = yOf(d.b.price);
        if ([x1, y1, x2, y2].every((v) => v != null) && distToSeg(x, y, x1, y1, x2, y2) <= HIT_TOL) return d;
      } else if (d.kind === 'fib') {
        const x1 = xOf(d.a), x2 = xOf(d.b); if (x1 == null || x2 == null) continue;
        const lo = Math.min(d.a.price, d.b.price), hi = Math.max(d.a.price, d.b.price);
        const xa = Math.min(x1, x2), xb = Math.max(x1, x2);
        if (x < xa - HIT_TOL || x > xb + HIT_TOL) continue;
        for (const lvl of FIB_LEVELS) { const yy = yOf(lo + (hi - lo) * (lvl.pct / 100)); if (yy != null && Math.abs(y - yy) <= HIT_TOL) return d; }
      } else if (d.kind === 'pitchfork') {
        for (const k of ['a', 'b', 'c']) { const px = xOf(d[k]), py = yOf(d[k].price); if (px != null && py != null && Math.hypot(x - px, y - py) <= HIT_TOL + 2) return d; }
      } else if (d.kind === 'brush') {
        for (let j = 1; j < d.points.length; j++) {
          const x1 = xOf(d.points[j - 1]), y1 = yOf(d.points[j - 1].price), x2 = xOf(d.points[j]), y2 = yOf(d.points[j].price);
          if ([x1, y1, x2, y2].every((v) => v != null) && distToSeg(x, y, x1, y1, x2, y2) <= HIT_TOL) return d;
        }
      } else if (d.kind === 'text' || d.kind === 'emoji') {
        const px = xOf(d.a), py = yOf(d.a.price); if (px != null && py != null && x >= px - 12 && x <= px + 80 && Math.abs(y - py) <= 12) return d;
      }
    }
    return null;
  }, [xOf, yOf]);

  // ── mutators ──
  const addDrawing = useCallback((d) => {
    setDrawings((prev) => [...prev, { id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...d }]);
  }, []);
  const removeDrawing = useCallback((id) => setDrawings((prev) => prev.filter((d) => d.id !== id)), []);
  const clearAll = useCallback(() => { setDrawings([]); setPending([]); setSelectedId(null); setMeasureReadout(null); }, []);

  // ── create the overlay canvas + bind pointer events (once) ──
  useEffect(() => {
    const container = containerRef?.current; if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', zIndex: '5', pointerEvents: 'none' });
    container.appendChild(canvas);
    overlayRef.current = canvas;
    ctxRef.current = canvas.getContext('2d');

    const sizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth, h = container.clientHeight;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctxRef.current = ctx;
      redraw();
    };
    sizeCanvas();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sizeCanvas) : null;
    ro?.observe(container);

    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const onDown = (e) => {
      if (lockedRef.current) return;
      const { x, y } = pos(e);
      const tool = toolRef.current;

      if (tool === 'crosshair') {
        const hit = hitTest(x, y);
        if (hit) {
          setSelectedId(hit.id);
          // snapshot anchor pixels for dragging
          const snap = [];
          const collect = (a) => snap.push({ ref: a, x: xOf(a), y: yOf(a.price) });
          if (hit.kind === 'hline') snap.push({ price: hit.price, y: yOf(hit.price) });
          else if (hit.kind === 'brush') hit.points.forEach(collect);
          else { ['a', 'b', 'c'].forEach((k) => hit[k] && collect(hit[k])); }
          dragRef.current = { id: hit.id, startX: x, startY: y, snap, kind: hit.kind, preview: JSON.parse(JSON.stringify(hit)) };
          canvas.setPointerCapture?.(e.pointerId);
        } else setSelectedId(null);
        return;
      }

      if (tool === 'brush') { const a = anchorFromXY(x, y); if (a) { brushRef.current = { points: [a] }; canvas.setPointerCapture?.(e.pointerId); } return; }

      const a = anchorFromXY(x, y); if (!a) return;
      if (ONE_POINT_TOOLS.has(tool)) {
        if (tool === 'hline') addDrawing({ kind: 'hline', price: a.price });
        else if (tool === 'text') { const t = window.prompt('Note text:'); if (t && t.trim()) addDrawing({ kind: 'text', a, text: t.trim() }); }
        else if (tool === 'emoji') addDrawing({ kind: 'emoji', a, emoji: emojiRef.current });
        setActiveTool('crosshair');
      } else if (TWO_POINT_TOOLS.has(tool)) {
        const pend = pendingRef.current;
        if (pend.length === 0) setPending([a]);
        else {
          if (tool === 'measure') {
            const dP = a.price - pend[0].price, dPct = pend[0].price ? (dP / pend[0].price) * 100 : 0;
            setMeasureReadout({ dPrice: dP, dPct });
          }
          addDrawing({ kind: tool, a: pend[0], b: a });
          setPending([]); setActiveTool('crosshair');
        }
      } else if (THREE_POINT_TOOLS.has(tool)) {
        const pend = pendingRef.current;
        if (pend.length < 2) setPending([...pend, a]);
        else { addDrawing({ kind: 'pitchfork', a: pend[0], b: pend[1], c: a }); setPending([]); setActiveTool('crosshair'); }
      }
    };

    const onMove = (e) => {
      const { x, y } = pos(e);
      hoverRef.current = { x, y };
      if (dragRef.current) {
        const dx = x - dragRef.current.startX, dy = y - dragRef.current.startY;
        const pv = dragRef.current.preview;
        if (pv.kind === 'hline') { const ny = dragRef.current.snap[0].y + dy; const np = candleSeriesRef.current?.coordinateToPrice(ny); if (Number.isFinite(np)) pv.price = np; }
        else {
          const keys = pv.kind === 'brush' ? pv.points.map((_, i) => i) : ['a', 'b', 'c'].filter((k) => pv[k]);
          dragRef.current.snap.forEach((sp, i) => {
            const na = anchorFromXY(sp.x + dx, sp.y + dy); if (!na) return;
            if (pv.kind === 'brush') pv.points[keys[i]] = na; else pv[keys[i]] = na;
          });
        }
        redraw();
        return;
      }
      if (brushRef.current) { const a = anchorFromXY(x, y); if (a) { brushRef.current.points.push(a); redraw(); } return; }
      if (pendingRef.current.length) redraw();
      else if (toolRef.current === 'crosshair') canvas.style.cursor = hitTest(x, y) ? 'move' : 'default';
    };

    const onUp = (e) => {
      canvas.releasePointerCapture?.(e.pointerId);
      if (dragRef.current) {
        const { id, preview } = dragRef.current; dragRef.current = null;
        setDrawings((prev) => prev.map((d) => (d.id === id ? preview : d)));
        return;
      }
      if (brushRef.current) {
        const pts = brushRef.current.points; brushRef.current = null;
        if (pts.length >= 2) addDrawing({ kind: 'brush', points: pts });
        setActiveTool('crosshair');
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // Keep drawings glued to the chart by repainting each animation frame —
    // the chart ref may not exist yet when this effect runs, and rAF stays in
    // perfect sync with pan / zoom / price-autoscale (cheap for a few shapes,
    // and the browser pauses it on hidden tabs).
    let raf = 0;
    const loop = () => { redraw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);

    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      try { container.removeChild(canvas); } catch { /* */ }
      overlayRef.current = null; ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, chartRef]);

  // Toggle overlay capture: ON while a tool is active or something is selected;
  // OFF on crosshair-idle so the chart pans/zooms freely.
  useEffect(() => {
    const c = overlayRef.current; if (!c) return;
    c.style.pointerEvents = (activeTool !== 'crosshair' || selectedId) ? 'auto' : 'none';
    c.style.cursor = activeTool !== 'crosshair' ? 'crosshair' : 'default';
  }, [activeTool, selectedId]);

  // Selection via the chart's own click (works while overlay capture is off).
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const onClick = (param) => {
      if (toolRef.current !== 'crosshair' || lockedRef.current || !param.point) return;
      const hit = hitTest(param.point.x, param.point.y);
      setSelectedId(hit ? hit.id : null);
    };
    chart.subscribeClick(onClick);
    return () => { try { chart.unsubscribeClick(onClick); } catch { /* */ } };
  }, [chartRef, hitTest]);

  // Redraw whenever the drawing set / flags change.
  useEffect(() => { redraw(); }, [drawings, hidden, selectedId, pending, redraw]);

  // Keyboard: Delete removes selection; Escape cancels pending / deselects.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setPending([]); setSelectedId(null); setActiveTool('crosshair'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) {
        const t = e.target?.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA') return;
        removeDrawing(selectedRef.current); setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [removeDrawing]);

  // ── zoom actions ──
  const zoomIn = useCallback(() => {
    const ts = chartRef.current?.timeScale(); const r = ts?.getVisibleLogicalRange?.(); if (!r) return;
    const span = (r.to - r.from) * 0.7, mid = (r.from + r.to) / 2;
    try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch { /* */ }
  }, [chartRef]);
  const zoomOut = useCallback(() => {
    const ts = chartRef.current?.timeScale(); const r = ts?.getVisibleLogicalRange?.(); if (!r) return;
    const span = (r.to - r.from) * 1.4, mid = (r.from + r.to) / 2;
    try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch { /* */ }
  }, [chartRef]);
  const resetZoom = useCallback(() => { try { chartRef.current?.timeScale().fitContent(); } catch { /* */ } }, [chartRef]);

  return {
    activeTool, setActiveTool,
    drawings, removeDrawing, clearAll,
    locked, setLocked,
    hidden, setHidden,
    pending,
    selectedId,
    measureReadout, clearMeasure: () => setMeasureReadout(null),
    selectedEmoji, setSelectedEmoji,
    zoomIn, zoomOut, resetZoom,
  };
}
