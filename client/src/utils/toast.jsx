import toast from 'react-hot-toast';

/**
 * orderToast — a success toast with a manual dismiss (×) button so the user can
 * clear it BEFORE the auto-dismiss timer fires. react-hot-toast passes the live
 * toast object to a render-function message, so the × can call toast.dismiss(t.id).
 *
 * Used for order confirmations (placed / filled), where a trader may want to
 * read-and-clear immediately rather than wait out the timer.
 */
export function orderToast(message, opts = {}) {
  return toast.success(
    (t) => (
      <span className="flex items-center gap-2">
        <span>{message}</span>
        <button
          type="button"
          onClick={() => toast.dismiss(t.id)}
          aria-label="Dismiss"
          title="Dismiss"
          className="ml-1 -mr-1 shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-current opacity-60 hover:opacity-100 hover:bg-black/10 transition"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </span>
    ),
    { duration: 4000, ...opts },
  );
}
