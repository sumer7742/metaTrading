/**
 * CMS helpers — slug generation/uniqueness and a lightweight HTML sanitizer.
 *
 * Authors are trusted admins (Super Admin / Admin), but we still strip the
 * obviously dangerous bits as defense-in-depth before persisting content.
 */

const slugify = (s) =>
  String(s || '')
    .toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

// Ensure the slug is unique for the given model (append -2, -3, … on collision).
async function uniqueSlug(Model, base, excludeId = null) {
  let slug = slugify(base) || 'page';
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const q = { slug };
    if (excludeId) q._id = { $ne: excludeId };
    const exists = await Model.exists(q);
    if (!exists) return slug;
    n += 1;
    slug = `${slugify(base) || 'page'}-${n}`;
  }
}

// Remove <script>/<style>/<iframe> blocks, on*="" handlers and javascript: URIs.
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

module.exports = { slugify, uniqueSlug, sanitizeHtml };
