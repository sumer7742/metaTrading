import { useEffect, useSyncExternalStore } from 'react';

/**
 * USD→INR rate, fetched lazily and cached at module scope so every component
 * that needs it shares the same value (and a single fetch per TTL window).
 *
 * - Free public source: frankfurter.app (no API key, CORS-friendly).
 * - 5-minute TTL — FX moves slowly, this is plenty fresh for display.
 * - Hard-coded fallback (env VITE_USDINR_RATE or 83) so the UI keeps working
 *   even if the FX API is down or blocked.
 *
 * The hook returns the live rate as a plain number. Components can multiply
 * a USD-quoted price by it to render the INR equivalent.
 */

const FALLBACK = Number(import.meta.env.VITE_USDINR_RATE) || 83;
const TTL_MS = 5 * 60 * 1000;

let currentRate = FALLBACK;
let lastFetchAt = 0;
let inflight = null;
const listeners = new Set();

const notify = () => {
  for (const l of listeners) l();
};

const refresh = async (force = false) => {
  const now = Date.now();
  if (!force && now - lastFetchAt < TTL_MS) return currentRate;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // 7s ceiling so a hung FX endpoint never blocks the UI; we'll just
      // keep using the previous value (or fallback) until the next try.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      const rate = Number(json?.rates?.INR);
      if (Number.isFinite(rate) && rate > 0) {
        currentRate = rate;
        lastFetchAt = now;
        notify();
      }
    } catch (e) {
      // Stay on the previous rate; log only the first failure to avoid spam.
      if (!lastFetchAt) console.warn('[useFxRate] FX fetch failed, using fallback:', e.message);
      lastFetchAt = now; // back off so we don't retry on every render
    } finally {
      inflight = null;
    }
    return currentRate;
  })();
  return inflight;
};

const subscribe = (cb) => {
  listeners.add(cb);
  // Kick off a refresh on first subscribe; further subscribers just wait.
  refresh();
  return () => listeners.delete(cb);
};

const getSnapshot = () => currentRate;
const getServerSnapshot = () => FALLBACK;

/** React hook — re-renders when the cached rate updates. */
export function useFxRate() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Imperative read for places where a hook can't be used (chart formatters,
 * etc). Returns whatever's currently cached — won't trigger a fetch on its
 * own; pair with `useFxRate()` mounted somewhere to keep it warm.
 */
export const getFxRate = () => currentRate;

/** Force a refresh — useful after the user explicitly toggles a setting. */
export const refreshFxRate = () => refresh(true);
