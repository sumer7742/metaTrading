import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate, fmtNum } from '../utils/format';

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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">User Management</h1>

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

  const load = async () => {
    const { data } = await api.get(`/admin/users/${userId}`);
    setData(data.data);
  };
  useEffect(() => { load(); }, [userId]);

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
                        <div className="text-xs text-gray-500">{a.accountNumber} • {a.accountType} • Lev 1:{a.leverage} • {a.mode}</div>
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
