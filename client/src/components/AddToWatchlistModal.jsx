import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from './Modal';
import AssetIcon from './AssetIcon';
import { useWatchlists } from '../hooks/useWatchlists';

/**
 * <AddToWatchlistModal /> — the single, asset-class-agnostic "Add to
 * Watchlist" sheet used everywhere (instrument cards on Explore / Markets,
 * the Trade instruments rail, …). One implementation handles stocks, crypto,
 * forex, commodities and indices — the symbol is just a string and the
 * server stamps the instrument type, so nothing here is asset-specific.
 *
 * Built on the shared <Modal>, which renders through a React Portal into
 * document.body (immune to transformed/overflow-hidden ancestors) with a
 * fade backdrop + slide-up panel, focus trap, scroll-lock and ESC/backdrop
 * close.
 *
 * Multi-select: a symbol can belong to any combination of lists. We diff the
 * checked set against the initial membership on Save and fan out the minimal
 * add/remove calls. All mutations go through useWatchlists' optimistic store,
 * so every other surface (other cards, MarketWatch ★, the Watchlist page)
 * updates instantly without a refresh.
 */

const NEW_LIST_EMOJIS = ['⭐', '📈', '🔥', '💎', '🚀', '📊', '⚡', '🌙'];

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);

export default function AddToWatchlistModal({ open = true, symbol, instrumentRow, onClose }) {
  const { watchlists, addSymbol, removeSymbol, createList } = useWatchlists();

  // Which lists already contain this symbol when the sheet opens.
  const initial = useMemo(() => {
    const s = new Set();
    for (const w of watchlists) if (w.items?.some((it) => it.symbol === symbol)) s.add(w._id);
    return s;
  }, [watchlists, symbol]);

  const [checked, setChecked] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Inline "create new list" affordance — lets a user with zero lists (or who
  // wants a fresh bucket) add this symbol without leaving the sheet.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState('📈');
  const newNameRef = useRef(null);

  // Re-sync when the modal is reused for a different symbol.
  useEffect(() => { setChecked(initial); }, [initial]);
  useEffect(() => { if (creating) setTimeout(() => newNameRef.current?.focus(), 30); }, [creating]);

  const toggle = (id) =>
    setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Create a list, drop the symbol straight into it, and tick it in the UI.
  const submitNewList = async (e) => {
    if (e) e.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const list = await createList({ name, emoji: newEmoji });
      if (list?._id) {
        await addSymbol(list._id, symbol);
        setChecked((prev) => new Set(prev).add(list._id));
      }
      setCreating(false);
      setNewName('');
      toast.success(`Added ${symbol} to ${name}`);
    } catch (_) { /* toast handled in the hook */ }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    const ops = [];
    for (const w of watchlists) {
      const was = initial.has(w._id);
      const now = checked.has(w._id);
      if (now && !was) ops.push(addSymbol(w._id, symbol));
      else if (!now && was) {
        const item = w.items.find((it) => it.symbol === symbol);
        if (item) ops.push(removeSymbol(w._id, item._id));
      }
    }
    try {
      if (ops.length) await Promise.all(ops);
      toast.success(ops.length ? `Updated watchlists for ${symbol}` : 'No changes');
      onClose();
    } catch (_) { /* per-op toasts handled in the hook */ }
    finally { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxW="max-w-sm"
      bodyClassName="p-2"
      title={(
        <div className="flex items-center gap-2.5 min-w-0">
          <AssetIcon row={instrumentRow || { symbol }} size={28} round />
          <div className="min-w-0">
            <div className="text-sm font-bold text-text-primary truncate">Add to Watchlist</div>
            <div className="text-[11px] text-text-muted truncate">{symbol}</div>
          </div>
        </div>
      )}
      footer={(
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="py-2.5 px-4 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
          <button onClick={save} disabled={busy} className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    >
      {watchlists.length === 0 && !creating && (
        <div className="px-3 py-6 text-center text-sm text-text-muted">No watchlists yet — create one below.</div>
      )}

      {watchlists.map((w) => {
        const on = checked.has(w._id);
        return (
          <button key={w._id} type="button" onClick={() => toggle(w._id)} className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors ${on ? 'bg-primary-500/5' : 'hover:bg-bg-hover'}`}>
            <span className="text-lg shrink-0">{w.emoji || '📋'}</span>
            <span className="flex-1 text-[15px] font-semibold text-text-primary truncate">{w.name}</span>
            <span className="text-xs text-text-muted tabular-nums">{w.items?.length || 0}</span>
            <span className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${on ? 'bg-primary-500 border-primary-500' : 'border-border-dark'}`}>
              {on && <CheckIcon />}
            </span>
          </button>
        );
      })}

      {/* Inline create-new-list */}
      {creating ? (
        <form onSubmit={submitNewList} className="px-3 py-3 space-y-3 border-t border-border-subtle mt-1">
          <div className="flex flex-wrap gap-1.5">
            {NEW_LIST_EMOJIS.map((em) => (
              <button key={em} type="button" onClick={() => setNewEmoji(em)} className={`w-8 h-8 rounded-lg text-base flex items-center justify-center border transition-all ${newEmoji === em ? 'border-primary-500 bg-primary-500/10 scale-105' : 'border-border-dark hover:border-primary-500/40'}`}>{em}</button>
            ))}
          </div>
          <input ref={newNameRef} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} placeholder="New watchlist name" className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setCreating(false); setNewName(''); }} className="py-2 px-3 rounded-lg border border-border-dark text-xs font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
            <button type="submit" disabled={busy || !newName.trim()} className="flex-1 py-2 rounded-lg bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-xs font-bold transition-colors">{busy ? 'Creating…' : 'Create & add'}</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setCreating(true)} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-primary-600 hover:bg-bg-hover transition-colors">
          <span className="w-6 h-6 rounded-md border-2 border-dashed border-primary-400 flex items-center justify-center shrink-0 text-primary-500">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          <span className="flex-1 text-sm font-semibold">New watchlist</span>
        </button>
      )}
    </Modal>
  );
}
