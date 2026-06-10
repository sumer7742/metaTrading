/**
 * Financial Department controller — scoped deposit/withdrawal queues, manual
 * reassignment, workload, staff management and the financial-admin overview.
 *
 * Approve/confirm/reject reuse the canonical adminController handlers (single
 * source of money logic); this layer only adds finance-role SCOPING.
 */
const { sendSuccess, asyncHandler } = require('../utils/errors');
const finance = require('../services/financeService');
const { Deposit, Withdrawal } = require('../models');
const User = require('../models/User');
const { ROLES } = require('../config/constants');

const _name = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;

// Enrich a request list with user + assigned-officer display info (batched).
async function attachInfo(items) {
  const userIds = [...new Set(items.map((i) => String(i.userId)).filter(Boolean))];
  const offIds = [...new Set(items.map((i) => i.assignedOfficerId && String(i.assignedOfficerId)).filter(Boolean))];
  const [users, offs] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select('firstName lastName email userUid').lean() : [],
    offIds.length ? User.find({ _id: { $in: offIds } }).select('firstName lastName email').lean() : [],
  ]);
  const uById = new Map(users.map((u) => [String(u._id), u]));
  const oById = new Map(offs.map((u) => [String(u._id), u]));
  return items.map((i) => {
    const u = uById.get(String(i.userId));
    const o = i.assignedOfficerId ? oById.get(String(i.assignedOfficerId)) : null;
    return {
      ...i,
      user: u ? { name: _name(u), email: u.email, userUid: u.userUid || null } : null,
      assignedOfficer: o ? { name: _name(o), email: o.email } : null,
    };
  });
}

const listDeposits = asyncHandler(async (req, res) => {
  const base = {};
  if (req.query.status) base.status = req.query.status;
  const filter = await finance.queueFilter('deposit', req.user, base);
  const items = await Deposit.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, await attachInfo(items));
});

const listWithdrawals = asyncHandler(async (req, res) => {
  const base = {};
  if (req.query.status) base.status = req.query.status;
  const filter = await finance.queueFilter('withdrawal', req.user, base);
  const items = await Withdrawal.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, await attachInfo(items));
});

const reassignDeposit = asyncHandler(async (req, res) => {
  sendSuccess(res, await finance.reassign('deposit', req.params.id, req.body.officerId, req.user));
});
const reassignWithdrawal = asyncHandler(async (req, res) => {
  sendSuccess(res, await finance.reassign('withdrawal', req.params.id, req.body.officerId, req.user));
});

const overview = asyncHandler(async (req, res) => sendSuccess(res, await finance.overview()));

const workload = asyncHandler(async (req, res) => {
  const kind = req.query.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  sendSuccess(res, await finance.workload(kind));
});

// Active managers of a department — the reassign target list (financial-admin).
const officers = asyncHandler(async (req, res) => {
  const kind = req.query.kind === 'withdrawal' ? 'withdrawal' : 'deposit';
  const list = await User.find({ role: finance.processorRoleFor(kind), isActive: true })
    .select('_id firstName lastName email').lean();
  sendSuccess(res, list.map((o) => ({ _id: String(o._id), name: _name(o), email: o.email })));
});

const listStaff = asyncHandler(async (req, res) => sendSuccess(res, await finance.listStaff(req.user)));

const createStaff = asyncHandler(async (req, res) => {
  const { user, tempPassword } = await finance.createStaff(req.body, req.user);
  sendSuccess(res, { _id: String(user._id), email: user.email, role: user.role, name: _name(user), tempPassword }, 201);
});

const resetStaffPassword = asyncHandler(async (req, res) => {
  const out = await finance.resetStaffPassword({ targetId: req.params.id, password: req.body.password }, req.user);
  sendSuccess(res, out);
});

module.exports = {
  listDeposits, listWithdrawals, reassignDeposit, reassignWithdrawal,
  overview, workload, officers, listStaff, createStaff, resetStaffPassword,
};
