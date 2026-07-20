import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import WalletSidebar from '../components/WalletSidebar';
import WithdrawModal from '../components/WithdrawModal';
import { wsClient } from '../services/ws';

/**
 * Bonus Wallet — standalone wallet that receives ALL referral & partner
 * earnings (commissions, multi-level, revenue share, bonuses). Earnings are
 * credited automatically; this page exposes a Withdraw action ONLY — never an
 * Add-Funds / deposit one (you don't deposit into a rewards wallet).
 */
const REASON_LABEL = {
  REFERRAL_COMMISSION: 'Referral Commission',
  PARTNER_COMMISSION: 'Partner Commission',
  REVENUE_SHARE: 'Revenue Share',
  BONUS_REWARD: 'Bonus Reward',
  DEPOSIT: 'Deposit',
  TRANSFER_IN: 'Internal Transfer In',
  TRANSFER_OUT: 'Internal Transfer Out',
  ADMIN_CREDIT: 'Admin Credit',
  ADMIN_DEBIT: 'Admin Debit',
};

export default function BonusWallet() {
  const [wallet, setWallet] = useState(null);
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState(null);
  const [effectivePlan, setEffectivePlan] = useState(null);
  const [savingAutoRenew, setSavingAutoRenew] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // ── Transaction-history filters ──
  const [q, setQ] = useState('');
  const [typeSel, setTypeSel] = useState('');      // '' = all
  const [statusSel, setStatusSel] = useState('');
  const [dirSel, setDirSel] = useState('');        // '' | 'CREDIT' | 'DEBIT'
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const refresh = async () => {
    try {
      const [w, h, me] = await Promise.allSettled([
        api.get('/bonus-wallet'),
        api.get('/bonus-wallet/history?limit=100'),
        api.get('/subscriptions/me'),
      ]);
      if (w.status === 'fulfilled') setWallet(w.value.data.data);
      if (h.status === 'fulfilled') setTxns(h.value.data.data || []);
      if (me.status === 'fulfilled') {
        setSub(me.value.data.data.subscription);
        setEffectivePlan(me.value.data.data.effectivePlan);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleAutoRenew = async (next) => {
    setSavingAutoRenew(true);
    try {
      await api.post('/bonus-wallet/auto-renew', { enabled: next });
      toast.success(`Auto-renew ${next ? 'enabled' : 'disabled'}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingAutoRenew(false);
    }
  };

  useEffect(() => { refresh(); }, []);
  // Live-update when an earning lands (partner/referral credit broadcasts).
  useEffect(() => {
    const unsub = wsClient.subscribe('bonusWallet', () => refresh());
    return () => { unsub && unsub(); };
  }, []);

  if (loading) {
    return (
      <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6">
        <WalletSidebar activeId="bonus" />
        <main className="col-span-12 lg:col-span-10 min-w-0">
          <div className="text-text-muted p-4">Loading walletâ€¦</div>
        </main>
      </div>
    );
  }

  const ccy = wallet?.currency || 'USD';
  const sym = ccy === 'USD' ? '$' : `${ccy} `;
  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const stats = [
    { label: 'Total Referral Earnings', value: wallet?.totalReferralEarnings },
    { label: 'Total Partner Earnings', value: wallet?.totalPartnerEarnings },
    { label: 'Total Revenue Share', value: wallet?.totalRevenueShare },
    { label: 'Total Bonus Rewards', value: wallet?.totalBonusRewards },
  ];

  const countdown = (() => {
    if (!sub?.expiresAt) return null;
    const ms = new Date(sub.expiresAt) - new Date();
    if (ms <= 0) return { expired: true, label: 'Expired' };
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return { expired: false, label: `${days}d ${hours}h` };
  })();
  const status = sub?.status || (effectivePlan?.code === 'FREE' ? 'FREE' : 'NONE');
  const statusTone = {
    ACTIVE: { bg: '#16A34A18', fg: '#16A34A', label: 'Active' },
    TRIAL: { bg: '#3B82F618', fg: '#3B82F6', label: 'Trial' },
    EXPIRED: { bg: '#DC262618', fg: '#DC2626', label: 'Expired' },
    CANCELLED: { bg: '#92400E18', fg: '#92400E', label: 'Cancelled' },
    FREE: { bg: '#6B728018', fg: '#6B7280', label: 'Free plan' },
    NONE: { bg: '#6B728018', fg: '#6B7280', label: 'No subscription' },
  }[status] || { bg: '#6B728018', fg: '#6B7280', label: status };

  // Distinct types present in the history (label via REASON_LABEL, else raw).
  const typeOptions = [...new Set(txns.map((t) => t.reason).filter(Boolean))]
    .sort((a, b) => (REASON_LABEL[a] || a).localeCompare(REASON_LABEL[b] || b));
  const statusOptions = ['SUCCESS', 'PENDING', 'FAILED'];
  const hasFilter = !!(q.trim() || typeSel || statusSel || dirSel || fromDate || toDate);
  const filteredTxns = txns.filter((t) => {
    if (typeSel && t.reason !== typeSel) return false;
    if (statusSel && (t.status || 'SUCCESS') !== statusSel) return false;
    if (dirSel && t.transactionType !== dirSel) return false;
    const ts = new Date(t.createdAt).getTime();
    if (fromDate && ts < new Date(`${fromDate}T00:00:00`).getTime()) return false;
    if (toDate && ts > new Date(`${toDate}T23:59:59`).getTime()) return false;
    const query = q.trim().toLowerCase();
    if (query) {
      const hay = `${REASON_LABEL[t.reason] || t.reason || ''} ${t.note || ''} ${t._id || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  const clearFilters = () => { setQ(''); setTypeSel(''); setStatusSel(''); setDirSel(''); setFromDate(''); setToDate(''); };

  return (
    <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6">
      <WalletSidebar activeId="bonus" />
      <main className="col-span-12 lg:col-span-10 min-w-0 space-y-5">
        <PageHero
          eyebrow="Rewards"
          title="Bonus Wallet"
          subtitle="All referral and partner earnings are credited here automatically. Withdraw your earnings to your bank or crypto wallet anytime."
        />

        {/* â”€â”€ Balance card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <div className="bg-white border-2 border-border-dark rounded-3xl p-6 md:p-8 shadow-card relative overflow-hidden">
          <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full opacity-[0.07] pointer-events-none"
               style={{ background: 'radial-gradient(circle, #16A34A 0%, transparent 70%)' }} />
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-bull" />
                Bonus wallet
              </div>
              <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-5xl md:text-6xl font-extrabold text-text-primary tracking-tight">{sym}{fmt(wallet?.balance)}</span>
              </div>
              <div className="mt-1 text-xs text-text-muted">Lifetime earnings: <span className="font-semibold text-text-secondary">{sym}{fmt(wallet?.totalEarnings)}</span></div>
            </div>

            {/* Actions — Withdraw only. A rewards wallet is credited
                automatically and is never deposited into, so there is no
                "Add Funds". Withdraw cashes out the Bonus Wallet balance
                (admin-approved, refunded if rejected). */}
            <div className="flex items-center gap-2">
              <button onClick={() => setWithdrawOpen(true)} className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
                Withdraw
              </button>
            </div>
          </div>

          {/* Stat tiles */}
          <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-2xl border border-border-subtle bg-bg-card px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{s.label}</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-text-primary">{sym}{fmt(s.value)}</div>
              </div>
            ))}
          </div>


        </div>

        {/* â”€â”€ Transaction history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <div id="bonus-history" className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-base font-bold text-text-primary">Transaction History</h3>
            <span className="text-xs text-text-muted">
              {hasFilter ? `${filteredTxns.length} of ${txns.length}` : txns.length} record{(hasFilter ? filteredTxns.length : txns.length) === 1 ? '' : 's'}
            </span>
          </div>

          {/* Filters */}
          {txns.length > 0 && (
            <div className="px-5 py-3 border-b border-border-subtle flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[160px]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description or ID..." className="w-full pl-9 pr-3 py-2 rounded-lg border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none" />
              </div>
              <select value={typeSel} onChange={(e) => setTypeSel(e.target.value)} className="text-sm px-2.5 py-2 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none">
                <option value="">All types</option>
                {typeOptions.map((r) => <option key={r} value={r}>{REASON_LABEL[r] || r}</option>)}
              </select>
              <select value={statusSel} onChange={(e) => setStatusSel(e.target.value)} className="text-sm px-2.5 py-2 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none">
                <option value="">All statuses</option>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={dirSel} onChange={(e) => setDirSel(e.target.value)} className="text-sm px-2.5 py-2 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none">
                <option value="">All</option>
                <option value="CREDIT">Credit (+)</option>
                <option value="DEBIT">Debit (-)</option>
              </select>
              <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className="text-sm px-2.5 py-2 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none" />
              <span className="text-text-muted text-xs">to</span>
              <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className="text-sm px-2.5 py-2 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none" />
              {hasFilter && <button type="button" onClick={clearFilters} className="text-xs font-semibold text-text-muted hover:text-text-primary px-2 py-1.5">Clear</button>}
            </div>
          )}

          {txns.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-text-muted">
              No transactions yet. Referral and partner earnings will appear here automatically.
            </div>
          ) : filteredTxns.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-text-muted">
              No transactions match your filters. <button type="button" onClick={clearFilters} className="font-semibold text-primary-600 hover:underline">Clear filters</button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider font-bold text-text-muted bg-bg-card">
                    <th className="text-left px-5 py-2.5">Date &amp; Time</th>
                    <th className="text-left px-3 py-2.5">Type</th>
                    <th className="text-left px-3 py-2.5">Description</th>
                    <th className="text-right px-3 py-2.5">Amount</th>
                    <th className="text-right px-3 py-2.5">Balance</th>
                    <th className="text-left px-3 py-2.5">Status</th>
                    <th className="text-left px-5 py-2.5">Transaction ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {filteredTxns.map((t) => {
                    const credit = t.transactionType === 'CREDIT';
                    return (
                      <tr key={t._id} className="hover:bg-bg-hover transition-colors">
                        <td className="px-5 py-2.5 text-text-secondary whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ background: credit ? '#16A34A14' : '#DC262614', color: credit ? '#16A34A' : '#DC2626' }}>
                            {REASON_LABEL[t.reason] || t.reason}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-text-muted max-w-[220px] truncate">{t.note || '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold" style={{ color: credit ? '#16A34A' : '#DC2626' }}>
                          {credit ? '+' : '-'}{sym}{fmt(t.amount)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{sym}{fmt(t.balanceAfter)}</td>
                        <td className="px-3 py-2.5">
                          <span className="text-[11px] font-semibold text-bull">{t.status || 'SUCCESS'}</span>
                        </td>
                        <td className="px-5 py-2.5 font-mono text-[11px] text-text-muted">{String(t._id).slice(-10)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {withdrawOpen && (
        <WithdrawModal
          endpoint="/bonus-wallet/withdraw"
          title="Withdraw from Bonus Wallet"
          currency={ccy}
          balance={Number(wallet?.balance || 0)}
          onClose={() => setWithdrawOpen(false)}
          onSuccess={() => { setWithdrawOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}
