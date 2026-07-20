import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

// User-submitted feedback = support tickets. This is the admin inbox: filter,
// preview attachments, change status, leave an internal note, and reply to the
// user (their reply shows in "My Tickets" + is best-effort emailed).

const STATUSES = [
  { id: 'OPEN',        label: 'Open',        cls: 'bg-amber-500/15 text-amber-400 border border-amber-500/30' },
  { id: 'TRIAGED',     label: 'Triaged',     cls: 'bg-sky-500/15 text-sky-400 border border-sky-500/30' },
  { id: 'IN_PROGRESS', label: 'In Progress', cls: 'bg-violet-500/15 text-violet-400 border border-violet-500/30' },
  { id: 'RESOLVED',    label: 'Resolved',    cls: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' },
  { id: 'WONT_FIX',    label: "Won't Fix",   cls: 'bg-gray-500/15 text-gray-400 border border-gray-500/30' },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
const CATEGORIES = ['BUG', 'FEATURE', 'UX', 'SUPPORT', 'OTHER'];
const CAT_CLS = {
  BUG: 'bg-rose-500/15 text-rose-400', FEATURE: 'bg-indigo-500/15 text-indigo-400',
  UX: 'bg-teal-500/15 text-teal-400', SUPPORT: 'bg-primary-500/15 text-primary-500', OTHER: 'bg-gray-500/15 text-gray-400',
};
const RANGES = [
  { id: 'all', label: 'All time' }, { id: '1', label: 'Today' },
  { id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: 'custom', label: 'Custom' },
];
const LIMIT = 25;

const StatusBadge = ({ status }) => {
  const s = STATUS_MAP[status] || STATUS_MAP.OPEN;
  return <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${s.cls}`}>{s.label}</span>;
};

export default function SupportTickets() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState('');       // '' = all
  const [category, setCategory] = useState('');
  const [range, setRange] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);   // force a refetch after edits

  const [detail, setDetail] = useState(null);      // full ticket in the slide-over

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const dateWindow = useMemo(() => {
    if (range === 'all') return {};
    if (range === 'custom') {
      const w = {};
      if (from) w.from = new Date(`${from}T00:00:00`).toISOString();
      if (to) w.to = new Date(`${to}T23:59:59`).toISOString();
      return w;
    }
    const days = Number(range);
    const d = new Date();
    if (days === 1) d.setHours(0, 0, 0, 0);
    else d.setDate(d.getDate() - days);
    return { from: d.toISOString() };
  }, [range, from, to]);

  useEffect(() => { setPage(1); }, [debouncedQ, status, category, range, from, to]);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    const params = { page, limit: LIMIT };
    if (debouncedQ) params.q = debouncedQ;
    if (status) params.status = status;
    if (category) params.category = category;
    if (dateWindow.from) params.from = dateWindow.from;
    if (dateWindow.to) params.to = dateWindow.to;
    api.get('/admin/support-tickets', { params })
      .then((r) => {
        if (dead) return;
        const d = r.data?.data || {};
        setItems(d.items || []);
        setTotal(d.total || 0);
        setPages(d.pages || 1);
        setCounts(d.counts || {});
      })
      .catch(() => { if (!dead) { setItems([]); setTotal(0); setPages(1); setCounts({}); } })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [debouncedQ, status, category, dateWindow, page, reloadKey]);

  // Live: a user submitting a ticket broadcasts on 'admin:tickets' → refetch
  // the current view (respects active filters + scope) so the inbox and the
  // status counts update without a manual refresh.
  useEffect(() => {
    const unsub = wsClient.subscribe('admin:tickets', () => setReloadKey((k) => k + 1));
    return () => unsub && unsub();
  }, []);

  // Merge an updated ticket back into the visible list (attachment is stripped
  // server-side on writes — recompute the hasAttachment flag from its name).
  const patchRow = (updated) => {
    setItems((prev) => prev.map((it) => (it._id === updated._id
      ? { ...it, ...updated, hasAttachment: !!updated.attachmentName }
      : it)));
  };

  const inputCls = 'text-xs px-2.5 py-1.5 rounded bg-bg-card text-gray-200 border border-border-dark focus:outline-none focus:border-primary-500';
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabs = [{ id: '', label: 'All', n: totalAll }, ...STATUSES.map((s) => ({ id: s.id, label: s.label, n: counts[s.id] || 0 }))];

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Support"
        title="Support Tickets"
        subtitle="User-submitted feedback & help requests. Preview attachments, set status, and reply."
      />

      {/* Status tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id || 'all'}
            onClick={() => setStatus(t.id)}
            className={`text-xs px-3 py-1.5 rounded flex items-center gap-1.5 ${status === t.id ? 'btn-primary' : 'bg-bg-card text-gray-400 hover:bg-bg-hover'}`}
          >
            {t.label}
            <span className={`text-[10px] font-bold px-1.5 rounded-full ${status === t.id ? 'bg-black/20' : 'bg-bg-hover text-gray-400'}`}>{t.n}</span>
          </button>
        ))}
      </div>

      {/* Filters — search + category + date range */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search subject, message, reply…"
          className={`${inputCls} flex-1 min-w-[200px] max-w-sm placeholder:text-gray-500`}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex items-center gap-1.5 flex-wrap">
          {RANGES.map((r) => (
            <button key={r.id} onClick={() => setRange(r.id)}
              className={`text-xs px-3 py-1.5 rounded ${range === r.id ? 'btn-primary' : 'bg-bg-card text-gray-400 hover:bg-bg-hover'}`}>
              {r.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            <span>→</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </div>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500 whitespace-nowrap">{total.toLocaleString()} tickets</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold bg-bg-panel">
            <tr>
              <th className="text-left p-3">Created</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Category</th>
              <th className="text-left p-3">Subject</th>
              <th className="text-center p-3">Rating</th>
              <th className="text-center p-3">Att.</th>
              <th className="text-left p-3">Status</th>
              <th className="text-center p-3">Reply</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t._id} className="table-row cursor-pointer" onClick={() => setDetail(t)}>
                <td className="p-3 text-xs text-text-secondary whitespace-nowrap font-mono">{fmtDate(t.createdAt)}</td>
                <td className="p-3 text-xs">
                  <div className="font-medium text-text-primary truncate max-w-[160px]">{t.user?.name || '—'}</div>
                  {t.user?.userUid && <div className="text-[10px] font-mono text-primary-500/80">{t.user.userUid}</div>}
                </td>
                <td className="p-3"><span className={`text-[10px] font-bold px-2 py-0.5 rounded ${CAT_CLS[t.category] || CAT_CLS.OTHER}`}>{t.category}</span></td>
                <td className="p-3 text-xs text-text-primary max-w-[280px] truncate">{t.subject}</td>
                <td className="p-3 text-center text-xs text-amber-400 whitespace-nowrap">{t.rating ? '★'.repeat(t.rating) : '—'}</td>
                <td className="p-3 text-center">{t.hasAttachment ? <span title="Has attachment">📎</span> : <span className="text-text-muted">—</span>}</td>
                <td className="p-3"><StatusBadge status={t.status} /></td>
                <td className="p-3 text-center">{t.adminReply ? <span className="text-emerald-400" title="Replied">✓</span> : <span className="text-text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="text-center text-text-muted py-10 text-sm">Loading…</div>}
        {!loading && !items.length && (
          <div className="text-center text-text-secondary py-10 text-sm">
            <div className="text-text-muted">No tickets match your filters</div>
            <div className="text-xs text-text-muted mt-1">Try a wider date range or clear the search.</div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-400 flex-wrap gap-2">
          <span>Page {page} of {pages} · {total.toLocaleString()} total</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 rounded bg-bg-card text-gray-300 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed">‹ Prev</button>
            <button disabled={page >= pages || loading} onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className="px-3 py-1.5 rounded bg-bg-card text-gray-300 hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed">Next ›</button>
          </div>
        </div>
      )}

      {detail && (
        <TicketDrawer
          row={detail}
          onClose={() => setDetail(null)}
          onChanged={(updated) => { patchRow(updated); setDetail((d) => (d && d._id === updated._id ? { ...d, ...updated } : d)); }}
          onCountsStale={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

// ───────── Slide-over: full ticket + actions ─────────
function TicketDrawer({ row, onClose, onChanged, onCountsStale }) {
  const [full, setFull] = useState(null);      // full doc incl. attachment
  const [loading, setLoading] = useState(true);
  const [dStatus, setDStatus] = useState(row.status);
  const [dNote, setDNote] = useState('');
  const [reply, setReply] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api.get(`/admin/support-tickets/${row._id}`)
      .then((r) => {
        if (dead) return;
        const fb = r.data?.data || null;
        setFull(fb);
        setDStatus(fb?.status || row.status);
        setDNote(fb?.adminNote || '');
      })
      .catch((e) => { if (!dead) toast.error(errorMessage(e)); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [row._id]);

  const saveMeta = async () => {
    setSavingMeta(true);
    try {
      const { data } = await api.put(`/admin/support-tickets/${row._id}`, { status: dStatus, adminNote: dNote });
      const updated = data?.data || {};
      setFull((f) => ({ ...f, ...updated }));
      onChanged(updated);
      onCountsStale();
      toast.success('Ticket updated');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSavingMeta(false); }
  };

  const sendReply = async () => {
    if (reply.trim().length < 2) { toast.error('Type a reply first'); return; }
    setSending(true);
    try {
      const { data } = await api.post(`/admin/support-tickets/${row._id}/reply`, { reply: reply.trim() });
      const updated = data?.data || {};
      setFull((f) => ({ ...f, ...updated }));
      setDStatus(updated.status || dStatus);
      setReply('');
      onChanged(updated);
      onCountsStale();
      toast.success('Reply sent to the user');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSending(false); }
  };

  const att = full?.attachment;
  const isImg = typeof att === 'string' && att.startsWith('data:image');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-bg-dark border-l border-border-dark shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border-dark flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${CAT_CLS[row.category] || CAT_CLS.OTHER}`}>{row.category}</span>
              <StatusBadge status={dStatus} />
              {row.rating ? <span className="text-amber-400 text-xs">{'★'.repeat(row.rating)}</span> : null}
            </div>
            <h2 className="text-base font-bold text-white mt-1.5 break-words">{row.subject}</h2>
            <div className="text-[11px] text-text-muted mt-0.5">
              {row.user?.name || '—'}{row.user?.email ? ` · ${row.user.email}` : ''}{row.user?.userUid ? ` · ${row.user.userUid}` : ''}
            </div>
            <div className="text-[11px] text-text-muted">{fmtDate(row.createdAt)}</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-white text-lg leading-none shrink-0">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading ? (
            <div className="text-center text-text-muted py-10 text-sm">Loading…</div>
          ) : (
            <>
              {/* Message */}
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Message</div>
                <div className="text-sm text-text-secondary whitespace-pre-wrap break-words bg-bg-card border border-border-dark rounded-lg p-3">{full?.message || row.subject}</div>
              </div>

              {/* Attachment */}
              {att && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Attachment · {full?.attachmentName || 'file'}</div>
                  {isImg ? (
                    <a href={att} target="_blank" rel="noreferrer">
                      <img src={att} alt={full?.attachmentName || 'attachment'} className="rounded-lg max-h-72 border border-border-dark" />
                    </a>
                  ) : (
                    <a href={att} download={full?.attachmentName || 'attachment'} className="inline-flex items-center gap-2 text-sm text-primary-500 hover:underline bg-bg-card border border-border-dark rounded-lg px-3 py-2">
                      📎 {full?.attachmentName || 'Download file'}
                    </a>
                  )}
                </div>
              )}

              {/* Context */}
              {(full?.context?.page || full?.context?.appVersion) && (
                <div className="text-[11px] text-text-muted space-y-0.5">
                  {full?.context?.page && <div>Page: <span className="font-mono text-text-secondary break-all">{full.context.page}</span></div>}
                  {full?.context?.appVersion && <div>App: <span className="font-mono text-text-secondary">{full.context.appVersion}</span></div>}
                </div>
              )}

              {/* Existing reply */}
              {full?.adminReply && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-400 mb-1.5">Your reply · {fmtDate(full.repliedAt)}</div>
                  <div className="text-sm text-text-secondary whitespace-pre-wrap break-words bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-3">{full.adminReply}</div>
                </div>
              )}

              {/* Status + internal note */}
              <div className="space-y-3 border-t border-border-dark pt-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Status</div>
                  <select value={dStatus} onChange={(e) => setDStatus(e.target.value)}
                    className="text-sm px-2.5 py-1.5 rounded bg-bg-card text-gray-200 border border-border-dark focus:outline-none focus:border-primary-500 w-full">
                    {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Internal note <span className="text-text-muted/60 normal-case font-normal">(never shown to the user)</span></div>
                  <textarea value={dNote} onChange={(e) => setDNote(e.target.value)} rows={2} placeholder="Triage notes…"
                    className="w-full text-sm px-3 py-2 rounded-lg bg-bg-card text-gray-200 border border-border-dark focus:outline-none focus:border-primary-500 resize-none" />
                </div>
                <button type="button" onClick={saveMeta} disabled={savingMeta}
                  className="btn-primary text-sm py-1.5 px-4 disabled:opacity-50">{savingMeta ? 'Saving…' : 'Save status & note'}</button>
              </div>
            </>
          )}
        </div>

        {/* Reply composer */}
        <div className="border-t border-border-dark p-4 space-y-2 bg-bg-panel/40">
          <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Reply to user <span className="text-text-muted/60 normal-case font-normal">(shown in their My Tickets + emailed)</span></div>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder="Write a reply the user will see…"
            className="w-full text-sm px-3 py-2 rounded-lg bg-bg-card text-gray-200 border border-border-dark focus:outline-none focus:border-primary-500 resize-none" />
          <div className="flex justify-end">
            <button type="button" onClick={sendReply} disabled={sending || reply.trim().length < 2}
              className="btn-primary text-sm py-1.5 px-4 disabled:opacity-50">{sending ? 'Sending…' : 'Send reply'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
