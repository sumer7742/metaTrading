import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Professional, enterprise-grade vertical drag-and-drop list — the feel of
 * TradingView / Notion / Linear / Trello:
 *
 *  • On grab, the item is lifted into a floating clone that follows the cursor
 *    (95% opacity, 1.02 scale, soft shadow, high z-index) and its slot in the
 *    list becomes a live dashed placeholder of the exact same size.
 *  • Reordering happens LIVE while dragging — neighbours slide up/down (FLIP,
 *    ~240ms) to open a gap before the pointer is released. No duplicates, no
 *    layout jumps, no flicker.
 *  • On drop the clone animates into the placeholder slot, then the order is
 *    saved. Escape (or pointer-cancel) returns it home with the same animation.
 *  • Auto-scrolls the nearest scroll container when dragging near an edge.
 *  • Full keyboard support: focus a handle, Space/Enter to lift, ↑/↓ to move,
 *    Space/Enter to drop, Escape to cancel — announced via an aria-live region.
 *
 * Coordinate note: hit-testing uses getBoundingClientRect (viewport space, so
 * it tracks auto-scroll), while the FLIP animation uses offsetTop (content
 * space, so a scroll mid-drag never injects a bogus delta).
 *
 * Props:
 *   items       — array of item objects (stable identity via getId)
 *   getId       — (item) => string   stable id per item
 *   onReorder   — (orderedIds[]) => void   called once, only when order changed
 *   renderItem  — (item, { dragHandleProps, isKbActive, isOverlay }) => node
 *   disabled    — when true, reordering is inert (rows still render)
 *   className   — applied to the flow container
 *   gap         — px gap between rows (default 8, matches Tailwind gap-2)
 */

const FLIP_MS = 240;   // neighbour reflow
const DROP_MS = 220;   // clone → slot settle
const EDGE = 64;       // auto-scroll activation band (px from edge)
const MAX_SCROLL = 16; // auto-scroll max px/frame
const THRESHOLD = 5;   // px the pointer must travel before a press becomes a drag
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Nearest scrollable ancestor on the drag axis (inclusive of `node` — for a
// horizontal rail the list element itself is usually the scroller), or null →
// scroll the window.
function getScrollParent(node, horizontal) {
  let el = node;
  while (el) {
    const s = getComputedStyle(el);
    const ov = horizontal ? s.overflowX : s.overflowY;
    const scrollSize = horizontal ? el.scrollWidth : el.scrollHeight;
    const clientSize = horizontal ? el.clientWidth : el.clientHeight;
    if (/(auto|scroll|overlay)/.test(ov) && scrollSize > clientSize + 1) return el;
    el = el.parentElement;
  }
  return null;
}

export default function DraggableList({
  items,
  getId = (it) => it.id,
  onReorder,
  renderItem,
  disabled = false,
  className = '',
  gap = 8,
  axis = 'vertical',            // 'vertical' | 'horizontal'
}) {
  const horizontal = axis === 'horizontal';
  const [order, setOrder] = useState(() => items.map(getId));
  const [dragId, setDragId] = useState(null);   // pointer-drag active id
  const [kbId, setKbId] = useState(null);        // keyboard-drag active id
  const [dragSize, setDragSize] = useState(null);// { width, height }
  const [announce, setAnnounce] = useState('');

  // ── Live refs (so all window handlers can stay stable / identity-safe) ──
  const itemsRef = useRef(items); itemsRef.current = items;
  const getIdRef = useRef(getId); getIdRef.current = getId;
  const onReorderRef = useRef(onReorder); onReorderRef.current = onReorder;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;

  const byId = new Map(items.map((it) => [getId(it), it]));

  const orderRef = useRef(order); orderRef.current = order;
  const dragIdRef = useRef(null);
  const kbIdRef = useRef(null);
  const kbOriginalRef = useRef([]);
  const activeRef = useRef(false);               // pointer drag in progress
  const droppingRef = useRef(false);             // drop animation in flight
  const pointerIdRef = useRef(null);
  const pendingRef = useRef(null);               // armed-but-not-yet-moved press
  const activateRef = useRef(null);              // latest activatePointerDrag
  const armMoveFnRef = useRef(null);
  const armEndFnRef = useRef(null);
  const othersRef = useRef([]);                  // non-dragged ids (stable during a drag)
  const originalOrderRef = useRef([]);
  const pointerRef = useRef({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });      // pointer → card top-left
  const cardLeftRef = useRef(0);
  const originalTopRef = useRef(0);
  const rafRef = useRef(0);
  const lastInsertRef = useRef(-1);
  const overlayRef = useRef(null);
  const nodeRefs = useRef(new Map());            // id → flow wrapper element
  const prevOffset = useRef(new Map());          // id → offsetTop (FLIP baseline)
  const scrollParentRef = useRef(null);
  const listRef = useRef(null);

  const say = (msg) => setAnnounce(msg);

  // Keep internal order synced with the items prop while idle (add / remove /
  // external reorder). Never fights an in-progress drag.
  useEffect(() => {
    if (dragId || kbId) return;
    const next = items.map(getId);
    setOrder((cur) => (sameOrder(cur, next) ? cur : next));
  }, [items, dragId, kbId, getId]);

  // ── FLIP: slide neighbours to their new slots on every order change during
  //    a drag. offsetTop keeps it scroll-stable. The pointer-dragged id is a
  //    placeholder → excluded (its gap should jump, not glide).
  useLayoutEffect(() => {
    if (!dragId && !kbId) {
      // Idle: clear any residual FLIP transforms so rows rest cleanly.
      for (const [, el] of nodeRefs.current) if (el) { el.style.transform = ''; el.style.transition = ''; }
      prevOffset.current = new Map();
      return;
    }
    const nextOffset = new Map();
    for (const [id, el] of nodeRefs.current) if (el) nextOffset.set(id, horizontal ? el.offsetLeft : el.offsetTop);
    for (const [id, el] of nodeRefs.current) {
      if (!el || id === dragId) continue;
      const prev = prevOffset.current.get(id);
      const now = nextOffset.get(id);
      if (prev != null && now != null && prev !== now) {
        const d = prev - now;
        el.style.transition = 'none';
        el.style.transform = horizontal ? `translate3d(${d}px, 0, 0)` : `translate3d(0, ${d}px, 0)`;
        requestAnimationFrame(() => {
          el.style.transition = `transform ${FLIP_MS}ms ${EASE}`;
          el.style.transform = '';
        });
      }
    }
    prevOffset.current = nextOffset;
  }, [order, dragId, kbId]);

  // ── Auto-scroll (called each frame) ─────────────────────────────────
  const autoScroll = (x, y) => {
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const sc = scrollParentRef.current;
    const p = horizontal ? x : y;
    if (sc) {
      const r = sc.getBoundingClientRect();
      const lo = horizontal ? r.left : r.top;
      const hi = horizontal ? r.right : r.bottom;
      if (p < lo + EDGE) { const d = Math.ceil(MAX_SCROLL * clamp((lo + EDGE - p) / EDGE)); if (horizontal) sc.scrollLeft -= d; else sc.scrollTop -= d; }
      else if (p > hi - EDGE) { const d = Math.ceil(MAX_SCROLL * clamp((p - (hi - EDGE)) / EDGE)); if (horizontal) sc.scrollLeft += d; else sc.scrollTop += d; }
    } else {
      const hi = horizontal ? window.innerWidth : window.innerHeight;
      if (p < EDGE) { const d = Math.ceil(MAX_SCROLL * clamp((EDGE - p) / EDGE)); window.scrollBy(horizontal ? -d : 0, horizontal ? 0 : -d); }
      else if (p > hi - EDGE) { const d = Math.ceil(MAX_SCROLL * clamp((p - (hi - EDGE)) / EDGE)); window.scrollBy(horizontal ? d : 0, horizontal ? 0 : d); }
    }
  };

  // Where would the dragged item land, given the pointer? Index among the
  // stable `others` sequence (0..others.length). Uses the drag-axis midpoint.
  const computeInsert = (x, y) => {
    const others = othersRef.current;
    const p = horizontal ? x : y;
    for (let i = 0; i < others.length; i++) {
      const el = nodeRefs.current.get(others[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      if (p < mid) return i;
    }
    return others.length;
  };

  const frame = useCallback(() => {
    if (!activeRef.current) return;
    const { x, y } = pointerRef.current;
    const ov = overlayRef.current;
    if (ov) {
      ov.style.transform = horizontal
        ? `translate3d(${x - offsetRef.current.x}px, 0, 0) scale(1.02)`
        : `translate3d(0, ${y - offsetRef.current.y}px, 0) scale(1.02)`;
    }
    autoScroll(x, y);
    const insertAt = computeInsert(x, y);
    if (insertAt !== lastInsertRef.current) {
      lastInsertRef.current = insertAt;
      const next = othersRef.current.slice();
      next.splice(insertAt, 0, dragIdRef.current);
      if (!sameOrder(next, orderRef.current)) { orderRef.current = next; setOrder(next); }
    }
    rafRef.current = requestAnimationFrame(frame);
  }, []);

  const onPointerMove = useCallback((e) => {
    pointerRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const endDrag = useCallback((cancel) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    droppingRef.current = true;                   // block a new grab mid-drop
    cancelAnimationFrame(rafRef.current);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onDragKeyDown, true);
    try { listRef.current?.releasePointerCapture?.(pointerIdRef.current); } catch (_) { /* released */ }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    const id = dragIdRef.current;
    // On cancel, snap the list order back home first (neighbours FLIP back).
    if (cancel && !sameOrder(orderRef.current, originalOrderRef.current)) {
      orderRef.current = originalOrderRef.current;
      setOrder(originalOrderRef.current);
    }
    const finalOrder = orderRef.current.slice();

    const commit = () => {
      setDragId(null);
      setDragSize(null);
      dragIdRef.current = null;
      droppingRef.current = false;
      if (!cancel && !sameOrder(finalOrder, itemsRef.current.map(getIdRef.current))) {
        say('Dropped.');
        onReorderRef.current?.(finalOrder);
      } else {
        say(cancel ? 'Reorder cancelled.' : '');
      }
    };

    // Animate the floating clone into the resting slot, then commit.
    const ov = overlayRef.current;
    requestAnimationFrame(() => {
      const targetEl = nodeRefs.current.get(id);
      if (ov && targetEl) {
        const r = targetEl.getBoundingClientRect();
        ov.style.transition = `transform ${DROP_MS}ms ${EASE}, box-shadow ${DROP_MS}ms ease, opacity ${DROP_MS}ms ease`;
        ov.style.transform = horizontal
          ? `translate3d(${r.left}px, 0, 0) scale(1)`
          : `translate3d(0, ${r.top}px, 0) scale(1)`;
        ov.style.opacity = '1';
        ov.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
        let done = false;
        const fin = () => { if (done) return; done = true; ov.removeEventListener('transitionend', fin); commit(); };
        ov.addEventListener('transitionend', fin);
        setTimeout(fin, DROP_MS + 80);
      } else {
        commit();
      }
    });
  }, [frame, onPointerMove]);

  const onPointerUp = useCallback(() => endDrag(false), [endDrag]);
  const onPointerCancel = useCallback(() => endDrag(true), [endDrag]);
  const onDragKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { e.preventDefault(); endDrag(true); }
  }, [endDrag]);

  // Actually lift the item — called once the press has crossed THRESHOLD.
  // `p` is the pending press; `e` the pointer event that crossed the threshold.
  const activatePointerDrag = (p, e) => {
    const id = p.id;
    const rowEl = nodeRefs.current.get(id);
    if (!rowEl) return;
    const rect = rowEl.getBoundingClientRect();
    // Capture on the stable list element (not the grabbed row, which unmounts
    // into a placeholder) so touch keeps streaming pointer events.
    try { pointerIdRef.current = p.pointerId; listRef.current?.setPointerCapture?.(p.pointerId); } catch (_) { /* capture optional */ }

    dragIdRef.current = id;
    activeRef.current = true;
    // Offset from the ORIGINAL press point so the card lifts from where it was
    // grabbed (no threshold-sized jump).
    offsetRef.current = { x: p.startX - rect.left, y: p.startY - rect.top };
    cardLeftRef.current = rect.left;
    originalTopRef.current = rect.top;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    originalOrderRef.current = orderRef.current.slice();
    othersRef.current = orderRef.current.filter((x) => x !== id);
    lastInsertRef.current = -1;
    scrollParentRef.current = getScrollParent(listRef.current, horizontal);

    setDragSize({ width: rect.width, height: rect.height });
    setDragId(id);
    say('Lifted. Move to reorder, release to drop, Escape to cancel.');

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onDragKeyDown, true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    rafRef.current = requestAnimationFrame(frame);
  };
  activateRef.current = activatePointerDrag;

  // ── Press → drag arming (whole-row grab with a movement threshold) ──
  // A press anywhere on a row *arms* a drag; it only lifts once the pointer
  // travels THRESHOLD px, so plain clicks (and clicks on the Trade button /
  // row menu) still behave normally. On touch, only the grip arms (the row
  // body keeps native scroll) — see touchAction on the grip.
  const disarm = () => {
    pendingRef.current = null;
    window.removeEventListener('pointermove', armMoveFnRef.current);
    window.removeEventListener('pointerup', armEndFnRef.current);
    window.removeEventListener('pointercancel', armEndFnRef.current);
  };
  const stableArmMove = useCallback((e) => {
    const p = pendingRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < THRESHOLD) return;
    disarm();
    activateRef.current?.(p, e);
  }, []);
  const stableArmEnd = useCallback(() => { disarm(); }, []);
  armMoveFnRef.current = stableArmMove;
  armEndFnRef.current = stableArmEnd;

  const armPointerDrag = useCallback((e, id) => {
    if (disabledRef.current || kbIdRef.current || droppingRef.current || activeRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Let real controls (Trade link, row menu, inputs) handle their own clicks.
    const t = e.target;
    if (t && t.closest && t.closest('a, button, input, select, textarea, [role="menuitem"], [data-no-drag]')) return;
    if (!nodeRefs.current.get(id)) return;
    pendingRef.current = { id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };
    window.addEventListener('pointermove', stableArmMove);
    window.addEventListener('pointerup', stableArmEnd);
    window.addEventListener('pointercancel', stableArmEnd);
  }, [stableArmMove, stableArmEnd]);

  // ── Keyboard reorder (accessibility) ────────────────────────────────
  const commitKb = useCallback(() => {
    const active = kbIdRef.current;
    if (!active) return;
    const finalOrder = orderRef.current.slice();
    kbIdRef.current = null;
    setKbId(null);
    if (!sameOrder(finalOrder, itemsRef.current.map(getIdRef.current))) {
      say('Dropped.');
      onReorderRef.current?.(finalOrder);
    }
  }, []);

  const cancelKb = useCallback(() => {
    if (!kbIdRef.current) return;
    kbIdRef.current = null;
    setKbId(null);
    const orig = kbOriginalRef.current;
    if (!sameOrder(orderRef.current, orig)) { orderRef.current = orig; setOrder(orig); }
    say('Reorder cancelled.');
  }, []);

  const onHandleKeyDown = useCallback((e, id) => {
    if (disabledRef.current || activeRef.current || droppingRef.current) return;
    const active = kbIdRef.current;
    if (!active) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        kbIdRef.current = id;
        kbOriginalRef.current = orderRef.current.slice();
        setKbId(id);
        const pos = orderRef.current.indexOf(id) + 1;
        say(`Lifted, position ${pos} of ${orderRef.current.length}. Use arrow keys to move, space to drop, escape to cancel.`);
      }
      return;
    }
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (e.key === prevKey || e.key === nextKey) {
      e.preventDefault();
      const cur = orderRef.current.slice();
      const from = cur.indexOf(active);
      const to = e.key === prevKey ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= cur.length) return;
      const [x] = cur.splice(from, 1);
      cur.splice(to, 0, x);
      orderRef.current = cur;
      setOrder(cur);
      say(`Position ${to + 1} of ${cur.length}.`);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      commitKb();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelKb();
    }
  }, [commitKb, cancelKb]);

  // Cleanup on unmount — never leak listeners / a running rAF / body styles.
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onDragKeyDown, true);
    window.removeEventListener('pointermove', armMoveFnRef.current);
    window.removeEventListener('pointerup', armEndFnRef.current);
    window.removeEventListener('pointercancel', armEndFnRef.current);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, [onPointerMove, onPointerUp, onPointerCancel, onDragKeyDown]);

  // Grab the WHOLE row (with a movement threshold) — like TradingView / Trello.
  const rowDragProps = (id) => (disabled ? {} : { onPointerDown: (e) => armPointerDrag(e, id) });

  // Grip: dedicated keyboard handle + the reliable touch drag affordance
  // (touchAction:none lets a finger drag it without scrolling the page).
  const handleProps = (id) => ({
    onKeyDown: (e) => onHandleKeyDown(e, id),
    onBlur: () => { if (kbIdRef.current === id) commitKb(); },
    tabIndex: disabled ? -1 : 0,
    role: 'button',
    'aria-roledescription': 'Draggable. Press space or enter to lift.',
    'aria-label': 'Drag to reorder',
    style: { touchAction: 'none', cursor: disabled ? 'default' : 'grab' },
  });

  const draggedItem = dragId != null ? byId.get(dragId) : null;

  return (
    <>
      <div ref={listRef} className={className} style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: horizontal ? 'center' : undefined, gap }}>
        {order.map((id) => {
          const it = byId.get(id);
          if (!it) return null;
          const isDragged = id === dragId;
          return (
            <div
              key={id}
              ref={(el) => { if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id); }}
              style={{ willChange: isDragged ? 'auto' : 'transform', flexShrink: horizontal ? 0 : undefined }}
            >
              {isDragged ? (
                <div
                  aria-hidden="true"
                  style={{ height: dragSize?.height, width: horizontal ? dragSize?.width : '100%' }}
                  className="rounded-xl border-2 border-dashed border-primary-500/60 bg-primary-500/10"
                />
              ) : (
                renderItem(it, { dragHandleProps: handleProps(id), rowDragProps: rowDragProps(id), isKbActive: id === kbId, isOverlay: false })
              )}
            </div>
          );
        })}
      </div>

      {/* Floating clone — portaled to <body> so no ancestor transform/overflow
          can clip it. React context (Router, etc.) still flows through. */}
      {draggedItem && dragSize && createPortal(
        <div
          ref={overlayRef}
          style={{
            position: 'fixed',
            left: horizontal ? 0 : cardLeftRef.current,
            top: horizontal ? originalTopRef.current : 0,
            width: dragSize.width,
            transform: horizontal
              ? `translate3d(${cardLeftRef.current}px, 0, 0) scale(1.02)`
              : `translate3d(0, ${originalTopRef.current}px, 0) scale(1.02)`,
            zIndex: 9999,
            opacity: 0.95,
            pointerEvents: 'none',
            willChange: 'transform',
            borderRadius: 12,
            boxShadow: '0 14px 30px -6px rgba(15,23,42,0.30), 0 6px 12px -6px rgba(15,23,42,0.22)',
          }}
        >
          {renderItem(draggedItem, { dragHandleProps: {}, rowDragProps: {}, isKbActive: false, isOverlay: true })}
        </div>,
        document.body,
      )}

      {/* Screen-reader announcements */}
      <div aria-live="polite" role="status" style={{ position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>
        {announce}
      </div>
    </>
  );
}
