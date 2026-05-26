import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Subscription Wallets admin — manage subscription balances, auto-renew,
 * grace period, and view the full payment log.
 *
 * Backend endpoints used:
 *   POST   /subscription-wallet/admin/credit
 *   POST   /subscription-wallet/admin/debit
 *   PATCH  /subscription-wallet/admin/:userId/auto-renew
 *   PATCH  /subscription-wallet/admin/:userId/grace-period
 *   GET    /subscription-wallet/admin/logs
 */
export default function SubscriptionWallets() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filterUser, setFilterUser] = useState('');
  const [actionPanel, setActionPanel] = useState(null); // { mode, userId? }

  const load = async (p = page, userId = filterUser.trim()) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: p, limit: 50 });
      if (userId) params.set('userId', userId);
      const res = await api.get(`/subscription-wallet/admin/logs?${params.toString()}`);
      setLogs(res.data.data.items || []);
      setTotal(res.data.data.pagination?.total || 0);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(1, ''); }, []);

  const stats = useMemo(() => {
    const credits = logs.filter((l) => l.transactionType === 'CREDIT').reduce((s, l) => s + Number(l.amount || 0), 0);
    const debits  = logs.filter((l) => l.transactionType === 'DEBIT').reduce((s, l) => s + Number(l.amount || 0), 0);
    return {
      total: logs.length,
      credits,
      debits,
      net: credits - debits,
    };
  }, [logs]);

  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero
        eyebrow="Subscriptions"
        title="Subscription Wallets"
        subtitle="Manually credit/debit user subscription balances, toggle auto-renew, set grace period, and inspect the full payment log."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setActionPanel({ mode: 'credit' })} className="btn-primary text-sm">+ Credit</button>
            <button onClick={() => setActionPanel({ mode: 'debit' })} className="btn-secondary text-sm">− Debit</button>
            <button onClick={() => setActionPanel({ mode: 'autorenew' })} className="btn-ghost text-sm">Auto-renew</button>
            <button onClick={() => setActionPanel({ mode: 'grace' })} className="btn-ghost text-sm">Grace period</button>
          </div>
        }
      />

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Visible rows" value={stats.total} />
        <Stat label="Credits (visible)" value={`$${fmt(stats.credits)}`} accent="emerald" />
        <Stat label="Debits (visible)" value={`$${fmt(stats.debits)}`} accent="rose" />
        <Stat label="Net (visible)" value={`$${fmt(stats.net)}`} accent={stats.net >= 0 ? 'emerald' : 'rose'} />
      </div>

      {/* Filter bar */}
      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <input
          value={filterUser}
          onChange={(e) => setFilterUser(e.target.value)}
          placeholder="Filter by userId (24-char Mongo ID)…"
          className="flex-1 min-w-[280px] bg-transparent outline-none text-sm font-mono"
        />
        <button onClick={() => { setPage(1); load(1, filterUser.trim()); }} className="btn-primary text-xs">Apply</button>
        <button onClick={() => { setFilterUser(''); setPage(1); load(1, ''); }} className="btn-ghost text-xs">Clear</button>
        <span className="text-[11px] text-text-muted">{total} total entr{total === 1 ? 'y' : 'ies'}</span>
      </div>

      {/* Log table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
                <th className="text-left py-2.5 px-3">When</th>
                <th className="text-left py-2.5 px-3">User</th>
                <th className="text-left py-2.5 px-3">Type</th>
                <th className="text-left py-2.5 px-3">Reason</th>
                <th className="text-left py-2.5 px-3">Plan</th>
                <th className="text-right py-2.5 px-3">Amount</th>
                <th className="text-right py-2.5 px-3">Balance after</th>
                <th className="text-center py-2.5 px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && logs.length === 0 && (
                <tr><td colSpan={8} className="py-10 text-center text-text-muted">Loading…</td></tr>
              )}
              {!loading && logs.length === 0 && (
                <tr><td colSpan={8} className="py-10 text-center text-text-muted">No entries</td></tr>
              )}
              {logs.map((t) => {
                const isCredit = t.transactionType === 'CREDIT' || t.transactionType === 'REFUND';
                return (
                  <tr key={t._id} className="border-b border-border-subtle hover:bg-bg-hover/40">
                    <td className="py-2 px-3 text-text-secondary whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                    <td className="py-2 px-3 font-mono text-[11px] text-text-secondary">{String(t.userId).slice(-8)}</td>
                    <td className="py-2 px-3">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${isCredit ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-600'}`}>
                        {t.transactionType}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-text-secondary">{t.reason?.replaceAll('_', ' ')}</td>
                    <td className="py-2 px-3 text-text-secondary">{t.planCode ? `${t.planCode}${t.billingCycle ? ` · ${t.billingCycle}` : ''}` : '—'}</td>
                    <td className={`py-2 px-3 text-right font-mono tabular-nums font-bold ${isCredit ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {isCredit ? '+' : '−'}${fmt(t.amount)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-text-secondary">
                      {t.balanceAfter != null ? `$${fmt(t.balanceAfter)}` : '—'}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                        t.status === 'SUCCESS' ? 'bg-emerald-500/15 text-emerald-600' :
                        t.status === 'FAILED'  ? 'bg-rose-500/15 text-rose-600' :
                                                 'bg-amber-500/15 text-amber-600'
                      }`}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {total > 50 && (
          <div className="px-3 py-2 border-t border-border-subtle flex items-center justify-between text-xs text-text-muted">
            <span>Page {page} · showing up to 50 rows</span>
            <div className="flex items-center gap-2">
              <button onClick={() => { const p = Math.max(1, page - 1); setPage(p); load(p); }} disabled={page <= 1} className="btn-ghost text-xs disabled:opacity-40">← Prev</button>
              <button onClick={() => { const p = page + 1; setPage(p); load(p); }} disabled={page * 50 >= total} className="btn-ghost text-xs disabled:opacity-40">Next →</button>
            </div>
          </div>
        )}
      </div>

      {actionPanel && (
        <ActionModal
          mode={actionPanel.mode}
          onClose={() => setActionPanel(null)}
          onSaved={() => { setActionPanel(null); load(page); }}
        />
      )}
    </div>
  );
}

function ActionModal({ mode, onClose, onSaved }) {
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState('3');
  const [submitting, setSubmitting] = useState(false);

  const title = {
    credit:    'Manual credit',
    debit:     'Manual debit',
    autorenew: 'Set auto-renew',
    grace:     'Set grace period',
  }[mode] || 'Action';

  const submit = async () => {
    if (!userId) return toast.error('userId required');
    setSubmitting(true);
    try {
      if (mode === 'credit') {
        await api.post('/subscription-wallet/admin/credit', { userId, amount: Number(amount), note });
        toast.success(`Credited $${Number(amount).toFixed(2)}`);
      } else if (mode === 'debit') {
        await api.post('/subscription-wallet/admin/debit', { userId, amount: Number(amount), note });
        toast.success(`Debited $${Number(amount).toFixed(2)}`);
      } else if (mode === 'autorenew') {
        await api.patch(`/subscription-wallet/admin/${userId}/auto-renew`, { enabled });
        toast.success(`Auto-renew ${enabled ? 'enabled' : 'disabled'}`);
      } else if (mode === 'grace') {
        await api.patch(`/subscription-wallet/admin/${userId}/grace-period`, { days: Number(days) });
        toast.success(`Grace period set to ${days}d`);
      }
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

          {(mode === 'credit' || mode === 'debit') && (
            <>
              <label className="block">
                <div className="text-[11px] font-semibold text-text-secondary mb-1">Amount (USD)</div>
                <input type="number" step="0.01" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="block">
                <div className="text-[11px] font-semibold text-text-secondary mb-1">Note</div>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / ticket #" />
              </label>
            </>
          )}

          {mode === 'autorenew' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span className="text-sm text-text-primary">{enabled ? 'Enable' : 'Disable'} auto-renew for this user</span>
            </label>
          )}

          {mode === 'grace' && (
            <label className="block">
              <div className="text-[11px] font-semibold text-text-secondary mb-1">Grace period (days)</div>
              <input type="number" min="0" step="1" className="input" value={days} onChange={(e) => setDays(e.target.value)} />
              <p className="text-[11px] text-text-muted mt-1">Days the user keeps their plan after a failed auto-renew before being downgraded to FREE.</p>
            </label>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2 bg-bg-panel/60">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="btn-primary text-sm disabled:opacity-50">
            {submitting ? 'Saving…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const tone = {
    emerald: 'text-emerald-600',
    rose:    'text-rose-600',
  }[accent] || 'text-text-primary';
  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
