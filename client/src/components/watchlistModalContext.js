import { createContext, useContext } from 'react';

// Context for the app-wide "Add to Watchlist" modal. Kept in its own
// (non-component) module — same reasoning as modalLayers.js — so the
// provider file stays Fast-Refresh-eligible (a module exporting a React
// component shouldn't also export non-component values, or Vite HMR bails).
//
// `open(symbol, row?)` opens the single shared modal for that instrument.
export const WatchlistModalContext = createContext({ open: () => {} });

export function useWatchlistModal() {
  return useContext(WatchlistModalContext);
}
