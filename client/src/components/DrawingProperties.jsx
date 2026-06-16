import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { HAS_WIDTH, HAS_STYLE, HAS_FILL, toolLabel, TEXT_TOOLS } from './chartTools';

/**
 * Floating property panel for the drawing being edited (double-click an object
 * or pick "Settings…" from its right-click menu). Theme-aware, rendered
 * absolutely inside the chart container at container-relative `x`/`y`.
 *
 * Shows only the fields relevant to the object's kind, plus quick actions
 * (duplicate / layer order / lock / delete). Every change is committed through
 * `controls.updateDrawing`, so it flows into undo/redo + persistence.
 */

const PALETTE = ['#2962FF', '#3B82F6', '#0EA5E9', '#10B981', '#22C55E', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6', '#7C3AED', '#64748B', '#111827'];
const WIDTHS = [1, 1.5, 2, 3, 4];
const STYLES = [{ k: 'solid', label: '──' }, { k: 'dashed', label: '- -' }, { k: 'dotted', label: '··' }];
const EMOJIS = ['🚀', '📈', '📉', '🐂', '🐻', '💎', '🔥', '⚡', '💰', '⭐', '👀', '⚠️'];

export default function DrawingProperties({ controls, theme }) {
  const { editing, editingDrawing: d, closeSettings, updateDrawing } = controls;

  useEffect(() => {
    if (!editing) return;
    const onKey = (e) => { if (e.key === 'Escape') closeSettings(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, closeSettings]);

  if (!editing || !d) return null;
  const dark = theme === 'dark';
  const id = d.id;
  const set = (patch) => updateDrawing(id, patch);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const x = Math.min(Math.max(4, editing.x), vw - 236);
  const y = Math.min(Math.max(4, editing.y), vh - 380);
  const card = dark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-border-dark text-text-primary';
  const lbl = dark ? 'text-slate-400' : 'text-text-muted';
  const chip = (active) => `h-7 px-2 rounded-md text-[11px] font-semibold border transition-colors ${
    active ? 'bg-primary-500 text-white border-primary-500' : dark ? 'border-slate-700 hover:bg-white/10' : 'border-border-dark hover:bg-bg-hover'
  }`;

  const fam = d.family;
  const isText = fam === 'text' || (fam === 'marker' && (d.variant === 'note' || d.variant === 'callout')) || TEXT_TOOLS.has(d.kind);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={closeSettings} />
      <div
        className={`fixed z-[61] w-[224px] rounded-xl border shadow-elevated ${card}`}
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className={`flex items-center justify-between px-3 py-2 border-b ${dark ? 'border-slate-700' : 'border-border-subtle'}`}>
          <span className="text-[12px] font-bold">{toolLabel(d.kind)}</span>
          <button type="button" onClick={closeSettings} className={lbl}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-3 space-y-3">
          {/* color */}
          <div>
            <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Color</div>
            <div className="grid grid-cols-6 gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ color: c })}
                  className={`w-6 h-6 rounded-md border-2 transition-transform hover:scale-110 ${d.color === c ? 'border-primary-500 ring-1 ring-primary-500/40' : 'border-transparent'}`}
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* line width */}
          {HAS_WIDTH.has(fam) && (
            <div>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Thickness</div>
              <div className="flex gap-1.5">
                {WIDTHS.map((w) => (
                  <button key={w} type="button" onClick={() => set({ width: w })} className={chip(d.width === w)}>{w}</button>
                ))}
              </div>
            </div>
          )}

          {/* line style */}
          {HAS_STYLE.has(fam) && (
            <div>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Style</div>
              <div className="flex gap-1.5">
                {STYLES.map((s) => (
                  <button key={s.k} type="button" onClick={() => set({ style: s.k })} className={chip((d.style || 'solid') === s.k)}>{s.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* fill toggle */}
          {HAS_FILL.has(fam) && (
            <label className="flex items-center justify-between cursor-pointer">
              <span className={`text-[11px] font-semibold`}>Fill</span>
              <input type="checkbox" checked={!!d.fill} onChange={(e) => set({ fill: e.target.checked })} className="accent-primary-500 w-4 h-4" />
            </label>
          )}

          {/* text content */}
          {isText && (
            <div>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Text</div>
              <input
                type="text"
                value={d.text || ''}
                onChange={(e) => set({ text: e.target.value })}
                className={`w-full h-8 px-2 text-[12px] rounded-md border focus:outline-none focus:border-primary-500 ${dark ? 'bg-slate-800 border-slate-700' : 'bg-bg-hover/40 border-border-dark'}`}
              />
            </div>
          )}

          {/* emoji picker */}
          {fam === 'emoji' && (
            <div>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Emoji</div>
              <div className="grid grid-cols-6 gap-1">
                {EMOJIS.map((em) => (
                  <button key={em} type="button" onClick={() => set({ emoji: em })} className={`w-7 h-7 rounded-md text-lg flex items-center justify-center transition-transform hover:scale-110 ${d.emoji === em ? 'bg-primary-500/15 ring-1 ring-primary-500/40' : ''}`}>{em}</button>
                ))}
              </div>
            </div>
          )}

          {/* font size */}
          {(isText || fam === 'emoji' || fam === 'marker') && (
            <div>
              <div className={`text-[10px] uppercase tracking-wider font-bold mb-1.5 ${lbl}`}>Size</div>
              <input type="range" min="10" max="48" value={d.fontSize || (fam === 'emoji' ? 20 : fam === 'marker' ? 18 : 13)} onChange={(e) => set({ fontSize: +e.target.value })} className="w-full accent-primary-500" />
            </div>
          )}

          {/* lock */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[11px] font-semibold">Lock object</span>
            <input type="checkbox" checked={!!d.locked} onChange={() => controls.toggleLockDrawing(id)} className="accent-primary-500 w-4 h-4" />
          </label>

          {/* actions */}
          <div className={`grid grid-cols-2 gap-1.5 pt-1 border-t ${dark ? 'border-slate-700' : 'border-border-subtle'}`}>
            <button type="button" onClick={() => controls.duplicateDrawing(id)} className={chip(false)}>⧉ Duplicate</button>
            <button type="button" onClick={() => controls.bringToFront(id)} className={chip(false)}>⤒ Front</button>
            <button type="button" onClick={() => controls.sendToBack(id)} className={chip(false)}>⤓ Back</button>
            <button type="button" onClick={() => { controls.removeDrawing(id); }} className="h-7 px-2 rounded-md text-[11px] font-semibold border border-bear/40 text-bear hover:bg-bear/10 transition-colors">🗑 Delete</button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
