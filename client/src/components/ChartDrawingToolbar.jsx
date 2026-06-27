import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { useConfirm } from './ConfirmProvider';
import { GROUPS, CURSORS, RAIL, TOOL_META } from './chartTools';

const COLLAPSE_KEY = 'chartDrawingToolbar.collapsed';
const EMOJI_PALETTE = ['🚀', '📈', '📉', '🐂', '🐻', '💎', '🔥', '⚡', '💰', '⭐', '👀', '⚠️', '✅', '❌', '🎯', '🛑', '😀', '😎', '😱', '🤔', '👍', '👎', '💡', '🏁'];

const RAIL_LABEL = {
  cursor: 'Cursor', lines: 'Lines, Channels & Pitchforks', fib: 'Fibonacci & Gann',
  patterns: 'Patterns, Elliott & Cycles', projection: 'Projection, Volume & Measure',
  brush: 'Brushes, Arrows & Shapes', text: 'Text & Notes', emoji: 'Stickers',
};

// tool → rail-id (which rail button owns it)
const TOOL_RAIL = (() => {
  const m = {};
  for (const r of RAIL) (r.groups || []).forEach((gName) => { const g = GROUPS.find((x) => x.name === gName); g?.items.forEach((it) => { m[it.tool] = r.id; }); });
  return m;
})();

/**
 * TradingView-style drawing toolbar. A left rail of category buttons, each
 * opening a grouped flyout (with search + hotkeys). The rail remembers the
 * last tool picked per category. Cursor variants + emoji have their own
 * flyouts; magnet / lock / hide / undo-redo / clear sit at the bottom.
 */
export default function ChartDrawingToolbar({ controls }) {
  const confirm = useConfirm();
  const {
    activeTool, setActiveTool, drawings, clearAll,
    locked, setLocked, hidden, setHidden,
    selectedEmoji, setSelectedEmoji,
    zoomIn, zoomOut, resetZoom, undo, redo, canUndo, canRedo,
  } = controls || {};

  const [openRail, setOpenRail] = useState(null);     // rail id whose flyout is open
  const [anchor, setAnchor] = useState({ left: 0, top: 0 }); // screen pos of the open rail button
  const [search, setSearch] = useState('');
  const [railLast, setRailLast] = useState(() => {    // last tool chosen per rail
    const m = {};
    for (const r of RAIL) if (r.groups) { const g = GROUPS.find((x) => x.name === r.groups[0]); m[r.id] = g?.items[0]?.tool; }
    return m;
  });
  const [cursorLast, setCursorLast] = useState('crosshair');
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
    // Broadcast so the host rail column (PriceChart / Trade shared rail) can
    // shrink to zero when collapsed → the chart reclaims the empty space.
    try { window.dispatchEvent(new CustomEvent('drawtoolbar:collapse', { detail: collapsed })); } catch {}
  }, [collapsed]);

  if (!controls) return null;

  const pickTool = (tool) => {
    if (locked) { toast.error('Drawings are locked'); return; }
    setActiveTool(tool);
    const rid = TOOL_RAIL[tool]; if (rid) setRailLast((m) => ({ ...m, [rid]: tool }));
    setOpenRail(null); setSearch('');
  };
  const onRail = (r, e) => {
    if (locked) { toast.error('Drawings are locked'); return; }
    if (r.cursors) setActiveTool(cursorLast);
    else if (r.emoji) setActiveTool('emoji');
    else if (railLast[r.id]) setActiveTool(railLast[r.id]);
    const rect = e?.currentTarget?.getBoundingClientRect?.();
    if (rect) setAnchor({ left: rect.right + 6, top: rect.top });
    setOpenRail((cur) => (cur === r.id ? null : r.id)); setSearch('');
  };
  const railActive = (r) => {
    if (r.cursors) return ['crosshair', 'dot', 'arrowcur', 'eraser'].includes(activeTool);
    if (r.emoji) return activeTool === 'emoji';
    return (r.groups || []).some((gn) => GROUPS.find((g) => g.name === gn)?.items.some((it) => it.tool === activeTool));
  };
  const railIcon = (r) => {
    if (r.cursors) return <CrosshairI />;
    if (r.emoji) return <span className="text-[15px] leading-none">{selectedEmoji}</span>;
    const last = railLast[r.id]; const fam = last ? TOOL_META[last]?.family : r.repIcon;
    return <FamilyIcon family={fam || r.repIcon} />;
  };

  if (collapsed) {
    return (
      <button type="button" onClick={() => setCollapsed(false)} title="Show drawing tools" aria-label="Show drawing tools"
        className="keep-white hidden md:flex absolute top-2 left-0 z-20 w-4 h-7 items-center justify-center rounded-r-md border border-l-0 border-primary-600 bg-primary-600 hover:bg-primary-700 shadow-elevated transition-colors" style={{ color: '#FFFFFF' }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
    );
  }

  return (
    <div className="chart-drawing-toolbar hidden md:flex absolute top-0 left-0 bottom-0 z-20 flex-col items-center gap-1 p-1 border border-l-0 border-t-0 border-border-dark bg-white/90 backdrop-blur-sm shadow-card overflow-y-auto overflow-x-visible"
      style={{ scrollbarWidth: 'thin', scrollbarColor: '#cbd5e1 transparent' }}>
      <button type="button" onClick={() => setCollapsed(true)} title="Hide drawing tools" aria-label="Hide drawing tools"
        className="keep-white w-8 h-7 rounded-md flex items-center justify-center bg-primary-600 hover:bg-primary-700 shadow-sm ring-1 ring-primary-700/30 transition-colors" style={{ color: '#FFFFFF' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
      <Divider />

      {/* category rail buttons */}
      {RAIL.map((r) => (
        <Btn key={r.id} label={RAIL_LABEL[r.id] || r.id} active={railActive(r)} onClick={(e) => onRail(r, e)} chevron>
          {railIcon(r)}
        </Btn>
      ))}
      {openRail && (() => {
        const r = RAIL.find((x) => x.id === openRail); if (!r) return null;
        return (
          <Flyout anchor={anchor} onClose={() => { setOpenRail(null); setSearch(''); }}>
            {r.cursors ? (
              <CursorFlyout activeTool={activeTool} onPick={(t) => { setCursorLast(t === 'eraser' ? cursorLast : t); pickTool(t); }} />
            ) : r.emoji ? (
              <EmojiFlyout selected={selectedEmoji} onPick={(em) => { setSelectedEmoji(em); pickTool('emoji'); }} />
            ) : (
              <GroupFlyout rail={r} activeTool={activeTool} search={search} setSearch={setSearch} onPick={pickTool} />
            )}
          </Flyout>
        );
      })()}

      <Divider />
      <Btn label="Measure — Price Range (2 clicks)" active={activeTool === 'pricerange'} onClick={() => pickTool(activeTool === 'pricerange' ? 'crosshair' : 'pricerange')}><RulerI /></Btn>
      <Btn label="Magnet snap" active={activeTool === 'magnet'} onClick={() => pickTool(activeTool === 'magnet' ? 'crosshair' : 'magnet')}><MagnetI /></Btn>
      <Btn label="Eraser — click drawings to delete" active={activeTool === 'eraser'} onClick={() => pickTool(activeTool === 'eraser' ? 'crosshair' : 'eraser')}><EraserI /></Btn>
      <Btn label="Zoom in" onClick={zoomIn}><ZoomI /></Btn>
      <Btn label="Zoom out" onClick={zoomOut}><ZoomOutI /></Btn>
      <Btn label="Reset / fit chart" onClick={resetZoom}><ZoomResetI /></Btn>

      <Divider />
      <Btn label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}><UndoI /></Btn>
      <Btn label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}><RedoI /></Btn>

      <Divider />
      <Btn label={locked ? 'Drawings locked — click to unlock' : 'Lock all drawings'} active={locked} onClick={() => setLocked((v) => !v)}>{locked ? <LockedI /> : <UnlockedI />}</Btn>
      <Btn label={hidden ? 'Drawings hidden — click to show' : 'Hide drawings'} active={hidden} onClick={() => setHidden((v) => !v)}>{hidden ? <EyeOffI /> : <EyeI />}</Btn>
      <Btn label={`Remove all (${drawings.length})`} onClick={async () => { if (drawings.length === 0 || await confirm(`Remove all ${drawings.length} drawing(s)?`)) clearAll(); }}><TrashI /></Btn>

      <style>{`
        .chart-drawing-toolbar::-webkit-scrollbar { width: 4px; }
        .chart-drawing-toolbar::-webkit-scrollbar-track { background: transparent; }
        .chart-drawing-toolbar::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.5); border-radius: 9999px; }
        .chart-drawing-toolbar::-webkit-scrollbar-thumb:hover { background: rgba(100,116,139,0.7); }
        .tv-flyout::-webkit-scrollbar { width: 6px; }
        .tv-flyout::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.5); border-radius: 9999px; }
      `}</style>
    </div>
  );
}

// ── flyout shell ──
// Rendered with fixed positioning so it escapes the toolbar's scroll container
// (overflow-y-auto would otherwise clip it horizontally). Anchored to the right
// of the clicked rail button and clamped to the viewport.
function Flyout({ children, onClose, anchor }) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const W = 256;
  let left = anchor?.left ?? 60;
  if (left + W > vw - 8) left = Math.max(8, (anchor?.left ?? 60) - W - 44); // flip to left of rail
  const top = Math.min(Math.max(8, anchor?.top ?? 60), Math.max(8, vh - 320));
  const maxHeight = vh - top - 12;
  // Portal to <body> so neither the toolbar's backdrop-blur nor any transformed
  // ancestor becomes the containing block for our fixed-position menu.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="tv-flyout fixed z-[61] w-64 overflow-y-auto rounded-xl border border-border-dark bg-white shadow-elevated py-1"
        style={{ left, top, maxHeight }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>,
    document.body,
  );
}

function GroupFlyout({ rail, activeTool, search, setSearch, onPick }) {
  const q = search.trim().toLowerCase();
  const groups = useMemo(() => (rail.groups || []).map((gn) => GROUPS.find((g) => g.name === gn)).filter(Boolean), [rail]);
  return (
    <>
      <div className="sticky top-0 bg-white border-b border-border-subtle p-2 z-10">
        <div className="relative">
          <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input autoFocus type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search drawing tools…"
            className="w-full h-7 pl-7 pr-2 text-[11px] rounded border border-border-dark bg-bg-hover/40 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500" />
        </div>
      </div>
      {groups.map((g) => {
        const items = g.items.filter((it) => !q || it.label.toLowerCase().includes(q));
        if (!items.length) return null;
        return (
          <div key={g.name}>
            <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider font-bold text-text-muted bg-bg-hover/40">{g.name}</div>
            {items.map((it) => (
              <button key={it.tool} type="button" onClick={() => onPick(it.tool)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${activeTool === it.tool ? 'bg-primary-500/15 text-primary-600' : 'text-text-primary hover:bg-bg-hover'}`}>
                <span className="shrink-0 w-4 flex items-center justify-center text-text-secondary"><FamilyIcon family={it.family} small /></span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.hotkey && <span className="text-[10px] text-text-muted">{it.hotkey}</span>}
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

function CursorFlyout({ activeTool, onPick }) {
  const icons = { crosshair: <CrosshairI />, dot: <DotI />, arrowcur: <ArrowCurI />, eraser: <EraserI /> };
  return (
    <div className="py-1">
      {CURSORS.map((c) => (
        <button key={c.tool} type="button" onClick={() => onPick(c.tool)}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors ${activeTool === c.tool ? 'bg-primary-500/15 text-primary-600' : 'text-text-primary hover:bg-bg-hover'}`}>
          <span className="shrink-0 w-4 flex items-center justify-center text-text-secondary">{icons[c.tool]}</span>{c.label}
        </button>
      ))}
    </div>
  );
}

function EmojiFlyout({ selected, onPick }) {
  return (
    <div className="p-2">
      <div className="px-1 pb-1.5 text-[9px] uppercase tracking-wider font-bold text-text-muted">Stickers</div>
      <div className="grid grid-cols-6 gap-1">
        {EMOJI_PALETTE.map((em) => (
          <button key={em} type="button" onClick={() => onPick(em)} title={`Use ${em}`}
            className={`w-8 h-8 rounded-md flex items-center justify-center text-lg transition-all hover:bg-bg-hover hover:scale-110 ${selected === em ? 'bg-primary-500/15 ring-1 ring-primary-500/30' : ''}`}>{em}</button>
        ))}
      </div>
      <div className="mt-1 pt-1 border-t border-border-subtle text-[10px] text-text-muted text-center">Click chart to place</div>
    </div>
  );
}

// ── button shell ──
function Btn({ children, label, active, onClick, hint, disabled, chevron }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={hint || label} aria-label={label}
      className={`relative w-8 h-8 rounded-md flex items-center justify-center transition-all ${
        disabled ? 'text-text-muted/40 cursor-not-allowed' : active ? 'bg-primary-500/15 text-primary-600 ring-1 ring-primary-500/30' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}>
      {children}
      {chevron && <svg className="absolute right-0 top-1/2 -translate-y-1/2 text-text-muted/60" width="6" height="6" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z" /></svg>}
    </button>
  );
}
function Divider() { return <span className="my-0.5 h-px w-5 bg-border-dark/60" />; }

// ── icons ──
const S = ({ children, sm }) => (<svg width={sm ? 13 : 16} height={sm ? 13 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{children}</svg>);
const CrosshairI = () => <S><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /><circle cx="12" cy="12" r="3" /></S>;
const DotI = () => <S><circle cx="12" cy="12" r="2.5" fill="currentColor" /></S>;
const ArrowCurI = () => <S><path d="M5 3l7 16 2-7 7-2z" /></S>;
const EraserI = () => <S><path d="M16 3l5 5L10 19H5l-2-2z" /><path d="M9 11l4 4" /></S>;
const MagnetI = () => <S><path d="M6 4h4v8a2 2 0 1 0 4 0V4h4v8a6 6 0 1 1-12 0z" /><line x1="6" y1="8" x2="10" y2="8" /><line x1="14" y1="8" x2="18" y2="8" /></S>;
const RulerI = () => <S><path d="M3 8l5-5 13 13-5 5z" /><path d="M8 5l2 2M11 8l2 2M14 11l2 2" /></S>;
const ZoomI = () => <S><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></S>;
const ZoomOutI = () => <S><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></S>;
const ZoomResetI = () => <S><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></S>;
const UndoI = () => <S><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" /></S>;
const RedoI = () => <S><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" /></S>;
const LockedI = () => <S><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></S>;
const UnlockedI = () => <S><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.46-2" /></S>;
const EyeI = () => <S><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></S>;
const EyeOffI = () => <S><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a17.61 17.61 0 0 1 3.94-5" /><path d="M9.9 4.24A10 10 0 0 1 12 4c7 0 10 7 10 7a17.6 17.6 0 0 1-2.13 3.36" /><line x1="1" y1="1" x2="23" y2="23" /></S>;
const TrashI = () => <S><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></S>;

// Family icon — one glyph per geometric family (reused across many tools).
function FamilyIcon({ family, small }) {
  const m = {
    trend: <S sm={small}><circle cx="5" cy="19" r="1.5" /><circle cx="19" cy="5" r="1.5" /><line x1="6" y1="18" x2="18" y2="6" /></S>,
    hline: <S sm={small}><line x1="3" y1="12" x2="21" y2="12" /><circle cx="5" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></S>,
    hray: <S sm={small}><line x1="3" y1="12" x2="21" y2="12" /><circle cx="5" cy="12" r="1.5" /></S>,
    vline: <S sm={small}><line x1="12" y1="3" x2="12" y2="21" /><circle cx="12" cy="5" r="1.5" /></S>,
    cross: <S sm={small}><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></S>,
    channel: <S sm={small}><line x1="4" y1="18" x2="20" y2="8" /><line x1="4" y1="14" x2="20" y2="4" /></S>,
    regression: <S sm={small}><line x1="4" y1="18" x2="20" y2="6" /><line x1="4" y1="20" x2="20" y2="8" strokeDasharray="2 2" /><line x1="4" y1="16" x2="20" y2="4" strokeDasharray="2 2" /></S>,
    pitchfork: <S sm={small}><circle cx="4" cy="6" r="1.5" /><circle cx="20" cy="6" r="1.5" /><circle cx="12" cy="18" r="1.5" /><path d="M4 6L12 18L20 6" /></S>,
    fib: <S sm={small}><line x1="3" y1="5" x2="21" y2="5" /><line x1="3" y1="9" x2="21" y2="9" strokeDasharray="2 2" /><line x1="3" y1="13" x2="21" y2="13" /><line x1="3" y1="17" x2="21" y2="17" strokeDasharray="2 2" /></S>,
    fibchannel: <S sm={small}><line x1="4" y1="18" x2="20" y2="8" /><line x1="4" y1="14" x2="20" y2="4" strokeDasharray="2 2" /></S>,
    fibtime: <S sm={small}><line x1="6" y1="4" x2="6" y2="20" /><line x1="11" y1="4" x2="11" y2="20" /><line x1="18" y1="4" x2="18" y2="20" /></S>,
    fan: <S sm={small}><path d="M4 20L20 4M4 20L20 10M4 20L20 16" /></S>,
    circles: <S sm={small}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /></S>,
    spiral: <S sm={small}><path d="M12 12a3 3 0 1 1 3-3 5 5 0 1 1-5 5 7 7 0 1 1 7-7" /></S>,
    arcs: <S sm={small}><path d="M3 20a9 9 0 0 1 18 0" /><path d="M7 20a5 5 0 0 1 10 0" /></S>,
    rectgrid: <S sm={small}><rect x="4" y="5" width="16" height="14" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="12" y1="5" x2="12" y2="19" /></S>,
    gannsquare: <S sm={small}><rect x="4" y="5" width="16" height="14" /><line x1="4" y1="19" x2="20" y2="5" /><line x1="4" y1="5" x2="20" y2="19" /></S>,
    rect: <S sm={small}><rect x="4" y="6" width="16" height="12" rx="1" /></S>,
    rotrect: <S sm={small}><path d="M3 13l8-8 10 6-8 8z" /></S>,
    ellipse: <S sm={small}><ellipse cx="12" cy="12" rx="9" ry="6" /></S>,
    poly: <S sm={small}><path d="M3 17l5-7 4 4 5-8 4 5" /></S>,
    sine: <S sm={small}><path d="M3 12c3-8 6 8 9 0s6-8 9 0" /></S>,
    position: <S sm={small}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" strokeDasharray="2 2" /><line x1="4" y1="18" x2="20" y2="18" /></S>,
    volprofile: <S sm={small}><line x1="4" y1="4" x2="4" y2="20" /><line x1="4" y1="7" x2="14" y2="7" /><line x1="4" y1="12" x2="18" y2="12" /><line x1="4" y1="17" x2="10" y2="17" /></S>,
    measure: <S sm={small}><path d="M21 6l-7-3-11 11 3 7z" /><path d="M8 9l-2 2M11 12l-2 2M14 6l-2 2" /></S>,
    brush: <S sm={small}><path d="M9 11l-6 6a2 2 0 0 0 2.83 2.83l6-6" /><path d="M16 4l4 4-9 9-4-4z" /></S>,
    marker: <S sm={small}><path d="M12 3l3 7h-6z" /><line x1="12" y1="10" x2="12" y2="21" /></S>,
    text: <S sm={small}><path d="M4 7V5h16v2" /><line x1="12" y1="5" x2="12" y2="20" /><line x1="8" y1="20" x2="16" y2="20" /></S>,
    emoji: <S sm={small}><circle cx="12" cy="12" r="9" /><path d="M8 14a4 4 0 0 0 8 0" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></S>,
  };
  return m[family] || <S sm={small}><line x1="5" y1="19" x2="19" y2="5" /></S>;
}
