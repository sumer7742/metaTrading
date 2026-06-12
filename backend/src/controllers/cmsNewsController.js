/**
 * CMS News — "Daily News Updates". Public listing (latest first, search,
 * category filter) + admin management.
 */
const CmsNews = require('../models/CmsNews');
const { AuditLog } = require('../models');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { uniqueSlug, sanitizeHtml } = require('../utils/cms');

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=120';

async function audit(req, action, targetId, metadata = {}) {
  try {
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action,
      targetType: 'CMS_NEWS', targetId: targetId != null ? String(targetId) : undefined,
      metadata, ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

/* ───────────────────────── PUBLIC ───────────────────────── */

// Published news, newest first, with search (q), category filter, pagination.
const listPublic = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const skip = (page - 1) * limit;

  const filter = { status: 'PUBLISHED', publishDate: { $lte: new Date() } };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { excerpt: rx }, { tags: rx }];
  }

  const [items, total] = await Promise.all([
    CmsNews.find(filter).select('-content').sort({ publishDate: -1 }).skip(skip).limit(limit).lean(),
    CmsNews.countDocuments(filter),
  ]);
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

const categoriesPublic = asyncHandler(async (req, res) => {
  const cats = await CmsNews.distinct('category', { status: 'PUBLISHED', publishDate: { $lte: new Date() } });
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, cats.filter(Boolean).sort());
});

const getPublicBySlug = asyncHandler(async (req, res) => {
  const article = await CmsNews.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'PUBLISHED', publishDate: { $lte: new Date() } }).lean();
  if (!article) throw new AppError('Article not found', 404, 'NOT_FOUND');
  CmsNews.updateOne({ _id: article._id }, { $inc: { views: 1 } }).catch(() => {});
  res.set('Cache-Control', PUBLIC_CACHE);
  sendSuccess(res, article);
});

/* ───────────────────────── ADMIN ───────────────────────── */

const adminList = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  if (req.query.category) filter.category = req.query.category;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { slug: rx }, { author: rx }];
  }
  const items = await CmsNews.find(filter).sort({ publishDate: -1 }).lean();
  sendSuccess(res, items);
});

const adminGet = asyncHandler(async (req, res) => {
  const a = await CmsNews.findById(req.params.id).lean();
  if (!a) throw new AppError('Article not found', 404);
  sendSuccess(res, a);
});

const adminCreate = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title) throw new AppError('Title is required', 400);
  const slug = await uniqueSlug(CmsNews, b.slug || b.title);
  const article = await CmsNews.create({
    title: b.title,
    slug,
    excerpt: b.excerpt || '',
    content: sanitizeHtml(b.content),
    category: b.category || 'General',
    author: b.author || '',
    featuredImageUrl: b.featuredImageUrl || '',
    tags: normalizeTags(b.tags),
    status: b.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
    publishDate: b.publishDate ? new Date(b.publishDate) : new Date(),
    language: b.language || 'en',
    createdBy: req.userId,
  });
  await audit(req, 'CMS_NEWS_CREATE', article._id, { slug: article.slug, status: article.status });
  sendSuccess(res, article, 201);
});

const adminUpdate = asyncHandler(async (req, res) => {
  const a = await CmsNews.findById(req.params.id);
  if (!a) throw new AppError('Article not found', 404);
  const b = req.body || {};
  if (b.title !== undefined) a.title = b.title;
  if (b.slug !== undefined && b.slug) a.slug = await uniqueSlug(CmsNews, b.slug, a._id);
  if (b.excerpt !== undefined) a.excerpt = b.excerpt || '';
  if (b.content !== undefined) a.content = sanitizeHtml(b.content);
  if (b.category !== undefined) a.category = b.category || 'General';
  if (b.author !== undefined) a.author = b.author || '';
  if (b.featuredImageUrl !== undefined) a.featuredImageUrl = b.featuredImageUrl || '';
  if (b.tags !== undefined) a.tags = normalizeTags(b.tags);
  if (b.publishDate !== undefined) a.publishDate = b.publishDate ? new Date(b.publishDate) : a.publishDate;
  if (b.language !== undefined) a.language = b.language || 'en';
  if (b.status !== undefined) a.status = b.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
  a.updatedBy = req.userId;
  await a.save();
  await audit(req, 'CMS_NEWS_UPDATE', a._id, { slug: a.slug, status: a.status });
  sendSuccess(res, a);
});

const adminPublish = asyncHandler(async (req, res) => {
  const publish = req.body.publish !== false;
  const a = await CmsNews.findById(req.params.id);
  if (!a) throw new AppError('Article not found', 404);
  a.status = publish ? 'PUBLISHED' : 'DRAFT';
  a.updatedBy = req.userId;
  await a.save();
  await audit(req, publish ? 'CMS_NEWS_PUBLISH' : 'CMS_NEWS_UNPUBLISH', a._id, { slug: a.slug });
  sendSuccess(res, { _id: a._id, status: a.status });
});

const adminDelete = asyncHandler(async (req, res) => {
  const a = await CmsNews.findByIdAndDelete(req.params.id);
  if (!a) throw new AppError('Article not found', 404);
  await audit(req, 'CMS_NEWS_DELETE', a._id, { slug: a.slug });
  sendSuccess(res, { ok: true });
});

function normalizeTags(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

module.exports = {
  listPublic, categoriesPublic, getPublicBySlug,
  adminList, adminGet, adminCreate, adminUpdate, adminPublish, adminDelete,
};
