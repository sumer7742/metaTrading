/**
 * Hierarchy configuration — the single source of truth for the management
 * hierarchy (SuperAdmin → Admin → Manager → Users) and its RBAC.
 *
 * EXTENSIBILITY: to add a future management role (Sub Admin, IB Partner,
 * Dealer, Risk Manager, Support Agent, …) you ONLY add a row to
 * ROLE_REGISTRY (and, if it needs distinct permissions, to PERMISSIONS).
 * The service/controller logic reads caps + parent from here and never
 * hardcodes "admin"/"manager", so no refactor is needed.
 */
const { ROLES } = require('./constants');

// Each managed role: who creates it (parentRole), how many may exist
// (cap — scoped to the parent for non-super creators), a soft display
// capacity for users (NOT enforced), and which child roles it manages.
const ROLE_REGISTRY = {
  [ROLES.ADMIN]: {
    parentRole: ROLES.SUPER_ADMIN,
    parentField: null,          // admins hang directly off the SuperAdmin pool
    cap: 4,                     // max 4 admins platform-wide (hard limit)
    capScope: 'global',
    userCapacity: 500,          // display-only workload target
    manages: [ROLES.MANAGER],
  },
  [ROLES.MANAGER]: {
    parentRole: ROLES.ADMIN,
    parentField: 'adminId',     // a manager belongs to one admin
    cap: 10,                    // max 10 managers per admin (hard limit)
    capScope: 'parent',
    userCapacity: 100,          // display-only workload target
    manages: [],
  },
  // ── Future roles — uncomment / add rows, zero logic changes ──────────
  // SUB_ADMIN:     { parentRole: ROLES.SUPER_ADMIN, parentField: null,      cap: 8,  capScope: 'global', userCapacity: 0, manages: [ROLES.MANAGER] },
  // IB_PARTNER:    { parentRole: ROLES.ADMIN,       parentField: 'adminId', cap: 50, capScope: 'parent', userCapacity: 0, manages: [] },
  // RISK_MANAGER:  { ... },
};

// Permission → roles allowed. SUPER_ADMIN is implicitly allowed everywhere
// (see hasPermission). Keep permission strings stable; gate routes by them
// rather than by raw role lists so future roles slot in via config.
const PERMISSIONS = {
  'hierarchy.admin.manage':   [ROLES.SUPER_ADMIN],
  'hierarchy.manager.manage': [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  'hierarchy.assign':         [ROLES.SUPER_ADMIN, ROLES.ADMIN],
  'hierarchy.view':           [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
};

/** SuperAdmin always passes; otherwise the role must be in the permission's list. */
function hasPermission(role, perm) {
  if (role === ROLES.SUPER_ADMIN) return true;
  const allowed = PERMISSIONS[perm];
  return Array.isArray(allowed) && allowed.includes(role);
}

/** Roles considered part of the management hierarchy (not regular users). */
const MANAGEMENT_ROLES = [ROLES.SUPER_ADMIN, ...Object.keys(ROLE_REGISTRY)];

// Feature flag — staged rollout. Default ON; set ENABLE_HIERARCHY=false to
// make every hierarchy route 404 with zero impact on the rest of the platform.
const FEATURE_ENABLED = String(process.env.ENABLE_HIERARCHY || 'true').toLowerCase() !== 'false';

module.exports = { ROLE_REGISTRY, PERMISSIONS, hasPermission, MANAGEMENT_ROLES, FEATURE_ENABLED };
