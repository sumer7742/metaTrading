import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

/**
 * CMS-driven footer. Links are loaded from the admin-managed CMS — no code
 * change is needed to add/remove/reorder a footer link. "Daily News Updates"
 * is always present (the dedicated news section).
 */
export default function CmsFooter() {
  const [links, setLinks] = useState([]);

  useEffect(() => {
    let on = true;
    api.get('/cms/footer-links')
      .then((r) => { if (on) setLinks(r.data.data || []); })
      .catch(() => { /* footer is non-critical */ });
    return () => { on = false; };
  }, []);

  const year = new Date().getFullYear();

  const linkCls = 'text-sm text-text-secondary hover:text-primary-500 transition-colors';

  return (
    <footer className="border-t border-border-dark bg-bg-card/40 mt-12">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Links — left aligned */}
        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
          <Link to="/news" className={linkCls}>Daily News Updates</Link>
          {links.map((l) => (
            l.openInNewTab ? (
              <a key={l.slug} href={l.href} target="_blank" rel="noopener noreferrer" className={linkCls}>{l.label}</a>
            ) : (
              <Link key={l.slug} to={l.href} className={linkCls}>{l.label}</Link>
            )
          ))}
        </nav>

        {/* Divider + bottom row */}
        <div className="mt-6 pt-5 border-t border-border-subtle flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="text-xs text-text-muted">© {year} TradePro. All rights reserved.</p>
          <p className="text-[11px] text-text-muted">
            Trading involves risk. Content is for informational purposes only.
          </p>
        </div>
      </div>
    </footer>
  );
}
