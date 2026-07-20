/**
 * Public CMS router (mounted at /api/cms) — no login required. AUTH-only pages
 * use optionalAuthenticate so a signed-in user is recognized when present.
 */
const express = require('express');
const { optionalAuthenticate } = require('../middleware/auth');
const pages = require('../controllers/cmsPageController');
const news = require('../controllers/cmsNewsController');

const router = express.Router();

// Footer links + pages.
router.get('/footer-links', pages.footerLinks);
router.get('/economic-calendar', pages.economicCalendar);
router.get('/knowledge-base', pages.knowledgeBase);
router.get('/pages/:slug', optionalAuthenticate, pages.getPublicBySlug);

// News (Daily News Updates).
router.get('/news', news.listPublic);
router.get('/news/categories', news.categoriesPublic);
router.get('/news/:slug', news.getPublicBySlug);

module.exports = router;
