import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

/**
 * CMS-driven multi-column footer.
 *   • Left: brand + address + social icons (admin → CMS Pages → Footer Settings).
 *   • Right: link columns grouped by each page's `footerColumn`.
 *   • Bottom: centered copyright.
 * Everything is admin-managed — no code change to add a link/column or edit the
 * brand/address/socials.
 */

// Brand icons (single-path where possible), tinted via currentColor.
const SOCIAL_ICONS = {
  facebook:  'M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z',
  twitter:   'M18.9 2H22l-7.5 8.6L23 22h-6.9l-5.4-7-6.2 7H1.4l8-9.2L1 2h7l4.9 6.5L18.9 2zm-1.2 18h1.9L7.1 4H5.1l12.6 16z',
  youtube:   'M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.8-1.8C19.3 5 12 5 12 5s-7.3 0-8.8.5A2.5 2.5 0 0 0 1.4 7.3C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.8 1.8C4.7 19 12 19 12 19s7.3 0 8.8-.5a2.5 2.5 0 0 0 1.8-1.8c.4-1.5.4-4.7.4-4.7zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z',
  linkedin:  'M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.3 0-2.95-1.8-2.95s-2.07 1.4-2.07 2.85V21h-4z',
  instagram: 'M12 2.2c3.2 0 3.6 0 4.85.07 1.17.05 1.8.25 2.23.42.56.22.96.48 1.38.9.42.42.68.82.9 1.38.17.42.37 1.06.42 2.23.06 1.25.07 1.65.07 4.85s0 3.6-.07 4.85c-.05 1.17-.25 1.8-.42 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.17-1.06.37-2.23.42-1.25.06-1.65.07-4.85.07s-3.6 0-4.85-.07c-1.17-.05-1.8-.25-2.23-.42-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.17-.42-.37-1.06-.42-2.23C2.21 15.6 2.2 15.2 2.2 12s0-3.6.07-4.85c.05-1.17.25-1.8.42-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.17 1.06-.37 2.23-.42C8.4 2.21 8.8 2.2 12 2.2zm0 1.8c-3.15 0-3.52.01-4.76.07-.9.04-1.38.19-1.7.32-.43.16-.74.36-1.06.68-.32.32-.52.63-.68 1.06-.13.32-.28.8-.32 1.7C3.21 8.48 3.2 8.85 3.2 12s.01 3.52.07 4.76c.04.9.19 1.38.32 1.7.16.43.36.74.68 1.06.32.32.63.52 1.06.68.32.13.8.28 1.7.32 1.24.06 1.61.07 4.76.07s3.52-.01 4.76-.07c.9-.04 1.38-.19 1.7-.32.43-.16.74-.36 1.06-.68.32-.32.52-.63.68-1.06.13-.32.28-.8.32-1.7.06-1.24.07-1.61.07-4.76s-.01-3.52-.07-4.76c-.04-.9-.19-1.38-.32-1.7a2.86 2.86 0 0 0-.68-1.06 2.86 2.86 0 0 0-1.06-.68c-.32-.13-.8-.28-1.7-.32C15.52 4.01 15.15 4 12 4zm0 3.06A4.94 4.94 0 1 0 12 17a4.94 4.94 0 0 0 0-9.88zm0 8.14A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4zm5.13-8.34a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0z',
  whatsapp:  'M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-2.9.76.77-2.83-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.13c-.25-.12-1.47-.72-1.7-.8-.23-.09-.4-.13-.56.12s-.64.8-.79.97c-.14.16-.29.18-.54.06a6.7 6.7 0 0 1-3.35-2.93c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.42-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.41-.56-.42h-.48c-.16 0-.42.06-.64.3-.22.25-.84.83-.84 2.02s.86 2.35.98 2.51c.12.16 1.7 2.6 4.12 3.65.58.25 1.02.4 1.37.5.58.19 1.1.16 1.52.1.46-.07 1.47-.6 1.68-1.18.2-.58.2-1.07.14-1.18-.05-.1-.22-.16-.47-.28z',
  telegram:  'M21.94 4.6 18.7 19.9c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.38 2.29c-.26.26-.48.48-.99.48l.35-5 9.1-8.22c.4-.35-.09-.55-.62-.2L4.62 13.1l-4.85-1.52c-1.05-.33-1.07-1.05.22-1.56L20.6 3.07c.88-.33 1.65.2 1.34 1.53z',
  skype:     'M12 2a4 4 0 0 0-3.9 4.86A6 6 0 0 0 6 12a6 6 0 0 0 6 6 4 4 0 0 0 3.9-4.86A6 6 0 0 0 18 8a6 6 0 0 0-6-6zm.2 13.2c-2 0-3.4-.95-3.4-2.06 0-.45.34-.79.8-.79.95 0 .9 1.42 2.6 1.42.86 0 1.36-.46 1.36-.92 0-1.5-4.93-.58-4.93-3.55 0-1.32 1.18-2.27 3.1-2.27 1.86 0 3.16.87 3.16 1.9 0 .47-.36.78-.82.78-.85 0-.78-1.18-2.4-1.18-.78 0-1.22.35-1.22.83 0 1.4 4.92.52 4.92 3.52 0 1.43-1.22 2.59-3.13 2.59z',
};

const linkCls = 'text-sm text-text-secondary hover:text-primary-500 transition-colors';

// Default dummy columns — shown when no CMS footer pages exist yet, so the
// footer looks complete out-of-the-box. As soon as admin adds real footer
// pages (with a Footer Column), those replace these.
const DEFAULT_COLUMNS = [
  { name: 'Company', items: [
    { label: 'About Us', href: '#' }, { label: 'Daily News Updates', href: '/news' },
    { label: 'Contact Us', href: '#' }, { label: 'Meet Our Team', href: '#' },
  ] },
  { name: 'Products', items: [
    { label: 'Solutions', href: '#' }, { label: 'Plans & Pricing', href: '#' },
    { label: 'Services', href: '#' }, { label: 'Partners', href: '#' },
  ] },
  { name: 'Resources', items: [
    { label: 'Gallery', href: '#' }, { label: 'Blog Articles', href: '#' },
    { label: 'FAQ', href: '#' }, { label: 'Guidelines', href: '#' },
  ] },
  { name: 'Support', items: [
    { label: 'Knowledge Base', href: '#' }, { label: 'Contact Support', href: '#' },
    { label: 'Privacy Policy', href: '#' }, { label: 'Terms & Conditions', href: '#' },
  ] },
];

// Render a footer link — '#' dummy (non-navigating), external, or internal route.
function FooterLink({ l }) {
  if (l.href === '#') return <a href="#" onClick={(e) => e.preventDefault()} className={linkCls}>{l.label}</a>;
  if (l.openInNewTab || /^https?:/i.test(l.href)) {
    return <a href={l.href} target="_blank" rel="noopener noreferrer" className={linkCls}>{l.label}</a>;
  }
  return <Link to={l.href} className={linkCls}>{l.label}</Link>;
}

export default function CmsFooter() {
  const [links, setLinks] = useState([]);
  const [config, setConfig] = useState({});

  useEffect(() => {
    let on = true;
    api.get('/cms/footer-links')
      .then((r) => {
        if (!on) return;
        const d = r.data.data || {};
        // Back-compat: older API returned a bare array.
        if (Array.isArray(d)) { setLinks(d); setConfig({}); }
        else { setLinks(d.links || []); setConfig(d.config || {}); }
      })
      .catch(() => { /* footer is non-critical */ });
    return () => { on = false; };
  }, []);

  const year = new Date().getFullYear();
  const brand = config.brand || 'TradePro';
  const socials = config.socials || {};
  const activeSocials = useMemo(
    () => Object.keys(SOCIAL_ICONS).filter((k) => socials[k] && String(socials[k]).trim()),
    [socials]
  );

  // Group links by column (preserve first-seen order). When no CMS footer pages
  // exist, fall back to the default dummy columns so the footer looks complete.
  const columns = useMemo(() => {
    if (!links.length) return DEFAULT_COLUMNS;
    const groups = {};
    const order = [];
    for (const l of links) {
      const col = l.column || 'Company';
      if (!groups[col]) { groups[col] = []; order.push(col); }
      groups[col].push(l);
    }
    // Keep the dedicated news section reachable.
    const firstCol = order[0] || 'Company';
    groups[firstCol].unshift({ href: '/news', label: 'Daily News Updates', _news: true });
    return order.map((name) => ({ name, items: groups[name] }));
  }, [links]);

  const copyright = config.copyright
    || `© ${year} · ${brand} · All rights reserved`;

  return (
    <footer className="border-t border-border-dark bg-bg-card/40 mt-12">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-6">
          {/* Brand + address + socials */}
          <div className="lg:col-span-4">
            <div className="flex items-center gap-2.5">
              <span
                className="w-9 h-9 rounded-xl flex items-center justify-center font-extrabold text-white text-base shrink-0"
                style={{ background: 'linear-gradient(135deg,#3B82F6 0%,#1D4ED8 100%)' }}
              >
                {brand.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-lg font-extrabold text-text-primary tracking-tight">{brand}</span>
            </div>

            {config.tagline && <p className="text-sm text-text-secondary mt-3 max-w-xs">{config.tagline}</p>}

            {config.address && (
              <p className="text-sm text-text-secondary mt-3 max-w-xs whitespace-pre-line leading-relaxed">
                {config.address}
              </p>
            )}

            {activeSocials.length > 0 && (
              <div className="flex items-center gap-3 mt-4">
                {activeSocials.map((k) => {
                  const url = socials[k];
                  const dummy = url === '#';
                  return (
                    <a
                      key={k}
                      href={url}
                      {...(dummy ? { onClick: (e) => e.preventDefault() } : { target: '_blank', rel: 'noopener noreferrer' })}
                      aria-label={k}
                      title={k}
                      className="text-text-muted hover:text-primary-500 transition-colors"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d={SOCIAL_ICONS[k]} /></svg>
                    </a>
                  );
                })}
              </div>
            )}
          </div>

          {/* Link columns */}
          <div className="lg:col-span-8 grid grid-cols-2 md:grid-cols-4 gap-6">
            {columns.map((col) => (
              <div key={col.name}>
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-primary mb-3">{col.name}</div>
                <ul className="space-y-2.5">
                  {col.items.map((l, i) => (
                    <li key={l.slug || `${l.label}-${i}`}><FooterLink l={l} /></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom — centered copyright */}
        <div className="mt-10 pt-6 border-t border-border-subtle text-center">
          <p className="text-xs text-text-muted">{copyright}</p>
        </div>
      </div>
    </footer>
  );
}
