const mongoose = require('mongoose');

/**
 * CMS Page — a footer/explore content page fully managed from the admin panel.
 * No code change is needed to create, edit, publish, reorder or delete a page.
 *
 *   status     DRAFT → invisible to public; PUBLISHED → live at /page/:slug
 *   visibility PUBLIC → anyone; AUTH → only logged-in users
 *   order      drag-and-drop footer / page ordering (ascending)
 */
const cmsPageSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    content: { type: String, default: '' }, // sanitized HTML

    status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT', index: true },
    visibility: { type: String, enum: ['PUBLIC', 'AUTH'], default: 'PUBLIC' },

    featuredImageUrl: { type: String, default: '' },

    // SEO
    seoTitle: { type: String, default: '' },
    seoDescription: { type: String, default: '' },
    metaKeywords: { type: [String], default: [] },

    // Footer placement
    showInFooter: { type: Boolean, default: true, index: true },
    footerLabel: { type: String, default: '' }, // overrides title in the footer when set
    footerColumn: { type: String, default: 'Company' }, // column group in the footer (e.g. Company / Products / Resources / Support)
    openInNewTab: { type: Boolean, default: false },
    order: { type: Number, default: 0, index: true },

    // Multi-language ready (architecture only for now).
    language: { type: String, default: 'en', index: true },

    views: { type: Number, default: 0 },

    publishedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Normalize slug to a URL-safe form whenever it changes.
cmsPageSchema.pre('save', function (next) {
  if (this.isModified('slug') && this.slug) {
    this.slug = this.slug.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  next();
});

cmsPageSchema.index({ status: 1, showInFooter: 1, order: 1 });

module.exports = mongoose.model('CmsPage', cmsPageSchema);
