import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * App-wide confirmation dialog for the admin console — a drop-in, promise-based
 * replacement for window.confirm(), styled to match the admin modals:
 *
 *   const confirm = useConfirm();
 *   if (await confirm('Delete this plan?')) { ...same code as before... }
 *
 * Resolves true on Confirm, false on Cancel / backdrop / ESC — exactly like the
 * native popup (OK = true, Cancel = false). Accepts a string (verbatim message)
 * or an options object { message, title, confirmText, cancelText, danger }.
 */
const ConfirmCtx = createContext(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmCtx);

export default function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((opts) => {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setState({
        message: o.message || 'Are you sure?',
        title: o.title || 'Please confirm',
        confirmText: o.confirmText || 'Confirm',
        cancelText: o.cancelText || 'Cancel',
        danger: !!o.danger,
      });
    });
  }, []);

  const settle = (val) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    if (r) r(val);
  };

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') settle(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4" onClick={() => settle(false)}>
          <div className="bg-bg-card rounded-2xl border border-border-dark max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-border-dark bg-bg-panel/60">
              <h3 className="text-base font-bold text-text-primary">{state.title}</h3>
            </div>
            <div className="p-5">
              <p className="text-sm text-text-secondary whitespace-pre-line">{state.message}</p>
            </div>
            <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2 bg-bg-panel/60">
              <button type="button" onClick={() => settle(false)} className="btn-secondary !py-1.5 !text-xs">
                {state.cancelText}
              </button>
              <button type="button" autoFocus onClick={() => settle(true)} className={`${state.danger ? 'btn-bear' : 'btn-primary'} !py-1.5 !text-xs`}>
                {state.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
