import { useState } from 'react';
import { createPortal } from 'react-dom';
import { LINE_STYLES } from './indicatorCatalog';

/**
 * IndicatorSettingsModal — TradingView/Groww-style per-indicator settings.
 * Edits period (moving averages), length (other indicators), colour, line width
 * and line style, then calls onApply with the chosen params. Live — the parent
 * updates the chart model immediately, no reload.
 *
 * props:
 *   target  { type:'ma', ma } | { type:'ind', ind }   (catalog entry)
 *   cfg     current params { period?, length?, color?, lineWidth?, lineStyle? }
 *   isActive  whether this indicator is currently on the chart
 *   onApply(params)   onRemove()   onClose()   theme
 */
export default function IndicatorSettingsModal({ target, cfg = {}, isActive, onApply, onRemove, onClose, theme }) {
  const dark = theme === 'dark';
  const isMa = target.type === 'ma';
  const meta = isMa ? target.ma : target.ind;

  const [period, setPeriod] = useState(cfg.period ?? (isMa ? meta.def : (meta.defLength ?? '')));
  const [color, setColor] = useState(cfg.color || meta.color);
  const [lineWidth, setLineWidth] = useState(cfg.lineWidth || 2);
  const [lineStyle, setLineStyle] = useState(cfg.lineStyle ?? 0);

  const hasLength = isMa || meta.defLength != null;

  const c = dark
    ? { bg: '#0F172A', border: '#334155', text: '#F1F5F9', muted: '#94A3B8', input: '#1E293B', hover: '#1E293B' }
    : { bg: '#FFFFFF', border: '#E2E8F0', text: '#0F172A', muted: '#64748B', input: '#FFFFFF', hover: '#F1F5F9' };

  const apply = () => {
    const params = { color, lineWidth: Number(lineWidth), lineStyle: Number(lineStyle) };
    if (isMa) params.period = Number(period) || meta.def;
    else if (meta.defLength != null) params.length = Number(period) || meta.defLength;
    onApply(params);
  };

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4" style={{ background: 'rgba(2,6,23,0.55)' }} onMouseDown={onClose}>
      <div
        className="w-full max-w-[380px] rounded-2xl shadow-2xl overflow-hidden"
        style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${c.border}` }}>
          <span className="flex items-center gap-2 text-base font-bold">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
            {meta.name} settings
          </span>
          <button type="button" onClick={onClose} style={{ color: c.muted }} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Period / Length */}
          {hasLength && (
            <Row label={isMa ? 'Period' : 'Length'} c={c}>
              {isMa ? (
                <select value={period} onChange={(e) => setPeriod(e.target.value)}
                  className="text-sm rounded-lg px-3 py-2 min-w-[120px] focus:outline-none"
                  style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }}>
                  {meta.periods.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : (
                <input type="number" min="1" max="500" value={period} onChange={(e) => setPeriod(e.target.value)}
                  className="text-sm rounded-lg px-3 py-2 w-[120px] focus:outline-none"
                  style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }} />
              )}
            </Row>
          )}

          {/* Colour */}
          <Row label="Color" c={c}>
            <span className="inline-flex items-center gap-2">
              <span className="font-mono text-xs" style={{ color: c.muted }}>{color}</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0" />
            </span>
          </Row>

          {/* Line width */}
          <Row label="Line width" c={c}>
            <select value={lineWidth} onChange={(e) => setLineWidth(e.target.value)}
              className="text-sm rounded-lg px-3 py-2 min-w-[120px] focus:outline-none"
              style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }}>
              {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
          </Row>

          {/* Line style */}
          <Row label="Line style" c={c}>
            <select value={lineStyle} onChange={(e) => setLineStyle(e.target.value)}
              className="text-sm rounded-lg px-3 py-2 min-w-[120px] focus:outline-none"
              style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }}>
              {LINE_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Row>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${c.border}` }}>
          {isActive && onRemove && (
            <button type="button" onClick={onRemove} className="px-4 py-2 rounded-lg text-sm font-semibold mr-auto"
              style={{ border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444' }}>Remove</button>
          )}
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-lg text-sm font-semibold"
            style={{ border: `1px solid ${c.border}`, color: c.text }}>Cancel</button>
          <button type="button" onClick={apply} className="px-6 py-2 rounded-lg text-sm font-bold text-white" style={{ background: '#1D4ED8' }}>
            {isActive ? 'Apply' : 'Add'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, c, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm" style={{ color: c.text }}>{label}</span>
      {children}
    </div>
  );
}
