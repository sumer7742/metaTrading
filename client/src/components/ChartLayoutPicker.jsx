import { useState } from 'react';
import { createPortal } from 'react-dom';
import { LAYOUT_GROUPS, SYNC_FIELDS, getLayout } from './chartLayouts';

/**
 * TradingView-style chart-layout picker: a toolbar button that opens a
 * dropdown of layout templates (grouped 1-8) plus the "SYNC IN LAYOUT"
 * toggles. Self-contained — manages its own open state; the dropdown is
 * portaled to <body> so it never gets clipped by the chart container.
 */
export default function ChartLayoutPicker({ value, onChange, sync, onSyncChange, theme }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const dark = theme === 'dark';
  const active = getLayout(value);

  const toggle = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom + 6 });
    setOpen((o) => !o);
  };

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const W = 360;
  const left = Math.max(8, Math.min(anchor.left, vw - W - 8));
  const top = Math.min(anchor.top, Math.max(8, vh - 380));
  const maxHeight = vh - top - 12;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        title="Select layout"
        aria-label="Select chart layout"
        className={`inline-flex items-center justify-center h-8 w-8 rounded border transition-colors ${
          open ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark bg-white text-text-secondary hover:text-text-primary hover:bg-bg-hover hover:border-border-accent'
        }`}
      >
        <LayoutIcon layout={active} size={16} />
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            className={`tv-layout-pop fixed z-[61] rounded-xl border shadow-elevated overflow-y-auto ${dark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-border-dark text-text-primary'}`}
            style={{ left, top, width: W, maxHeight }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 space-y-2">
              {LAYOUT_GROUPS.map((g) => (
                <div key={g.n} className="flex items-center gap-2 py-1.5 border-b last:border-0 border-border-subtle/60">
                  <span className={`w-4 shrink-0 text-[12px] font-bold ${dark ? 'text-slate-500' : 'text-text-muted'}`}>{g.n}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {g.items.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => { onChange(l.id); setOpen(false); }}
                        title={`${l.n} chart${l.n > 1 ? 's' : ''}`}
                        className={`w-9 h-7 rounded-md border flex items-center justify-center transition-colors ${
                          value === l.id ? 'border-primary-500 bg-primary-500/10 text-primary-600' : dark ? 'border-slate-700 hover:bg-white/10 text-slate-300' : 'border-border-dark hover:bg-bg-hover text-text-secondary'
                        }`}
                      >
                        <LayoutIcon layout={l} size={22} />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* SYNC IN LAYOUT */}
            <div className={`px-3 pb-3 pt-1 ${dark ? 'border-t border-slate-700' : 'border-t border-border-subtle'}`}>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${dark ? 'text-slate-500' : 'text-text-muted'}`}>Sync in layout</div>
              {SYNC_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center justify-between py-1.5 cursor-pointer">
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    {f.label}
                    <span title={f.info} className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] ${dark ? 'bg-slate-700 text-slate-300' : 'bg-bg-hover text-text-muted'}`}>i</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!sync[f.key]}
                    onClick={() => onSyncChange(f.key, !sync[f.key])}
                    className={`relative w-9 h-5 rounded-full transition-colors ${sync[f.key] ? 'bg-primary-600' : dark ? 'bg-slate-600' : 'bg-slate-300'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${sync[f.key] ? 'translate-x-4' : ''}`} />
                  </button>
                </label>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// Mini preview of a layout — renders its `cells` as a tiny CSS grid.
export function LayoutIcon({ layout, size = 22 }) {
  const w = size, h = Math.round(size * 0.78);
  return (
    <div
      style={{ width: w, height: h, display: 'grid', gridTemplateColumns: `repeat(${layout.cols}, 1fr)`, gridTemplateRows: `repeat(${layout.rows}, 1fr)`, gap: 1.5 }}
    >
      {layout.cells.map((c, i) => (
        <span key={i} style={{ gridColumn: `${c[0]} / span ${c[1]}`, gridRow: `${c[2]} / span ${c[3]}`, border: '1.4px solid currentColor', borderRadius: 2 }} />
      ))}
    </div>
  );
}
