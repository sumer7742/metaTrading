import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

// Admin-managed Knowledge Base articles. These MERGE with the client's built-in
// default FAQ set (they don't replace it). Each article can carry an optional
// in-app link and a video (YouTube / Vimeo / direct mp4). Stored as a whole
// { articles } blob in systemSettings ('kb.config').

const blank = () => ({
  id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  tag: 'General', q: '', a: '', link: '', videoUrl: '',
});

export default function KnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/cms/knowledge-config');
      setArticles((data.data?.articles || []).map((a) => ({ ...blank(), ...a })));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const update = (id, k, v) => setArticles((arr) => arr.map((a) => (a.id === id ? { ...a, [k]: v } : a)));
  const addRow = () => setArticles((arr) => [blank(), ...arr]);
  const removeRow = (id) => setArticles((arr) => arr.filter((a) => a.id !== id));

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        articles: articles
          .filter((a) => String(a.q).trim() && String(a.a).trim())
          .map((a) => ({ id: a.id, tag: a.tag, q: a.q, a: a.a, link: a.link, videoUrl: a.videoUrl })),
      };
      const { data } = await api.put('/admin/cms/knowledge-config', payload);
      setArticles((data.data?.articles || []).map((a) => ({ ...blank(), ...a })));
      toast.success('Knowledge base saved');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Knowledge Base</h1>
          <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
            Add your own help articles (with an optional in-app link and a video). They appear in the
            client’s Help → Knowledge Base <b>alongside</b> the built-in FAQ.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={addRow} className="btn-secondary text-sm">+ Add article</button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {loading && <div className="card p-6 text-center text-text-muted text-sm">Loading…</div>}
      {!loading && !articles.length && (
        <div className="card p-6 text-center text-text-muted text-sm">No custom articles yet — click “+ Add article”. The built-in FAQ still shows to users.</div>
      )}

      <div className="space-y-3">
        {articles.map((a) => (
          <div key={a.id} className="card p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-3">
              <div>
                <label className="label">Category</label>
                <input className="input" value={a.tag} onChange={(e) => update(a.id, 'tag', e.target.value)} placeholder="Trading" />
              </div>
              <div>
                <label className="label">Question</label>
                <input className="input" value={a.q} onChange={(e) => update(a.id, 'q', e.target.value)} placeholder="How is margin calculated?" />
              </div>
            </div>
            <div>
              <label className="label">Answer</label>
              <textarea className="input min-h-[80px]" value={a.a} onChange={(e) => update(a.id, 'a', e.target.value)} placeholder="Answer text… (line breaks are preserved)" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Link <span className="font-normal text-gray-500">— optional, in-app path</span></label>
                <input className="input font-mono text-xs" value={a.link} onChange={(e) => update(a.id, 'link', e.target.value)} placeholder="/wallet" />
              </div>
              <div>
                <label className="label">Video URL <span className="font-normal text-gray-500">— optional, YouTube/Vimeo/mp4</span></label>
                <input className="input font-mono text-xs" value={a.videoUrl} onChange={(e) => update(a.id, 'videoUrl', e.target.value)} placeholder="https://youtu.be/…" />
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={() => removeRow(a.id)} className="text-bear hover:bg-bear/10 rounded px-2.5 py-1 text-xs font-semibold">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
