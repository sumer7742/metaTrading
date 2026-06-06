import { useEffect, useState, useMemo } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate, fmtNum } from '../utils/format';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';

// ── Column registry ──────────────────────────────────────────────────
// Canonical, ordered list of every available column. `actions` is pinned
// separately (always last, never toggled). `adminOnly` columns are hidden
// from MANAGER role entirely. `sortBy` maps to the backend SORT_FIELDS.
const ALL_COLUMNS = [
  { key: 'userId',          label: 'User ID',          sortBy: null },
  { key: 'email',           label: 'Email',            sortBy: 'email' },
  { key: 'name',            label: 'Name',             sortBy: 'name' },
  { key: 'phone',           label: 'Phone',            sortBy: null },
  { key: 'country',         label: 'Country',          sortBy: null },
  { key: 'role',            label: 'Role',             sortBy: 'role' },
  { key: 'plan',            label: 'Plan',             sortBy: 'plan' },
  { key: 'walletBalance',   label: 'Wallet Balance',   sortBy: 'walletBalance',   numeric: true },
  { key: 'totalDeposit',    label: 'Total Deposit',    sortBy: 'totalDeposit',    numeric: true },
  { key: 'totalWithdrawal', label: 'Total Withdrawal', sortBy: 'totalWithdrawal', numeric: true },
  { key: 'totalPnl',        label: 'Total PnL',        sortBy: 'totalPnl',        numeric: true },
  { key: 'platformEarnings',label: 'Platform Earnings',sortBy: null,             numeric: true },
  { key: 'kyc',             label: 'KYC',              sortBy: 'kyc' },
  { key: 'referredBy',      label: 'Referred By',      sortBy: null },
  { key: 'status',          label: 'Status',           sortBy: 'status' },
  { key: 'joined',          label: 'Joined',           sortBy: 'joined' },
  { key: 'lastLogin',       label: 'Last Login',       sortBy: 'lastLogin' },
  { key: 'manager',         label: 'Manager',          sortBy: null, adminOnly: true },
  { key: 'admin',           label: 'Admin',            sortBy: null, adminOnly: true },
];
const DEFAULT_ORDER = ALL_COLUMNS.map((c) => c.key);
const LAYOUT_VERSION = 1;

// Role-based DEFAULT visibility. Super Admin sees everything; Admin sees the
// canonical set; Manager sees a limited subset (and no admin-only columns).
function defaultVisibility(role) {
  const vis = {};
  ALL_COLUMNS.forEach((c) => { vis[c.key] = false; });
  const show = (keys) => keys.forEach((k) => { vis[k] = true; });
  if (role === 'SUPER_ADMIN') {
    ALL_COLUMNS.forEach((c) => { vis[c.key] = true; });
  } else if (role === 'MANAGER') {
    show(['userId', 'email', 'name', 'plan', 'walletBalance', 'kyc', 'status', 'joined']);
  } else { // ADMIN + fallback
    show(['userId', 'email', 'name', 'role', 'plan', 'walletBalance', 'totalDeposit',
      'totalWithdrawal', 'totalPnl', 'platformEarnings', 'kyc', 'referredBy', 'status', 'joined']);
  }
  return vis;
}

const PLAN_TONE = {
  FREE:    'bg-gray-700/70 text-gray-300 border-gray-600',
  BASIC:   'bg-zinc-600/40 text-zinc-200 border-zinc-500',
  SILVER:  'bg-slate-400/20 text-slate-200 border-slate-400/40',
  GOLD:    'bg-amber-500/15 text-amber-300 border-amber-500/40',
  PREMIUM: 'bg-blue-500/15 text-blue-300 border-blue-500/40',
  PRO:     'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  VIP:     'bg-violet-500/15 text-violet-300 border-violet-500/40',
};
const PLAN_FILTER_OPTIONS = ['FREE', 'BASIC', 'SILVER', 'GOLD', 'PREMIUM', 'PRO', 'VIP'];

const signedMoney = (v) => { const n = Number(v) || 0; return `${n < 0 ? '-' : ''}$${fmtNum(Math.abs(n))}`; };
const money = (v) => `$${fmtNum(Math.abs(Number(v) || 0))}`;
const fullName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ');
const csvEscape = (val) => {
  const s = val == null ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function Users() {
  const { user: me } = useAuthStore();
  const role = me?.role || 'ADMIN';
  const myId = me?._id || me?.id || 'anon';
  const storageKey = `userTableLayout:${myId}`;

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kycFilter, setKycFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [sortBy, setSortBy] = useState('joined');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [history, setHistory] = useState(null); // { kind, user }
  const [exporting, setExporting] = useState(false);

  // Columns this role may ever see (managers can't access admin-only ones).
  const accessibleColumns = useMemo(
    () => ALL_COLUMNS.filter((c) => !c.adminOnly || role !== 'MANAGER'),
    [role]
  );

  const [order, setOrder] = useState(DEFAULT_ORDER);
  const [visible, setVisible] = useState(() => defaultVisibility(role));

  // Restore saved layout (per admin user) or fall back to the role default.
  useEffect(() => {
    const fallback = () => { setOrder(DEFAULT_ORDER); setVisible(defaultVisibility(role)); };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && saved.v === LAYOUT_VERSION && Array.isArray(saved.order) && saved.visible) {
        const known = new Set(ALL_COLUMNS.map((c) => c.key));
        const ord = saved.order.filter((k) => known.has(k));
        ALL_COLUMNS.forEach((c) => { if (!ord.includes(c.key)) ord.push(c.key); }); // append new cols
        const def = defaultVisibility(role);
        const vis = {};
        ALL_COLUMNS.forEach((c) => { vis[c.key] = c.key in saved.visible ? !!saved.visible[c.key] : def[c.key]; });
        setOrder(ord); setVisible(vis);
      } else fallback();
    } catch { fallback(); }
  }, [storageKey, role]);

  const persist = (ord, vis) => {
    setOrder(ord); setVisible(vis);
    try { localStorage.setItem(storageKey, JSON.stringify({ v: LAYOUT_VERSION, order: ord, visible: vis })); } catch { /* quota */ }
  };
  const resetLayout = () => {
    try { localStorage.removeItem(storageKey); } catch { /* */ }
    setOrder(DEFAULT_ORDER); setVisible(defaultVisibility(role));
    toast.success('Layout reset to default');
  };

  // Ordered + visible + role-accessible columns actually rendered.
  const visibleColumns = useMemo(
    () => order
      .map((k) => accessibleColumns.find((c) => c.key === k))
      .filter((c) => c && visible[c.key]),
    [order, visible, accessibleColumns]
  );

  const fetchUsers = async (params) => {
    const { data } = await api.get('/admin/users', {
      params: { search, kyc: kycFilter, status: statusFilter, plan: planFilter, role: roleFilter, sortBy, sortDir, ...params },
    });
    return data.data;
  };

  const load = async () => {
    setLoading(true);
    try {
      const d = await fetchUsers({ page, limit: 25 });
      setUsers(d.users || []);
      setTotal(d.total || 0);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [page, kycFilter, statusFilter, planFilter, roleFilter, sortBy, sortDir]);

  const onSearch = (e) => { e.preventDefault(); setPage(1); load(); };

  const toggleSort = (col) => {
    if (!col.sortBy) return;
    if (sortBy === col.sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col.sortBy); setSortDir(col.numeric ? 'desc' : 'asc'); }
    setPage(1);
  };

  // CSV export — respects current visible columns + their order, and the
  // active filters/sort. Pulls a wider page so it isn't limited to 25 rows.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const d = await fetchUsers({ page: 1, limit: 1000 });
      const rows = d.users || [];
      const cols = visibleColumns;
      const lines = [cols.map((c) => csvEscape(c.label)).join(',')];
      for (const u of rows) lines.push(cols.map((c) => csvEscape(exportCell(c.key, u))).join(','));
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `users_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} users`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  // Plain value for CSV export, per column.
  const exportCell = (key, u) => {
    switch (key) {
      case 'userId': return u.userUid || '';
      case 'email': return u.email || '';
      case 'name': return fullName(u);
      case 'phone': return u.phone || '';
      case 'country': return u.country || '';
      case 'role': return u.role || '';
      case 'plan': return u.plan?.name || u.plan?.code || 'Free';
      case 'walletBalance': return Number(u.walletBalance || 0).toFixed(2);
      case 'totalDeposit': return Number(u.totalDeposit || 0).toFixed(2);
      case 'totalWithdrawal': return Number(u.totalWithdrawal || 0).toFixed(2);
      case 'totalPnl': return Number(u.totalPnl || 0).toFixed(2);
      case 'platformEarnings': return Number(u.platformEarnings || 0).toFixed(2);
      case 'kyc': return u.kycStatus || '';
      case 'referredBy': return u.referredBy ? (fullName(u.referredBy) || u.referredBy.email || '') : '';
      case 'status': return u.isActive ? 'Active' : 'Blocked';
      case 'joined': return u.createdAt ? new Date(u.createdAt).toISOString() : '';
      case 'lastLogin': return u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '';
      case 'manager': return u.manager?.name || '';
      case 'admin': return u.admin?.name || '';
      default: return '';
    }
  };

  // Cell renderer, per column.
  const renderCell = (key, u) => {
    switch (key) {
      case 'userId':
        return u.userUid ? (
          <button type="button" title="Copy User ID"
            onClick={() => { navigator.clipboard.writeText(u.userUid); toast.success('User ID copied'); }}
            className="font-mono text-xs font-bold text-primary-500 hover:text-primary-400">
            {u.userUid}
          </button>
        ) : <span className="text-gray-600 text-xs">—</span>;
      case 'email': return <span className="text-gray-200">{u.email}</span>;
      case 'name': return <span className="text-gray-200">{fullName(u) || '—'}</span>;
      case 'phone': return <span className="font-mono text-xs text-gray-300">{u.phone || '—'}</span>;
      case 'country': return <span className="text-gray-300">{u.country || '—'}</span>;
      case 'role': return <span className="text-xs text-primary-500">{u.role}</span>;
      case 'plan': return <PlanBadge plan={u.plan} />;
      case 'walletBalance':
        return <span className="font-mono tabular-nums text-gray-100">{money(u.walletBalance)}</span>;
      case 'totalDeposit':
        return (
          <button type="button" onClick={() => setHistory({ kind: 'deposit', user: u })}
            title="View deposit history"
            className="font-mono tabular-nums text-emerald-300/90 hover:text-emerald-300 underline decoration-dotted underline-offset-2">
            {money(u.totalDeposit)}
          </button>
        );
      case 'totalWithdrawal':
        return (
          <button type="button" onClick={() => setHistory({ kind: 'withdrawal', user: u })}
            title="View withdrawal history"
            className="font-mono tabular-nums text-amber-300/90 hover:text-amber-300 underline decoration-dotted underline-offset-2">
            {money(u.totalWithdrawal)}
          </button>
        );
      case 'totalPnl': return <PnlCell u={u} />;
      case 'platformEarnings': {
        const v = Number(u.platformEarnings) || 0;
        return (
          <span
            title="Platform earnings from this user = commissions/fees paid + broker counterparty result (user net losses)"
            className={`font-mono tabular-nums ${v > 0 ? 'text-emerald-300' : v < 0 ? 'text-rose-300' : 'text-gray-400'}`}>
            {v > 0 ? '+' : ''}{signedMoney(v)}
          </span>
        );
      }
      case 'kyc': return <KycBadge status={u.kycStatus} />;
      case 'referredBy': {
        const refBy = u.referredBy;
        const refName = refBy ? (fullName(refBy) || refBy.email) : null;
        return refBy ? (
          <div className="flex flex-col leading-tight">
            <span className="text-white truncate max-w-[150px]" title={refName}>{refName}</span>
            {refBy.referralCode && <span className="font-mono text-[10px] text-primary-500">{refBy.referralCode}</span>}
          </div>
        ) : <span className="text-gray-600">—</span>;
      }
      case 'status':
        return <span className={u.isActive ? 'text-bull text-xs' : 'text-bear text-xs'}>{u.isActive ? 'Active' : 'Blocked'}</span>;
      case 'joined': return <span className="text-xs text-gray-400">{fmtDate(u.createdAt)}</span>;
      case 'lastLogin': return <span className="text-xs text-gray-400">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</span>;
      case 'manager': return <span className="text-xs text-gray-300">{u.manager?.name || '—'}</span>;
      case 'admin': return <span className="text-xs text-gray-300">{u.admin?.name || '—'}</span>;
      default: return null;
    }
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
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="User ID, email, name, phone" />
        </div>
        <div>
          <label className="label">Plan</label>
          <select className="input w-36" value={planFilter} onChange={(e) => { setPlanFilter(e.target.value); setPage(1); }}>
            <option value="">All</option>
            {PLAN_FILTER_OPTIONS.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
          </select>
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
            <option value="dormant">Inactive (6mo+)</option>
          </select>
        </div>
        <div>
          <label className="label">Account Type</label>
          <select className="input w-36" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="USER">User</option>
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
            <option value="SUPER_ADMIN">Super Admin</option>
          </select>
        </div>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      {/* Toolbar — customize / export / refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">
          {visibleColumns.length} columns · sorted by {sortBy} ({sortDir})
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={load} className="btn-ghost text-xs" title="Refresh values">↻ Refresh</button>
          <button type="button" onClick={exportCsv} disabled={exporting} className="btn-ghost text-xs disabled:opacity-40">
            {exporting ? 'Exporting…' : '⭳ Export CSV'}
          </button>
          <button type="button" onClick={() => setCustomizeOpen(true)} className="btn-secondary text-xs">⚙ Customize Columns</button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              {visibleColumns.map((col) => (
                <SortHeader key={col.key} col={col} sortBy={sortBy} sortDir={sortDir} onSort={() => toggleSort(col)} />
              ))}
              <th className="text-right p-3 whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <SkeletonRows cols={visibleColumns.length + 1} />
            ) : users.length === 0 ? (
              <tr><td colSpan={visibleColumns.length + 1} className="p-8 text-center text-gray-500">No users found.</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u._id} className={`table-row ${loading ? 'opacity-60' : ''}`}>
                  {visibleColumns.map((col) => (
                    <td key={col.key} className={`p-3 ${col.numeric ? 'text-right' : 'text-left'} whitespace-nowrap`}>
                      {renderCell(col.key, u)}
                    </td>
                  ))}
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => setSelected(u)} className="btn-ghost text-xs">View</button>
                  </td>
                </tr>
              ))
            )}
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

      {customizeOpen && (
        <CustomizeColumnsModal
          columns={accessibleColumns}
          order={order}
          visible={visible}
          onChange={persist}
          onReset={resetLayout}
          onClose={() => setCustomizeOpen(false)}
        />
      )}

      {history && (
        <HistoryModal
          kind={history.kind}
          user={history.user}
          onClose={() => setHistory(null)}
        />
      )}

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

// ── Presentational helpers ───────────────────────────────────────────
function SortHeader({ col, sortBy, sortDir, onSort }) {
  const active = col.sortBy && sortBy === col.sortBy;
  return (
    <th
      onClick={onSort}
      className={`p-3 whitespace-nowrap ${col.numeric ? 'text-right' : 'text-left'} ${col.sortBy ? 'cursor-pointer select-none hover:text-gray-300' : ''}`}
      title={col.sortBy ? 'Click to sort' : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {col.label}
        {col.sortBy && (
          active
            ? <span className="text-primary-500">{sortDir === 'asc' ? '▲' : '▼'}</span>
            : <span className="text-gray-600">⇅</span>
        )}
      </span>
    </th>
  );
}

function PlanBadge({ plan }) {
  const code = (plan?.code || 'FREE').toUpperCase();
  const name = plan?.name || 'Free';
  const tone = PLAN_TONE[code] || 'bg-primary-500/15 text-primary-300 border-primary-500/40';
  return <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${tone}`}>{name}</span>;
}

function PnlCell({ u }) {
  const pnl = Number(u.totalPnl) || 0;
  const s = u.tradeStats || {};
  const tip = `Win Rate ${fmtNum(s.winRate || 0)}% · ${s.trades || 0} trades · ROI ${fmtNum(s.roi || 0)}%`;
  return (
    <span className={`font-mono tabular-nums font-semibold ${pnl > 0 ? 'text-bull' : pnl < 0 ? 'text-bear' : 'text-gray-400'}`} title={tip}>
      {pnl > 0 ? '+' : ''}{signedMoney(pnl)}
    </span>
  );
}

function SkeletonRows({ cols, rows = 8 }) {
  return Array.from({ length: rows }).map((_, r) => (
    <tr key={r} className="border-t border-border-dark/50">
      {Array.from({ length: cols }).map((__, c) => (
        <td key={c} className="p-3">
          <div className="h-3.5 rounded bg-bg-hover animate-pulse" style={{ width: `${40 + ((r + c) % 4) * 15}%` }} />
        </td>
      ))}
    </tr>
  ));
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

// ── Customize Columns modal (visibility + drag-to-reorder) ───────────
function CustomizeColumnsModal({ columns, order, visible, onChange, onReset, onClose }) {
  const [dragKey, setDragKey] = useState(null);
  const [overKey, setOverKey] = useState(null);

  const colByKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  // Only rows for columns this role can access, in the current order.
  const rows = order.map((k) => colByKey.get(k)).filter(Boolean);
  const visibleCount = rows.filter((c) => visible[c.key]).length;

  const toggle = (key) => onChange(order, { ...visible, [key]: !visible[key] });

  const moveKey = (from, to) => {
    if (from === to) return;
    const next = [...order];
    const fromIdx = next.indexOf(from);
    const toIdx = next.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, from);
    onChange(next, visible);
  };

  const showAll = () => { const v = { ...visible }; rows.forEach((c) => { v[c.key] = true; }); onChange(order, v); };
  const hideAll = () => { const v = { ...visible }; rows.forEach((c) => { v[c.key] = false; }); onChange(order, v); };

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white">Customize Columns</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">Drag to reorder · toggle to show/hide · {visibleCount} shown</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-2 border-b border-border-dark flex items-center gap-2 text-xs">
          <button onClick={showAll} className="btn-ghost text-xs">Show all</button>
          <button onClick={hideAll} className="btn-ghost text-xs">Hide all</button>
          <button onClick={onReset} className="btn-ghost text-xs ml-auto text-amber-400 hover:text-amber-300">↺ Reset to default</button>
        </div>

        <div className="p-3 overflow-y-auto space-y-1">
          {rows.map((col) => (
            <div
              key={col.key}
              draggable
              onDragStart={() => setDragKey(col.key)}
              onDragEnd={() => { setDragKey(null); setOverKey(null); }}
              onDragOver={(e) => { e.preventDefault(); if (overKey !== col.key) setOverKey(col.key); }}
              onDrop={(e) => { e.preventDefault(); if (dragKey) moveKey(dragKey, col.key); setOverKey(null); }}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded border transition-all cursor-grab active:cursor-grabbing
                ${dragKey === col.key ? 'opacity-40' : ''}
                ${overKey === col.key && dragKey !== col.key ? 'border-primary-500 bg-primary-500/10' : 'border-border-dark bg-bg-dark'}`}
            >
              <span className="text-gray-600 select-none" aria-hidden>⋮⋮</span>
              <label className="flex items-center gap-2 flex-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!visible[col.key]}
                  onChange={() => toggle(col.key)}
                  className="accent-primary-500"
                  onClick={(e) => e.stopPropagation()}
                />
                <span className={`text-sm ${visible[col.key] ? 'text-white' : 'text-gray-500'}`}>{col.label}</span>
              </label>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border-dark flex justify-end">
          <button onClick={onClose} className="btn-primary text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Deposit / Withdrawal history modal ───────────────────────────────
function HistoryModal({ kind, user, onClose }) {
  const [items, setItems] = useState(null);
  const isDep = kind === 'deposit';
  useEffect(() => {
    let cancelled = false;
    api.get(`/admin/${isDep ? 'deposits' : 'withdrawals'}`, { params: { userId: user._id } })
      .then((r) => { if (!cancelled) setItems(r.data.data || []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [kind, user._id]);

  const okStatus = isDep ? 'CONFIRMED' : 'COMPLETED';
  const lifetime = (items || []).filter((x) => x.status === okStatus)
    .reduce((s, x) => s + (Number(x.baseAmount) || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white">{isDep ? 'Deposit' : 'Withdrawal'} history</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {user.email} · lifetime {isDep ? 'deposited' : 'withdrawn'}{' '}
              <span className={isDep ? 'text-emerald-300' : 'text-amber-300'}>${fmtNum(lifetime)}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="p-4 overflow-y-auto">
          {items === null && <div className="text-gray-500 text-sm py-6 text-center">Loading…</div>}
          {items && items.length === 0 && <div className="text-gray-500 text-sm py-8 text-center">No {kind}s on record.</div>}
          {items && items.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-[10px] text-gray-500 uppercase">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-right p-2">Amount</th>
                  <th className="text-right p-2">USD</th>
                  <th className="text-left p-2">{isDep ? 'Target' : 'Source'}</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x._id} className="border-t border-border-dark/60">
                    <td className="p-2 text-gray-400">{fmtDate(x.createdAt)}</td>
                    <td className="p-2 text-right font-mono text-gray-200">{fmtNum(x.amount)} {x.currency}</td>
                    <td className="p-2 text-right font-mono text-gray-300">${fmtNum(x.baseAmount)}</td>
                    <td className="p-2 text-gray-400">{isDep ? (x.targetWallet || 'trading') : (x.source || 'TRADING')}</td>
                    <td className="p-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        x.status === okStatus ? 'bg-emerald-900 text-emerald-300'
                        : ['REJECTED', 'CANCELLED'].includes(x.status) ? 'bg-red-900 text-red-300'
                        : 'bg-yellow-900 text-yellow-300'}`}>{x.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
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
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h2 className="text-lg font-semibold text-white truncate">{user.email}</h2>
            {user.userUid && (
              <button
                type="button"
                onClick={() => { navigator.clipboard.writeText(user.userUid); toast.success('User ID copied'); }}
                title="Copy User ID"
                className="shrink-0 font-mono text-xs font-bold text-primary-500 bg-primary-500/10 border border-primary-500/30 rounded px-2 py-0.5 hover:bg-primary-500/20 transition-colors"
              >
                {user.userUid}
              </button>
            )}
          </div>
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
            <Field label="User ID" value={user.userUid || '—'} />
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
                    options={['INHERIT', 'INTERNAL_MATCHING', 'B_BOOK', 'A_BOOK', 'HYBRID']}
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
