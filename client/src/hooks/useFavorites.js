import { useCallback, useEffect, useState } from 'react';

// Shared localStorage key with MarketWatch — toggling a star anywhere on
// the platform updates every other consumer in real time via the
// browser's `storage` event.
const FAVS_KEY = 'tradepro:favorites';

const read = () => {
  if (typeof window === 'undefined') return new Set();
  try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')); }
  catch (_) { return new Set(); }
};

const write = (set) => {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify([...set])); } catch (_) {}
};

/**
 * Reactive favorites set. Returns the live Set plus helpers, and
 * subscribes to cross-tab `storage` events + in-tab updates so every
 * star toggle anywhere in the app is reflected instantly.
 */
export function useFavorites() {
  const [favs, setFavs] = useState(() => read());

  useEffect(() => {
    const onStorage = (e) => { if (e.key === FAVS_KEY) setFavs(read()); };
    const onLocal = () => setFavs(read());
    window.addEventListener('storage', onStorage);
    window.addEventListener('tradepro:favs-changed', onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('tradepro:favs-changed', onLocal);
    };
  }, []);

  const toggle = useCallback((symbol) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      write(next);
      try { window.dispatchEvent(new Event('tradepro:favs-changed')); } catch (_) {}
      return next;
    });
  }, []);

  const add = useCallback((symbol) => {
    setFavs((prev) => {
      if (prev.has(symbol)) return prev;
      const next = new Set(prev); next.add(symbol); write(next);
      try { window.dispatchEvent(new Event('tradepro:favs-changed')); } catch (_) {}
      return next;
    });
  }, []);

  const remove = useCallback((symbol) => {
    setFavs((prev) => {
      if (!prev.has(symbol)) return prev;
      const next = new Set(prev); next.delete(symbol); write(next);
      try { window.dispatchEvent(new Event('tradepro:favs-changed')); } catch (_) {}
      return next;
    });
  }, []);

  const has = useCallback((symbol) => favs.has(symbol), [favs]);

  return { favs, toggle, add, remove, has, count: favs.size };
}
