import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

/**
 * Recommended Markets — admin curation of the symbols that power BOTH the
 * client's top ticker strip AND the "Recommended" tab in the market selector.
 *
 *   • Add a market (searches the live instrument catalog).
 *   • Drag-and-drop to reorder — the strip follows this exact order.
 *   • Remove a market.
 *   • Save Changes persists the order (PUT …/reorder).
 *
 * No hard-coded showcase symbols exist anywhere downstream: the strip renders
 * exactly this list, so an add / remove / reorder here flows through end-to-end.
 */

const CATEGORY_TINT = {
  CRYPTO: '#F7931A', FOREX: '#3B82F6', COMMODITY: '#D4A017',
  INDEX: '#8B5CF6', STOCK: '#10B981',
};
const tintFor = (cat, symbol) => {
  if (cat && CATEGORY_TINT[cat.toUpperCase()]) return CATEGORY_TINT[cat.toUpperCase()];
  let h = 0; for (let i = 0; i < (symbol || '').length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  const palette = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#EA580C', '#DB2777', '#0D9488', '#CA8A04'];
  return palette[h % palette.length];
};

function Avatar({ symbol, category, size = 36 }) {
  const glyph = (symbol || '?').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
  return (
    <span
      className="rounded-lg flex items-center justify-center font-bold text-white shrink-0"
      style={{
        width: size, height: size, background: tintFor(category, symbol),
        fontSize: Math.round(size * (glyph.length > 2 ? 0.3 : 0.38)),
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
      }}
    >
      {glyph}
    </span>
  );
}

const catLabel = (c) => {
  const m = { FOREX: 'Forex', CRYPTO: 'Crypto', COMMODITY: 'Commodity', INDEX: 'Index', STOCK: 'Stock' };
  return m[(c || '').toUpperCase()] || c || '—';
};

export default function RecommendedMarkets() {
  const confirm = useConfirm();
  const [order, setOrder] = useState([]);       // working copy (drag reorders this)
  const [serverIds, setServerIds] = useState('');// snapshot to detect dirty
  const [catalog, setCatalog] = useState([]);   // full instrument list for the picker
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState('');     // symbol currently being added
  const [query, setQuery] = useState('');
  const [dragId, setDragId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [recRes, catRes] = await Promise.all([
        api.get('/admin/recommended-markets'),
        api.get('/instruments'),
      ]);
      const recs = recRes.data.data || [];
      setOrder(recs);
      setServerIds(recs.map((r) => r.id).join('|'));
      setCatalog(catRes.data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => order.map((r) => r.id).join('|') !== serverIds, [order, serverIds]);

  const recommendedSymbols = useMemo(() => new Set(order.map((r) => r.symbol)), [order]);

  // Catalog filtered for the "add" picker — excludes already-recommended symbols.
  const candidates = useMemo(() => {
    const q = query.trim().toUpperCase();
    return catalog
      .filter((r) => !recommendedSymbols.has(r.symbol))
      .filter((r) => !q || r.symbol?.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q))
      .slice(0, 60);
  }, [catalog, recommendedSymbols, query]);

  // ── Add ──
  const addMarket = async (symbol) => {
    setAdding(symbol);
    try {
      await api.post('/admin/recommended-markets', { symbol });
      toast.success(`${symbol} added to Recommended`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding('');
    }
  };

  // ── Remove ──
  const removeMarket = async (rec) => {
    if (!(await confirm({ title: 'Remove from Recommended', message: `Remove ${rec.symbol} from the recommended markets?`, confirmText: 'Remove', danger: true }))) return;
    try {
      await api.delete(`/admin/recommended-markets/${rec.id}`);
      toast.success(`${rec.symbol} removed`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // ── Save order ──
  const saveOrder = async () => {
    setSaving(true);
    try {
      await api.put('/admin/recommended-markets/reorder', { order: order.map((r) => r.id) });
      toast.success('Order saved — ticker strip will follow this order');
      setServerIds(order.map((r) => r.id).join('|'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Drag & drop reorder (native HTML5; no extra dependency) ──
  const onDragOver = (e, overId) => {
    e.preventDefault();
    if (dragId == null || dragId === overId) return;
    setOrder((cur) => {
      const from = cur.findIndex((x) => x.id === dragId);
      const to = cur.findIndex((x) => x.id === overId);
      if (from < 0 || to < 0 || from === to) return cur;
      const next = cur.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // Keyboard-accessible reorder fallback (drag is not reachable by keyboard).
  const move = (idx, dir) => {
    setOrder((cur) => {
      const to = idx + dir;
      if (to < 0 || to >= cur.length) return cur;
      const next = cur.slice();
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  };

  return (
    <div>
      <PageHero
        eyebrow="Market Management"
        title="Recommended Markets"
        subtitle="Curate the symbols shown in the client's top ticker strip and the “Recommended” tab of the market selector. Drag to reorder — the strip follows this exact order."
        actions={(
          <button
            type="button"
            onClick={saveOrder}
            disabled={!dirty || saving}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-primary-500 text-bg-dark hover:bg-primary-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        )}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Recommended list (ordered, drag-drop) ── */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-border-dark bg-bg-card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-dark">
              <h2 className="text-sm font-bold text-white">
                Recommended <span className="text-text-muted font-semibold">({order.length})</span>
              </h2>
              {dirty && <span className="text-[11px] font-semibold text-amber-400">Unsaved order</span>}
            </div>

            {loading ? (
              <div className="p-8 text-center text-sm text-text-muted">Loading…</div>
            ) : order.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm text-text-secondary font-semibold">No recommended markets yet</div>
                <div className="text-xs text-text-muted mt-1">Add markets from the panel on the right — the ticker strip will fall back to all instruments until then.</div>
              </div>
            ) : (
              <ul className="divide-y divide-border-dark">
                {order.map((rec, idx) => (
                  <li
                    key={rec.id}
                    draggable
                    onDragStart={() => setDragId(rec.id)}
                    onDragOver={(e) => onDragOver(e, rec.id)}
                    onDragEnd={() => setDragId(null)}
                    className={`group flex items-center gap-3 px-4 py-3 transition-colors ${dragId === rec.id ? 'opacity-50 bg-bg-hover' : 'hover:bg-bg-hover'}`}
                  >
                    {/* drag handle */}
                    <span className="cursor-grab active:cursor-grabbing text-text-muted hover:text-white shrink-0" title="Drag to reorder">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
                    </span>
                    <span className="w-6 text-center text-xs font-mono font-bold text-text-muted shrink-0">{idx + 1}</span>
                    <Avatar symbol={rec.symbol} category={rec.category} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white truncate">{rec.name}</div>
                      <div className="text-[11px] text-text-muted truncate">
                        {rec.symbol} · {catLabel(rec.category)}
                        {rec.missing && <span className="ml-2 text-bear font-semibold">⚠ instrument missing</span>}
                        {!rec.missing && !rec.instrumentActive && <span className="ml-2 text-amber-400 font-semibold">inactive</span>}
                      </div>
                    </div>
                    {/* keyboard reorder */}
                    <div className="hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} className="p-1 rounded text-text-muted hover:text-white disabled:opacity-30" title="Move up">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
                      </button>
                      <button type="button" onClick={() => move(idx, 1)} disabled={idx === order.length - 1} className="p-1 rounded text-text-muted hover:text-white disabled:opacity-30" title="Move down">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeMarket(rec)}
                      className="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-bear hover:bg-bear/10 transition-colors"
                      title="Remove"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ── Add markets ── */}
        <div className="lg:col-span-1">
          <div className="rounded-2xl border border-border-dark bg-bg-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border-dark">
              <h2 className="text-sm font-bold text-white">Add markets</h2>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border-dark bg-bg-dark mb-3">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-text-muted shrink-0"><path d="M21 21l-4.35-4.35"/><circle cx="11" cy="11" r="8"/></svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search symbol or name…"
                  className="flex-1 bg-transparent outline-none text-sm text-white placeholder-text-muted"
                />
              </div>

              <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-1">
                {loading && <div className="py-6 text-center text-sm text-text-muted">Loading…</div>}
                {!loading && candidates.length === 0 && (
                  <div className="py-6 text-center text-sm text-text-muted">
                    {query ? `No markets match “${query}”.` : 'All markets are already recommended.'}
                  </div>
                )}
                {candidates.map((r) => (
                  <div key={r.symbol} className="flex items-center gap-2.5 p-2 rounded-xl hover:bg-bg-hover transition-colors">
                    <Avatar symbol={r.symbol} category={r.category} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-white truncate">{r.name || r.symbol}</div>
                      <div className="text-[10px] text-text-muted truncate">{r.symbol} · {catLabel(r.category)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addMarket(r.symbol)}
                      disabled={adding === r.symbol}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-primary-500/15 text-primary-400 hover:bg-primary-500 hover:text-bg-dark disabled:opacity-50 transition-colors"
                    >
                      {adding === r.symbol ? '…' : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                          Add
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
