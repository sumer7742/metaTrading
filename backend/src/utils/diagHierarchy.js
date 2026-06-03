/**
 * Read-only diagnostic + service-filter check for the Admin→User scoping fix.
 *   node src/utils/diagHierarchy.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const User = require('../models/User');
  const { ROLES } = require('../config/constants');
  const svc = require('../services/hierarchyService');

  const admins = await User.find({ role: ROLES.ADMIN }).select('_id email').lean();
  console.log(`\nADMINS: ${admins.length}`);
  for (const a of admins) {
    const total = await User.countDocuments({ role: ROLES.USER, adminId: a._id });
    const noMgr = await User.countDocuments({ role: ROLES.USER, adminId: a._id, managerId: null });
    const withMgr = await User.countDocuments({ role: ROLES.USER, adminId: a._id, managerId: { $ne: null } });
    console.log(`  Admin ${a._id} <${a.email}>  total=${total}  noManager=${noMgr}  withManager=${withMgr}`);

    // Verify the service returns what the Assignments "My users" screen needs.
    const all = await svc.listUsersForAdmin(a._id, { limit: 200 });
    const pool = await svc.listUsersForAdmin(a._id, { limit: 200, managerStatus: 'unassigned' });
    const assigned = await svc.listUsersForAdmin(a._id, { limit: 200, managerStatus: 'assigned' });
    const okAll = all.total === total;
    const okPool = pool.total === noMgr;
    const okAssigned = assigned.total === withMgr;
    console.log(`     svc all=${all.total} (${okAll ? 'OK' : 'MISMATCH'})  unassigned=${pool.total} (${okPool ? 'OK' : 'MISMATCH'})  assigned=${assigned.total} (${okAssigned ? 'OK' : 'MISMATCH'})`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
