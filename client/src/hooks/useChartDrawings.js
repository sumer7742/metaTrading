import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toolMeta, pointsFor, familyOf } from '../components/chartTools';

/**
 * Interactive drawing-tools engine for lightweight-charts — TradingView-style.
 *
 * Every drawing is painted onto a dedicated <canvas> overlaid on the chart.
 * Anchors are stored in chart space ({ logical, time, price }) in a single
 * `pts[]` array and re-projected to pixels on every pan / zoom / resize, so
 * drawings stay glued to the chart. The whole palette (lines, channels,
 * pitchforks, fibonacci, gann, patterns, elliott, cycles, projections,
 * volume, measurers, brushes, arrows, shapes, text & notes, emoji) is driven
 * by a small set of geometric "families" (see chartTools.js).
 *
 * Each object is selectable, draggable, resizable (per-anchor handles),
 * editable, duplicable, lockable, layer-orderable and deletable, with undo /
 * redo, a right-click context menu, a double-click property panel and keyboard
 * shortcuts. Drawings persist per-symbol and survive a refresh.
 */

const SELECT = '#FACC15';
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.414, 1.618, 2.618];
const FIB_COLORS = ['#6B7280', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#6B7280', '#0EA5E9'];
const GANN_RATIOS = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];
const FIB_SEQ = [0, 1, 2, 3, 5, 8, 13, 21, 34];
const POLY_LABELS = {
  XABCD: ['X', 'A', 'B', 'C', 'D'], ABCD: ['A', 'B', 'C', 'D'],
  HS: ['', 'LS', '', 'H', '', 'RS', ''], '3D': ['', '1', '', '2', '', '3', ''],
  '12345': ['0', '1', '2', '3', '4', '5'], ABC: ['0', 'A', 'B', 'C'],
  ABCDE: ['0', 'A', 'B', 'C', 'D', 'E'], WXY: ['0', 'W', 'X', 'Y'], WXYXZ: ['0', 'W', 'X', 'Y', 'X', 'Z'],
};

const HIT_TOL = 6;
const HANDLE_TOL = 8;
const SELECT_TOOLS = new Set(['crosshair', 'magnet', 'dot', 'arrowcur']);

const VERSION = 'v4';
const storeKey = (symbol) => `tradepro:drawings:${VERSION}:${symbol || 'GLOBAL'}`;
const newId = () => `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

const DEFAULT_STYLE = (family, variant) => {
  const s = { color: '#2962FF', width: 2, style: 'solid' };
  if (['fib', 'fibchannel', 'fibtime', 'circles', 'arcs', 'spiral', 'fan'].includes(family)) s.width = 1;
  if (['rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'poly', 'position', 'fibchannel', 'volprofile'].includes(family)) s.fill = true;
  if (variant === 'hl') { s.width = 12; s.color = '#FACC15'; }
  if (family === 'measure') s.color = '#F59E0B';
  return s;
};

const normalize = (d) => {
  const meta = toolMeta(d.kind) || {};
  return { locked: false, family: meta.family, variant: meta.variant, glyph: meta.glyph, ...DEFAULT_STYLE(meta.family, meta.variant || d.variant), ...d };
};
const readPersisted = (symbol) => {
  try { const raw = JSON.parse(localStorage.getItem(storeKey(symbol)) || '[]'); return Array.isArray(raw) ? raw.map(normalize) : []; } catch { return []; }
};
const writePersisted = (symbol, drawings) => { try { localStorage.setItem(storeKey(symbol), JSON.stringify(drawings)); } catch { /* quota */ } };

const lineDash = (style) => (style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 3] : []);
const hexA = (hex, a) => {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) return hex;
  return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
};
const distToSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
const bbox = (pts) => {
  const xs = pts.filter(Boolean).map((p) => p.x), ys = pts.filter(Boolean).map((p) => p.y);
  if (!xs.length) return null;
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
};
const inExpandedBox = (x, y, b, tol) => b && x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol;

// ── Measurement-tool stats (computed from real OHLCV) ─────────────────────
const _fmtDur = (s) => {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const dys = Math.floor(h / 24), hh = h % 24;
  return `${dys}d ${hh}h`;
};
const measureStats = (d, candles, prec) => {
  const p0 = d.pts?.[0] || {}, p1 = d.pts?.[1] || {};
  const startPrice = Number(p0.price) || 0, endPrice = Number(p1.price) || 0;
  const priceDiff = endPrice - startPrice;
  const pct = startPrice ? (priceDiff / startPrice) * 100 : 0;
  const tick = Math.pow(10, -(Number(prec) || 2));
  const ticks = tick ? priceDiff / tick : 0;
  const t0 = p0.time, t1 = p1.time;
  const durSec = (t0 != null && t1 != null) ? Math.abs(Number(t1) - Number(t0)) : null;
  let lo = Infinity, hi = -Infinity, vol = 0, bars = 0;
  const cs = Array.isArray(candles) ? candles : [];
  if (t0 != null && t1 != null) {
    const tmin = Math.min(t0, t1), tmax = Math.max(t0, t1);
    for (const c of cs) {
      if (c.time >= tmin && c.time <= tmax) {
        bars++;
        const h = Number(c.high), l = Number(c.low);
        if (Number.isFinite(h) && h > hi) hi = h;
        if (Number.isFinite(l) && l < lo) lo = l;
        vol += Number(c.volume) || 0;
      }
    }
  }
  if (!bars) bars = Math.abs(Math.round((Number(p1.logical) || 0) - (Number(p0.logical) || 0)));
  const high = hi === -Infinity ? null : hi;
  const low = lo === Infinity ? null : lo;
  const range = (high != null && low != null) ? high - low : null;
  return { priceDiff, pct, ticks, durSec, bars, high, low, range, vol, prec: Number(prec) || 2 };
};
const drawMeasurePanel = (ctx, st, ax, ay, color, paneW, paneH) => {
  const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: st.prec, maximumFractionDigits: st.prec }));
  const sign = (v) => (v >= 0 ? '+' : '');
  const head = `${sign(st.priceDiff)}${fmt(st.priceDiff)} (${sign(st.pct)}${st.pct.toFixed(2)}%)`;
  const lines = [
    `${sign(st.ticks)}${Math.round(st.ticks)} ticks`,
    `${st.bars} bars · ${_fmtDur(st.durSec)}`,
    `H ${fmt(st.high)}   L ${fmt(st.low)}`,
    `Range ${fmt(st.range)}`,
  ];
  if (st.vol > 0) lines.push(`Vol ${st.vol.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 12px ui-sans-serif, system-ui';
  let w = ctx.measureText(head).width;
  ctx.font = '11px ui-sans-serif, system-ui';
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  w = Math.ceil(w) + 16;
  const headH = 22, lineH = 16, bodyH = lines.length * lineH + 8, h = headH + bodyH;
  let px = ax + 10, py = ay + 10;
  if (px + w > paneW) px = Math.max(2, ax - w - 10);
  if (py + h > paneH) py = Math.max(2, ay - h - 10);
  px = Math.max(2, px); py = Math.max(2, py);
  ctx.setLineDash([]);
  ctx.fillStyle = color; ctx.fillRect(px, py, w, headH);                       // colored header
  ctx.fillStyle = 'rgba(15,23,42,0.94)'; ctx.fillRect(px, py + headH, w, bodyH); // dark body
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px ui-sans-serif, system-ui'; ctx.fillText(head, px + 8, py + headH / 2);
  ctx.font = '11px ui-sans-serif, system-ui'; ctx.fillStyle = '#E2E8F0';
  lines.forEach((l, i) => ctx.fillText(l, px + 8, py + headH + 8 + i * lineH));
};

export function useChartDrawings({ chartRef, candleSeriesRef, containerRef, symbol, externalMarkers = [], candles = [], pricePrecision = 2 }) {
  const [activeTool, setActiveTool] = useState('crosshair');
  const [hist, setHist] = useState(() => ({ past: [], present: readPersisted(symbol), future: [] }));
  const drawings = hist.present;
  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;

  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pending, setPending] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [measureReadout, setMeasureReadout] = useState(null);
  const [selectedEmoji, setSelectedEmoji] = useState('🚀');
  const [contextMenu, setContextMenu] = useState(null);
  const [editing, setEditing] = useState(null);

  const overlayRef = useRef(null);
  const ctxRef = useRef(null);
  const drawingsRef = useRef(drawings);
  const pendingRef = useRef(pending);
  const hoverRef = useRef(null);
  const dragRef = useRef(null);
  const brushRef = useRef(null);
  const selectedRef = useRef(selectedId);
  const hiddenRef = useRef(hidden);
  const lockedRef = useRef(locked);
  const toolRef = useRef(activeTool);
  const emojiRef = useRef(selectedEmoji);
  const candlesRef = useRef(candles);
  const precRef = useRef(pricePrecision);
  precRef.current = pricePrecision;
  const lastDownRef = useRef({ t: 0, x: 0, y: 0 });
  drawingsRef.current = drawings;
  pendingRef.current = pending;
  selectedRef.current = selectedId;
  hiddenRef.current = hidden;
  lockedRef.current = locked;
  toolRef.current = activeTool;
  emojiRef.current = selectedEmoji;
  candlesRef.current = candles;

  // ── history-aware commit ──
  const commit = useCallback((updater) => {
    setHist((h) => {
      const next = typeof updater === 'function' ? updater(h.present) : updater;
      if (next === h.present) return h;
      return { past: [...h.past, h.present].slice(-120), present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)), []);

  // ── coordinate helpers ──
  const xOf = useCallback((anc) => {
    const chart = chartRef.current; if (!chart || !anc) return null;
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
  const P = useCallback((anc) => { if (!anc) return null; const x = xOf(anc), y = yOf(anc.price); return (x == null || y == null) ? null : { x, y }; }, [xOf, yOf]);
  const ptsPx = useCallback((d) => (d.pts || []).map(P), [P]);
  const paneDims = useCallback(() => {
    const canvas = overlayRef.current, chart = chartRef.current;
    let w = canvas?.clientWidth || 0; const h = canvas?.clientHeight || 0;
    try { w = chart?.timeScale().width() || w; } catch { /* */ }
    return { w, h };
  }, [chartRef]);

  // ── persistence + symbol swap ──
  useEffect(() => { writePersisted(symbol, drawings); }, [symbol, drawings]);
  useEffect(() => {
    setHist({ past: [], present: readPersisted(symbol), future: [] });
    setPending([]); setSelectedId(null); setMeasureReadout(null); setContextMenu(null); setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  // ── magnet → chart crosshair mode ──
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    try { chart.applyOptions({ crosshair: { mode: activeTool === 'magnet' ? 1 : 0 } }); } catch { /* */ }
  }, [activeTool, chartRef]);

  // ── external markers stay on the series ──
  useEffect(() => {
    const s = candleSeriesRef.current; if (!s) return;
    const merged = (externalMarkers || []).filter((m) => m && Number.isFinite(Number(m.time))).sort((a, b) => Number(a.time) - Number(b.time));
    try { s.setMarkers(merged); } catch { /* */ }
  }, [externalMarkers, candleSeriesRef, symbol]);

  // ── handle positions for a drawing (pixel space) — shared by render + hit ──
  const handlesFor = useCallback((d) => {
    const { w, h } = paneDims();
    const out = [];
    const push = (key, x, y) => { if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) out.push({ key, x, y }); };
    const px = ptsPx(d);
    const fam = d.family;
    if (fam === 'hline') { push('p0', w / 2, yOf(d.pts[0]?.price)); return out; }
    if (fam === 'vline' || fam === 'cross') { push('p0', xOf(d.pts[0]), h / 2); return out; }
    if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'ellipse') {
      const a = px[0], b = px[1]; if (!a || !b) return out;
      push('p0', a.x, a.y); push('p1', b.x, b.y); push('p01', b.x, a.y); push('p10', a.x, b.y); return out;
    }
    // default: a handle per stored anchor
    px.forEach((p, i) => p && push(`p${i}`, p.x, p.y));
    return out;
  }, [ptsPx, paneDims, xOf, yOf]);

  // ── arrowhead helper ──
  const arrowHead = (ctx, x1, y1, x2, y2, size = 9) => {
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(a - 0.4), y2 - size * Math.sin(a - 0.4));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(a + 0.4), y2 - size * Math.sin(a + 0.4));
    ctx.stroke();
  };

  // ── render one drawing ──
  const drawOne = useCallback((ctx, d, paneW, paneH, selected) => {
    const col = selected ? SELECT : (d.color || '#2962FF');
    const w = d.width || 2;
    const px = ptsPx(d);
    const set = (color, width, dash) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); };
    const fam = d.family;
    const dash = lineDash(d.style);

    const extLine = (a, b, mode, arrow) => {
      let { x: x1, y: y1 } = a, { x: x2, y: y2 } = b;
      const dx = x2 - x1, dy = y2 - y1;
      if (mode === 'rayR' || mode === 'arrowR') { if (dx !== 0 || dy !== 0) { const f = Math.max((dx >= 0 ? (paneW - x1) / (dx || 1e-6) : -x1 / (dx || -1e-6)), 1); x2 = x1 + dx * f; y2 = y1 + dy * f; } }
      else if (mode === 'extend') { const f = 4; x1 = a.x - dx * f; y1 = a.y - dy * f; x2 = b.x + dx * f; y2 = b.y + dy * f; }
      set(col, w, dash); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      if (arrow) { set(col, w); arrowHead(ctx, a.x, a.y, b.x, b.y); }
    };

    if (fam === 'trend') {
      if (!px[0] || !px[1]) return;
      const v = d.variant;
      const arrow = v === 'arrowR';
      extLine(px[0], px[1], v, arrow);
      if (v === 'info' || v === 'angle') {
        const dP = d.pts[1].price - d.pts[0].price, dPct = d.pts[0].price ? (dP / d.pts[0].price) * 100 : 0;
        const ang = Math.atan2(-(px[1].y - px[0].y), px[1].x - px[0].x) * 180 / Math.PI;
        const txt = v === 'angle' ? `${ang.toFixed(1)}°` : `${dP >= 0 ? '+' : ''}${dP.toFixed(2)} (${dPct.toFixed(2)}%)`;
        ctx.font = 'bold 11px ui-sans-serif, system-ui';
        const tw = ctx.measureText(txt).width + 10, mx = px[1].x + 6, my = px[1].y - 8;
        ctx.fillStyle = d.color || '#2962FF'; ctx.fillRect(mx, my - 8, tw, 16);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(txt, mx + 5, my);
      }
    } else if (fam === 'hline') {
      const y = yOf(d.pts[0].price); if (y == null) return;
      set(col, w, dash); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke(); ctx.setLineDash([]);
      const label = Number(d.pts[0].price).toLocaleString(undefined, { maximumFractionDigits: 6 });
      ctx.font = '11px ui-monospace, monospace'; const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = d.color || '#2962FF'; ctx.fillRect(paneW - tw, y - 8, tw, 16);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, paneW - tw + 4, y);
    } else if (fam === 'hray') {
      const xx = xOf(d.pts[0]), yy = yOf(d.pts[0].price); if (xx == null || yy == null) return;
      set(col, w, dash); ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(paneW, yy); ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'vline') {
      const xx = xOf(d.pts[0]); if (xx == null) return;
      set(col, w, dash); ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, paneH); ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'cross') {
      const xx = xOf(d.pts[0]), yy = yOf(d.pts[0].price);
      set(col, w, dash); ctx.beginPath(); if (yy != null) { ctx.moveTo(0, yy); ctx.lineTo(paneW, yy); } if (xx != null) { ctx.moveTo(xx, 0); ctx.lineTo(xx, paneH); } ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
      if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fillRect(rx, ry, rw, rh); }
      set(col, w, dash); ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
      if (fam === 'rectgrid' || fam === 'gannsquare') {
        set(hexA(col, 0.5), 1); ctx.beginPath();
        for (let i = 1; i < 4; i++) { ctx.moveTo(rx + (rw * i) / 4, ry); ctx.lineTo(rx + (rw * i) / 4, ry + rh); ctx.moveTo(rx, ry + (rh * i) / 4); ctx.lineTo(rx + rw, ry + (rh * i) / 4); }
        ctx.stroke();
      }
      if (fam === 'gannsquare') { set(col, 1); ctx.beginPath(); ctx.moveTo(rx, ry + rh); ctx.lineTo(rx + rw, ry); ctx.moveTo(rx, ry); ctx.lineTo(rx + rw, ry + rh); ctx.stroke(); }
    } else if (fam === 'rotrect') {
      const a = px[0], b = px[1], c = px[2]; if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1; const nx = -dy / len, ny = dx / len;
      const off = c ? ((c.x - a.x) * nx + (c.y - a.y) * ny) : 30;
      const p1 = a, p2 = b, p3 = { x: b.x + nx * off, y: b.y + ny * off }, p4 = { x: a.x + nx * off, y: a.y + ny * off };
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath();
      if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
      set(col, w, dash); ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'ellipse') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      ctx.beginPath();
      if (d.variant === 'circle') { const r = Math.hypot(b.x - a.x, b.y - a.y); ctx.ellipse(a.x, a.y, r, r, 0, 0, Math.PI * 2); }
      else { ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); }
      if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
      set(col, w, dash); ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'channel' || fam === 'regression') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      let off = 0;
      if (fam === 'regression') { off = -(Math.abs(b.y - a.y) * 0.5 + 20); }
      else { const c = px[2]; const lineYatX = (xx) => a.y + (b.y - a.y) * ((xx - a.x) / ((b.x - a.x) || 1)); off = c ? (c.y - lineYatX(c.x)) : 40; }
      set(col, w, dash); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      let b2y = b.y + off, a2y = a.y + off;
      if (d.variant === 'flat' && px[2]) { a2y = px[2].y; b2y = px[2].y; }
      ctx.beginPath(); ctx.moveTo(a.x, a2y); ctx.lineTo(b.x, b2y); ctx.stroke(); ctx.setLineDash([]);
      if (fam === 'regression') { ctx.beginPath(); ctx.moveTo(a.x, a.y - off); ctx.lineTo(b.x, b.y - off); ctx.stroke(); }
      if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.07); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x, b2y); ctx.lineTo(a.x, a2y); ctx.closePath(); ctx.fill(); }
    } else if (fam === 'fib') {
      const a = d.pts[0], b = d.pts[1], c = d.pts[2];
      const ratios = d.variant === 'ext' ? FIB_EXT : FIB_RATIOS;
      const baseLo = c ? c.price : a.price, span = b.price - a.price;
      const xa = px[0]?.x ?? 0, xb = (d.variant === 'ext' ? paneW : (px[1]?.x ?? paneW));
      ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
      ratios.forEach((r, i) => {
        const price = d.variant === 'ext' ? baseLo + r * span : a.price + (b.price - a.price) * r;
        const y = yOf(price); if (y == null) return;
        set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
        ctx.beginPath(); ctx.moveTo(Math.min(xa, xb), y); ctx.lineTo(Math.max(xa, xb), y); ctx.stroke();
        ctx.fillStyle = FIB_COLORS[i % FIB_COLORS.length]; ctx.fillText(`${(r * 100).toFixed(1)}%`, Math.min(xa, xb) + 4, y - 6);
      });
    } else if (fam === 'fibchannel') {
      const a = px[0], b = px[1], c = px[2]; if (!a || !b) return;
      const lineYatX = (xx) => a.y + (b.y - a.y) * ((xx - a.x) / ((b.x - a.x) || 1));
      const off = c ? (c.y - lineYatX(c.x)) : 60;
      FIB_RATIOS.forEach((r, i) => {
        set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
        ctx.beginPath(); ctx.moveTo(a.x, a.y + off * r); ctx.lineTo(b.x, b.y + off * r); ctx.stroke();
      });
    } else if (fam === 'fibtime') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const step = b.x - a.x;
      const seq = d.variant === 'cycle' ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : FIB_SEQ;
      seq.forEach((n, i) => {
        const x = a.x + step * n; if (x < 0 || x > paneW) return;
        set(selected ? SELECT : (d.color || '#2962FF'), 1, [4, 3]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, paneH); ctx.stroke();
      });
      ctx.setLineDash([]);
    } else if (fam === 'fan') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const ratios = d.variant === 'gann' ? GANN_RATIOS : FIB_RATIOS;
      ratios.forEach((r, i) => {
        set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
        const ty = a.y + (b.y - a.y) * (d.variant === 'gann' ? Math.min(r, 1) : r);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, d.variant === 'gann' ? a.y + (b.y - a.y) * r : ty); ctx.stroke();
      });
    } else if (fam === 'circles' || fam === 'arcs' || fam === 'spiral') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const R = Math.hypot(b.x - a.x, b.y - a.y);
      if (fam === 'spiral') {
        set(col, w); ctx.beginPath();
        for (let t = 0; t < Math.PI * 6; t += 0.15) { const rr = (R / 30) * Math.exp(0.196 * t); const x = a.x + rr * Math.cos(t), y = a.y + rr * Math.sin(t); if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
      } else {
        FIB_RATIOS.forEach((r, i) => {
          if (r === 0) return; set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
          ctx.beginPath();
          if (fam === 'arcs') ctx.arc(a.x, a.y, R * r, Math.PI, Math.PI * 2);
          else ctx.ellipse(a.x, a.y, R * r, R * r, 0, 0, Math.PI * 2);
          ctx.stroke();
        });
      }
    } else if (fam === 'pitchfork') {
      const a = px[0], b = px[1], c = px[2]; if (!a || !b || !c) return;
      let origin = a;
      if (d.variant === 'schiff') origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      else if (d.variant === 'modschiff') origin = { x: a.x, y: (a.y + b.y) / 2 };
      const mid = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
      const dx = mid.x - origin.x, dy = mid.y - origin.y;
      const ext = (sx, sy) => { if (dx === 0) return [sx, paneH]; const f = (paneW - sx) / dx; return [paneW, sy + dy * f]; };
      set(col, w); let [mx, my] = ext(origin.x, origin.y); ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(mx, my); ctx.stroke();
      set(col, Math.max(1, w - 1));
      [b, c].forEach((p) => { const [ux, uy] = ext(p.x, p.y); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ux, uy); ctx.stroke(); });
    } else if (fam === 'poly') {
      if (px.length < 2) { if (px[0]) { set(col, w); ctx.beginPath(); ctx.arc(px[0].x, px[0].y, 3, 0, 7); ctx.stroke(); } return; }
      set(col, w, dash); ctx.beginPath();
      px.forEach((p, i) => { if (!p) return; i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
      if (d.variant === 'closed') ctx.closePath();
      if (d.variant === 'closed' && d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
      ctx.stroke(); ctx.setLineDash([]);
      if (d.variant === 'arrow' && px.length >= 2) { set(col, w); const a = px[px.length - 2], b = px[px.length - 1]; arrowHead(ctx, a.x, a.y, b.x, b.y); }
      const labels = POLY_LABELS[d.variant];
      if (labels) { ctx.font = 'bold 11px ui-sans-serif, system-ui'; ctx.fillStyle = d.color || '#2962FF'; ctx.textBaseline = 'middle'; px.forEach((p, i) => { if (p && labels[i]) ctx.fillText(labels[i], p.x + 5, p.y - 8); }); }
    } else if (fam === 'sine') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const amp = (b.y - a.y) / 2, midY = (a.y + b.y) / 2, len = b.x - a.x;
      set(col, w, dash); ctx.beginPath();
      for (let i = 0; i <= 60; i++) { const t = i / 60; const x = a.x + len * t; const y = midY - amp * Math.sin(t * Math.PI * 2); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
    } else if (fam === 'vwap') {
      const a = d.pts[0]; if (!a) return;
      const cs = candlesRef.current || [];
      let pv = 0, vol = 0; const line = [];
      for (const c of cs) { if (a.time != null && c.time < a.time) continue; const tp = (c.high + c.low + c.close) / 3; const v = Number(c.volume) || 1; pv += tp * v; vol += v; const y = yOf(pv / vol); const x = xOf({ time: c.time }); if (x != null && y != null) line.push({ x, y }); }
      set(col, w); ctx.beginPath(); line.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))); ctx.stroke();
    } else if (fam === 'volprofile') {
      const a = px[0], b = px[1]; if (!a || !b || !d.pts) return;
      const cs = candlesRef.current || [];
      const t1 = Math.min(d.pts[0].time, d.pts[1].time), t2 = Math.max(d.pts[0].time, d.pts[1].time);
      const lo = Math.min(d.pts[0].price, d.pts[1].price), hi = Math.max(d.pts[0].price, d.pts[1].price);
      const BINS = 24; const buckets = new Array(BINS).fill(0); let maxV = 0;
      for (const c of cs) { if (c.time < t1 || c.time > t2) continue; const idx = Math.max(0, Math.min(BINS - 1, Math.floor(((c.close - lo) / ((hi - lo) || 1)) * BINS))); buckets[idx] += Number(c.volume) || 1; maxV = Math.max(maxV, buckets[idx]); }
      const x0 = Math.min(a.x, b.x), boxW = Math.abs(b.x - a.x);
      if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.06); ctx.fillRect(x0, Math.min(a.y, b.y), boxW, Math.abs(b.y - a.y)); }
      ctx.fillStyle = hexA(d.color || '#2962FF', 0.5);
      for (let i = 0; i < BINS; i++) { if (!maxV) break; const py = yOf(lo + ((i + 0.5) / BINS) * (hi - lo)); if (py == null) continue; const bw = (buckets[i] / maxV) * boxW * 0.6; ctx.fillRect(x0, py - 3, bw, 6); }
      set(col, 1, [4, 3]); ctx.strokeRect(x0, Math.min(a.y, b.y), boxW, Math.abs(b.y - a.y)); ctx.setLineDash([]);
    } else if (fam === 'measure') {
      // ── TradingView-style Price Range / measurement tool ──────────────
      const a = px[0], b = px[1]; if (!a || !b) return;
      const st = measureStats(d, candlesRef.current, precRef.current);
      const up = st.priceDiff >= 0;
      const linec = up ? '#089981' : '#F23645';                 // TV green / red
      const fillc = up ? 'rgba(8,153,129,0.15)' : 'rgba(242,54,69,0.15)';
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      // Filled selection area + vertical time band edges.
      ctx.fillStyle = fillc; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      set(linec, 1.5, []); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      // Horizontal reference line through the START price.
      set(linec, 1, [4, 3]); ctx.beginPath(); ctx.moveTo(x0, a.y); ctx.lineTo(x1, a.y); ctx.stroke(); ctx.setLineDash([]);
      // Centre direction arrow (start price → end price).
      const cx = (x0 + x1) / 2;
      set(linec, 1.5); ctx.beginPath(); ctx.moveTo(cx, a.y); ctx.lineTo(cx, b.y); ctx.stroke();
      if (Math.abs(b.y - a.y) > 12) arrowHead(ctx, cx, a.y, cx, b.y, 8);
      // Floating stats panel — colored header + dark body, readable on both themes.
      drawMeasurePanel(ctx, st, x1, y1, linec, paneW, paneH);
    } else if (fam === 'position') {
      const a = px[0], b = px[1]; if (!a || !b) return;
      const long = d.variant !== 'short';
      const entryY = a.y, targetY = b.y, stopY = entryY + (entryY - targetY);
      const x0 = a.x, x1 = b.x !== a.x ? b.x : a.x + 80;
      ctx.fillStyle = 'rgba(16,185,129,0.15)'; ctx.fillRect(Math.min(x0, x1), Math.min(entryY, targetY), Math.abs(x1 - x0), Math.abs(targetY - entryY));
      ctx.fillStyle = 'rgba(239,68,68,0.15)'; ctx.fillRect(Math.min(x0, x1), Math.min(entryY, stopY), Math.abs(x1 - x0), Math.abs(stopY - entryY));
      set(col, 1.5); ctx.beginPath(); ctx.moveTo(Math.min(x0, x1), entryY); ctx.lineTo(Math.max(x0, x1), entryY); ctx.stroke();
      ctx.font = 'bold 10px ui-sans-serif, system-ui'; ctx.fillStyle = '#10b981'; ctx.fillText(long ? 'Target' : 'Stop', x0 + 4, targetY - 4); ctx.fillStyle = '#ef4444'; ctx.fillText(long ? 'Stop' : 'Target', x0 + 4, stopY + 10);
    } else if (fam === 'brush') {
      if (px.length < 1) return;
      const isHl = d.variant === 'hl';
      set(isHl ? hexA(d.color || '#FACC15', 0.4) : col, isHl ? (d.width || 12) : w, dash);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      let started = false; for (const p of px) { if (!p) continue; started ? ctx.lineTo(p.x, p.y) : (ctx.moveTo(p.x, p.y), started = true); }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'butt';
    } else if (fam === 'text') {
      const p = px[0]; if (!p) return; const fs = d.fontSize || 13;
      ctx.font = `bold ${fs}px ui-sans-serif, system-ui`; const tw = ctx.measureText(d.text || 'Text').width + 10;
      ctx.fillStyle = selected ? SELECT : (d.color || '#2962FF'); ctx.fillRect(p.x, p.y - fs / 2 - 3, tw, fs + 6);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(d.text || 'Text', p.x + 5, p.y);
    } else if (fam === 'emoji') {
      const p = px[0]; if (!p) return; const fs = d.fontSize || 20;
      ctx.font = `${fs}px serif`; ctx.textBaseline = 'middle'; ctx.fillText(d.emoji || '⭐', p.x - fs / 2, p.y);
    } else if (fam === 'marker') {
      const p = px[0]; if (!p) return; const fs = d.fontSize || 18;
      if ((d.variant === 'note' || d.variant === 'callout') && (d.text || d.text === '')) {
        ctx.font = 'bold 11px ui-sans-serif, system-ui'; const label = d.text || 'Note'; const tw = ctx.measureText(label).width + 12;
        if (d.variant === 'callout') { set(col, 1.5); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 14, p.y - 22); ctx.stroke(); }
        const bx = d.variant === 'callout' ? p.x + 14 : p.x, by = d.variant === 'callout' ? p.y - 30 : p.y - 9;
        ctx.fillStyle = hexA(d.color || '#2962FF', 0.95); ctx.fillRect(bx, by, tw, 18); set(d.color || '#2962FF', 1); ctx.strokeRect(bx, by, tw, 18);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 6, by + 9);
      } else { ctx.font = `${fs}px serif`; ctx.textBaseline = 'middle'; ctx.fillText(d.glyph || '⬆', p.x - fs / 2, p.y); }
    }

    // selection handles
    if (selected) {
      ctx.setLineDash([]);
      for (const hnd of handlesFor(d)) { ctx.fillStyle = '#fff'; ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.rect(hnd.x - 4, hnd.y - 4, 8, 8); ctx.fill(); ctx.stroke(); }
      if (d.locked) { const p = handlesFor(d)[0]; if (p) { ctx.fillStyle = SELECT; ctx.font = '11px serif'; ctx.fillText('🔒', p.x + 8, p.y - 8); } }
    }
  }, [ptsPx, yOf, xOf, handlesFor]);

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
      drawOne(ctx, use, paneW, h, d.id === selectedRef.current);
    }
    if (brushRef.current) drawOne(ctx, brushRef.current, paneW, h, false);
    // in-progress preview
    const pend = pendingRef.current, hov = hoverRef.current, tool = toolRef.current;
    if (pend.length && hov && !SELECT_TOOLS.has(tool) && tool !== 'eraser') {
      const cur = anchorFromXY(hov.x, hov.y);
      if (cur) drawOne(ctx, normalize({ kind: tool, pts: [...pend, cur] }), paneW, h, false);
    }
  }, [chartRef, drawOne, anchorFromXY]);

  // ── hit-test (topmost first) ──
  const hitOne = useCallback((d, x, y) => {
    const px = ptsPx(d); const { w } = paneDims();
    const fam = d.family;
    if (fam === 'hline') { const yy = yOf(d.pts[0].price); return yy != null && Math.abs(y - yy) <= HIT_TOL; }
    if (fam === 'vline') { const xx = xOf(d.pts[0]); return xx != null && Math.abs(x - xx) <= HIT_TOL; }
    if (fam === 'cross') { const xx = xOf(d.pts[0]), yy = yOf(d.pts[0].price); return (xx != null && Math.abs(x - xx) <= HIT_TOL) || (yy != null && Math.abs(y - yy) <= HIT_TOL); }
    if (fam === 'hray') { const xx = xOf(d.pts[0]), yy = yOf(d.pts[0].price); return xx != null && yy != null && x >= xx - HIT_TOL && Math.abs(y - yy) <= HIT_TOL; }
    if (fam === 'trend') { if (!px[0] || !px[1]) return false; return distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= HIT_TOL; }
    if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'rotrect') {
      const a = px[0], b = px[1]; if (!a || !b) return false;
      const edge = Math.min(distToSeg(x, y, a.x, a.y, b.x, a.y), distToSeg(x, y, b.x, a.y, b.x, b.y), distToSeg(x, y, b.x, b.y, a.x, b.y), distToSeg(x, y, a.x, b.y, a.x, a.y));
      return edge <= HIT_TOL || (d.fill && inExpandedBox(x, y, bbox([a, b]), 0));
    }
    if (fam === 'ellipse') {
      const a = px[0], b = px[1]; if (!a || !b) return false;
      let cx, cy, rx, ry; if (d.variant === 'circle') { cx = a.x; cy = a.y; rx = ry = Math.hypot(b.x - a.x, b.y - a.y); } else { cx = (a.x + b.x) / 2; cy = (a.y + b.y) / 2; rx = Math.abs(b.x - a.x) / 2; ry = Math.abs(b.y - a.y) / 2; }
      const n = Math.sqrt(((x - cx) / (rx || 1)) ** 2 + ((y - cy) / (ry || 1)) ** 2);
      return Math.abs(n - 1) * Math.min(rx, ry) <= HIT_TOL + 2 || (d.fill && n <= 1);
    }
    if (fam === 'poly' || fam === 'brush') {
      for (let j = 1; j < px.length; j++) { if (px[j - 1] && px[j] && distToSeg(x, y, px[j - 1].x, px[j - 1].y, px[j].x, px[j].y) <= HIT_TOL) return true; }
      if ((d.variant === 'closed') && d.fill && inExpandedBox(x, y, bbox(px), 0)) return true;
      return false;
    }
    if (fam === 'channel' || fam === 'regression' || fam === 'fibchannel' || fam === 'pitchfork') {
      const a = px[0], b = px[1]; if (!a || !b) return false;
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= HIT_TOL + 2) return true;
      return inExpandedBox(x, y, bbox(px), 8);
    }
    if (fam === 'fib' || fam === 'measure' || fam === 'position' || fam === 'volprofile') {
      return inExpandedBox(x, y, bbox(px), HIT_TOL);
    }
    // markers / text / emoji / single-anchor families
    if (px[0]) {
      if (fam === 'text' || (fam === 'marker' && (d.variant === 'note' || d.variant === 'callout'))) return x >= px[0].x - 14 && x <= px[0].x + 100 && Math.abs(y - px[0].y) <= 16;
      if (fam === 'marker' || fam === 'emoji' || fam === 'vwap') return Math.hypot(x - px[0].x, y - px[0].y) <= 16;
    }
    // fans / circles / arcs / spiral / fibtime / sine → bbox of control pts
    return inExpandedBox(x, y, bbox(px), HIT_TOL + 4);
  }, [ptsPx, paneDims, xOf, yOf]);

  const hitTest = useCallback((x, y) => {
    const list = drawingsRef.current;
    for (let i = list.length - 1; i >= 0; i--) { if (hitOne(list[i], x, y)) return list[i]; }
    return null;
  }, [hitOne]);
  const hitTestAt = useCallback((x, y) => { const d = hitTest(x, y); return d ? d.id : null; }, [hitTest]);

  // ── mutators ──
  const addDrawing = useCallback((tool, pts, extra = {}) => {
    const id = newId();
    commit((prev) => [...prev, normalize({ id, kind: tool, pts, ...extra })]);
    setSelectedId(id); return id;
  }, [commit]);
  const removeDrawing = useCallback((id) => { commit((prev) => prev.filter((d) => d.id !== id)); setSelectedId((s) => (s === id ? null : s)); setContextMenu(null); setEditing((e) => (e && e.id === id ? null : e)); }, [commit]);
  const clearAll = useCallback(() => { commit([]); setPending([]); setSelectedId(null); setMeasureReadout(null); setContextMenu(null); setEditing(null); }, [commit]);
  const updateDrawing = useCallback((id, patch) => { commit((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d))); }, [commit]);
  const toggleLockDrawing = useCallback((id) => { commit((prev) => prev.map((d) => (d.id === id ? { ...d, locked: !d.locked } : d))); }, [commit]);
  const duplicateDrawing = useCallback((id) => {
    const src = drawingsRef.current.find((d) => d.id === id); if (!src) return;
    const off = (a) => { const x = xOf(a), y = yOf(a.price); const na = anchorFromXY((x ?? 0) + 16, (y ?? 0) + 16); return na || a; };
    const nd = clone(src); nd.id = newId(); nd.locked = false; nd.pts = (nd.pts || []).map(off);
    commit((prev) => [...prev, nd]); setSelectedId(nd.id); setContextMenu(null);
  }, [commit, xOf, yOf, anchorFromXY]);
  const reorder = useCallback((id, mode) => {
    commit((prev) => { const i = prev.findIndex((d) => d.id === id); if (i < 0) return prev; const c = [...prev]; const [it] = c.splice(i, 1); if (mode === 'front') c.push(it); else if (mode === 'back') c.unshift(it); else if (mode === 'forward') c.splice(Math.min(i + 1, c.length), 0, it); else if (mode === 'backward') c.splice(Math.max(i - 1, 0), 0, it); else c.splice(i, 0, it); return c; });
    setContextMenu(null);
  }, [commit]);
  const bringToFront = useCallback((id) => reorder(id, 'front'), [reorder]);
  const sendToBack = useCallback((id) => reorder(id, 'back'), [reorder]);
  const bringForward = useCallback((id) => reorder(id, 'forward'), [reorder]);
  const sendBackward = useCallback((id) => reorder(id, 'backward'), [reorder]);

  const openContextMenu = useCallback((id, x, y) => { setSelectedId(id); setContextMenu({ id, x, y }); }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openSettings = useCallback((id, x, y) => { setSelectedId(id); setEditing({ id, x: x ?? 60, y: y ?? 60 }); setContextMenu(null); }, []);
  const closeSettings = useCallback(() => setEditing(null), []);

  // finalize free polyline
  const finalizeFree = useCallback(() => {
    const pend = pendingRef.current; const tool = toolRef.current;
    if (pend.length >= 2 && familyOf(tool) === 'poly' && pointsFor(tool) === 'free') { addDrawing(tool, pend); }
    setPending([]); setActiveTool('crosshair');
  }, [addDrawing]);

  // ── canvas + pointer events ──
  useEffect(() => {
    const container = containerRef?.current; if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', zIndex: '5', pointerEvents: 'none' });
    container.appendChild(canvas);
    overlayRef.current = canvas; ctxRef.current = canvas.getContext('2d');

    const sizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1; const w = container.clientWidth, h = container.clientHeight;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctxRef.current = ctx; redraw();
    };
    sizeCanvas();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sizeCanvas) : null; ro?.observe(container);
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const onDown = (e) => {
      if (e.button !== 0 || lockedRef.current) return;
      const { x, y } = pos(e); const tool = toolRef.current; setContextMenu(null);
      const now = Date.now(); const dbl = now - lastDownRef.current.t < 320 && Math.hypot(x - lastDownRef.current.x, y - lastDownRef.current.y) < 6;
      lastDownRef.current = { t: now, x, y };

      if (tool === 'eraser') { const hit = hitTest(x, y); if (hit) removeDrawing(hit.id); return; }

      if (SELECT_TOOLS.has(tool)) {
        const sel = selectedRef.current;
        if (sel) { const d = drawingsRef.current.find((dd) => dd.id === sel); if (d && !d.locked) { const hnd = handlesFor(d).find((hh) => Math.hypot(x - hh.x, y - hh.y) <= HANDLE_TOL); if (hnd) { dragRef.current = { mode: 'resize', id: d.id, key: hnd.key, orig: clone(d), preview: clone(d) }; canvas.setPointerCapture?.(e.pointerId); return; } } }
        const hit = hitTest(x, y);
        if (hit) { setSelectedId(hit.id); if (hit.locked) return; const snap = (hit.pts || []).map((a) => ({ x: xOf(a), y: yOf(a.price) })); dragRef.current = { mode: 'move', id: hit.id, startX: x, startY: y, snap, preview: clone(hit) }; canvas.setPointerCapture?.(e.pointerId); }
        else setSelectedId(null);
        return;
      }

      // drawing tools
      const fam = familyOf(tool); const need = pointsFor(tool); const a = anchorFromXY(x, y); if (!a) return;
      if (fam === 'brush') { brushRef.current = normalize({ kind: tool, pts: [a] }); canvas.setPointerCapture?.(e.pointerId); return; }
      if (need === 'free') { if (dbl) { finalizeFree(); return; } setPending((p) => [...p, a]); return; }
      if (need === 1) {
        if (fam === 'text') { const t = window.prompt('Text:'); if (t != null) addDrawing(tool, [a], { text: t }); }
        else if (fam === 'emoji') addDrawing(tool, [a], { emoji: emojiRef.current });
        else if (fam === 'marker' && (toolMeta(tool)?.variant === 'note' || toolMeta(tool)?.variant === 'callout')) { const t = window.prompt('Note text:', 'Note'); if (t != null) addDrawing(tool, [a], { text: t }); }
        else addDrawing(tool, [a]);
        setActiveTool('crosshair'); return;
      }
      // fixed N≥2
      const pend = pendingRef.current;
      if (pend.length < need - 1) { setPending([...pend, a]); }
      else {
        const pts = [...pend, a];
        if (fam === 'measure') { const dP = a.price - pts[0].price, dPct = pts[0].price ? (dP / pts[0].price) * 100 : 0; setMeasureReadout({ dPrice: dP, dPct }); }
        addDrawing(tool, pts); setPending([]); setActiveTool('crosshair');
      }
    };

    const onMove = (e) => {
      const { x, y } = pos(e); hoverRef.current = { x, y };
      const drag = dragRef.current;
      if (drag) {
        if (drag.mode === 'resize') { const na = anchorFromXY(x, y); if (na) { drag.preview = applyResize(drag.orig, drag.key, na); redraw(); } return; }
        const dx = x - drag.startX, dy = y - drag.startY; const pv = drag.preview;
        pv.pts = drag.snap.map((sp) => anchorFromXY((sp.x ?? 0) + dx, (sp.y ?? 0) + dy) || null).map((na, i) => na || pv.pts[i]);
        redraw(); return;
      }
      if (brushRef.current) { const a = anchorFromXY(x, y); if (a) { brushRef.current.pts.push(a); redraw(); } return; }
      if (pendingRef.current.length) { redraw(); return; }
      if (SELECT_TOOLS.has(toolRef.current)) {
        const sel = selectedRef.current; let cur = 'default';
        if (sel) { const d = drawingsRef.current.find((dd) => dd.id === sel); if (d && !d.locked && handlesFor(d).some((hh) => Math.hypot(x - hh.x, y - hh.y) <= HANDLE_TOL)) cur = 'nwse-resize'; }
        if (cur === 'default') cur = hitTest(x, y) ? 'move' : 'default'; canvas.style.cursor = cur;
      }
    };

    const onUp = (e) => {
      canvas.releasePointerCapture?.(e.pointerId);
      if (dragRef.current) { const { id, preview } = dragRef.current; dragRef.current = null; if (preview) commit((prev) => prev.map((d) => (d.id === id ? preview : d))); return; }
      if (brushRef.current) { const pts = brushRef.current.pts; const tool = toolRef.current; brushRef.current = null; if (pts.length >= 2) addDrawing(tool, pts); setActiveTool('crosshair'); }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    // rAF loop — but only actually repaint when the chart moved (pan / zoom /
    // autoscale) or the user is mid-interaction. Idle frames just compute a
    // cheap signature and skip the canvas work, so the chart stays responsive.
    let raf = 0; let lastSig = '';
    const loop = () => {
      const chart = chartRef.current, s = candleSeriesRef.current;
      let sig = '';
      try {
        const r = chart?.timeScale().getVisibleLogicalRange();
        const h = canvas.clientHeight;
        const p0 = s?.coordinateToPrice(0), p1 = s?.coordinateToPrice(h);
        sig = `${r?.from?.toFixed?.(3)}|${r?.to?.toFixed?.(3)}|${p0?.toFixed?.(5)}|${p1?.toFixed?.(5)}|${canvas.clientWidth}x${h}`;
      } catch { /* */ }
      if (sig !== lastSig || dragRef.current || brushRef.current || pendingRef.current.length) { lastSig = sig; redraw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      ro?.disconnect(); cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      try { container.removeChild(canvas); } catch { /* */ } overlayRef.current = null; ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, chartRef]);

  // Apply a resize: replace the dragged anchor/corner of `orig` with `na`.
  function applyResize(orig, key, na) {
    const nd = clone(orig); const fam = nd.family;
    if (fam === 'hline') nd.pts[0] = { ...nd.pts[0], price: na.price };
    else if (fam === 'vline' || fam === 'cross') nd.pts[0] = { ...nd.pts[0], time: na.time, logical: na.logical };
    else if ((fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'ellipse')) {
      if (key === 'p0') nd.pts[0] = na; else if (key === 'p1') nd.pts[1] = na;
      else if (key === 'p01') { nd.pts[1] = { ...nd.pts[1], time: na.time, logical: na.logical }; nd.pts[0] = { ...nd.pts[0], price: na.price }; }
      else if (key === 'p10') { nd.pts[0] = { ...nd.pts[0], time: na.time, logical: na.logical }; nd.pts[1] = { ...nd.pts[1], price: na.price }; }
    } else { const i = parseInt(key.slice(1), 10); if (Number.isFinite(i) && nd.pts[i]) nd.pts[i] = na; }
    return nd;
  }

  // capture toggle
  useEffect(() => {
    const c = overlayRef.current; if (!c) return;
    c.style.pointerEvents = (!SELECT_TOOLS.has(activeTool) || selectedId) ? 'auto' : 'none';
    c.style.cursor = (!SELECT_TOOLS.has(activeTool) && activeTool !== 'eraser') ? 'crosshair' : (activeTool === 'eraser' ? 'pointer' : 'default');
  }, [activeTool, selectedId]);

  // selection via chart click (when capture off)
  useEffect(() => {
    const chart = chartRef.current; if (!chart) return;
    const onClick = (param) => { if (!SELECT_TOOLS.has(toolRef.current) || lockedRef.current || !param.point) return; const hit = hitTest(param.point.x, param.point.y); setSelectedId(hit ? hit.id : null); };
    chart.subscribeClick(onClick);
    return () => { try { chart.unsubscribeClick(onClick); } catch { /* */ } };
  }, [chartRef, hitTest]);

  useEffect(() => { redraw(); }, [drawings, hidden, selectedId, pending, redraw]);

  // keyboard
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target?.tagName; const typing = t === 'INPUT' || t === 'TEXTAREA' || e.target?.isContentEditable; const meta = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { setPending([]); setSelectedId(null); setActiveTool('crosshair'); setContextMenu(null); setEditing(null); return; }
      if (typing) return;
      if (e.key === 'Enter' && pendingRef.current.length >= 2) { finalizeFree(); return; }
      if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (meta && (e.key === 'd' || e.key === 'D')) { if (selectedRef.current) { e.preventDefault(); duplicateDrawing(selectedRef.current); } return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) { e.preventDefault(); removeDrawing(selectedRef.current); }
      else if (e.key === ']' && selectedRef.current) bringToFront(selectedRef.current);
      else if (e.key === '[' && selectedRef.current) sendToBack(selectedRef.current);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [removeDrawing, undo, redo, duplicateDrawing, bringToFront, sendToBack, finalizeFree]);

  // zoom
  const zoomIn = useCallback(() => { const ts = chartRef.current?.timeScale(); const r = ts?.getVisibleLogicalRange?.(); if (!r) return; const span = (r.to - r.from) * 0.7, mid = (r.from + r.to) / 2; try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch { /* */ } }, [chartRef]);
  const zoomOut = useCallback(() => { const ts = chartRef.current?.timeScale(); const r = ts?.getVisibleLogicalRange?.(); if (!r) return; const span = (r.to - r.from) * 1.4, mid = (r.from + r.to) / 2; try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch { /* */ } }, [chartRef]);
  const resetZoom = useCallback(() => { try { chartRef.current?.timeScale().fitContent(); } catch { /* */ } }, [chartRef]);

  const selectedDrawing = useMemo(() => drawings.find((d) => d.id === selectedId) || null, [drawings, selectedId]);
  const editingDrawing = useMemo(() => (editing ? drawings.find((d) => d.id === editing.id) || null : null), [drawings, editing]);

  return {
    activeTool, setActiveTool,
    drawings, addDrawing, removeDrawing, clearAll, updateDrawing, duplicateDrawing, toggleLockDrawing,
    bringToFront, sendToBack, bringForward, sendBackward,
    undo, redo, canUndo, canRedo,
    locked, setLocked, hidden, setHidden, pending,
    selectedId, setSelectedId, selectedDrawing,
    measureReadout, clearMeasure: () => setMeasureReadout(null),
    selectedEmoji, setSelectedEmoji,
    zoomIn, zoomOut, resetZoom, hitTestAt,
    contextMenu, openContextMenu, closeContextMenu,
    editing, editingDrawing, openSettings, closeSettings,
  };
}
