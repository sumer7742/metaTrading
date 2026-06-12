import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtDate } from '../utils/format';
import { useConfirm } from '../components/ConfirmProvider';
import PageHero from '../components/PageHero';
import RichTextEditor from '../components/RichTextEditor';

/**
 * News Management — the Daily News Updates system. Create/edit/publish/delete
 * articles; search + filter; latest first. Live at /news once published.
 */
export default function CmsNews() {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search) params.q = search;
      if (statusF) params.status = statusF;
      const { data } = await api.get('/admin/cms/news', { params });
      setRows(data.data || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, [search, statusF]);
  useEffect(() => { load(); }, [load]);

  const togglePublish = async (a) => {
    try { await api.post(`/admin/cms/news/${a._id}/publish`, { publish: a.status !== 'PUBLISHED' }); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (a) => {
    if (!(await confirm({ title: 'Delete article', message: `Delete "${a.title}"?`, danger: true, confirmText: 'Delete' }))) return;
    try { await api.delete(`/admin/cms/news/${a._id}`); toast.success('Article deleted'); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-4 max-w-[1400px]">
      <PageHero
        eyebrow="Content"
        title="News Management"
        subtitle="Daily News Updates — write, categorize, schedule and publish articles. Live at /news."
        actions={<button onClick={() => setEditing({})} className="btn-primary text-sm">+ New Article</button>}
      />

      <form onSubmit={(e) => { e.preventDefault(); setSearch(q); }} className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[180px]"><label className="label">Search</label><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="title, author, slug" /></div>
        <div><label className="label">Status</label><select className="input w-36" value={statusF} onChange={(e) => setStatusF(e.target.value)}><option value="">All</option><option value="PUBLISHED">Published</option><option value="DRAFT">Draft</option></select></div>
        <button className="btn-primary text-sm">Search</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] text-text-muted uppercase border-b border-border-dark">
            <tr>
              <th className="p-2.5 text-left">Title</th><th className="p-2.5 text-left">Category</th>
              <th className="p-2.5 text-left">Author</th><th className="p-2.5 text-left">Publish Date</th>
              <th className="p-2.5 text-left">Status</th><th className="p-2.5 text-right">Views</th><th className="p-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0, 1, 2].map((i) => <tr key={i} className="border-t border-border-dark/50"><td colSpan={7} className="p-3"><div className="h-4 bg-bg-hover rounded animate-pulse" /></td></tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={7} className="p-10 text-center text-text-muted">No articles yet.</td></tr>
            ) : rows.map((a) => (
              <tr key={a._id} className="table-row align-middle">
                <td className="p-2.5 font-semibold text-white">{a.title}</td>
                <td className="p-2.5"><span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-500">{a.category}</span></td>
                <td className="p-2.5 text-text-secondary">{a.author || '—'}</td>
                <td className="p-2.5 text-text-muted text-xs">{fmtDate(a.publishDate)}</td>
                <td className="p-2.5"><Badge status={a.status} /></td>
                <td className="p-2.5 text-right text-text-muted">{fmtNum(a.views, 0)}</td>
                <td className="p-2.5 text-right">
                  <div className="inline-flex gap-1">
                    <button onClick={() => setEditing(a)} className="btn-ghost text-[11px] px-2 py-1">Edit</button>
                    <button onClick={() => togglePublish(a)} className={`text-[11px] px-2 py-1 rounded ${a.status === 'PUBLISHED' ? 'text-warn hover:bg-warn/10' : 'text-emerald-400 hover:bg-emerald-500/10'}`}>{a.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}</button>
                    <button onClick={() => remove(a)} className="text-[11px] px-2 py-1 rounded text-bear hover:bg-bear/10">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <NewsEditor article={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

const Badge = ({ status }) => (
  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${status === 'PUBLISHED' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-bg-hover text-text-muted border-border-dark'}`}>{status}</span>
);

function NewsEditor({ article, onClose, onSaved }) {
  const isNew = !article._id;
  const [f, setF] = useState({
    title: article.title || '', slug: article.slug || '', excerpt: article.excerpt || '',
    content: article.content || '', category: article.category || 'General', author: article.author || '',
    featuredImageUrl: article.featuredImageUrl || '', tags: (article.tags || []).join(', '),
    publishDate: article.publishDate ? new Date(article.publishDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    status: article.status || 'DRAFT',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const save = async (publish) => {
    if (!f.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const body = { ...f, status: publish ? 'PUBLISHED' : f.status };
      if (isNew) await api.post('/admin/cms/news', body);
      else await api.put(`/admin/cms/news/${article._id}`, body);
      toast.success(isNew ? 'Article created' : 'Article saved');
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl h-full bg-bg-card border-l border-border-dark overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-bold text-white">{isNew ? 'New Article' : 'Edit Article'}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div><label className="label">Title *</label><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
          <div><label className="label">URL Slug <span className="text-text-muted">(blank = auto)</span></label>
            <div className="flex items-center gap-1"><span className="text-text-muted text-sm">/news/</span><input className="input" value={f.slug} onChange={(e) => set('slug', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Category</label><input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /></div>
            <div><label className="label">Author</label><input className="input" value={f.author} onChange={(e) => set('author', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Publish Date</label><input type="date" className="input" value={f.publishDate} onChange={(e) => set('publishDate', e.target.value)} /></div>
            <div><label className="label">Tags <span className="text-text-muted">(comma sep)</span></label><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></div>
          </div>
          <div><label className="label">Excerpt</label><textarea className="input min-h-[60px]" value={f.excerpt} onChange={(e) => set('excerpt', e.target.value)} placeholder="Short summary shown in the news list" /></div>
          <div><label className="label">Featured Image URL</label><input className="input" value={f.featuredImageUrl} onChange={(e) => set('featuredImageUrl', e.target.value)} placeholder="https://…" />
            {f.featuredImageUrl ? <img src={f.featuredImageUrl} alt="" className="mt-2 h-24 rounded border border-border-dark object-cover" /> : null}
          </div>
          <div><label className="label">Content</label><RichTextEditor value={f.content} onChange={(html) => set('content', html)} /></div>
        </div>
        <div className="sticky bottom-0 bg-bg-card border-t border-border-dark p-4 flex items-center justify-end gap-2">
          <button onClick={() => save(false)} disabled={saving} className="btn-secondary text-sm">Save Draft</button>
          <button onClick={() => save(true)} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Publish'}</button>
        </div>
      </div>
    </div>
  );
}
