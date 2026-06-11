/**
 * Admin Access Control — permission catalog (single source of truth).
 *
 * In a professional setup an ADMIN has NO fixed access: the Super Admin decides
 * exactly which modules each admin can use. These keys are toggled per-admin
 * (User.adminPermissions). The catalog is exposed via the admin app so the UI
 * never hard-codes the list.
 *
 *   route     — admin-app path the permission gates (frontend sidebar/routes)
 *   apiPrefix — /api/admin/* sub-path(s) the permission gates (backend enforce)
 *
 * Default is GRANT (true) for any key not explicitly set, so existing admins
 * keep working until a Super Admin restricts them.
 */
const ADMIN_PERMISSIONS = [
  { key: 'DASHBOARD',        label: 'Dashboard',         route: '/dashboard',            apiPrefix: ['/dashboard'] },
  { key: 'USERS',            label: 'User Management',   route: '/users',                apiPrefix: ['/users'] },
  { key: 'ACCOUNTS',         label: 'Accounts',          route: '/accounts',             apiPrefix: ['/accounts'] },
  { key: 'INSTRUMENTS',      label: 'Instruments',       route: '/instruments',          apiPrefix: ['/instruments', '/leverage-overrides', '/volume-overrides'] },
  { key: 'MARKET_EXPOSURE',  label: 'Market Exposure',   route: '/market-exposure',      apiPrefix: ['/exposure'] },
  { key: 'DEPOSITS',         label: 'Deposits',          route: '/deposits',             apiPrefix: ['/deposits'] },
  { key: 'WITHDRAWALS',      label: 'Withdrawals',       route: '/withdrawals',          apiPrefix: ['/withdrawals'] },
  { key: 'FINANCE',          label: 'Finance Dept',      route: '/finance',              apiPrefix: [] },
  { key: 'PLANS',            label: 'Plans',             route: '/plans',                apiPrefix: [] },
  { key: 'ACCOUNT_PLANS',    label: 'Account Plans',     route: '/account-plans',        apiPrefix: [] },
  { key: 'WALLETS',          label: 'Wallets',           route: '/subscription-wallets', apiPrefix: [] },
  { key: 'BONUS_WALLETS',    label: 'Bonus Wallets',     route: '/bonus-wallets',        apiPrefix: [] },
  { key: 'USER_TRANSFERS',   label: 'User Transfers',    route: '/user-transfers',       apiPrefix: [] },
  { key: 'PARTNERS',         label: 'Partners',          route: '/partners',             apiPrefix: [] },
  { key: 'MANAGERS',         label: 'Managers',          route: '/managers',             apiPrefix: [] },
  { key: 'ASSIGNMENTS',      label: 'Assignments',       route: '/assignments',          apiPrefix: [] },
  { key: 'REPORTS',          label: 'Reports',           route: '/reports',              apiPrefix: [] },
  { key: 'EXECUTION',        label: 'Execution Stats',   route: '/execution',            apiPrefix: [] },
  { key: 'AUDIT_LOGS',       label: 'Audit Log',         route: '/audit',                apiPrefix: ['/audit-logs'] },
  { key: 'DATA_FEEDS',       label: 'Data Feeds',        route: '/data-feeds',           apiPrefix: ['/data-feeds'] },
  { key: 'SUPPORT_CHATS',    label: 'Support Chats',     route: '/support-chats',        apiPrefix: [] },
  { key: 'SETTINGS',         label: 'Settings',          route: '/settings',             apiPrefix: ['/system'] },
  { key: 'SECURITY',         label: 'Security',          route: '/security',             apiPrefix: [] },
];

const PERMISSION_KEYS = ADMIN_PERMISSIONS.map((p) => p.key);

// Unconfigured keys default to GRANT so existing admins are unaffected; a Super
// Admin then toggles OFF what a given admin shouldn't have.
function effectiveAdminPermissions(stored) {
  const map = stored && typeof stored === 'object'
    ? (typeof stored.get === 'function' ? Object.fromEntries(stored) : stored)
    : {};
  const out = {};
  for (const k of PERMISSION_KEYS) out[k] = k in map ? !!map[k] : true;
  return out;
}

// Resolve which permission key an /api/admin sub-path belongs to (longest
// matching apiPrefix wins). Returns null when the path isn't gated.
function adminPermissionForPath(path) {
  let best = null; let bestLen = -1;
  for (const p of ADMIN_PERMISSIONS) {
    for (const pre of (p.apiPrefix || [])) {
      if ((path === pre || path.startsWith(pre + '/')) && pre.length > bestLen) { best = p.key; bestLen = pre.length; }
    }
  }
  return best;
}

module.exports = { ADMIN_PERMISSIONS, PERMISSION_KEYS, effectiveAdminPermissions, adminPermissionForPath };
