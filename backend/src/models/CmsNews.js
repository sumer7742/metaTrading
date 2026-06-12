const mongoose = require('mongoose');

/**
 * CMS News Article — the "Daily News Updates" system, fully admin-managed.
 * Latest published articles surface first at /news; each opens at /news/:slug.
 */
const cmsNewsSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    excerpt: { type: String, default: '' },
    content: { type: String, default: '' }, // sanitized HTML

    category: { type: String, default: 'General', trim: true, index: true },
    author: { type: String, default: '' },
    featuredImageUrl: { type: String, default: '' },
    tags: { type: [String], default: [] },

    status: { type: String, enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT', index: true },
    publishDate: { type: Date, default: Date.now, index: true },

    language: { type: String, default: 'en', index: true },
    views: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cmsNewsSchema.pre('save', function (next) {
  if (this.isModified('slug') && this.slug) {
    this.slug = this.slug.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  next();
});

// Public listing: published, newest first.
cmsNewsSchema.index({ status: 1, publishDate: -1 });

module.exports = mongoose.model('CmsNews', cmsNewsSchema);
