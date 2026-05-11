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
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Joined</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u._id} className="table-row">
                <td className="p-3">{u.email}</td>
                <td className="p-3">{u.firstName} {u.lastName}</td>
                <td className="p-3 text-xs text-primary-500">{u.role}</td>
                <td className="p-3"><KycBadge status={u.kycStatus} /></td>
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
            ))}
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

      {selected && <UserDetail userId={selected._id} onClose={() => { setSelected(null); load(); }} />}
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

function UserDetail({ userId, onClose }) {
  const [data, setData] = useState(null);
  // Fetched once on mount — we surface the LP-credential warning when
  // admin sets a user to A_BOOK / HYBRID and the platform has no
  // credentialed LP provider configured.
  const [systemInfo, setSystemInfo] = useState(null);

  const load = async () => {
    const { data } = await api.get(`/admin/users/${userId}`);
    setData(data.data);
  };
  useEffect(() => {
    load();
    api.get('/admin/system/settings').then((r) => setSystemInfo(r.data.data)).catch(() => {});
  }, [userId]);

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
  const { user, accounts, wallets } = data;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{user.email}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
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
            <Field label="Last Login" value={fmtDate(user.lastLoginAt)} />
            <Field label="Joined" value={fmtDate(user.createdAt)} />
          </div>

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
                        <div className="text-xs text-gray-500">{a.accountNumber} • {a.accountType} • Lev 1:{a.leverage}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                        a.isTradingEnabled === false
                          ? 'bg-bear/20 text-bear'
                          : 'bg-emerald-500/20 text-emerald-400'
                      }`}>
                        {a.isTradingEnabled === false ? 'TRADING OFF' : 'ACTIVE'}
                      </span>
                    </div>

                    {/* Per-account execution-config controls were removed —
                        routing is now a PLATFORM-WIDE setting (Settings →
                        Routing Mode). Only leverage + trading-enabled
                        remain as account-level toggles. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 pb-3 border-b border-border-dark">
                      <ConfigNumber
                        label="Leverage"
                        value={a.leverage || 1}
                        onSave={(v) => updateExecutionConfig(a._id, { leverage: v })}
                      />
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
