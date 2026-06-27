import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';

/**
 * useRecommendedMarkets — the admin-curated "Recommended" symbol list, in order.
 *
 * Powers the top ticker strip and the "Recommended" tab of the market selector.
 * Shared module-level cache (like useInstruments) so the strip + the modal hit
 * the API once. Near-real-time: refetches on window focus and on a light 60s
 * poll, so an admin add / remove / reorder propagates without a manual reload.
 *
 * Returns { symbols: string[] (ordered), loading }.
 */

let _cache = null;     // ordered array of symbols
let _inflight = null;
let _ts = 0;
const TTL = 60000;
const _listeners = new Set();

const notify = () => _listeners.forEach((fn) => fn(_cache));

function fetchNow() {
  _inflight = api.get('/instruments/recommended')
    .then((res) => {
      const arr = (res.data?.data || [])
        .map((r) => (typeof r === 'string' ? r : r && r.symbol))
        .filter(Boolean);
      _cache = arr;
      _ts = Date.now();
      _inflight = null;
      notify();
      return arr;
    })
    .catch((err) => { _inflight = null; throw err; });
  return _inflight;
}

export function useRecommendedMarkets() {
  const [symbols, setSymbols] = useState(_cache || []);
  const [loading, setLoading] = useState(!_cache);

  useEffect(() => {
    let cancelled = false;
    const onCache = (next) => { if (!cancelled) setSymbols(next || []); };
    _listeners.add(onCache);

    const fresh = _cache && Date.now() - _ts < TTL;
    if (fresh) {
      setSymbols(_cache);
      setLoading(false);
    } else {
      (_inflight || fetchNow())
        .then((arr) => { if (!cancelled) { setSymbols(arr); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    }

    // Real-time: the admin add/remove/reorder publishes `recommended:refresh`.
    // Focus + a light poll are the safety net (missed socket / reconnect).
    const onFocus = () => fetchNow().catch(() => {});
    window.addEventListener('focus', onFocus);
    const id = setInterval(() => fetchNow().catch(() => {}), TTL);
    let unsub;
    try { unsub = wsClient.subscribe('recommended:refresh', () => fetchNow().catch(() => {})); } catch (_) { /* */ }

    return () => {
      cancelled = true;
      _listeners.delete(onCache);
      window.removeEventListener('focus', onFocus);
      clearInterval(id);
      if (unsub) unsub();
    };
  }, []);

  return { symbols, loading };
}
