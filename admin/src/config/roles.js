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
});

// Every role permitted into the admin console (mirrors the auth-store guard).
export const ADMIN_APP_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER];

// Landing route per role — used immediately after login AND as the safe
// fallback when a role hits a page it isn't allowed to see.
const ROLE_HOME = Object.freeze({
  [ROLES.SUPER_ADMIN]: '/dashboard',
  [ROLES.ADMIN]: '/dashboard',
  [ROLES.MANAGER]: '/my-users',
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

  '/my-users':       [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
  '/support-chats':  [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
  '/admins':         [ROLES.SUPER_ADMIN],
  '/managers':       [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/assignments':    [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  '/hierarchy-tree': [ROLES.SUPER_ADMIN],
});

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
