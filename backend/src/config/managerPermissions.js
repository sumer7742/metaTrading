/**
 * Manager Access Control — permission catalog (single source of truth).
 *
 * Super Admin (and optionally delegated Admins) toggle these per manager.
 * The catalog is exposed to the admin app via GET /admin/manager-access/meta
 * so the UI never hard-codes the list. `route` (when present) is the admin-app
 * path the permission gates; backend enforcement uses `requireManagerPermission`.
 */
const MANAGER_PERMISSIONS = [
  { key: 'DASHBOARD',           label: 'Dashboard',           route: '/dashboard' },
  { key: 'USER_MANAGEMENT',     label: 'User Management',     route: '/my-users' },
  { key: 'DEPOSITS',            label: 'Deposits',            route: '/deposits' },
  { key: 'WITHDRAWALS',         label: 'Withdrawals',         route: '/withdrawals' },
  { key: 'TRADING',             label: 'Trading',             route: null },
  { key: 'OPEN_POSITIONS',      label: 'Open Positions',      route: null },
  { key: 'ORDERS',              label: 'Orders',              route: null },
  { key: 'PORTFOLIO',           label: 'Portfolio',           route: '/portfolio' },
  { key: 'WALLET_MANAGEMENT',   label: 'Wallet Management',   route: '/subscription-wallets' },
  { key: 'KYC_MANAGEMENT',      label: 'KYC Management',      route: null },
  { key: 'REPORTS',             label: 'Reports',             route: '/reports' },
  { key: 'AUDIT_LOGS',          label: 'Audit Logs',          route: '/audit' },
  { key: 'SUPPORT_TICKETS',     label: 'Support Tickets',     route: '/support-chats' },
  { key: 'NOTIFICATIONS',       label: 'Notifications',       route: null },
  { key: 'REFERRAL_MANAGEMENT', label: 'Referral Management', route: '/partners' },
  { key: 'RISK_MANAGEMENT',     label: 'Risk Management',     route: null },
  { key: 'FINANCE_ACCESS',      label: 'Finance Access',      route: '/finance' },
  { key: 'SETTINGS',            label: 'Settings',            route: '/settings' },
];

const PERMISSION_KEYS = MANAGER_PERMISSIONS.map((p) => p.key);

// Baseline for a manager with nothing configured yet — only Dashboard +
// Support are ON. Everything else is OFF until a Super Admin (or delegated
// Admin) grants it.
const DEFAULT_MANAGER_PERMISSIONS = {
  DASHBOARD: true,
  SUPPORT_TICKETS: true,
};

// Resolve the effective permission map for a manager (defaults + stored
// overrides), always returning every key as an explicit boolean.
function effectivePermissions(stored) {
  const map = stored && typeof stored === 'object'
    ? (typeof stored.get === 'function' ? Object.fromEntries(stored) : stored)
    : {};
  const out = {};
  for (const k of PERMISSION_KEYS) {
    out[k] = k in map ? !!map[k] : !!DEFAULT_MANAGER_PERMISSIONS[k];
  }
  return out;
}

module.exports = { MANAGER_PERMISSIONS, PERMISSION_KEYS, DEFAULT_MANAGER_PERMISSIONS, effectivePermissions };
