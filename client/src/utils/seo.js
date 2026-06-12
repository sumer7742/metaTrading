/**
 * Lightweight client-side SEO head manager (no react-helmet dependency).
 * Sets <title> + upserts <meta> description/keywords and Open Graph / Twitter
 * tags so admin-authored SEO fields actually render into the document head.
 *
 * Note: this runs client-side. JS-executing crawlers (Google, social
 * preview bots) read it; for guaranteed static crawling, SSR/prerender
 * would be required — the data is all stored and ready for that later.
 */
function upsertMeta(attr, key, content) {
  if (content == null) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export function setPageSeo({ title, description, keywords, image, type = 'article' } = {}) {
  if (title) document.title = title;
  if (description) upsertMeta('name', 'description', description);
  if (keywords && keywords.length) {
    upsertMeta('name', 'keywords', Array.isArray(keywords) ? keywords.join(', ') : String(keywords));
  }
  // Open Graph (social link previews)
  upsertMeta('property', 'og:title', title || '');
  if (description) upsertMeta('property', 'og:description', description);
  upsertMeta('property', 'og:type', type);
  if (image) upsertMeta('property', 'og:image', image);
  upsertMeta('property', 'og:url', window.location.href);
  // Twitter
  upsertMeta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
  upsertMeta('name', 'twitter:title', title || '');
  if (description) upsertMeta('name', 'twitter:description', description);
  if (image) upsertMeta('name', 'twitter:image', image);
}

// Restore a sane default when leaving a CMS page.
export function resetPageSeo(defaultTitle = 'TradePro') {
  document.title = defaultTitle;
}
