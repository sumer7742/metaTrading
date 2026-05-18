import { useEffect, useState } from 'react';

const KEY = 'tradepro:recently-viewed';
const MAX_ITEMS = 5;
const listeners = new Set();

function read() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch (_) { /* private mode */ }
  listeners.forEach((fn) => fn(items));
}

/**
 * Record a symbol as recently viewed. Promotes existing entries to the
 * front and caps the list at MAX_ITEMS. Safe to call on every render.
 */
export function recordRecentlyViewed(symbol) {
  if (!symbol) return;
  const current = read();
  if (current[0] === symbol) return; // already at the front
  const next = [symbol, ...current.filter((s) => s !== symbol)].slice(0, MAX_ITEMS);
  write(next);
}

/** Subscribe to the recently-viewed list. Updates when other tabs change it. */
export function useRecentlyViewed() {
  const [items, setItems] = useState(() => read());
  useEffect(() => {
    const fn = (next) => setItems(next);
    listeners.add(fn);
    // Cross-tab sync via the storage event.
    const onStorage = (e) => { if (e.key === KEY) setItems(read()); };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return items;
}
