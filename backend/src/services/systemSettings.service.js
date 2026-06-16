/**
 * In-memory cached accessor for SystemSetting docs.
 *
 * Why cache: every order placement reads `routingMode`. A round-trip to
 * Mongo on every order would add ~5-10ms to the hot path. We refresh
 * the cache lazily (60s TTL) and immediately on any setSetting() write.
 *
 * Keys + their meaning are documented in models/SystemSetting.js.
 */
const SystemSetting = require('../models/SystemSetting');

const TTL_MS = Number(process.env.SETTINGS_CACHE_TTL_MS) || 60_000;

// Defaults applied when the DB row is missing — keeps the platform safe
// on a fresh install before admin has touched the Settings page.
const DEFAULTS = {
  routingMode: 'B_BOOK',
  defaultLpProvider: 'NONE',
  // ── Public footer (CMS-driven multi-column footer) ──
  // Brand + address + socials + copyright shown alongside the column links.
  // Edited from Admin → CMS Pages → Footer Settings.
  'footer.config': {
    brand: 'TradePro',
    logoUrl: '', // brand logo image URL (blank → letter mark)
    tagline: '',
    address: 'Chirala, Ganjipalem area Bapatla district,\nAndhra Pradesh, India 523155',
    copyright: '', // empty → "© <year> · <brand> · All rights reserved"
    // Dummy '#' so the icons render out-of-the-box; admin swaps in real URLs.
    socials: {
      facebook: '#', twitter: '#', youtube: '#', linkedin: '#',
      instagram: '#', whatsapp: '#', telegram: '#', skype: '#',
    },
    // Extra links beyond the built-in 8 — each with its own uploaded icon.
    // [{ label, url, icon (data URL / image URL) }]
    customSocials: [],
  },
  // Max number of top-level platform admins (Hierarchy → Admins). Super-admin
  // editable; falls back to the hard cap in config/hierarchy.js when unset.
  'hierarchy.maxAdmins': 4,
  // Manager Access Control: when true, an Admin may edit the permissions of
  // managers under them. When false, only the Super Admin can.
  'manager.allowAdminManagePerms': false,
  // ── Help/Support chat file-upload limits (Super-Admin configurable) ──
  // Applied immediately (no redeploy). Per-role overrides where a 0 means
  // "inherit the global value". Executable/unsafe extensions are blocked in
  // code regardless of these settings (see chatService BLOCKED_EXTENSIONS).
  'chat.upload.enabled':    true,
  'chat.upload.maxFileMB':  5,    // max size per file (MB) — the only size limit
  'chat.upload.maxTotalMB': 0,    // 0 = unlimited total per message
  'chat.upload.maxFiles':   0,    // 0 = unlimited file count per message
  'chat.upload.allowedExtensions': [], // empty = any type (executables still blocked)
  'chat.upload.roles': {
    USER:    { enabled: true, maxFileMB: 0, maxTotalMB: 0, maxFiles: 0 },
    MANAGER: { enabled: true, maxFileMB: 0, maxTotalMB: 0, maxFiles: 0 },
    ADMIN:   { enabled: true, maxFileMB: 0, maxTotalMB: 0, maxFiles: 0 },
  },
  // Peer-to-peer wallet transfers (Wallet → Transfer Funds → Another User).
  // Keep keys flat (dotted strings as Mongo doc keys) so adding more
  // transfer knobs later is a single-row insert each.
  'userTransfer.enabled':    true,
  'userTransfer.min':        '1',
  'userTransfer.max':        '0',   // 0 = no upper cap
  'userTransfer.feePercent': '0',
  // Partner / Referral program. Bonuses + revenue share credit the user's
  // Subscription Wallet (see partnerService). Tiers are computed from
  // active referral count (active = referee made a qualifying first
  // deposit ≥ `minDeposit`). Each tier carries the L1 revenue-share %.
  //
  // `tiers` is stored as a JSON array so the admin can edit the
  // thresholds inline without a schema migration. Tier with maxActive=0
  // means "no upper bound" (Diamond). Tiers must be sorted ascending
  // by `minActive`.
  'partner.enabled':      true,
  'partner.bonusAmount':  '10',     // instant credit on referee's first qualifying deposit
  'partner.minDeposit':   '50',     // deposit threshold that "activates" a referee
  'partner.bonusCurrency': 'USD',   // currency recorded for the first-deposit bonus
  'partner.tiers': [
    { name: 'BRONZE',  minActive:   1, maxActive:  20, percent: '10' },
    { name: 'SILVER',  minActive:  21, maxActive:  50, percent: '15' },
    { name: 'GOLD',    minActive:  51, maxActive: 200, percent: '20' },
    { name: 'DIAMOND', minActive: 201, maxActive:   0, percent: '25' },
  ],
  // Volume-based tiers (USD notional of TOTAL referral trading volume) that
  // drive the partner LEVEL + revenue-share % shown on the partner dashboard.
  // Admin-configurable. `minVolume` is the floor to enter the tier; tiers must
  // be sorted ascending. Independent of the count-based `partner.tiers` above.
  'partner.volumeTiers': [
    { name: 'BRONZE',   minVolume: 0,         percent: '10' },
    { name: 'SILVER',   minVolume: 100000,    percent: '15' },
    { name: 'GOLD',     minVolume: 500000,    percent: '20' },
    { name: 'PLATINUM', minVolume: 2000000,   percent: '25' },
    { name: 'ELITE',    minVolume: 10000000,  percent: '30' },
  ],
  // Copy-trading Master Earnings (performance fee). When a copied trade
  // closes IN PROFIT, the master earns `feePercent` of the follower's
  // realized profit, credited to the master's Bonus Wallet (USD). Losses
  // and breakeven never generate a fee. Per-master override lives on
  // TraderProfile.performanceFeePercent; the default below applies when a
  // master hasn't set their own. Every applied fee is clamped to [min,max].
  'copyTrading.enabled':              true,  // master kill-switch for the whole fee system
  'copyTrading.defaultPerformanceFee': 20,   // percent, used when master has no override
  'copyTrading.minFee':                0,    // percent floor
  'copyTrading.maxFee':                50,   // percent ceiling

  // Subscription billing. Plans bill from the MAIN WALLET only by default.
  // The Bonus Wallet is NEVER a billing source (enforced in code). When this
  // is true, the Trading Wallet is used as a SECONDARY source if the Main
  // Wallet can't cover the charge.
  'subscription.allowTradingWallet':  false,
};

const _cache = new Map(); // key -> { value, expiresAt }

const _readDb = async (key) => {
  const doc = await SystemSetting.findOne({ key }).lean();
  return doc?.value;
};

/**
 * Read a setting. Falls back to DEFAULTS if not set in DB.
 * Cached for TTL_MS. Reads are non-blocking — first read may take a
 * round-trip; subsequent reads in the window are O(1).
 */
const getSetting = async (key) => {
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const dbValue = await _readDb(key);
  const value = dbValue !== undefined ? dbValue : DEFAULTS[key];
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
};

/**
 * Synchronous accessor — returns the cached value WITHOUT a DB round-
 * trip, or the default if not yet cached. Useful inside the hot order
 * path where we've already warmed the cache at boot. If you need
 * guaranteed-fresh, use getSetting() (async).
 */
const getSettingSync = (key) => {
  const cached = _cache.get(key);
  if (cached) return cached.value;
  return DEFAULTS[key];
};

/**
 * Upsert a setting + bust cache. Returns the persisted value.
 */
const setSetting = async (key, value, updatedBy = null) => {
  await SystemSetting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
};

/**
 * Bulk read — returns { routingMode, defaultLpProvider, ... } for the
 * admin settings UI to render. Includes defaults for unset keys.
 */
const getAllSettings = async () => {
  const docs = await SystemSetting.find().lean();
  const map = { ...DEFAULTS };
  for (const d of docs) map[d.key] = d.value;
  // Refresh cache while we're here.
  for (const [k, v] of Object.entries(map)) {
    _cache.set(k, { value: v, expiresAt: Date.now() + TTL_MS });
  }
  return map;
};

/**
 * Warm the cache at startup — called from server.js so the very first
 * order doesn't pay the cache-miss cost.
 */
const warmCache = async () => {
  try {
    await getAllSettings();
  } catch (e) {
    // Non-fatal: hot path will lazy-load on first read.
    console.warn('[systemSettings] warmCache failed:', e.message);
  }
};

module.exports = {
  getSetting,
  getSettingSync,
  setSetting,
  getAllSettings,
  warmCache,
  DEFAULTS,
};
