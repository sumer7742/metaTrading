import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import DateFilter, { useDateFilter } from '../components/DateFilter';

/**
 * Bonus Wallets admin — view balances, manually credit/debit, inspect the
 * full transaction log (filterable by referral/partner reason), and export
 * records to CSV.
 *
 * Backend endpoints used:
 *   POST /bonus-wallet/admin/credit
 *   POST /bonus-wallet/admin/debit
 *   GET  /bonus-wallet/admin/balances
 *   GET  /bonus-wallet/admin/logs?userId=&reason=&from=&to=&page=&limit=
 */
const REASONS = [
  '', 'REFERRAL_COMMISSION', 'PARTNER_COMMISSION', 'REVENUE_SHARE', 'BONUS_REWARD',
  'DEPOSIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADMIN_CREDIT', 'ADMIN_DEBIT',
];

export default function BonusWallets() {
  const [tab, setTab] = useState('logs'); // 'logs' | 'balances'
  const [logs, setLogs] = useState([]);
  const [balances, setBalances] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filterUser, setFilterUser] = useState('');
  const [filterReason, setFilterReason] = useState('');
  const [actionPanel, setActionPanel] = useState(null);
  // Date range (defaults to all-time so nothing changes by default).
  const [range, setRange] = useDateFilter('admin.bonus.range', null);

  const loadLogs = async (p = page, userId = filterUser.trim(), reason = filterReason) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: p, limit: 50 });
      if (userId) params.set('userId', userId);
      if (reason) params.set('reason', reason);
      if (range?.fromDate) params.set('from', range.fromDate);
      if (range?.toDate) params.set('to', `${range.toDate}T23:59:59.999`); // inclusive end-of-day
      const res = await api.get(`/bonus-wallet/admin/logs?${params.toString()}`);
      setLogs(res.data.data.items || []);
      setTotal(res.data.data.pagination?.total || 0);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const loadBalances = async () => {
    setLoading(true);
    try {
      const res = await api.get('/bonus-wallet/admin/balances?limit=200');
      setBalances(res.data.data.items || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Initial load + reload whenever the date range changes (keeps current
  // user/reason filters). Replaces the plain mount effect.
  useEffect(() => { setPage(1); loadLogs(1, filterUser.trim(), filterReason); /* eslint-disable-line */ }, [range]);
  useEffect(() => { if (tab === 'balances' && balances.length === 0) loadBalances(); /* eslint-disable-line */ }, [tab]);

  const stats = useMemo(() => {
    const credits = logs.filter((l) => l.transactionType === 'CREDIT').reduce((s, l) => s + Number(l.amount || 0), 0);
    const debits  = logs.filter((l) => l.transactionType === 'DEBIT').reduce((s, l) => s + Number(l.amount || 0), 0);
    return { total: logs.length, credits, debits, net: credits - debits };
  }, [logs]);

  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const exportCsv = async () => {
    try {
      const params = new URLSearchParams({ page: 1, limit: 1000 });
      if (filterUser.trim()) params.set('userId', filterUser.trim());
      if (filterReason) params.set('reason', filterReason);
      if (range?.fromDate) params.set('from', range.fromDate);
      if (range?.toDate) params.set('to', `${range.toDate}T23:59:59.999`);
      const res = await api.get(`/bonus-wallet/admin/logs?${params.toString()}`);
      const rows = res.data.data.items || [];
      const head = ['Transaction ID', 'Date', 'User', 'Type', 'Reason', 'Amount', 'Balance After', 'Status', 'Note'];
      const body = rows.map((t) => [
        t._id,
        new Date(t.createdAt).toISOString(),
        t.userId?.email || (typeof t.userId === 'string' ? t.userId : t.userId?._id || ''),
        t.transactionType,
        t.reason,
        t.amount,
        t.balanceAfter ?? '',
        t.status,
        (t.note || '').replace(/"/g, '""'),
      ]);
      const csv = [head, ...body].map((r) => r.map((c) => `"${String(c ?? '')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bonus-wallet-logs-${Date.now()}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} rows`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const userLabel = (u) => (typeof u === 'object' && u ? (u.email || `${u.firstName || ''} ${u.lastName || ''}`.trim() || String(u._id).slice(-8)) : String(u || '').slice(-8));

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero
        eyebrow="Rewards"
        title="Bonus Wallets"
        subtitle="Referral & partner earnings wallet. Manually credit/debit balances, inspect and export the transaction log, and filter by referral/partner earning type."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setActionPanel({ mode: 'credit' })} className="btn-primary text-sm">+ Credit</button>
            <button onClick={() => setActionPanel({ mode: 'debit' })} className="btn-secondary text-sm">− Debit</button>
            <button onClick={exportCsv} className="btn-ghost text-sm">Export CSV</button>
          </div>
        }
      />

      {/* Tabs */}
      <div className="inline-flex p-1 bg-bg-hover rounded-xl border border-border-dark">
        {[{ id: 'logs', label: 'Transactions' }, { id: 'balances', label: 'Balances' }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-1.5 text-sm font-bold rounded-lg transition-all ${tab === t.id ? 'bg-bg-card text-text-primary shadow' : 'text-text-secondary'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'logs' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Visible rows" value={stats.total} />
            <Stat label="Credits (visible)" value={`$${fmt(stats.credits)}`} accent="emerald" />
            <Stat label="Debits (visible)" value={`$${fmt(stats.debits)}`} accent="rose" />
            <Stat label="Net (visible)" value={`$${fmt(stats.net)}`} accent={stats.net >= 0 ? 'emerald' : 'rose'} />
          </div>

          <div className="card p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Date range</span>
              <DateFilter value={range} onChange={setRange} />
            </div>
            <div className="flex items-center gap-3 flex-wrap border-t border-border-subtle pt-2.5">
              <input value={filterUser} onChange={(e) => setFilterUser(e.target.value)} placeholder="Filter by userId…" className="flex-1 min-w-[240px] bg-transparent outline-none text-sm font-mono" />
              <select value={filterReason} onChange={(e) => setFilterReason(e.target.value)} className="input text-xs max-w-[200px]">
                {REASONS.map((r) => <option key={r || 'all'} value={r}>{r ? r.replaceAll('_', ' ') : 'All reasons'}</option>)}
              </select>
              <button onClick={() => { setPage(1); loadLogs(1, filterUser.trim(), filterReason); }} className="btn-primary text-xs">Apply</button>
              <button onClick={() => { setFilterUser(''); setFilterReason(''); setPage(1); setRange({ period: null, fromDate: '', toDate: '' }); }} className="btn-ghost text-xs">Clear</button>
              <span className="text-[11px] text-text-muted">{total} total</span>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
                    <th className="text-left py-2.5 px-3">When</th>
                    <th className="text-left py-2.5 px-3">User</th>
                    <th className="text-left py-2.5 px-3">Type</th>
                    <th className="text-left py-2.5 px-3">Reason</th>
                    <th className="text-right py-2.5 px-3">Amount</th>
                    <th className="text-right py-2.5 px-3">Balance after</th>
                    <th className="text-center py-2.5 px-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && logs.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-text-muted">Loading…</td></tr>}
                  {!loading && logs.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-text-muted">No entries</td></tr>}
                  {logs.map((t) => {
                    const isCredit = t.transactionType === 'CREDIT';
                    return (
                      <tr key={t._id} className="border-b border-border-subtle hover:bg-bg-hover/40">
                        <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                        <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">{userLabel(t.userId)}</td>
                        <td className="py-2 px-3"><span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${isCredit ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-600'}`}>{t.transactionType}</span></td>
                        <td className="py-2 px-3 text-text-secondary">{t.reason?.replaceAll('_', ' ')}</td>
                        <td className={`py-2 px-3 text-right font-mono tabular-nums font-bold ${isCredit ? 'text-emerald-600' : 'text-rose-600'}`}>{isCredit ? '+' : '−'}${fmt(t.amount)}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-text-secondary">{t.balanceAfter != null ? `$${fmt(t.balanceAfter)}` : '—'}</td>
                        <td className="py-2 px-3 text-center"><span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600">{t.status}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {total > 50 && (
              <div className="px-3 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-text-muted">
                <span>Page {page} · up to 50 rows</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => { const p = Math.max(1, page - 1); setPage(p); loadLogs(p); }} disabled={page <= 1} className="btn-ghost text-xs disabled:opacity-40">← Prev</button>
                  <button onClick={() => { const p = page + 1; setPage(p); loadLogs(p); }} disabled={page * 50 >= total} className="btn-ghost text-xs disabled:opacity-40">Next →</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'balances' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
                  <th className="text-left py-2.5 px-3">User</th>
                  <th className="text-left py-2.5 px-3">User ID</th>
                  <th className="text-right py-2.5 px-3">Balance</th>
                  <th className="text-left py-2.5 px-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {loading && balances.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-text-muted">Loading…</td></tr>}
                {!loading && balances.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-text-muted">No bonus wallets yet</td></tr>}
                {balances.map((w) => (
                  <tr key={w._id} className="border-b border-border-subtle hover:bg-bg-hover/40">
                    <td className="py-2 px-3 text-text-primary">{userLabel(w.userId)}</td>
                    <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">{typeof w.userId === 'object' ? w.userId?._id : w.userId}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums font-bold text-text-primary">${fmt(w.balance)}</td>
                    <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{w.updatedAt ? new Date(w.updatedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {actionPanel && <ActionModal mode={actionPanel.mode} onClose={() => setActionPanel(null)} onSaved={() => { setActionPanel(null); loadLogs(page); if (tab === 'balances') loadBalances(); }} />}
    </div>
  );
}

function ActionModal({ mode, onClose, onSaved }) {
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const title = mode === 'credit' ? 'Manual credit' : 'Manual debit';

  const submit = async () => {
    if (!userId) return toast.error('userId required');
    if (!(Number(amount) > 0)) return toast.error('amount must be > 0');
    setSubmitting(true);
    try {
      await api.post(`/bonus-wallet/admin/${mode}`, { userId, amount: Number(amount), note });
      toast.success(`${mode === 'credit' ? 'Credited' : 'Debited'} $${Number(amount).toFixed(2)}`);
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between bg-bg-panel/60">
          <h3 className="text-base font-bold text-text-primary">{title}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block">
            <div className="text-[11px] font-semibold text-text-secondary mb-1">User ID</div>
            <input className="input font-mono text-xs" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="65a..." autoFocus />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold text-text-secondary mb-1">Amount (USD)</div>
            <input type="number" step="0.01" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="block">
            <div className="text-[11px] font-semibold text-text-secondary mb-1">Note</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / ticket #" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2 bg-bg-panel/60">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="btn-primary text-sm disabled:opacity-50">{submitting ? 'Saving…' : 'Apply'}</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const tone = { emerald: 'text-emerald-600', rose: 'text-rose-600' }[accent] || 'text-text-primary';
  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
