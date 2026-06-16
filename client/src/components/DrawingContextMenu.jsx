import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Right-click context menu for a selected drawing object — TradingView-style.
 * Portaled to <body> with fixed positioning (so it can't be clipped by the
 * chart container or any transformed/blurred ancestor); `x`/`y` are viewport
 * pixels, clamped to stay on-screen. A full-screen backdrop catches outside
 * clicks.
 */
export default function DrawingContextMenu({ controls, theme }) {
  const { contextMenu, closeContextMenu } = controls;

  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu, closeContextMenu]);

  if (!contextMenu) return null;
  const d = controls.drawings.find((x) => x.id === contextMenu.id);
  if (!d) return null;
  const dark = theme === 'dark';
  const id = contextMenu.id;

  // Clamp so the menu (≈190×330) stays inside the viewport.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const x = Math.min(Math.max(4, contextMenu.x), vw - 200);
  const y = Math.min(Math.max(4, contextMenu.y), vh - 336);

  const Item = ({ onClick, children, danger, kbd }) => (
    <button
      type="button"
      onClick={() => { onClick(); }}
      className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 text-[12px] text-left transition-colors ${
        dark ? 'hover:bg-white/10' : 'hover:bg-bg-hover'
      } ${danger ? 'text-bear' : dark ? 'text-slate-100' : 'text-text-primary'}`}
    >
      <span className="flex items-center gap-2">{children}</span>
      {kbd && <span className={`text-[10px] ${dark ? 'text-slate-400' : 'text-text-muted'}`}>{kbd}</span>}
    </button>
  );
  const Sep = () => <div className={`my-1 h-px ${dark ? 'bg-white/10' : 'bg-border-subtle'}`} />;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
      <div
        className={`fixed z-[61] min-w-[188px] py-1 rounded-lg border shadow-elevated text-[12px] ${
          dark ? 'bg-slate-900 border-slate-700' : 'bg-white border-border-dark'
        }`}
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        <Item onClick={() => controls.openSettings(id, x, y)}>⚙️ Settings…</Item>
        <Item onClick={() => controls.duplicateDrawing(id)} kbd="Ctrl+D">⧉ Duplicate</Item>
        <Item onClick={() => controls.toggleLockDrawing(id)}>{d.locked ? '🔓 Unlock' : '🔒 Lock'}</Item>
        <Sep />
        <Item onClick={() => controls.bringToFront(id)} kbd="]">⤒ Bring to front</Item>
        <Item onClick={() => controls.bringForward(id)}>↑ Bring forward</Item>
        <Item onClick={() => controls.sendBackward(id)}>↓ Send backward</Item>
        <Item onClick={() => controls.sendToBack(id)} kbd="[">⤓ Send to back</Item>
        <Sep />
        <Item onClick={() => controls.removeDrawing(id)} danger kbd="Del">🗑 Delete</Item>
      </div>
    </>,
    document.body,
  );
}
