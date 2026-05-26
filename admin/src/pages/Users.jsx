import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate, fmtNum } from '../utils/format';
import PageHero from '../components/PageHero';

export default function Users() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [kycFilter, setKycFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);

  const load = async () => {
    const { data } = await api.get('/admin/users', { params: { search, kyc: kycFilter, status: statusFilter, page, limit: 25 } });
    setUsers(data.data.users);
    setTotal(data.data.total);
  };

  useEffect(() => { load(); }, [page, kycFilter, statusFilter]);

  const onSearch = (e) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Operations"
        title="User Management"
        subtitle={`${total.toLocaleString()} total users · review KYC, block/unblock accounts, adjust balances.`}
      />

      <form onSubmit={onSearch} className="card p-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Search</label>
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="email, name, phone" />
        </div>
        <div>
          <label className="label">KYC</label>
          <select className="input w-40" value={kycFilter} onChange={(e) => { setKycFilter(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="NOT_SUBMITTED">Not Submitted</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input w-32" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Blocked</option>
          </select>
        </div>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Role</th>
              <th className="text-left p-3">KYC</th>
              <th className="text-left p-3">Referred By</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Joined</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const refBy = u.referredBy;
              const refName = refBy
                ? ([refBy.firstName, refBy.lastName].filter(Boolean).join(' ') || refBy.email)
                : null;
              return (
                <tr key={u._id} className="table-row">
                  <td className="p-3">{u.email}</td>
                  <td className="p-3">{u.firstName} {u.lastName}</td>
                  <td className="p-3 text-xs text-primary-500">{u.role}</td>
                  <td className="p-3"><KycBadge status={u.kycStatus} /></td>
                  <td className="p-3 text-xs">
                    {refBy ? (
                      <div className="flex flex-col leading-tight">
                        <span className="text-white truncate max-w-[150px]" title={refName}>{refName}</span>
                        {refBy.referralCode && (
                          <span className="font-mono text-[10px] text-primary-500">{refBy.referralCode}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={u.isActive ? 'text-bull text-xs' : 'text-bear text-xs'}>
                      {u.isActive ? 'Active' : 'Blocked'}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-gray-400">{fmtDate(u.createdAt)}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => setSelected(u)} className="btn-ghost text-xs">View</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>Showing {users.length} of {total}</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-ghost text-xs disabled:opacity-30">Prev</button>
          <span>Page {page}</span>
          <button disabled={users.length < 25} onClick={() => setPage(page + 1)} className="btn-ghost text-xs disabled:opacity-30">Next</button>
        </div>
      </div>

      {selected && (
        <UserDetail
          userId={selected._id}
          onClose={() => { setSelected(null); load(); }}
          onJumpToUser={(id) => setSelected({ _id: id })}
        />
      )}
    </div>
  );
}

function KycBadge({ status }) {
  const colors = {
    NOT_SUBMITTED: 'bg-gray-700 text-gray-400',
    PENDING: 'bg-yellow-900 text-yellow-300',
    APPROVED: 'bg-emerald-900 text-emerald-300',
    REJECTED: 'bg-red-900 text-red-300',
  };
  return <span className={`text-xs px-2 py-0.5 rounded ${colors[status] || ''}`}>{status}</span>;
}

function UserDetail({ userId, onClose, onJumpToUser }) {
  const [data, setData] = useState(null);
  // Fetched once on mount — we surface the LP-credential warning when
  // admin sets a user to A_BOOK / HYBRID and the platform has no
  // credentialed LP provider configured.
  const [systemInfo, setSystemInfo] = useState(null);
  // Leverage state — fetched separately so admin can edit + see history
  // without polluting the main user payload. Refetches after every edit.
  const [leverage, setLeverage] = useState(null);
  const [leverageEditOpen, setLeverageEditOpen] = useState(false);
  const [leverageHistoryOpen, setLeverageHistoryOpen] = useState(false);

  // Affiliate-bonus form state. Lives here so opening/closing it
  // doesn't trigger a remount-driven data refetch.
  const [bonusOpen, setBonusOpen] = useState(false);
  const [bonusAmt, setBonusAmt] = useState('');
  const [bonusNote, setBonusNote] = useState('');
  const [bonusSubmitting, setBonusSubmitting] = useState(false);

  const load = async () => {
    const { data } = await api.get(`/admin/users/${userId}`);
    setData(data.data);
  };
  const loadLeverage = async () => {
    try {
      const { data } = await api.get(`/admin/users/${userId}/leverage`);
      setLeverage(data.data);
    } catch (_) { /* non-fatal */ }
  };
  useEffect(() => {
    load();
    loadLeverage();
    api.get('/admin/system/settings').then((r) => setSystemInfo(r.data.data)).catch(() => {});
  }, [userId]);

  // ── Leverage actions ────────────────────────────────────────────
  const saveLeverage = async ({ value, reason, expiresAt }) => {
    try {
      await api.put(`/admin/users/${userId}/leverage`, { value, reason, expiresAt });
      toast.success(`Leverage set to 1:${value}`);
      setLeverageEditOpen(false);
      loadLeverage();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const resetLeverage = async () => {
    if (!window.confirm('Reset leverage to plan default? The user will revert to their subscription tier.')) return;
    try {
      await api.delete(`/admin/users/${userId}/leverage`, {
        data: { reason: 'Reset by admin' },
      });
      toast.success('Override cleared — reverted to plan default');
      loadLeverage();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const toggleStatus = async () => {
    try {
      await api.put(`/admin/users/${userId}/status`, { isActive: !data.user.isActive });
      toast.success('Status updated');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const reviewKyc = async (decision) => {
    let reason = null;
    if (decision === 'REJECT') {
      reason = prompt('Rejection reason:');
      if (!reason) return;
    }
    try {
      await api.post(`/admin/users/${userId}/kyc-review`, { decision, reason });
      toast.success(`KYC ${decision.toLowerCase()}d`);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const adjustBalance = async (accountId, currency) => {
    const amount = prompt('Amount to add (negative to debit):');
    if (!amount) return;
    const reason = prompt('Reason:');
    if (!reason) return;
    try {
      await api.post(`/admin/users/${userId}/balance-adjustment`, { accountId, currency, amount, reason });
      toast.success('Balance adjusted');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Set / change / clear who referred this user. Useful for fixing
  // chains broken by the old case-sensitive lookup bug, or for admin-
  // assigned attribution.
  const fixReferrer = async () => {
    const code = window.prompt(
      'Set referrer by referral code (blank = clear):',
      data?.user?.referredBy?.referralCode || ''
    );
    if (code === null) return; // cancelled
    try {
      await api.post(`/admin/users/${userId}/set-referrer`, {
        referralCode: code.trim() || null,
      });
      toast.success(code.trim() ? 'Referrer updated' : 'Referrer cleared');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Credit a referral / affiliate bonus to this user. Creates a
  // Commission row (visible on user's Affiliate page) AND credits their
  // primary REAL wallet immediately.
  const submitAffiliateBonus = async () => {
    const n = Number(bonusAmt);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Enter a positive amount');
      return;
    }
    setBonusSubmitting(true);
    try {
      await api.post(`/admin/users/${userId}/affiliate-bonus`, {
        amount: n,
        note: bonusNote || undefined,
      });
      toast.success(`Credited ${n.toFixed(2)} as referral bonus`);
      setBonusAmt('');
      setBonusNote('');
      setBonusOpen(false);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBonusSubmitting(false);
    }
  };

  // Save partial execution-config update for an account. Sends only the
  // changed field; backend's PATCH endpoint merges + auto-picks an LP if
  // bookType flips to A_BOOK / HYBRID without one selected.
  const updateExecutionConfig = async (accountId, patch) => {
    // Find what the LP was BEFORE the change so we can surface auto-pick.
    const existing = data?.accounts?.find((x) => x._id === accountId);
    const prevLp = existing?.lpProvider || 'NONE';
    try {
      const { data: resp } = await api.patch(`/admin/accounts/${accountId}/execution-config`, patch);
      // If we asked for a bookType change but didn't specify lpProvider, and
      // the server bumped it from NONE → something else, tell the admin.
      const newLp = resp?.data?.lpProvider;
      if (patch.bookType && !patch.lpProvider && newLp && newLp !== prevLp && newLp !== 'NONE') {
        toast.success(`Updated. LP auto-set to ${newLp}.`);
      } else {
        toast.success('Execution config updated');
      }
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Per-user risk controls: forceABook override, userGroup tag, and
  // symbol-level block list. forceABook short-circuits the riskEngine
  // for HYBRID accounts; blockedInstruments rejects orders at the router.
  const updateRiskControls = async (patch) => {
    try {
      await api.patch(`/admin/users/${userId}/risk-controls`, patch);
      toast.success('Risk controls updated');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!data) return null;
  const { user, accounts, wallets, referees = [], bonusQuota } = data;
  // Default quota for older API responses that don't return it.
  const quota = bonusQuota || { refereeCount: referees.length, credited: 0, available: referees.length };
  const bonusAvailable = quota.available > 0;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{user.email}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={load}
              title="Reload — pulls fresh referee count + balances"
              className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-bg-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
          </div>
        </div>
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Name" value={`${user.firstName || ''} ${user.lastName || ''}`} />
            <Field label="Phone" value={user.phone || '-'} />
            <Field label="Role" value={user.role} />
            <Field label="Status" value={user.isActive ? 'Active' : 'Blocked'} />
            <Field label="KYC Status" value={user.kycStatus} />
            <Field label="2FA" value={user.twoFactorEnabled ? 'Enabled' : 'Disabled'} />
            <Field label="Group" value={user.userGroup} />
            <Field label="Referral Code" value={user.referralCode} />
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1 flex items-center gap-2">
                <span>Referred By</span>
                <button
                  type="button"
                  onClick={fixReferrer}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-bg-card border border-border-dark text-primary-500 hover:text-white hover:border-primary-500 transition-colors font-bold uppercase tracking-wider"
                  title="Set or fix the referrer (use the referrer's referral code)"
                >
                  Edit
                </button>
              </div>
              <div className="text-white text-sm">
                {user.referredBy ? (
                  <button
                    type="button"
                    onClick={() => onJumpToUser && onJumpToUser(user.referredBy._id)}
                    title="Open the referrer's profile"
                    className="inline-flex items-center gap-1 hover:text-primary-500 transition-colors group"
                  >
                    <span className="underline decoration-dotted underline-offset-2 group-hover:decoration-solid">
                      {[user.referredBy.firstName, user.referredBy.lastName].filter(Boolean).join(' ') || user.referredBy.email}
                    </span>
                    {user.referredBy.referralCode && (
                      <span className="font-mono text-xs text-text-muted">({user.referredBy.referralCode})</span>
                    )}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted group-hover:text-primary-500">
                      <path d="M7 17L17 7" /><path d="M7 7h10v10" />
                    </svg>
                  </button>
                ) : (
                  <span className="text-gray-500">Direct signup</span>
                )}
              </div>
            </div>
            <Field label="Last Login" value={fmtDate(user.lastLoginAt)} />
            <Field label="Joined" value={fmtDate(user.createdAt)} />
          </div>

          {/* Affiliate bonus — ONLY rendered for REFERRERS (users who
              have referred ≥1 other user). For everyone else (referees,
              direct signups) the section is hidden entirely — admin
              shouldn't see noisy "you can't credit this user" cards.
              The "Referred By" field above already conveys the chain. */}
          {referees.length > 0 && (
            <div className="bg-bg-dark rounded p-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-white text-sm">Referral / Affiliate bonus</h3>
                  <div className={`text-[10px] uppercase tracking-wide font-bold mt-0.5 ${bonusAvailable ? 'text-bull' : 'text-warn'}`}>
                    {bonusAvailable ? (
                      <>
                        {quota.available} of {quota.refereeCount} bonus{quota.refereeCount === 1 ? '' : 'es'} available
                        {quota.credited > 0 && (
                          <span className="text-gray-500 ml-1.5 normal-case tracking-normal font-normal">
                            ({quota.credited} already credited)
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        All bonuses credited · {quota.credited} of {quota.refereeCount}
                      </>
                    )}
                  </div>
                </div>
                {!bonusOpen ? (
                  <button
                    type="button"
                    onClick={() => bonusAvailable && setBonusOpen(true)}
                    disabled={!bonusAvailable}
                    title={
                      bonusAvailable
                        ? 'Credit a referral bonus to this user'
                        : 'All bonus slots used — wait for a new referee to sign up'
                    }
                    className="text-xs px-3 py-1.5 rounded bg-primary-500 text-white font-bold hover:bg-primary-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-primary-500"
                  >
                    + Add bonus
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setBonusOpen(false); setBonusAmt(''); setBonusNote(''); }}
                    className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {!bonusOpen && (
                <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">
                  {bonusAvailable ? (
                    <>
                      Credit a manual referral payout to <span className="text-white font-semibold">this referrer</span>.
                      One bonus per referee — the slot re-opens when a new user signs up via their link.
                    </>
                  ) : (
                    <>
                      This referrer has been paid for all <span className="text-white font-semibold">{quota.refereeCount}</span>{' '}
                      {quota.refereeCount === 1 ? 'referee' : 'referees'}. The button unlocks again when their next referee joins.
                    </>
                  )}
                </p>
              )}
              {bonusOpen && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-1">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500 block mb-1">Amount</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={bonusAmt}
                        onChange={(e) => setBonusAmt(e.target.value)}
                        placeholder="100.00"
                        autoFocus
                        className="w-full bg-bg-card border border-border-dark rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-primary-500"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500 block mb-1">
                        Note (optional)
                      </label>
                      <input
                        type="text"
                        value={bonusNote}
                        onChange={(e) => setBonusNote(e.target.value)}
                        placeholder="e.g. Q2 affiliate payout"
                        maxLength={120}
                        className="w-full bg-bg-card border border-border-dark rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-primary-500"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={submitAffiliateBonus}
                      disabled={bonusSubmitting || !bonusAmt}
                      className="text-xs px-3 py-1.5 rounded bg-bull text-white font-bold hover:bg-bull/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {bonusSubmitting ? 'Crediting…' : 'Credit bonus'}
                    </button>
                    <span className="text-[10px] text-gray-500">
                      Credits in the referrer's primary real-account currency.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Leverage management — admin can override or reset the
              user's leverage cap. Override always beats plan default. */}
          {leverage && (
            <LeverageCard
              state={leverage}
              userActive={user.isActive !== false}
              onEdit={() => setLeverageEditOpen(true)}
              onReset={resetLeverage}
              onHistory={() => setLeverageHistoryOpen(true)}
            />
          )}
          {leverageEditOpen && leverage && (
            <LeverageEditModal
              current={leverage}
              onClose={() => setLeverageEditOpen(false)}
              onSave={saveLeverage}
            />
          )}
          {leverageHistoryOpen && (
            <LeverageHistoryModal
              userId={userId}
              onClose={() => setLeverageHistoryOpen(false)}
            />
          )}

          {/* Referees — anyone who signed up using this user's referral
              code. Compliance / affiliate audit at a glance. */}
          {referees.length > 0 && (
            <div className="bg-bg-dark rounded p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-white text-sm">Direct referrals</h3>
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                  {referees.length} {referees.length === 1 ? 'user' : 'users'}
                </span>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {referees.map((r) => {
                  const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email;
                  return (
                    <div key={r._id} className="flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded hover:bg-bg-hover">
                      <div className="min-w-0">
                        <div className="text-white truncate">{name}</div>
                        <div className="text-gray-500 text-[10px] truncate">{r.email}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          r.kycStatus === 'APPROVED' ? 'bg-bull/15 text-bull' :
                          r.kycStatus === 'REJECTED' ? 'bg-bear/15 text-bear' :
                          'bg-warn/15 text-warn'
                        }`}>{r.kycStatus || 'NONE'}</span>
                        {r.isActive === false && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bear/15 text-bear">Blocked</span>
                        )}
                        <span className="text-gray-500 font-mono text-[10px]">{fmtDate(r.createdAt)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button onClick={toggleStatus} className={user.isActive ? 'btn-bear' : 'btn-bull'}>
              {user.isActive ? 'Block User' : 'Unblock User'}
            </button>
            {user.kycStatus === 'PENDING' && (
              <>
                <button onClick={() => reviewKyc('APPROVE')} className="btn-bull">Approve KYC</button>
                <button onClick={() => reviewKyc('REJECT')} className="btn-bear">Reject KYC</button>
              </>
            )}
          </div>

          {/* Risk controls — user-level overrides. Routing Override here
              takes precedence over the global Settings → Routing Mode for
              THIS user only. INHERIT = use whatever the global says. */}
          {(() => {
            const userRouting = user.riskOverride?.routingMode || 'INHERIT';
            const globalMode = systemInfo?.settings?.routingMode || 'B_BOOK';
            const effective = userRouting === 'INHERIT' ? globalMode : userRouting;
            const needsLp = effective === 'A_BOOK' || effective === 'HYBRID';
            const noCreds = systemInfo
              ? !(systemInfo.lpProviders || []).some((p) => p.credentialed)
              : false;
            return (
              <div className="bg-bg-dark rounded p-3">
                <h3 className="font-semibold text-white mb-3 text-sm">Risk Controls</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <ConfigSelect
                    label="Routing Override"
                    value={userRouting}
                    options={['INHERIT', 'A_BOOK', 'B_BOOK', 'HYBRID']}
                    onChange={(v) => updateRiskControls({ routingMode: v })}
                  />
                  <ConfigSelect
                    label="User Group"
                    value={user.userGroup || 'DEFAULT'}
                    options={['DEFAULT', 'NEW', 'VIP', 'PROFITABLE', 'SUSPICIOUS', 'NO_BBOOK']}
                    onChange={(v) => updateRiskControls({ userGroup: v })}
                  />
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                      Blocked Symbols ({(user.blockedInstruments || []).length})
                    </div>
                    <input
                      type="text"
                      defaultValue={(user.blockedInstruments || []).join(', ')}
                      placeholder="BTCUSD, ETHUSD"
                      onBlur={(e) => {
                        const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                        const current = (user.blockedInstruments || []).join(',');
                        if (list.join(',') !== current) updateRiskControls({ blockedInstruments: list });
                      }}
                      className="w-full bg-bg-card border border-border-dark rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary-500"
                    />
                  </div>
                </div>
                <div className="text-[10px] text-gray-500 mt-2">
                  Effective routing for this user: <span className="text-white font-mono">{effective}</span>
                  {userRouting === 'INHERIT' && <span className="text-gray-500"> (inheriting global)</span>}
                </div>

                {/* LP credential warning — if effective routing needs LP and
                    none of the providers have creds, yell loud. Doesn't
                    block save (stub fills work for dev) but admin needs to
                    know orders won't reach a real venue. */}
                {needsLp && noCreds && (
                  <div className="mt-3 flex items-start gap-2 text-xs bg-bear/10 border border-bear/30 text-bear rounded p-2.5">
                    <span className="leading-none">⚠</span>
                    <div>
                      <div className="font-semibold mb-0.5">LP credentials not configured</div>
                      <div className="text-bear/80">
                        This user is set to <b>{effective}</b> but no LP provider has API
                        keys in <code>.env</code> — orders will use synthetic stub fills.
                        Set <code>OANDA_API_KEY</code> / <code>BINANCE_API_KEY</code> /
                        <code>CUSTOM_LP_*</code> and restart backend before going live.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {user.kycDocuments?.length > 0 && (
            <div>
              <h3 className="font-semibold text-white mb-2">KYC Documents</h3>
              <div className="space-y-2">
                {user.kycDocuments.map((d, i) => (
                  <div key={i} className="bg-bg-dark p-2 rounded text-sm">
                    <span className="text-gray-400">{d.type}: </span>
                    <a href={d.url} target="_blank" rel="noreferrer" className="text-primary-500 underline break-all">{d.url}</a>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="font-semibold text-white mb-2">Trading Accounts ({accounts.length})</h3>
            <div className="space-y-2">
              {accounts.map((a) => {
                const accWallets = wallets.filter((w) => w.accountId === a._id);
                return (
                  <div key={a._id} className="bg-bg-dark p-3 rounded text-sm">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="font-medium text-white">{a.nickname || a.accountNumber}</div>
                        <div className="text-xs text-gray-500">{a.accountNumber} • {a.accountType}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                        a.isTradingEnabled === false
                          ? 'bg-bear/20 text-bear'
                          : 'bg-emerald-500/20 text-emerald-400'
                      }`}>
                        {a.isTradingEnabled === false ? 'TRADING OFF' : 'ACTIVE'}
                      </span>
                    </div>

                    {/* Per-account leverage moved to the user-level
                        Leverage card above — single source of truth via
                        leverageService. Only trading-enabled toggle
                        remains as a per-account control. */}
                    <div className="mb-3 pb-3 border-b border-border-dark">
                      <div className="flex items-end justify-between text-xs">
                        <span className="text-gray-400">Trading Enabled</span>
                        <button
                          onClick={() => updateExecutionConfig(a._id, { isTradingEnabled: !(a.isTradingEnabled !== false) })}
                          className={`relative w-10 h-5 rounded-full transition-colors ${
                            a.isTradingEnabled !== false ? 'bg-bull' : 'bg-gray-600'
                          }`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                            a.isTradingEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'
                          }`} />
                        </button>
                      </div>
                    </div>

                    {accWallets.map((w) => (
                      <div key={w._id} className="flex items-center justify-between text-xs py-1 border-t border-border-dark">
                        <span className="text-gray-400">{w.currency}</span>
                        <span className="font-mono">Balance: {fmtNum(w.balance, 2)} | Locked: {fmtNum(w.locked, 2)}</span>
                        <button onClick={() => adjustBalance(a._id, w.currency)} className="btn-ghost text-xs">Adjust</button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-gray-200 mt-0.5">{value}</div>
    </div>
  );
}

// ─── Leverage management UI ──────────────────────────────────────────
function LeverageCard({ state, userActive, onEdit, onReset, onHistory }) {
  const overridden = state.isOverridden;
  return (
    <div className="bg-bg-dark rounded p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <h3 className="font-semibold text-white text-sm">Leverage</h3>
          <div className={`text-[10px] uppercase tracking-wide font-bold mt-0.5 ${
            overridden ? 'text-amber-400' : 'text-emerald-400'
          }`}>
            {overridden ? 'Admin Override Active' : `From ${state.planName} Plan`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono font-bold text-white tabular-nums">
            1:{state.effectiveLeverage}
          </div>
          <div className="text-[10px] text-gray-500 font-mono">
            Plan default 1:{state.planDefault}
          </div>
        </div>
      </div>

      {overridden && state.overrideMeta?.reason && (
        <div className="text-[11px] text-gray-400 italic mb-2 truncate" title={state.overrideMeta.reason}>
          "{state.overrideMeta.reason}"
        </div>
      )}
      {overridden && state.overrideMeta?.expiresAt && (
        <div className="text-[10px] text-amber-400 mb-2 font-mono">
          Expires {new Date(state.overrideMeta.expiresAt).toLocaleString()}
        </div>
      )}

      <div className="flex items-center gap-1.5 pt-2 border-t border-border-dark">
        <button
          type="button"
          onClick={onEdit}
          disabled={!userActive}
          title={userActive ? 'Set / change leverage override' : 'User is blocked — cannot modify'}
          className="text-xs px-3 py-1.5 rounded bg-primary-500 text-white font-bold hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {overridden ? 'Edit' : '+ Set override'}
        </button>
        {overridden && (
          <button
            type="button"
            onClick={onReset}
            disabled={!userActive}
            className="text-xs px-3 py-1.5 rounded bg-bg-card border border-border-dark text-text-secondary hover:text-white hover:border-bear transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset to plan default
          </button>
        )}
        <button
          type="button"
          onClick={onHistory}
          className="text-xs px-3 py-1.5 rounded text-gray-400 hover:text-white hover:bg-bg-hover transition-colors ml-auto"
        >
          History →
        </button>
      </div>
    </div>
  );
}

// Platform-wide sentinel — encodes "1:Unlimited" as a finite integer so
// margin math stays positive. Must match leverageService.SYSTEM_MAX.
const UNLIMITED_LEVERAGE = 999999;
// Slider only renders up to a usable visual ceiling — going to 999999
// would make every preset look like 0% of the bar. The "Unlimited"
// preset bypasses the slider entirely.
const SLIDER_VISUAL_MAX = 1000;

function LeverageEditModal({ current, onClose, onSave }) {
  const [value, setValue] = useState(current.effectiveLeverage);
  const [reason, setReason] = useState('');
  const [tempEnabled, setTempEnabled] = useState(!!current.overrideMeta?.expiresAt);
  const [expiresAt, setExpiresAt] = useState(
    current.overrideMeta?.expiresAt
      ? new Date(current.overrideMeta.expiresAt).toISOString().slice(0, 16)
      : ''
  );
  const [saving, setSaving] = useState(false);
  const presets = [10, 50, 100, 200, 500, 1000];

  const isUnlimited = Number(value) >= UNLIMITED_LEVERAGE;
  const displayValue = isUnlimited ? 'Unlimited' : `1:${Math.round(Number(value) || 1)}`;

  const submit = async (e) => {
    e?.preventDefault?.();
    let v = Math.round(Number(value) || 1);
    if (v >= UNLIMITED_LEVERAGE) v = UNLIMITED_LEVERAGE;
    else v = Math.max(1, Math.min(SLIDER_VISUAL_MAX, v));
    setSaving(true);
    try {
      await onSave({
        value: v,
        reason: reason.trim() || undefined,
        expiresAt: tempEnabled && expiresAt ? new Date(expiresAt).toISOString() : null,
      });
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="card max-w-md w-full"
      >
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-base font-bold text-white">Set leverage override</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-gray-500 block mb-2 font-bold">
              New leverage
            </label>
            <div className="flex items-center gap-2">
              <span className="text-text-secondary font-mono">1 :</span>
              {isUnlimited ? (
                <div className="flex-1 bg-bg-card border border-primary-500 rounded px-3 py-2 text-lg font-bold text-primary-500 flex items-center justify-between">
                  <span>Unlimited</span>
                  <button
                    type="button"
                    onClick={() => setValue(current.effectiveLeverage >= UNLIMITED_LEVERAGE ? 100 : current.effectiveLeverage)}
                    className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded bg-bg-hover text-text-secondary hover:text-white"
                  >
                    Set custom
                  </button>
                </div>
              ) : (
                <input
                  type="number"
                  min="1"
                  max={UNLIMITED_LEVERAGE}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                  className="flex-1 bg-bg-card border border-border-dark rounded px-3 py-2 text-lg font-mono font-bold text-white focus:outline-none focus:border-primary-500"
                />
              )}
            </div>
            <input
              type="range"
              min="1"
              max={SLIDER_VISUAL_MAX}
              value={isUnlimited ? SLIDER_VISUAL_MAX : value}
              onChange={(e) => setValue(Number(e.target.value))}
              disabled={isUnlimited}
              className="w-full mt-3 accent-primary-500 disabled:opacity-40"
            />
            <div className="flex flex-wrap gap-1.5 mt-3">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setValue(p)}
                  className={`text-xs px-2.5 py-1 rounded font-bold transition-colors ${
                    !isUnlimited && Number(value) === p
                      ? 'bg-primary-500 text-white'
                      : 'bg-bg-card border border-border-dark text-text-secondary hover:text-white hover:border-primary-500'
                  }`}
                >
                  1:{p}
                </button>
              ))}
              {/* Unlimited preset — sets the sentinel value */}
              <button
                type="button"
                onClick={() => setValue(UNLIMITED_LEVERAGE)}
                className={`text-xs px-2.5 py-1 rounded font-bold transition-colors ${
                  isUnlimited
                    ? 'bg-primary-500 text-white'
                    : 'bg-bg-card border border-border-dark text-text-secondary hover:text-white hover:border-primary-500'
                }`}
              >
                1:Unlimited
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-gray-500 block mb-1 font-bold">
              Reason (optional)
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. VIP request, risk review"
              maxLength={140}
              className="w-full bg-bg-card border border-border-dark rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-300">
              <input
                type="checkbox"
                checked={tempEnabled}
                onChange={(e) => setTempEnabled(e.target.checked)}
                className="accent-primary-500"
              />
              Temporary override (auto-reverts after a date)
            </label>
            {tempEnabled && (
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-bg-card border border-border-dark rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500"
              />
            )}
          </div>

          <div className="bg-warn/10 border border-warn/30 rounded p-3 text-[11px] text-warn">
            ⚠ Override always beats the plan default. Reset removes it and
            the user reverts to their {current.planName} plan cap (1:{current.planDefault}).
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary text-sm">
            {saving ? 'Saving…' : `Set ${displayValue}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function LeverageHistoryModal({ userId, onClose }) {
  const [logs, setLogs] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.get(`/admin/users/${userId}/leverage/history`)
      .then((r) => { if (!cancelled) setLogs(r.data.data); })
      .catch(() => { if (!cancelled) setLogs([]); });
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between sticky top-0 bg-bg-card z-10">
          <h2 className="text-base font-bold text-white">Leverage change history</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <div className="p-5">
          {logs === null && <div className="text-text-muted text-sm">Loading…</div>}
          {logs && logs.length === 0 && (
            <div className="text-text-muted text-sm text-center py-8">No changes recorded yet.</div>
          )}
          {logs && logs.length > 0 && (
            <div className="space-y-2">
              {logs.map((l) => (
                <div key={l._id} className="bg-bg-dark rounded p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      l.action === 'SET_OVERRIDE'   ? 'bg-amber-500/15 text-amber-400'
                      : l.action === 'CLEAR_OVERRIDE' ? 'bg-bull/15 text-bull'
                      : l.action === 'PLAN_CHANGE'    ? 'bg-primary-500/15 text-primary-400'
                      :                                 'bg-violet-500/15 text-violet-400'
                    }`}>
                      {l.action.replace('_', ' ')}
                    </span>
                    <span className="text-[10px] font-mono text-gray-500">
                      {new Date(l.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-white font-mono">
                    1:{l.from?.effective || '—'}
                    <span className="text-gray-500 mx-1.5">→</span>
                    <span className="font-bold">1:{l.to?.effective || '—'}</span>
                    <span className="ml-2 text-[10px] text-gray-500 font-sans normal-case">
                      ({l.from?.source || '—'} → {l.to?.source || '—'})
                    </span>
                  </div>
                  {l.reason && (
                    <div className="text-[11px] text-gray-400 italic mt-1 truncate" title={l.reason}>
                      "{l.reason}"
                    </div>
                  )}
                  {l.changedBy && (
                    <div className="text-[10px] text-gray-500 mt-1">
                      by {[l.changedBy.firstName, l.changedBy.lastName].filter(Boolean).join(' ') || l.changedBy.email}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigSelect({ label, value, options, onChange }) {
  return (
    <label className="block">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-card border border-border-dark rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary-500"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </label>
  );
}

function ConfigNumber({ label, value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== value) onSave(n);
  };
  return (
    <label className="block">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">{label}</div>
      <input
        type="number"
        value={v}
        min="1"
        max="1000"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
        className="w-full bg-bg-card border border-border-dark rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-primary-500"
      />
    </label>
  );
}
