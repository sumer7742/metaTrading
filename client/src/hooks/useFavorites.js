import { useWatchlists } from './useWatchlists';

/**
 * @deprecated Compatibility shim. Favorites are now one of many
 * server-backed watchlists (the default "Favorites" list). New code should
 * use `useWatchlists()` directly. This shim preserves the old surface
 * (has / toggle / add / remove / count) so any lingering import keeps
 * working — the ★ always targets the Favorites list.
 */
export function useFavorites() {
  const { has, toggleFavorite, favCount, favoritesList, removeSymbol } = useWatchlists();

  const add = (symbol) => { if (!has(symbol)) toggleFavorite(symbol); };
  const remove = (symbol) => {
    const fav = favoritesList;
    const item = fav?.items.find((it) => it.symbol === symbol);
    if (item) removeSymbol(fav._id, item._id).catch(() => {});
  };

  return {
    favs: new Set((favoritesList?.items || []).map((it) => it.symbol)),
    toggle: toggleFavorite,
    add,
    remove,
    has,
    count: favCount,
  };
}
