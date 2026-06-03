import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Z } from './modalLayers';

// Ref-counted body scroll lock so stacked modals (e.g. Rename opened from
// the manager) don't unlock the background until the LAST one closes.
let _lockCount = 0;
let _prevOverflow = '';
const lockScroll = () => {
  if (_lockCount === 0) { _prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
  _lockCount += 1;
};
const unlockScroll = () => {
  _lockCount = Math.max(0, _lockCount - 1);
  if (_lockCount === 0) document.body.style.overflow = _prevOverflow || '';
};

const FOCUSABLE = 'a[href],button:not([disabled]),textarea,input:not([type="hidden"]),select,[tabindex]:not([tabindex="-1"])';

/**
 * Hardened, portal-based modal / bottom-sheet shell used by every
 * watchlist overlay (and reusable app-wide).
 *
 * Guarantees:
 *  • Renders into document.body — immune to transformed / overflow-hidden
 *    / position-relative ancestors and nested layouts.
 *  • Standardized z-index (defaults to Z.modal = 1000).
 *  • Body scroll lock while open (ref-counted for stacked modals).
 *  • ESC + backdrop-tap close (set dismissible=false for destructive flows
 *    that must require an explicit choice).
 *  • Focus management: focuses the first input on open and restores focus
 *    to the triggering element on close. Tab / Shift+Tab are trapped.
 *  • Mobile safe-area inset so bottom sheets clear the home indicator.
 *  • Fade backdrop + slide-up panel, ~180ms, reversed on close.
 *  • role="dialog" + aria-modal for accessibility.
 *
 * Layout: optional `title` (string or node) renders a header with a close
 * button; `children` go in a scrollable padded body; optional `footer`
 * renders pinned below the scroll area (sticky action bar).
 */
export default function Modal({
  open = true,
  onClose,
  title,
  children,
  footer,
  maxW = 'max-w-md',
  dismissible = true,
  zIndex = Z.modal,
  initialFocus,
  bodyClassName = 'p-5',
}) {
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false); // drives enter/exit transition

  // Keep the node mounted through the exit transition.
  useEffect(() => {
    if (open) { setRender(true); return undefined; }
    if (render) { setShown(false); const t = setTimeout(() => setRender(false), 190); return () => clearTimeout(t); }
    return undefined;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Side-effects that run while the modal is in the DOM.
  useEffect(() => {
    if (!render) return undefined;
    const raf = requestAnimationFrame(() => setShown(true));
    triggerRef.current = document.activeElement;
    lockScroll();

    const focusTimer = setTimeout(() => {
      const el =
        (initialFocus && initialFocus.current) ||
        panelRef.current?.querySelector('input:not([type="hidden"]),textarea,select') ||
        panelRef.current?.querySelector(FOCUSABLE);
      if (el && typeof el.focus === 'function') el.focus();
    }, 40);

    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault(); e.stopPropagation(); onClose && onClose();
        return;
      }
      if (e.key === 'Tab') {
        const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
        if (!nodes || !nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);

    // Dev diagnostics (spec §8): confirm the portal actually mounted.
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) {
      setTimeout(() => {
        if (!panelRef.current || !document.body.contains(panelRef.current)) {
          // eslint-disable-next-line no-console
          console.warn('[Modal] panel is not mounted under document.body — portal failed.');
        }
        if (typeof onClose !== 'function') {
          // eslint-disable-next-line no-console
          console.warn('[Modal] no onClose handler provided — ESC / backdrop close will not work.');
        }
      }, 60);
    }

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey, true);
      unlockScroll();
      const tr = triggerRef.current;
      if (tr && typeof tr.focus === 'function') setTimeout(() => { try { tr.focus(); } catch (_) {} }, 0);
    };
  }, [render]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!render) return null;

  return createPortal((
    <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex }} role="dialog" aria-modal="true">
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className={`relative w-full ${maxW} bg-white border border-border-dark rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] flex flex-col transition-all duration-200 ease-out ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {title != null && (
          <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-2 shrink-0">
            {typeof title === 'string' ? <h3 className="text-base font-bold text-text-primary truncate">{title}</h3> : <div className="min-w-0 flex-1">{title}</div>}
            <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        )}
        <div className={`overflow-y-auto ${bodyClassName} flex-1`}>{children}</div>
        {footer && <div className="p-4 border-t border-border-subtle shrink-0">{footer}</div>}
      </div>
    </div>
  ), document.body);
}
