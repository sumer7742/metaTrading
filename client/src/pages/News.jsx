import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import PublicShell from '../components/PublicShell';
import { fmtDate } from '../utils/format';

/**
 * Daily News Updates — public list at /news. Latest first, search + category
 * filter, paginated. Each card links to /news/:slug.
 */
export default function News() {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => { document.title = 'Daily News Updates · TradePro'; }, []);
  useEffect(() => { api.get('/cms/news/categories').then((r) => setCats(r.data.data || [])).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 12 };
      if (search) params.q = search;
      if (category) params.category = category;
      const { data } = await api.get('/cms/news', { params });
      setItems(data.data.items || []);
      setPagination(data.data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (_) { setItems([]); }
    finally { setLoading(false); }
  }, [page, search, category]);
  useEffect(() => { load(); }, [load]);

  return (
    <PublicShell>
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Daily News Updates</h1>
            <p className="text-text-secondary mt-1">Latest market news, analysis and announcements.</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q); }} className="flex gap-2">
            <input className="input w-48" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search news…" />
            <button className="btn-primary text-sm">Search</button>
          </form>
        </div>

        {cats.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            <Chip active={!category} onClick={() => { setCategory(''); setPage(1); }}>All</Chip>
            {cats.map((c) => <Chip key={c} active={category === c} onClick={() => { setCategory(c); setPage(1); }}>{c}</Chip>)}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-64 rounded-xl bg-bg-hover animate-pulse" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center text-text-muted py-20">No news articles yet.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {items.map((a) => (
              <Link key={a._id} to={`/news/${a.slug}`} className="card overflow-hidden hover:shadow-lg transition-shadow group">
                {a.featuredImageUrl ? (
                  <img src={a.featuredImageUrl} alt={a.title} className="w-full h-40 object-cover" />
                ) : (
                  <div className="w-full h-40 bg-bg-hover flex items-center justify-center text-text-muted text-sm">No image</div>
                )}
                <div className="p-4">
                  <div className="flex items-center gap-2 text-[11px] text-text-muted mb-1.5">
                    <span className="px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-500 font-semibold">{a.category}</span>
                    <span>{fmtDate(a.publishDate)}</span>
                  </div>
                  <h2 className="text-base font-bold text-text-primary group-hover:text-primary-500 transition-colors line-clamp-2">{a.title}</h2>
                  {a.excerpt ? <p className="text-sm text-text-secondary mt-1.5 line-clamp-3">{a.excerpt}</p> : null}
                  {a.author ? <div className="text-xs text-text-muted mt-2">By {a.author}</div> : null}
                </div>
              </Link>
            ))}
          </div>
        )}

        {pagination.pages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-8 text-sm text-text-secondary">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-secondary text-xs disabled:opacity-30">Prev</button>
            <span>Page {pagination.page} / {pagination.pages}</span>
            <button disabled={page >= pagination.pages} onClick={() => setPage(page + 1)} className="btn-secondary text-xs disabled:opacity-30">Next</button>
          </div>
        )}
      </div>
    </PublicShell>
  );
}

const Chip = ({ active, onClick, children }) => (
  <button onClick={onClick}
    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${active ? 'bg-primary-500 text-white border-primary-500' : 'border-border-dark text-text-secondary hover:border-primary-500'}`}>
    {children}
  </button>
);
