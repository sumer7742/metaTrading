/**
 * Centralized role + access configuration for the admin console.
 *
 * Single source of truth for:
 *   • which roles exist
 *   • where each role lands after login (and as a safe fallback)
 *   • which roles may view each route
 *
 * Imported by App (route guards), Login (post-auth redirect) and Layout
 * (sidebar visibility) so the rules never drift across the app.
 */

/** @typedef {'SUPER_ADMIN' | 'ADMIN' | 'MANAGER'} Role */

export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  // Financial Department (simplified — managers process directly; finance
  // staff only see /finance)
  FINANCIAL_ADMIN: 'FINANCIAL_ADMIN',
  DEPOSIT_MANAGER: 'DEPOSIT_MANAGER',
  WITHDRAWAL_MANAGER: 'WITHDRAWAL_MANAGER',
  // Read-only oversight: regular checking, fraud detection, random inspection.
  AUDIT_MANAGER: 'AUDIT_MANAGER',
});

export const FINANCE_ROLES = [
  ROLES.FINANCIAL_ADMIN,
  ROLES.DEPOSIT_MANAGER, ROLES.WITHDRAWAL_MANAGER,
  ROLES.AUDIT_MANAGER,
];

// Every role permitted into the admin console (mirrors the auth-store guard).
export const ADMIN_APP_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER, ...FINANCE_ROLES];

// Landing route per role — used immediately after login AND as the safe
// fallback when a role hits a page it isn't allowed to see.
const ROLE_HOME = Object.freeze({
  [ROLES.SUPER_ADMIN]: '/dashboard',
  [ROLES.ADMIN]: '/dashboard',
  [ROLES.MANAGER]: '/my-users',
  // All finance staff land on the Finance workspace.
  [ROLES.FINANCIAL_ADMIN]: '/finance',
  [ROLES.DEPOSIT_MANAGER]: '/finance',
  [ROLES.DEPOSIT_OFFICER]: '/finance',
  [ROLES.WITHDRAWAL_MANAGER]: '/finance',
  [ROLES.WITHDRAWAL_OFFICER]: '/finance',
  [ROLES.AUDIT_MANAGER]: '/audit-compliance',
});

/**
 * Home route for a role. Unknown/blocked roles fall back to the most
 * restricted home (/my-users) rather than the admin dashboard.
 * @param {Role | null | undefined} role
 * @returns {string}
 */
export const roleHome = (role) => ROLE_HOME[role] || '/my-users';

// Default allow-list for any route not listed in ROUTE_ACCESS below:
// admins only. Managers are intentionally scoped to just their own pages,
// so they can never reach a legacy admin screen by typing the URL.
export const DEFAULT_ROUTE_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

// Per-route allow-lists. SUPER_ADMIN implicitly passes everything (canAccess).
export const ROUTE_ACCESS = Object.freeze({
  '/dashboard':      [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/portfolio':      [ROLES.SUPER_ADMIN],   // platform portfolio — super admin only
  '/market-exposure': [ROLES.SUPER_ADMIN, ROLES.ADMIN], // exposure dashboard — managers/users blocked

  // "My Users" = personal assigned-user view (manager / admin subtree).
  // Super Admin doesn't have "assigned" users — they use full User Management.
  '/my-users':       [ROLES.ADMIN, ROLES.MANAGER],
  '/support-chats':  [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
  // Orders Management — institutional dealing desk. Super/Admin platform-wide,
  // Managers see only their own users' orders (backend-scoped).
  '/orders':         [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
  // Global Alert Popups — Super/Admin only (Admin scoped to own subtree + ALERTS module).
  '/global-alerts':  [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/admins':         [ROLES.SUPER_ADMIN],
  '/managers':       [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/assignments':    [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/hierarchy-tree': [ROLES.SUPER_ADMIN],

  // Financial Department workspace — finance staff + super admin.
  '/finance':        [ROLES.SUPER_ADMIN, ...FINANCE_ROLES],

  // Audit & Compliance dashboard — Audit Manager + Super Admin only.
  '/audit-compliance': [ROLES.SUPER_ADMIN, ROLES.AUDIT_MANAGER],

  // Manager Access Control — Super Admin always; Admin only when delegation
  // is enabled (the page itself enforces that; managers never see it).
  '/access-control': [ROLES.SUPER_ADMIN, ROLES.ADMIN],

  // Admin Access Control — Super Admin only (decides each admin's modules).
  '/admin-access': [ROLES.SUPER_ADMIN],
});

// Admin Access Control: which per-admin permission KEY gates each admin route.
// For an ADMIN, a mapped route is visible/openable only when the Super Admin
// has granted that module. Unmapped routes fall back to ROUTE_ACCESS.
export const ADMIN_ROUTE_PERMISSION = Object.freeze({
  '/dashboard': 'DASHBOARD',
  '/users': 'USERS',
  '/accounts': 'ACCOUNTS',
  '/instruments': 'INSTRUMENTS',
  '/market-exposure': 'MARKET_EXPOSURE',
  '/deposits': 'DEPOSITS',
  '/withdrawals': 'WITHDRAWALS',
  '/finance': 'FINANCE',
  '/plans': 'PLANS',
  '/account-plans': 'ACCOUNT_PLANS',
  '/subscription-wallets': 'WALLETS',
  '/bonus-wallets': 'BONUS_WALLETS',
  '/user-transfers': 'USER_TRANSFERS',
  '/partners': 'PARTNERS',
  '/managers': 'MANAGERS',
  '/assignments': 'ASSIGNMENTS',
  '/reports': 'REPORTS',
  '/orders': 'ORDERS',
  '/cms-pages': 'CMS',
  '/cms-news': 'CMS',
  '/global-alerts': 'ALERTS',
  '/execution': 'EXECUTION',
  '/audit': 'AUDIT_LOGS',
  '/data-feeds': 'DATA_FEEDS',
  '/support-chats': 'SUPPORT_CHATS',
  '/settings': 'SETTINGS',
  '/security': 'SECURITY',
});

// Manager Access Control: which per-manager permission KEY gates each admin
// route. For a MANAGER, a mapped route is visible/openable ONLY when that
// permission is toggled ON (Super-Admin controlled). Unmapped routes fall
// back to the static ROUTE_ACCESS allow-list above.
export const MANAGER_ROUTE_PERMISSION = Object.freeze({
  '/my-users': 'USER_MANAGEMENT',
  '/deposits': 'DEPOSITS',
  '/withdrawals': 'WITHDRAWALS',
  '/orders': 'ORDERS_MANAGEMENT',
  '/reports': 'REPORTS',
  '/audit': 'AUDIT_LOGS',
  '/support-chats': 'SUPPORT_TICKETS',
});

// Routes hidden even from SUPER_ADMIN (otherwise they bypass every check).
// "My Users" is a personal assigned-user view — meaningless for Super Admin,
// who manages everyone via full User Management.
const SUPER_ADMIN_HIDDEN = ['/my-users'];

/**
 * Permission-aware access check (the authority for managers). Use this in the
 * sidebar + route guard so a manager's enabled/disabled modules are honored
 * live from their loaded permission map.
 */
export const canUserAccessPath = (user, pathname) => {
  const role = user?.role;
  if (!role) return false;
  if (role === ROLES.SUPER_ADMIN) return !SUPER_ADMIN_HIDDEN.includes(pathname);
  if (role === ROLES.MANAGER) {
    const key = MANAGER_ROUTE_PERMISSION[pathname];
    if (key) return !!(user.managerPermissions && user.managerPermissions[key]);
    return canAccess(role, accessForPath(pathname));
  }
  if (role === ROLES.ADMIN) {
    // Must pass the static allow-list first (keeps super-only routes blocked),
    // THEN the Super-Admin-controlled per-admin module permission.
    if (!canAccess(role, accessForPath(pathname))) return false;
    const key = ADMIN_ROUTE_PERMISSION[pathname];
    if (key && user.adminPermissions) return user.adminPermissions[key] !== false;
    return true;
  }
  return canAccess(role, accessForPath(pathname));
};

/**
 * Can `role` access a route whose allow-list is `allowedRoles`?
 * SUPER_ADMIN always passes.
 * @param {Role | null | undefined} role
 * @param {Role[]} [allowedRoles]
 * @returns {boolean}
 */
export const canAccess = (role, allowedRoles = DEFAULT_ROUTE_ROLES) => {
  if (!role) return false;
  if (role === ROLES.SUPER_ADMIN) return true;
  return allowedRoles.includes(role);
};

/**
 * Allow-list for a given pathname (falls back to admins-only).
 * @param {string} pathname
 * @returns {Role[]}
 */
export const accessForPath = (pathname) => ROUTE_ACCESS[pathname] || DEFAULT_ROUTE_ROLES;

/**
 * Convenience: may this role view this pathname?
 * @param {Role | null | undefined} role
 * @param {string} pathname
 * @returns {boolean}
 */
export const canAccessPath = (role, pathname) => canAccess(role, accessForPath(pathname));

/**
 * Where to send a user immediately after a successful login. Honors a
 * deep-link `from` when the role is actually allowed to see it; otherwise
 * the role's home. Never returns the login page or the bare root.
 * @param {Role} role
 * @param {string} [from]
 * @returns {string}
 */
export const redirectAfterLogin = (role, from) => {
  if (from && from !== '/login' && from !== '/' && canAccessPath(role, from)) {
    return from;
  }
  return roleHome(role);
};
