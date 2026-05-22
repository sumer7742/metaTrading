import { useState } from 'react';
import toast from 'react-hot-toast';

/**
 * Vertical drawing toolbar that sits at the left edge of the chart.
 * Matches the TradingView reference screenshot — 16 slots with dividers.
 *
 * All 12 Phase-1 + Phase-2 tools are now functional.
 */

const EMOJI_PALETTE = ['🚀', '📈', '📉', '🐂', '🐻', '💎', '🔥', '⚡', '💰', '⭐', '👀', '⚠️'];

export default function ChartDrawingToolbar({ controls }) {
  if (!controls) return null;
  const {
    activeTool, setActiveTool,
    drawings, clearAll,
    locked, setLocked,
    hidden, setHidden,
    pending,
    selectedEmoji, setSelectedEmoji,
    zoomIn, zoomOut, resetZoom,
  } = controls;
  const [emojiOpen, setEmojiOpen] = useState(false);

  const pick = (id) => {
    if (locked) {
      toast.error('Drawings are locked');
      return;
    }
    setActiveTool((curr) => (curr === id ? 'crosshair' : id));
  };
  const pickEmoji = () => {
    if (locked) { toast.error('Drawings are locked'); return; }
    setEmojiOpen((v) => !v);
    if (activeTool !== 'emoji') setActiveTool('emoji');
  };

  const isActive = (id) => activeTool === id;
  const hintFor = (id, need) => (pending.length === need - 1 && isActive(id) ? `Click point ${need}` : pending.length === 1 && need === 3 && isActive(id) ? 'Click point 2' : pending.length === 2 && need === 3 && isActive(id) ? 'Click point 3' : null);

  return (
    <div
      className="chart-drawing-toolbar hidden md:flex absolute top-0 left-0 bottom-0 z-20 flex-col items-center gap-1 p-1 rounded-br-xl border border-l-0 border-t-0 border-border-dark bg-white/90 backdrop-blur-sm shadow-card overflow-y-auto overflow-x-visible"
      style={{ scrollbarWidth: 'thin', scrollbarColor: '#cbd5e1 transparent' }}
    >
      <Btn label="Crosshair" active={isActive('crosshair')} onClick={() => setActiveTool('crosshair')}>
        <CrosshairI />
      </Btn>
      <Btn label="Trend line" active={isActive('trendline')} hint={hintFor('trendline', 2)} onClick={() => pick('trendline')}>
        <TrendI />
      </Btn>
      <Btn label="Horizontal line" active={isActive('hline')} onClick={() => pick('hline')}>
        <HLineI />
      </Btn>
      <Btn label="Pitchfork (3 clicks)" active={isActive('pitchfork')} hint={hintFor('pitchfork', 3)} onClick={() => pick('pitchfork')}>
        <PitchforkI />
      </Btn>
      <Btn label="Fibonacci retracement (2 clicks)" active={isActive('fib')} hint={hintFor('fib', 2)} onClick={() => pick('fib')}>
        <FibI />
      </Btn>
      <Btn label="Brush — click & drag" active={isActive('brush')} onClick={() => pick('brush')}>
        <BrushI />
      </Btn>
      <Btn label="Text note" active={isActive('text')} onClick={() => pick('text')}>
        <TextI />
      </Btn>
      <div className="relative">
        <Btn label={`Emoji · ${selectedEmoji}`} active={isActive('emoji')} onClick={pickEmoji}>
          <span className="text-[14px] leading-none">{selectedEmoji}</span>
        </Btn>
        {emojiOpen && (
          <div className="absolute left-full top-0 ml-2 grid grid-cols-4 gap-1 p-2 rounded-xl bg-white border border-border-dark shadow-card z-30 w-[148px]">
            {EMOJI_PALETTE.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => { setSelectedEmoji(em); setEmojiOpen(false); setActiveTool('emoji'); }}
                className={`w-8 h-8 rounded-md flex items-center justify-center text-lg transition-all hover:bg-bg-hover hover:scale-110 ${selectedEmoji === em ? 'bg-primary-500/15 ring-1 ring-primary-500/30' : ''}`}
                title={`Use ${em}`}
              >
                {em}
              </button>
            ))}
            <div className="col-span-4 mt-1 pt-1 border-t border-border-subtle text-[10px] text-text-muted text-center">
              Click chart to place
            </div>
          </div>
        )}
      </div>

      <Divider />
      <Btn label="Measure" active={isActive('measure')} hint={hintFor('measure', 2)} onClick={() => pick('measure')}>
        <RulerI />
      </Btn>
      <Btn label="Zoom in" onClick={zoomIn}>
        <ZoomI />
      </Btn>
      <Btn label="Reset zoom" onClick={resetZoom}>
        <ZoomResetI />
      </Btn>

      <Divider />
      <Btn label={activeTool === 'magnet' ? 'Magnet on (click to disable)' : 'Magnet snap'} active={isActive('magnet')} onClick={() => pick('magnet')}>
        <MagnetI />
      </Btn>
      <Btn label={locked ? 'Drawings locked — click to unlock' : 'Lock drawings'} active={locked} onClick={() => setLocked((v) => !v)}>
        {locked ? <LockedI /> : <UnlockedI />}
      </Btn>
      <Btn label={hidden ? 'Drawings hidden — click to show' : 'Hide drawings'} active={hidden} onClick={() => setHidden((v) => !v)}>
        {hidden ? <EyeOffI /> : <EyeI />}
      </Btn>
      <Btn label={`Clear all (${drawings.length})`} onClick={() => { if (drawings.length === 0 || window.confirm(`Clear all ${drawings.length} drawing(s)?`)) clearAll(); }}>
        <TrashI />
      </Btn>

      {/* Thin webkit-style scrollbar for Chrome/Edge/Safari */}
      <style>{`
        .chart-drawing-toolbar::-webkit-scrollbar { width: 4px; }
        .chart-drawing-toolbar::-webkit-scrollbar-track { background: transparent; }
        .chart-drawing-toolbar::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.5);
          border-radius: 9999px;
        }
        .chart-drawing-toolbar::-webkit-scrollbar-thumb:hover {
          background: rgba(100, 116, 139, 0.7);
        }
      `}</style>
    </div>
  );
}

// ── Button shell ─────────────────────────────────────────────────────
function Btn({ children, label, active, onClick, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint || label}
      aria-label={label}
      className={`relative w-8 h-8 rounded-md flex items-center justify-center transition-all ${
        active
          ? 'bg-primary-500/15 text-primary-600 ring-1 ring-primary-500/30'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
      {hint && active && (
        <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-primary-500 text-white text-[10px] font-bold whitespace-nowrap shadow-sm z-30">
          {hint}
        </span>
      )}
    </button>
  );
}

function Divider() {
  return <span className="my-0.5 h-px w-5 bg-border-dark/60" />;
}

// ── Icons (lightweight inline SVG, ~14-16px stroke) ──────────────────
const S = ({ children }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const CrosshairI = () => <S><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" /><circle cx="12" cy="12" r="3" /></S>;
const TrendI = () => <S><circle cx="5" cy="19" r="1.5" /><circle cx="19" cy="5" r="1.5" /><line x1="6" y1="18" x2="18" y2="6" /></S>;
const HLineI = () => <S><line x1="3" y1="12" x2="21" y2="12" /><circle cx="5" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></S>;
const PitchforkI = () => <S><circle cx="4" cy="6" r="1.5" /><circle cx="20" cy="6" r="1.5" /><circle cx="12" cy="18" r="1.5" /><path d="M4 6L12 18L20 6" /><line x1="4" y1="6" x2="20" y2="6" strokeDasharray="2 2" /></S>;
const FibI = () => <S><line x1="3" y1="5" x2="21" y2="5" /><line x1="3" y1="9" x2="21" y2="9" strokeDasharray="2 2" /><line x1="3" y1="13" x2="21" y2="13" /><line x1="3" y1="17" x2="21" y2="17" strokeDasharray="2 2" /><circle cx="5" cy="5" r="1.2" /><circle cx="19" cy="17" r="1.2" /></S>;
const BrushI = () => <S><path d="M9 11l-6 6a2 2 0 0 0 2.83 2.83l6-6" /><path d="M14 6l4 4" /><path d="M16 4l4 4-9 9-4-4z" /></S>;
const TextI = () => <S><path d="M4 7V5h16v2" /><line x1="12" y1="5" x2="12" y2="20" /><line x1="8" y1="20" x2="16" y2="20" /></S>;
const RulerI = () => <S><path d="M21 6l-7-3-11 11 3 7z" /><path d="M14 3l-2 2" /><path d="M17 6l-2 2" /><path d="M8 9l-2 2" /><path d="M11 12l-2 2" /></S>;
const ZoomI = () => <S><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></S>;
const ZoomResetI = () => <S><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></S>;
const MagnetI = () => <S><path d="M6 4h4v8a2 2 0 1 0 4 0V4h4v8a6 6 0 1 1-12 0z" /><line x1="6" y1="8" x2="10" y2="8" /><line x1="14" y1="8" x2="18" y2="8" /></S>;
const LockedI = () => <S><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></S>;
const UnlockedI = () => <S><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.46-2" /></S>;
const EyeI = () => <S><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></S>;
const EyeOffI = () => <S><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a17.61 17.61 0 0 1 3.94-5" /><path d="M9.9 4.24A10 10 0 0 1 12 4c7 0 10 7 10 7a17.6 17.6 0 0 1-2.13 3.36" /><line x1="1" y1="1" x2="23" y2="23" /></S>;
const TrashI = () => <S><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></S>;
