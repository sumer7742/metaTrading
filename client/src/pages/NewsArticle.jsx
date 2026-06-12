import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import PublicShell from '../components/PublicShell';
import { fmtDate } from '../utils/format';
import { setPageSeo, resetPageSeo } from '../utils/seo';

/**
 * Public news article at /news/:slug.
 */
export default function NewsArticle() {
  const { slug } = useParams();
  const [a, setA] = useState(null);
  const [state, setState] = useState('loading'); // loading | ok | notfound

  useEffect(() => {
    let on = true;
    setState('loading');
    api.get(`/cms/news/${slug}`)
      .then((r) => {
        if (!on) return;
        const a2 = r.data.data;
        setA(a2); setState('ok');
        setPageSeo({
          title: `${a2.title} · TradePro`,
          description: a2.excerpt,
          keywords: a2.tags,
          image: a2.featuredImageUrl,
          type: 'article',
        });
      })
      .catch(() => { if (on) setState('notfound'); });
    return () => { on = false; resetPageSeo(); };
  }, [slug]);

  return (
    <PublicShell>
      <div className="max-w-[820px] mx-auto px-4 sm:px-6 py-10">
        <Link to="/news" className="text-sm text-primary-500 hover:underline">← Back to News</Link>

        {state === 'loading' && (
          <div className="space-y-3 mt-6">
            <div className="h-8 w-2/3 rounded bg-bg-hover animate-pulse" />
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-4 rounded bg-bg-hover animate-pulse" style={{ width: `${90 - i * 10}%` }} />)}
          </div>
        )}

        {state === 'notfound' && (
          <div className="text-center py-20">
            <h1 className="text-2xl font-bold text-text-primary">Article not found</h1>
            <Link to="/news" className="btn-primary inline-block mt-6">All News</Link>
          </div>
        )}

        {state === 'ok' && a && (
          <article className="mt-4">
            <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
              <span className="px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-500 font-semibold">{a.category}</span>
              <span>{fmtDate(a.publishDate)}</span>
              {a.author ? <span>· By {a.author}</span> : null}
            </div>
            <h1 className="text-3xl font-bold text-text-primary">{a.title}</h1>
            {a.featuredImageUrl ? (
              <img src={a.featuredImageUrl} alt={a.title} className="w-full rounded-xl border border-border-dark my-6 object-cover max-h-[400px]" />
            ) : <div className="mt-6" />}
            {a.excerpt ? <p className="text-lg text-text-secondary mb-4">{a.excerpt}</p> : null}
            <div className="cms-content" dangerouslySetInnerHTML={{ __html: a.content || '' }} />
            {a.tags?.length ? (
              <div className="flex flex-wrap gap-2 mt-8 pt-4 border-t border-border-subtle">
                {a.tags.map((t) => <span key={t} className="text-xs text-text-muted bg-bg-hover px-2 py-1 rounded">#{t}</span>)}
              </div>
            ) : null}
          </article>
        )}
      </div>
    </PublicShell>
  );
}
