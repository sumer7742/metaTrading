import { useCallback, useMemo, useState } from 'react';
import { WatchlistModalContext } from './watchlistModalContext';
import AddToWatchlistModal from './AddToWatchlistModal';

/**
 * Mounts a SINGLE shared "Add to Watchlist" modal for the whole app and
 * exposes open() via context, so any instrument card on any page can trigger
 * it without each one carrying its own modal state. The modal itself renders
 * through a React Portal (see Modal.jsx), and is only mounted while a target
 * is set — so logged-out routes never touch the watchlist store.
 */
export default function WatchlistModalProvider({ children }) {
  const [target, setTarget] = useState(null); // { symbol, row } | null

  const open = useCallback((symbol, row = null) => {
    if (!symbol) return;
    setTarget({ symbol: String(symbol).toUpperCase(), row });
  }, []);
  const close = useCallback(() => setTarget(null), []);

  // Stable value — consumers only re-render if `open` changes (it won't).
  const value = useMemo(() => ({ open }), [open]);

  return (
    <WatchlistModalContext.Provider value={value}>
      {children}
      {target && (
        <AddToWatchlistModal
          symbol={target.symbol}
          instrumentRow={target.row}
          onClose={close}
        />
      )}
    </WatchlistModalContext.Provider>
  );
}
