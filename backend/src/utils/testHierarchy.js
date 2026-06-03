/**
 * Hierarchy logic test harness — runnable against the dev DB.
 * Creates throwaway data (emails prefixed `htest_`), exercises every
 * hierarchy rule, then deletes everything it created. No jest required:
 *
 *   node src/utils/testHierarchy.js
 *
 * Exits non-zero if any assertion fails.
 */
require('dotenv').config();
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };
async function expectThrow(fn, codeOrMsg, label) {
  try { await fn(); fail++; console.error('  ✗', label, '(expected throw)'); }
  catch (e) { ok(!codeOrMsg || e.code === codeOrMsg || String(e.message).includes(codeOrMsg), `${label} → ${e.code || e.message}`); }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const User = require('../models/User');
  const AssignmentLog = require('../models/AssignmentLog');
  const svc = require('../services/hierarchyService');
  const { ROLES } = require('../config/constants');

  const created = [];
  const mkUser = async (suffix, role = ROLES.USER) => {
    const u = await User.create({ email: `htest_${Date.now()}_${suffix}@ex.com`, passwordHash: 'x', firstName: 'H', lastName: suffix, role, referralCode: 'HT' + Math.random().toString(36).slice(2, 8).toUpperCase() });
    created.push(u._id); return u;
  };
  const SUPER = { _id: new mongoose.Types.ObjectId(), role: ROLES.SUPER_ADMIN };

  try {
    console.log('— Admin cap (≤4) —');
    const admins = [];
    for (let i = 0; i < 4; i++) {
      const a = await svc.createRole(ROLES.ADMIN, { email: `htest_${Date.now()}_a${i}@ex.com`, firstName: 'Admin', lastName: String(i) }, SUPER);
      created.push(a._id); admins.push(a);
    }
    ok(admins.length === 4, 'created 4 admins');
    // NOTE: counts ALL admins in the DB; if real admins exist the 4-cap may already be exceeded.
    const adminTotal = await User.countDocuments({ role: ROLES.ADMIN });
    await expectThrow(() => svc.createRole(ROLES.ADMIN, { email: `htest_${Date.now()}_a5@ex.com` }, SUPER), 'CAP_REACHED', `5th admin rejected (DB admin total=${adminTotal})`);

    console.log('— Manager cap (≤10 per admin) —');
    const admin = admins[0];
    const actorAdmin = { _id: admin._id, role: ROLES.ADMIN };
    const mgrs = [];
    for (let i = 0; i < 10; i++) {
      const m = await svc.createRole(ROLES.MANAGER, { email: `htest_${Date.now()}_m${i}@ex.com` }, actorAdmin);
      created.push(m._id); mgrs.push(m);
    }
    ok(mgrs.length === 10, '10 managers created under admin[0]');
    ok(mgrs.every((m) => String(m.adminId) === String(admin._id)), 'managers carry adminId = their admin');
    await expectThrow(() => svc.createRole(ROLES.MANAGER, { email: `htest_${Date.now()}_m11@ex.com` }, actorAdmin), 'CAP_REACHED', '11th manager under same admin rejected');
    // A different admin can still create managers (cap is per-admin).
    const m2 = await svc.createRole(ROLES.MANAGER, { email: `htest_${Date.now()}_other@ex.com` }, { _id: admins[1]._id, role: ROLES.ADMIN });
    created.push(m2._id); ok(String(m2.adminId) === String(admins[1]._id), 'cap is per-admin (admin[1] can still create)');

    console.log('— Assignment + AssignmentLog history —');
    const u1 = await mkUser('u1');
    await svc.assignUserToAdmin(u1._id, admin._id, { actor: SUPER, reason: 'initial' });
    let fresh = await User.findById(u1._id).lean();
    ok(String(fresh.adminId) === String(admin._id) && !fresh.managerId && fresh.assignedAt, 'assigned to admin (adminId set, no manager, assignedAt)');

    await svc.assignUserToManager(u1._id, mgrs[0]._id, { actor: actorAdmin, reason: 'to mgr0' });
    fresh = await User.findById(u1._id).lean();
    ok(String(fresh.managerId) === String(mgrs[0]._id) && String(fresh.adminId) === String(admin._id), 'assigned to manager; adminId stays consistent');

    await svc.reassign(u1._id, mgrs[1]._id, { actor: actorAdmin, reason: 'rebalance' });
    fresh = await User.findById(u1._id).lean();
    ok(String(fresh.managerId) === String(mgrs[1]._id), 'reassigned to mgr1');

    const logs = await AssignmentLog.find({ userId: u1._id }).sort({ createdAt: 1 }).lean();
    ok(logs.length === 3, `3 AssignmentLog rows preserved (got ${logs.length})`);
    ok(logs[2].action === 'REASSIGN' && logs[2].reason === 'rebalance', 'reassign logged with reason + actor');

    console.log('— Ownership rule: only USER role assignable —');
    await expectThrow(() => svc.assignUserToManager(mgrs[0]._id, mgrs[1]._id, { actor: SUPER }), 'NOT_A_USER', 'cannot assign a manager as a user');

    console.log('— Admin scope on assign —');
    await expectThrow(() => svc.assignUserToManager(u1._id, m2._id, { actor: actorAdmin }), 'OUT_OF_SCOPE', "admin can't assign to a manager outside their team");

    console.log('— Bulk assign —');
    const bu = await Promise.all([mkUser('b1'), mkUser('b2'), mkUser('b3')]);
    const bulk = await svc.bulkAssign(bu.map((u) => u._id), { managerId: mgrs[0]._id }, { actor: actorAdmin });
    ok(bulk.ok === 3 && bulk.failed === 0, `bulk assigned 3 users (ok=${bulk.ok})`);

    console.log('— Unassigned list excludes assigned —');
    const un = await svc.listUnassigned({ search: 'htest_' });
    ok(!un.items.some((u) => String(u._id) === String(u1._id)), 'assigned user not in unassigned list');

    console.log('— Workload analytics —');
    const wl = await svc.workload({ adminId: admin._id });
    const mgr0wl = wl.managers.find((m) => String(m.id) === String(mgrs[0]._id));
    ok(mgr0wl && mgr0wl.totalUsers >= 3, `manager workload counts users (totalUsers=${mgr0wl?.totalUsers})`);
    ok(mgr0wl.userCapacity === 100, 'manager userCapacity = 100 (display target)');

    console.log('— Tree —');
    const t = await svc.tree({ adminId: admin._id });
    ok(t.admins[0] && t.admins[0].managers.length >= 1, 'tree nests managers under admin');

    console.log('— Soft-deactivate manager (toAdminPool) —');
    await svc.deactivateManager(mgrs[0]._id, 'toAdminPool', { actor: SUPER });
    const reUsers = await User.find({ managerId: mgrs[0]._id }).lean();
    ok(reUsers.length === 0, 'no users left on deactivated manager');
    const movedUser = await User.findById(bu[0]._id).lean();
    ok(!movedUser.managerId && String(movedUser.adminId) === String(admin._id), 'users kept under admin (no orphan)');
    const deadMgr = await User.findById(mgrs[0]._id).lean();
    ok(deadMgr.role === ROLES.USER && deadMgr.isActive === false, 'manager demoted + deactivated');

    console.log('— Soft-deactivate admin (toSuperPool) —');
    await svc.deactivateAdmin(admin._id, 'toSuperPool', { actor: SUPER });
    const orphanUsers = await User.countDocuments({ adminId: admin._id });
    ok(orphanUsers === 0, 'no users orphaned under deactivated admin');
    const orphanMgrs = await User.countDocuments({ role: ROLES.MANAGER, adminId: admin._id });
    ok(orphanMgrs === 0, 'no managers orphaned under deactivated admin');
  } catch (e) {
    fail++; console.error('  ✗ UNEXPECTED', e.stack || e.message);
  } finally {
    await User.deleteMany({ _id: { $in: created } });
    await AssignmentLog.deleteMany({ userId: { $in: created } });
    await User.deleteMany({ email: /^htest_/ }); // safety net
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
