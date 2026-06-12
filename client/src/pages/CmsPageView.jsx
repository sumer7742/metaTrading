import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, errorMessage } from '../services/api';
import PublicShell from '../components/PublicShell';
import { fmtDate } from '../utils/format';
import { setPageSeo, resetPageSeo } from '../utils/seo';

/**
 * Public renderer for a CMS page at /page/:slug. Content is admin-authored
 * HTML rendered inside a .cms-content prose wrapper. Handles AUTH-only pages
 * (prompts sign-in) and not-found.
 */
export default function CmsPageView() {
  const { slug } = useParams();
  const [page, setPage] = useState(null);
  const [state, setState] = useState('loading'); // loading | ok | notfound | auth

  useEffect(() => {
    let on = true;
    setState('loading');
    api.get(`/cms/pages/${slug}`)
      .then((r) => {
        if (!on) return;
        const p = r.data.data;
        setPage(p);
        setState('ok');
        setPageSeo({
          title: p.seoTitle || p.title || 'TradePro',
          description: p.seoDescription,
          keywords: p.metaKeywords,
          image: p.featuredImageUrl,
          type: 'article',
        });
      })
      .catch((e) => {
        if (!on) return;
        const code = e?.response?.data?.error?.code;
        setState(code === 'AUTH_REQUIRED' ? 'auth' : 'notfound');
      });
    return () => { on = false; resetPageSeo(); };
  }, [slug]);

  return (
    <PublicShell>
      <div className="max-w-[820px] mx-auto px-4 sm:px-6 py-10">
        {state === 'loading' && (
          <div className="space-y-3">
            <div className="h-8 w-2/3 rounded bg-bg-hover animate-pulse" />
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-4 rounded bg-bg-hover animate-pulse" style={{ width: `${90 - i * 8}%` }} />)}
          </div>
        )}

        {state === 'notfound' && (
          <div className="text-center py-20">
            <h1 className="text-2xl font-bold text-text-primary">Page not found</h1>
            <p className="text-text-secondary mt-2">This page may have been moved or unpublished.</p>
            <Link to="/" className="btn-primary inline-block mt-6">Go Home</Link>
          </div>
        )}

        {state === 'auth' && (
          <div className="text-center py-20">
            <h1 className="text-2xl font-bold text-text-primary">Members only</h1>
            <p className="text-text-secondary mt-2">Please sign in to view this page.</p>
            <Link to="/login" className="btn-primary inline-block mt-6">Sign In</Link>
          </div>
        )}

        {state === 'ok' && page && (
          <article>
            {page.featuredImageUrl ? (
              <img src={page.featuredImageUrl} alt={page.title} className="w-full rounded-xl border border-border-dark mb-6 object-cover max-h-[360px]" />
            ) : null}
            <h1 className="text-3xl font-bold text-text-primary">{page.title}</h1>
            <div className="text-xs text-text-muted mt-2">Updated {fmtDate(page.updatedAt || page.publishedAt)}</div>
            <div className="cms-content mt-6" dangerouslySetInnerHTML={{ __html: page.content || '' }} />
          </article>
        )}
      </div>
    </PublicShell>
  );
}
