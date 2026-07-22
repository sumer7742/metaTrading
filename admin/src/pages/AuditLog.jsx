import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

const RANGES = [
  { id: 'all', label: 'All time' },
  { id: '1', label: 'Today' },
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: 'custom', label: 'Custom' },
];
const LIMIT = 50;

export default function AuditLog() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [range, setRange] = useState('all');
  const [from, setFrom] = useState('');   // custom start (datetime-local: YYYY-MM-DDTHH:mm)
  const [to, setTo] = useState('');       // custom end (datetime-local)
  const [page, setPage] = useState(1);

  // Debounce the search box so we don't fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Derive the ISO date window from the selected range / custom dates.
  const dateWindow = useMemo(() => {
    if (range === 'all') return {};
    if (range === 'custom') {
      // Custom now includes TIME (datetime-local → YYYY-MM-DDTHH:mm, local).
      const w = {};
      if (from) w.from = new Date(from).toISOString();
      // No seconds in datetime-local → include the whole selected minute so the
      // upper bound is inclusive (e.g. 11:00 covers 11:00:00 → 11:00:59.999).
      if (to) w.to = new Date(to.length <= 16 ? `${to}:59.999` : to).toISOString();
      return w;
    }
    const days = Number(range);
    const d = new Date();
    if (days === 1) d.setHours(0, 0, 0, 0);   // Today → since midnight
    else d.setDate(d.getDate() - days);        // last N days
    return { from: d.toISOString() };
  }, [range, from, to]);

  // Any filter change resets to page 1.
  useEffect(() => { setPage(1); }, [debouncedQ, range, from, to]);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    const params = { page, limit: LIMIT };
    if (debouncedQ) params.q = debouncedQ;
    if (dateWindow.from) params.from = dateWindow.from;
    if (dateWindow.to) params.to = dateWindow.to;
    api.get('/admin/audit-log', { params })
      .then((r) => {
        if (dead) return;
        const d = r.data?.data || {};
        setItems(d.items || []);
        setTotal(d.total || 0);
        setPages(d.pages || 1);
      })
      .catch(() => { if (!dead) { setItems([]); setTotal(0); setPages(1); } })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [debouncedQ, dateWindow, page]);

  const inputCls = 'text-xs px-2.5 py-1.5 rounded bg-bg-card text-gray-200 border border-border-dark focus:outline-none focus:border-primary-500';

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Insights"
        title="Audit Log"
        subtitle="Immutable, append-only record of every admin action."
      />

      {/* Filters — search + date range + custom dates */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search action, actor, target, role, IP…"
          className={`${inputCls} flex-1 min-w-[200px] max-w-sm placeholder:text-gray-500`}
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`text-xs px-3 py-1.5 rounded ${range === r.id ? 'btn-primary' : 'bg-bg-card text-gray-400 hover:bg-bg-hover'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="datetime-local" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} title="From date & time" />
            <span>→</span>
            <input type="datetime-local" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} title="To date & time" />
          </div>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500 whitespace-nowrap">{total.toLocaleString()} events</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold bg-bg-panel">
            <tr>
              <th className="text-left p-3">Timestamp</th>
              <th className="text-left p-3">Actor</th>
              <th className="text-left p-3">Role</th>
              <th className="text-left p-3">Action</th>
              <th className="text-left p-3">Target</th>
              <th className="text-left p-3">Metadata</th>
              <th className="text-left p-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l._id} className="table-row">
                <td className="p-3 text-xs text-text-secondary whitespace-nowrap font-mono">{fmtDate(l.createdAt)}</td>
                <td className="p-3 text-xs font-mono text-text-primary">{l.actorId?.toString().slice(-6) || '-'}</td>
                <td className="p-3 text-xs"><span className="chip-primary">{l.actorRole}</span></td>
                <td className="p-3 text-xs font-medium text-text-primary">{l.action}</td>
                <td className="p-3 text-xs text-text-secondary font-mono">
                  {l.targetType}: {l.targetId?.toString().slice(-8) || '-'}
                </td>
                <td className="p-3 text-[10px] text-text-muted max-w-xs truncate font-mono">
                  {l.metadata ? JSON.stringify(l.metadata) : '-'}
                </td>
                <td className="p-3 text-xs text-text-muted font-mono">{l.ip || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && (
          <div className="text-center text-text-muted py-10 text-sm">Loading…</div>
        )}
        {!loading && !items.length && (
          <div className="text-center text-text-secondary py-10 text-sm">
            <div className="text-text-muted">No audit entries match your filters</div>
            <div className="text-xs text-text-muted mt-1">Try a wider date range or clear the search.</div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-400 flex-wrap gap-2">
          <span>Page {page} of {pages} · {total.toLocaleString()} total</span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 rounded bg-bg-card text-gray-300 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ‹ Prev
            </button>
            <button
              disabled={page >= pages || loading}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className="px-3 py-1.5 rounded bg-bg-card text-gray-300 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
