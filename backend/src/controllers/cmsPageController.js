/**
 * CMS Pages — public read endpoints + admin management.
 *
 * Public:  footer links, page-by-slug (visibility + view tracking).
 * Admin:   list (incl. drafts), get-by-id (preview), create, update,
 *          publish/unpublish, reorder (drag & drop), delete.
 */
const CmsPage = require('../models/CmsPage');
const { AuditLog } = require('../models');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { uniqueSlug, sanitizeHtml } = require('../utils/cms');
const systemSettings = require('../services/systemSettings.service');

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=120';

async function audit(req, action, targetId, metadata = {}) {
  try {
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action,
      targetType: 'CMS_PAGE', targetId: targetId != null ? String(targetId) : undefined,
      metadata, ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

/* ───────────────────────── PUBLIC ───────────────────────── */

// Footer links + footer config (brand / address / socials / copyright). Links
// carry their column group so the client renders a multi-column footer.
const footerLinks = asyncHandler(async (req, res) => {
  const lang = req.query.lang || 'en';
  const [pages, config] = await Promise.all([
    CmsPage.find({ status: 'PUBLISHED', showInFooter: true, language: lang })
      .select('slug title footerLabel footerColumn openInNewTab order visibility')
      .sort({ order: 1, title: 1 }).lean(),
    systemSettings.getSetting('footer.config'),
  ]);
  const links = pages.map((p) => ({
    slug: p.slug,
    label: p.footerLabel || p.title,
    href: `/page/${p.slug}`,
    column: p.footerColumn || 'Company',
    openInNewTab: !!p.openInNewTab,
    authOnly: p.visibility === 'AUTH',
  }));
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, { links, config: config || {} });
});

// Admin: read the footer config (brand / address / socials / copyright).
const getFooterConfig = asyncHandler(async (req, res) => {
  sendSuccess(res, (await systemSettings.getSetting('footer.config')) || {});
});

// Admin: update the footer config.
const setFooterConfig = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cur = (await systemSettings.getSetting('footer.config')) || {};
  const next = {
    brand:     b.brand     !== undefined ? String(b.brand)     : (cur.brand || ''),
    logoUrl:   b.logoUrl   !== undefined ? String(b.logoUrl)   : (cur.logoUrl || ''),
    tagline:   b.tagline   !== undefined ? String(b.tagline)   : (cur.tagline || ''),
    address:   b.address   !== undefined ? String(b.address)   : (cur.address || ''),
    copyright: b.copyright !== undefined ? String(b.copyright) : (cur.copyright || ''),
    socials:   { ...(cur.socials || {}), ...(b.socials || {}) },
    customSocials: Array.isArray(b.customSocials)
      ? b.customSocials
          .map((c) => ({ label: String(c.label || '').slice(0, 40), url: String(c.url || ''), icon: String(c.icon || '') }))
          .filter((c) => c.url)
      : (cur.customSocials || []),
  };
  await systemSettings.setSetting('footer.config', next, req.userId);
  await audit(req, 'CMS_FOOTER_CONFIG_UPDATE', null, {});
  sendSuccess(res, next);
});

// ── Economic calendar (admin-managed events + show/hide toggle) ──────────
// Stored in systemSettings under 'economic.config' as { enabled, events }. The
// client MERGES these admin events with its own generated global schedule, so
// the built-in events keep showing unless the admin turns the section off
// (enabled=false).
const _normEconEvents = (arr) => (Array.isArray(arr) ? arr : [])
  .map((e) => ({
    id:        String(e.id || `adm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    date:      e.date ? new Date(e.date).toISOString() : null,
    country:   String(e.country || '').slice(0, 4).toUpperCase(),
    currency:  String(e.currency || '').slice(0, 6).toUpperCase(),
    impact:    ['high', 'medium', 'low'].includes(String(e.impact)) ? e.impact : 'medium',
    event:     String(e.event || e.name || '').slice(0, 120),
    previous:  e.previous === '' || e.previous == null ? null : Number(e.previous),
    consensus: e.consensus === '' || e.consensus == null ? null : Number(e.consensus),
    forecast:  e.forecast === '' || e.forecast == null ? null : Number(e.forecast),
    actual:    e.actual === '' || e.actual == null ? null : Number(e.actual),
    unit:      String(e.unit || '').slice(0, 8),
  }))
  .filter((e) => e.date && e.event);

// Public: enabled flag + admin events (client merges with its generated set).
const economicCalendar = asyncHandler(async (req, res) => {
  const cfg = (await systemSettings.getSetting('economic.config')) || {};
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, { enabled: cfg.enabled !== false, events: _normEconEvents(cfg.events) });
});

// Admin: read the economic-calendar config.
const getEconomicConfig = asyncHandler(async (req, res) => {
  const cfg = (await systemSettings.getSetting('economic.config')) || {};
  sendSuccess(res, { enabled: cfg.enabled !== false, events: _normEconEvents(cfg.events) });
});

// Admin: replace the economic-calendar config ({ enabled, events }).
const setEconomicConfig = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const next = { enabled: b.enabled !== false, events: _normEconEvents(b.events).slice(0, 200) };
  await systemSettings.setSetting('economic.config', next, req.userId);
  await audit(req, 'CMS_ECONOMIC_CALENDAR_UPDATE', null, { count: next.events.length, enabled: next.enabled });
  sendSuccess(res, next);
});

// ── Knowledge base (admin-managed help articles + optional video) ────────
// Stored in systemSettings under 'kb.config' as { articles }. The client MERGES
// these with its built-in default FAQ set, so both show together. Each article
// may carry a `videoUrl` (YouTube/Vimeo/mp4) rendered in the card.
const _normKbArticles = (arr) => (Array.isArray(arr) ? arr : [])
  .map((a) => ({
    id:       String(a.id || `kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    tag:      String(a.tag || 'General').slice(0, 40),
    q:        String(a.q || a.question || '').slice(0, 200),
    a:        String(a.a || a.answer || '').slice(0, 4000),
    link:     String(a.link || '').slice(0, 300),
    videoUrl: String(a.videoUrl || '').slice(0, 500),
  }))
  .filter((a) => a.q && a.a);

// Public: admin articles (client merges with its generated/default set).
const knowledgeBase = asyncHandler(async (req, res) => {
  const cfg = (await systemSettings.getSetting('kb.config')) || {};
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, { articles: _normKbArticles(cfg.articles) });
});

// Admin: read the knowledge-base config.
const getKnowledgeConfig = asyncHandler(async (req, res) => {
  const cfg = (await systemSettings.getSetting('kb.config')) || {};
  sendSuccess(res, { articles: _normKbArticles(cfg.articles) });
});

// Admin: replace the knowledge-base config ({ articles }).
const setKnowledgeConfig = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const next = { articles: _normKbArticles(b.articles).slice(0, 100) };
  await systemSettings.setSetting('kb.config', next, req.userId);
  await audit(req, 'CMS_KNOWLEDGE_BASE_UPDATE', null, { count: next.articles.length });
  sendSuccess(res, next);
});

// Single published page by slug. Honors visibility; tracks views.
const getPublicBySlug = asyncHandler(async (req, res) => {
  const page = await CmsPage.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'PUBLISHED' }).lean();
  if (!page) throw new AppError('Page not found', 404, 'NOT_FOUND');
  if (page.visibility === 'AUTH' && !req.user) {
    throw new AppError('Please sign in to view this page', 401, 'AUTH_REQUIRED');
  }
  // Fire-and-forget view counter (don't block the response).
  CmsPage.updateOne({ _id: page._id }, { $inc: { views: 1 } }).catch(() => {});
  res.set('Cache-Control', page.visibility === 'AUTH' ? 'private, max-age=30' : PUBLIC_CACHE);
  sendSuccess(res, page);
});

/* ───────────────────────── ADMIN ───────────────────────── */

const adminList = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { slug: rx }];
  }
  const pages = await CmsPage.find(filter).sort({ order: 1, createdAt: -1 }).lean();
  sendSuccess(res, pages);
});

const adminGet = asyncHandler(async (req, res) => {
  const page = await CmsPage.findById(req.params.id).lean();
  if (!page) throw new AppError('Page not found', 404);
  sendSuccess(res, page);
});

const adminCreate = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title) throw new AppError('Title is required', 400);
  const slug = await uniqueSlug(CmsPage, b.slug || b.title);
  const maxOrder = await CmsPage.findOne().sort({ order: -1 }).select('order').lean();
  const page = await CmsPage.create({
    title: b.title,
    slug,
    content: sanitizeHtml(b.content),
    status: b.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
    visibility: b.visibility === 'AUTH' ? 'AUTH' : 'PUBLIC',
    featuredImageUrl: b.featuredImageUrl || '',
    seoTitle: b.seoTitle || '',
    seoDescription: b.seoDescription || '',
    metaKeywords: normalizeKeywords(b.metaKeywords),
    showInFooter: b.showInFooter !== false,
    footerLabel: b.footerLabel || '',
    footerColumn: b.footerColumn || 'Company',
    openInNewTab: !!b.openInNewTab,
    order: Number.isFinite(+b.order) ? +b.order : ((maxOrder?.order || 0) + 1),
    language: b.language || 'en',
    publishedAt: b.status === 'PUBLISHED' ? new Date() : null,
    createdBy: req.userId,
  });
  await audit(req, 'CMS_PAGE_CREATE', page._id, { slug: page.slug, status: page.status });
  sendSuccess(res, page, 201);
});

const adminUpdate = asyncHandler(async (req, res) => {
  const page = await CmsPage.findById(req.params.id);
  if (!page) throw new AppError('Page not found', 404);
  const b = req.body || {};

  if (b.title !== undefined) page.title = b.title;
  if (b.slug !== undefined && b.slug) page.slug = await uniqueSlug(CmsPage, b.slug, page._id);
  if (b.content !== undefined) page.content = sanitizeHtml(b.content);
  if (b.visibility !== undefined) page.visibility = b.visibility === 'AUTH' ? 'AUTH' : 'PUBLIC';
  if (b.featuredImageUrl !== undefined) page.featuredImageUrl = b.featuredImageUrl || '';
  if (b.seoTitle !== undefined) page.seoTitle = b.seoTitle || '';
  if (b.seoDescription !== undefined) page.seoDescription = b.seoDescription || '';
  if (b.metaKeywords !== undefined) page.metaKeywords = normalizeKeywords(b.metaKeywords);
  if (b.showInFooter !== undefined) page.showInFooter = !!b.showInFooter;
  if (b.footerLabel !== undefined) page.footerLabel = b.footerLabel || '';
  if (b.footerColumn !== undefined) page.footerColumn = b.footerColumn || 'Company';
  if (b.openInNewTab !== undefined) page.openInNewTab = !!b.openInNewTab;
  if (b.order !== undefined && Number.isFinite(+b.order)) page.order = +b.order;
  if (b.language !== undefined) page.language = b.language || 'en';
  if (b.status !== undefined) {
    const next = b.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
    if (next === 'PUBLISHED' && page.status !== 'PUBLISHED') page.publishedAt = new Date();
    page.status = next;
  }
  page.updatedBy = req.userId;
  await page.save();
  await audit(req, 'CMS_PAGE_UPDATE', page._id, { slug: page.slug, status: page.status });
  sendSuccess(res, page);
});

const adminPublish = asyncHandler(async (req, res) => {
  const publish = req.body.publish !== false;
  const page = await CmsPage.findById(req.params.id);
  if (!page) throw new AppError('Page not found', 404);
  page.status = publish ? 'PUBLISHED' : 'DRAFT';
  if (publish && !page.publishedAt) page.publishedAt = new Date();
  page.updatedBy = req.userId;
  await page.save();
  await audit(req, publish ? 'CMS_PAGE_PUBLISH' : 'CMS_PAGE_UNPUBLISH', page._id, { slug: page.slug });
  sendSuccess(res, { _id: page._id, status: page.status });
});

// Drag & drop reorder — accepts [{ id, order }, ...].
const adminReorder = asyncHandler(async (req, res) => {
  const orders = Array.isArray(req.body.orders) ? req.body.orders : [];
  if (!orders.length) throw new AppError('orders[] required', 400);
  await Promise.all(orders.map((o) =>
    CmsPage.updateOne({ _id: o.id }, { $set: { order: Number(o.order) || 0 } })
  ));
  await audit(req, 'CMS_PAGE_REORDER', null, { count: orders.length });
  sendSuccess(res, { ok: true });
});

const adminDelete = asyncHandler(async (req, res) => {
  const page = await CmsPage.findByIdAndDelete(req.params.id);
  if (!page) throw new AppError('Page not found', 404);
  await audit(req, 'CMS_PAGE_DELETE', page._id, { slug: page.slug });
  sendSuccess(res, { ok: true });
});

function normalizeKeywords(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

module.exports = {
  footerLinks, getPublicBySlug,
  adminList, adminGet, adminCreate, adminUpdate, adminPublish, adminReorder, adminDelete,
  getFooterConfig, setFooterConfig,
  economicCalendar, getEconomicConfig, setEconomicConfig,
  knowledgeBase, getKnowledgeConfig, setKnowledgeConfig,
};
