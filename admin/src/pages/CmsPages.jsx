import { useEffect, useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtDate } from '../utils/format';
import { useConfirm } from '../components/ConfirmProvider';
import PageHero from '../components/PageHero';
import RichTextEditor from '../components/RichTextEditor';

/**
 * CMS Pages — create/edit/publish/reorder/delete footer & explore pages.
 * Drag a row to change footer order. Live at /page/:slug once published.
 */
export default function CmsPages() {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // page object or {} for new
  const [preview, setPreview] = useState(null);
  const dragId = useRef(null);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/admin/cms/pages'); setRows(data.data || []); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const togglePublish = async (p) => {
    try { await api.post(`/admin/cms/pages/${p._id}/publish`, { publish: p.status !== 'PUBLISHED' }); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (p) => {
    if (!(await confirm({ title: 'Delete page', message: `Delete "${p.title}"? This cannot be undone.`, danger: true, confirmText: 'Delete' }))) return;
    try { await api.delete(`/admin/cms/pages/${p._id}`); toast.success('Page deleted'); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  /* drag & drop reorder */
  const onDrop = async (targetId) => {
    const from = rows.findIndex((r) => r._id === dragId.current);
    const to = rows.findIndex((r) => r._id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
    dragId.current = null;
    try {
      await api.put('/admin/cms/pages/reorder', { orders: next.map((r, i) => ({ id: r._id, order: i + 1 })) });
      toast.success('Order saved');
    } catch (e) { toast.error(errorMessage(e)); load(); }
  };

  return (
    <div className="space-y-4 max-w-[1400px]">
      <PageHero
        eyebrow="Content"
        title="CMS Pages"
        subtitle="Create and manage footer / explore pages — no code change required. Drag rows to set the footer order."
        actions={<button onClick={() => setEditing({})} className="btn-primary text-sm">+ New Page</button>}
      />

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] text-text-muted uppercase border-b border-border-dark">
            <tr>
              <th className="p-2.5 w-8"></th>
              <th className="p-2.5 text-left">Title</th>
              <th className="p-2.5 text-left">Slug</th>
              <th className="p-2.5 text-left">Status</th>
              <th className="p-2.5 text-left">Footer</th>
              <th className="p-2.5 text-left">Visibility</th>
              <th className="p-2.5 text-right">Views</th>
              <th className="p-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0, 1, 2].map((i) => <tr key={i} className="border-t border-border-dark/50"><td colSpan={8} className="p-3"><div className="h-4 bg-bg-hover rounded animate-pulse" /></td></tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-10 text-center text-text-muted">No pages yet. Create your first page.</td></tr>
            ) : rows.map((p) => (
              <tr key={p._id} className="table-row align-middle"
                draggable onDragStart={() => { dragId.current = p._id; }}
                onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(p._id)}>
                <td className="p-2.5 text-text-muted cursor-grab" title="Drag to reorder">⠿</td>
                <td className="p-2.5 font-semibold text-white">{p.title}</td>
                <td className="p-2.5 text-text-muted">/page/{p.slug}</td>
                <td className="p-2.5"><Badge status={p.status} /></td>
                <td className="p-2.5">{p.showInFooter ? <span className="text-emerald-400 text-xs">Shown · #{p.order}</span> : <span className="text-text-muted text-xs">Hidden</span>}</td>
                <td className="p-2.5 text-xs text-text-secondary">{p.visibility === 'AUTH' ? 'Logged-in' : 'Public'}</td>
                <td className="p-2.5 text-right text-text-muted">{fmtNum(p.views, 0)}</td>
                <td className="p-2.5 text-right">
                  <div className="inline-flex gap-1">
                    <button onClick={() => setPreview(p)} className="btn-ghost text-[11px] px-2 py-1">Preview</button>
                    <button onClick={() => setEditing(p)} className="btn-ghost text-[11px] px-2 py-1">Edit</button>
                    <button onClick={() => togglePublish(p)} className={`text-[11px] px-2 py-1 rounded ${p.status === 'PUBLISHED' ? 'text-warn hover:bg-warn/10' : 'text-emerald-400 hover:bg-emerald-500/10'}`}>
                      {p.status === 'PUBLISHED' ? 'Unpublish' : 'Publish'}
                    </button>
                    <button onClick={() => remove(p)} className="text-[11px] px-2 py-1 rounded text-bear hover:bg-bear/10">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <FooterSettings />

      {editing && <PageEditor page={editing} columns={[...new Set(rows.map((r) => r.footerColumn).filter(Boolean))]} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onPreview={(p) => setPreview(p)} />}
      {preview && <PreviewModal page={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

// Footer brand / address / socials / copyright — the multi-column footer chrome.
const SOCIAL_KEYS = ['facebook', 'twitter', 'youtube', 'linkedin', 'instagram', 'whatsapp', 'telegram', 'skype'];
function FooterSettings() {
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setSocial = (k, v) => setF((s) => ({ ...s, socials: { ...(s.socials || {}), [k]: v } }));

  useEffect(() => {
    api.get('/admin/cms/footer-config')
      .then((r) => setF({ brand: '', tagline: '', address: '', copyright: '', socials: {}, ...(r.data.data || {}) }))
      .catch(() => setF({ brand: '', tagline: '', address: '', copyright: '', socials: {} }));
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api.put('/admin/cms/footer-config', f); toast.success('Footer settings saved'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  if (!f) return null;
  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-white">Footer Settings</h3>
        <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save Footer'}</button>
      </div>
      <p className="text-[11px] text-text-muted">Brand, address & socials shown on the public footer. Links/columns are the pages above (set each page's Footer Column).</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><label className="label">Brand name</label><input className="input" value={f.brand} onChange={(e) => set('brand', e.target.value)} placeholder="TradePro" /></div>
        <div><label className="label">Tagline <span className="text-text-muted">(optional)</span></label><input className="input" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} /></div>
        <div className="md:col-span-2"><label className="label">Address</label><textarea className="input min-h-[60px]" value={f.address} onChange={(e) => set('address', e.target.value)} placeholder={'Chirala, Bapatla district,\nAndhra Pradesh, India 523155'} /></div>
        <div className="md:col-span-2"><label className="label">Copyright <span className="text-text-muted">(blank = auto)</span></label><input className="input" value={f.copyright} onChange={(e) => set('copyright', e.target.value)} placeholder="© 2026 · TradePro · All rights reserved" /></div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-primary-500 font-bold mb-2">Social links <span className="text-text-muted normal-case">(blank = hidden)</span></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {SOCIAL_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-xs text-text-muted w-20 capitalize shrink-0">{k}</span>
              <input className="input" value={f.socials?.[k] || ''} onChange={(e) => setSocial(k, e.target.value)} placeholder={`https://…/${k}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const Badge = ({ status }) => (
  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${status === 'PUBLISHED' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-bg-hover text-text-muted border-border-dark'}`}>{status}</span>
);

function PageEditor({ page, columns = [], onClose, onSaved, onPreview }) {
  const isNew = !page._id;
  const [f, setF] = useState({
    title: page.title || '', slug: page.slug || '', content: page.content || '',
    featuredImageUrl: page.featuredImageUrl || '', seoTitle: page.seoTitle || '',
    seoDescription: page.seoDescription || '', metaKeywords: (page.metaKeywords || []).join(', '),
    showInFooter: page.showInFooter !== false, footerLabel: page.footerLabel || '',
    footerColumn: page.footerColumn || 'Company',
    openInNewTab: !!page.openInNewTab, visibility: page.visibility || 'PUBLIC',
    status: page.status || 'DRAFT',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const payload = () => ({ ...f, metaKeywords: f.metaKeywords });
  const save = async (publish) => {
    if (!f.title.trim()) { toast.error('Title is required'); return; }
    setSaving(true);
    try {
      const body = { ...payload(), status: publish ? 'PUBLISHED' : f.status };
      if (isNew) await api.post('/admin/cms/pages', body);
      else await api.put(`/admin/cms/pages/${page._id}`, body);
      toast.success(isNew ? 'Page created' : 'Page saved');
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl h-full bg-bg-card border-l border-border-dark overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-bold text-white">{isNew ? 'New Page' : 'Edit Page'}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label">Title *</label><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
            <div className="col-span-2"><label className="label">URL Slug <span className="text-text-muted">(blank = auto from title)</span></label>
              <div className="flex items-center gap-1"><span className="text-text-muted text-sm">/page/</span><input className="input" value={f.slug} onChange={(e) => set('slug', e.target.value)} placeholder="about-us" /></div>
            </div>
          </div>

          <div><label className="label">Content</label><RichTextEditor value={f.content} onChange={(html) => set('content', html)} /></div>

          <div><label className="label">Featured Image URL</label><input className="input" value={f.featuredImageUrl} onChange={(e) => set('featuredImageUrl', e.target.value)} placeholder="https://…" />
            {f.featuredImageUrl ? <img src={f.featuredImageUrl} alt="" className="mt-2 h-24 rounded border border-border-dark object-cover" /> : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Visibility</label><select className="input" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}><option value="PUBLIC">Public</option><option value="AUTH">Logged-in users only</option></select></div>
            <div><label className="label">Footer Label <span className="text-text-muted">(optional)</span></label><input className="input" value={f.footerLabel} onChange={(e) => set('footerLabel', e.target.value)} placeholder={f.title} /></div>
            <div><label className="label">Footer Column <span className="text-text-muted">(group)</span></label>
              <input className="input" value={f.footerColumn} onChange={(e) => set('footerColumn', e.target.value)} placeholder="Type a column, e.g. Products" />
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {[...new Set(['Company', 'Products', 'Resources', 'Support', ...columns])].map((c) => (
                  <button type="button" key={c} onClick={() => set('footerColumn', c)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${f.footerColumn === c ? 'bg-primary-500/15 text-primary-500 border-primary-500/40' : 'bg-bg-hover text-text-muted border-border-dark hover:text-text-secondary'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-text-muted mt-1">Pick one, or type any name to create a new column.</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.showInFooter} onChange={(e) => set('showInFooter', e.target.checked)} /> Show in footer</label>
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.openInNewTab} onChange={(e) => set('openInNewTab', e.target.checked)} /> Open in new tab</label>
          </div>

          <div className="border-t border-border-dark pt-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-primary-500 font-bold">SEO</div>
            <div><label className="label">SEO Title</label><input className="input" value={f.seoTitle} onChange={(e) => set('seoTitle', e.target.value)} /></div>
            <div><label className="label">SEO Description</label><textarea className="input min-h-[60px]" value={f.seoDescription} onChange={(e) => set('seoDescription', e.target.value)} /></div>
            <div><label className="label">Meta Keywords <span className="text-text-muted">(comma separated)</span></label><input className="input" value={f.metaKeywords} onChange={(e) => set('metaKeywords', e.target.value)} /></div>
          </div>
        </div>
        <div className="sticky bottom-0 bg-bg-card border-t border-border-dark p-4 flex items-center justify-between gap-2">
          <button onClick={() => onPreview({ ...page, ...f, metaKeywords: f.metaKeywords.split(',').map((s) => s.trim()).filter(Boolean) })} className="btn-ghost text-sm">Preview</button>
          <div className="flex gap-2">
            <button onClick={() => save(false)} disabled={saving} className="btn-secondary text-sm">Save Draft</button>
            <button onClick={() => save(true)} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Publish'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({ page, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Preview · {page.status || 'DRAFT'}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-6">
          {page.featuredImageUrl ? <img src={page.featuredImageUrl} alt="" className="w-full rounded-lg mb-4 max-h-64 object-cover" /> : null}
          <h1 className="text-2xl font-bold text-white mb-4">{page.title}</h1>
          <div className="cms-content" dangerouslySetInnerHTML={{ __html: page.content || '<p class="text-text-muted">No content.</p>' }} />
        </div>
      </div>
    </div>
  );
}
