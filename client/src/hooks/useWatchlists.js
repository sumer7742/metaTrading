import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

// ─── Module-level store ──────────────────────────────────────────────
// One shared cache + listener set (same pattern as useInstruments) so
// every consumer — Watchlist page, MarketWatch, Trade — sees the same
// server-backed watchlists and stays in sync without prop drilling.
//
// state = { watchlists: [...], activeId, lastSelectedWatchlistId, loaded, loading }
let _state = { watchlists: [], activeId: null, lastSelectedWatchlistId: null, loaded: false, loading: false };
let _inflight = null;
const _listeners = new Set();

const LEGACY_FAVS_KEY = 'tradepro:favorites';
const MIGRATION_KEY = 'tradepro_watchlist_migration_v1';

const set = (patch) => { _state = { ..._state, ...patch }; _listeners.forEach((fn) => fn(_state)); };
const snapshot = () => ({ ..._state, watchlists: _state.watchlists });

// Replace a single watchlist in the cache by id (used after item mutations
// where the server returns the full updated list).
const upsertList = (wl) => {
  if (!wl?._id) return;
  const idx = _state.watchlists.findIndex((w) => w._id === wl._id);
  const next = [..._state.watchlists];
  if (idx === -1) next.push(wl); else next[idx] = wl;
  set({ watchlists: next });
};

const favoritesList = (s = _state) =>
  s.watchlists.find((w) => w.isDefault) || s.watchlists[0] || null;

// ─── Initial load + one-time legacy migration ────────────────────────
async function loadOnce() {
  if (_state.loaded) return _state;
  if (_inflight) return _inflight;
  set({ loading: true });
  _inflight = (async () => {
    const { data } = await api.get('/watchlists');
    let lists = data?.data?.watchlists || [];
    let lastSelected = data?.data?.lastSelectedWatchlistId || null;

    // Migration: if the server has no lists yet, create "Favorites" and
    // seed it from the browser's legacy localStorage favorites. Versioned
    // flag so future migrations are independently manageable.
    if (lists.length === 0 && !localStorage.getItem(MIGRATION_KEY)) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_FAVS_KEY) || '[]');
        const { data: created } = await api.post('/watchlists', { name: 'Favorites', emoji: '⭐', isDefault: true });
        let fav = created.data;
        if (Array.isArray(legacy) && legacy.length) {
          const { data: withItems } = await api.post(`/watchlists/${fav._id}/items/bulk`, { symbols: legacy });
          fav = withItems.data;
        }
        lists = [fav];
        lastSelected = fav._id;
      } catch (e) {
        // Non-fatal: leave lists empty; user can create manually.
        console.warn('[watchlist migration] failed', e);
      }
      localStorage.setItem(MIGRATION_KEY, '1');
    }

    const activeId = lastSelected && lists.some((w) => w._id === lastSelected)
      ? lastSelected
      : (favoritesList({ watchlists: lists })?._id || null);

    set({ watchlists: lists, lastSelectedWatchlistId: lastSelected, activeId, loaded: true, loading: false });
    _inflight = null;
    return _state;
  })().catch((err) => {
    _inflight = null;
    set({ loading: false });
    throw err;
  });
  return _inflight;
}

// Optimistic helper: apply an immediate cache change, fire the API, and on
// failure roll back to the pre-mutation snapshot + surface a toast.
async function optimistic(applyLocal, apiCall, { rollbackMsg } = {}) {
  const prev = snapshot();
  applyLocal();
  try {
    return await apiCall();
  } catch (err) {
    set(prev);
    toast.error(rollbackMsg || errorMessage(err));
    throw err;
  }
}

// ─── Mutations (exported via the hook) ───────────────────────────────

const setActiveId = (id) => {
  if (!id || id === _state.activeId) return;
  set({ activeId: id });
  // Persist "remember last watchlist" — best-effort, fire-and-forget.
  api.patch('/watchlists/last-selected', { watchlistId: id }).catch(() => {});
};

const createList = async ({ name, emoji = '', color = '' }) => {
  try {
    const { data } = await api.post('/watchlists', { name, emoji, color });
    upsertList(data.data);
    set({ activeId: data.data._id });
    api.patch('/watchlists/last-selected', { watchlistId: data.data._id }).catch(() => {});
    return data.data;
  } catch (err) {
    toast.error(errorMessage(err)); // e.g. duplicate name (409)
    throw err;
  }
};

const renameList = (id, { name, emoji, color }) =>
  optimistic(
    () => upsertList({
      ..._state.watchlists.find((w) => w._id === id),
      ...(name != null ? { name } : {}),
      ...(emoji != null ? { emoji } : {}),
      ...(color != null ? { color } : {}),
    }),
    async () => { const { data } = await api.patch(`/watchlists/${id}`, { name, emoji, color }); upsertList(data.data); return data.data; },
  );

// Import: create a new list then bulk-add its symbols in one validated
// write. Symbols should be pre-filtered by the caller against the known
// instrument catalogue so unknown tickers don't abort the whole import.
const importWatchlist = async ({ name, emoji = '', color = '', symbols = [] }) => {
  const list = await createList({ name, emoji, color });
  if (symbols.length) return bulkAddSymbols(list._id, symbols);
  return list;
};

const deleteList = async (id) => {
  const prev = snapshot();
  const remaining = _state.watchlists.filter((w) => w._id !== id);
  const nextActive = _state.activeId === id ? (remaining[0]?._id || null) : _state.activeId;
  set({ watchlists: remaining, activeId: nextActive });
  try {
    await api.delete(`/watchlists/${id}`);
  } catch (err) {
    set(prev);
    toast.error(errorMessage(err));
    throw err;
  }
};

const duplicateList = async (id) => {
  const { data } = await api.post(`/watchlists/${id}/duplicate`);
  upsertList(data.data);
  return data.data;
};

const reorderLists = (orderedIds) =>
  optimistic(
    () => {
      const byId = new Map(_state.watchlists.map((w) => [w._id, w]));
      set({ watchlists: orderedIds.map((id) => byId.get(id)).filter(Boolean) });
    },
    () => api.post('/watchlists/reorder', { orderedIds }),
    { rollbackMsg: 'Could not reorder watchlists' },
  );

const addSymbol = (listId, symbol) =>
  optimistic(
    () => {
      const wl = _state.watchlists.find((w) => w._id === listId);
      if (!wl || wl.items.some((it) => it.symbol === symbol)) return;
      upsertList({ ...wl, items: [...wl.items, { _id: `tmp-${symbol}`, symbol, sortOrder: wl.items.length, pinned: false }], itemCount: wl.items.length + 1 });
    },
    async () => { const { data } = await api.post(`/watchlists/${listId}/items`, { symbol }); upsertList(data.data); return data.data; },
  );

const bulkAddSymbols = async (listId, symbols) => {
  const { data } = await api.post(`/watchlists/${listId}/items/bulk`, { symbols });
  upsertList(data.data);
  return data.data;
};

const removeSymbol = (listId, itemId) =>
  optimistic(
    () => {
      const wl = _state.watchlists.find((w) => w._id === listId);
      if (!wl) return;
      upsertList({ ...wl, items: wl.items.filter((it) => it._id !== itemId), itemCount: Math.max(0, wl.items.length - 1) });
    },
    async () => { const { data } = await api.delete(`/watchlists/${listId}/items/${itemId}`); upsertList(data.data); return data.data; },
  );

const reorderSymbols = (listId, orderedItemIds) =>
  optimistic(
    () => {
      const wl = _state.watchlists.find((w) => w._id === listId);
      if (!wl) return;
      const byId = new Map(wl.items.map((it) => [it._id, it]));
      const reordered = orderedItemIds.map((id) => byId.get(id)).filter(Boolean);
      upsertList({ ...wl, items: reordered });
    },
    async () => { const { data } = await api.post(`/watchlists/${listId}/items/reorder`, { orderedItemIds }); upsertList(data.data); return data.data; },
    { rollbackMsg: 'Could not reorder symbols' },
  );

const pinSymbol = (listId, itemId, pinned) =>
  optimistic(
    () => {
      const wl = _state.watchlists.find((w) => w._id === listId);
      if (!wl) return;
      upsertList({ ...wl, items: wl.items.map((it) => it._id === itemId ? { ...it, pinned } : it) });
    },
    async () => { const { data } = await api.post(`/watchlists/${listId}/items/${itemId}/pin`, { pinned }); upsertList(data.data); return data.data; },
  );

const moveSymbol = async (listId, itemId, targetWatchlistId) => {
  const { data } = await api.post(`/watchlists/${listId}/items/${itemId}/move`, { targetWatchlistId });
  upsertList(data.data.source); upsertList(data.data.target);
  return data.data;
};

const copySymbol = async (listId, itemId, targetWatchlistId) => {
  const { data } = await api.post(`/watchlists/${listId}/items/${itemId}/copy`, { targetWatchlistId });
  upsertList(data.data.source); upsertList(data.data.target);
  return data.data;
};

// ─── Favorites-based star shim ───────────────────────────────────────
// Per product spec, the ★ star ALWAYS targets the Favorites (default)
// list — never the currently-active list — for predictable behavior
// across MarketWatch / Trade / Watchlist.
const favHas = (symbol) => {
  const fav = favoritesList();
  return !!fav && fav.items.some((it) => it.symbol === symbol);
};

const toggleFavorite = async (symbol) => {
  await loadOnce().catch(() => {});
  let fav = favoritesList();
  // No Favorites list yet (edge case) — create it on demand.
  if (!fav) {
    try {
      const { data } = await api.post('/watchlists', { name: 'Favorites', emoji: '⭐', isDefault: true });
      upsertList(data.data); fav = data.data;
    } catch (err) { toast.error(errorMessage(err)); return; }
  }
  const existing = fav.items.find((it) => it.symbol === symbol);
  if (existing) { await removeSymbol(fav._id, existing._id); toast.success('Removed from Favorites'); }
  else { await addSymbol(fav._id, symbol); toast.success('Added to Favorites'); }
};

/**
 * Subscribe to the shared watchlist store. Triggers the one-time load on
 * first mount. Returns the live state plus all mutation helpers and a
 * Favorites-based star shim (has/toggleFavorite/favCount) compatible with
 * the retired useFavorites hook.
 */
export function useWatchlists() {
  const [s, setS] = useState(_state);

  useEffect(() => {
    const onChange = (next) => setS(next);
    _listeners.add(onChange);
    setS(_state);
    if (!_state.loaded) loadOnce().catch(() => {});
    return () => { _listeners.delete(onChange); };
  }, []);

  const fav = favoritesList(s);
  const has = useCallback((symbol) => favHas(symbol), [s]);

  return {
    // data
    watchlists: s.watchlists,
    loading: s.loading,
    loaded: s.loaded,
    activeId: s.activeId,
    activeList: s.watchlists.find((w) => w._id === s.activeId) || null,
    favoritesList: fav,
    // list ops
    setActiveId, createList, renameList, deleteList, duplicateList, reorderLists, importWatchlist,
    // item ops
    addSymbol, bulkAddSymbols, removeSymbol, reorderSymbols, pinSymbol, moveSymbol, copySymbol,
    // favorites shim (replaces useFavorites)
    has, toggleFavorite, favCount: fav ? fav.items.length : 0,
    reload: () => { _state = { ..._state, loaded: false }; return loadOnce(); },
  };
}
