import { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';

/**
 * App-wide confirmation dialog built on the platform's Modal — a drop-in,
 * promise-based replacement for window.confirm():
 *
 *   const confirm = useConfirm();
 *   if (await confirm('Close all positions?')) { ...same code as before... }
 *
 * Resolves true on Confirm, false on Cancel / backdrop / ESC — exactly like
 * the native popup (OK = true, Cancel = false). Pass a string to keep the
 * existing message verbatim, or an options object for a custom title/labels.
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

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => settle(false)}
        title={state?.title}
        maxW="max-w-sm"
        footer={state && (
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => settle(false)}
              className="px-4 py-2 rounded-xl border border-border-dark text-text-primary text-sm font-semibold hover:bg-bg-hover transition-colors">
              {state.cancelText}
            </button>
            <button type="button" onClick={() => settle(true)}
              className={`px-4 py-2 rounded-xl text-white text-sm font-bold transition-colors ${state.danger ? 'bg-bear hover:opacity-90' : 'bg-primary-500 hover:bg-primary-600'}`}>
              {state.confirmText}
            </button>
          </div>
        )}
      >
        <p className="text-sm text-text-secondary whitespace-pre-line">{state?.message}</p>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
