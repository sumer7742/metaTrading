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

  // Subscription billing now runs off the Bonus Wallet.
  const isLow = wallet?.isLowBalance || Number(wallet?.balance || 0) <= Number(wallet?.lowBalanceThreshold || 0);
  const lowThreshold = Number(wallet?.lowBalanceThreshold || 0);
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
              <Link to="/plans" className="inline-flex items-center gap-2 border border-border-dark text-text-primary hover:bg-bg-hover text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">
                View Plans
              </Link>
            </div>
          </div>

          {/* Low-balance warning — plan renewals debit this wallet */}
          {isLow && (
            <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
              <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700 shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
              </span>
              <div className="text-sm">
                <div className="font-bold text-amber-900">Low balance</div>
                <div className="text-amber-800 text-[12px] mt-0.5">Your balance is at or below {sym}{fmt(lowThreshold)}. Top up to keep your subscription from being downgraded on renewal.</div>
              </div>
            </div>
          )}

          {/* Stat tiles */}
          <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-2xl border border-border-subtle bg-bg-card px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{s.label}</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-text-primary">{sym}{fmt(s.value)}</div>
              </div>
            ))}
          </div>

          {/* Subscription status strip — plan / renews-in / auto-renew.
              Plan purchases & renewals are billed from this Bonus Wallet. */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-border-dark p-4 bg-bg-hover/30">
              <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Current plan</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-lg font-bold text-text-primary">{effectivePlan?.name || '—'}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: statusTone.bg, color: statusTone.fg }}>{statusTone.label}</span>
              </div>
              {sub?.billingCycle && <div className="text-[11px] text-text-muted mt-0.5">{sub.billingCycle.toLowerCase()} billing</div>}
            </div>
            <div className="rounded-2xl border border-border-dark p-4 bg-bg-hover/30">
              <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Renews in</div>
              <div className={`mt-1 text-lg font-bold ${countdown?.expired ? 'text-bear' : 'text-text-primary'}`}>{countdown ? countdown.label : '—'}</div>
              <div className="text-[11px] text-text-muted mt-0.5">{sub?.expiresAt ? new Date(sub.expiresAt).toLocaleDateString() : 'No renewal scheduled'}</div>
            </div>
            <div className="rounded-2xl border border-border-dark p-4 bg-bg-hover/30">
              <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Auto-renew</div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className={`text-sm font-bold ${wallet?.autoRenew ? 'text-bull' : 'text-text-muted'}`}>{wallet?.autoRenew ? 'Enabled' : 'Disabled'}</span>
                <button onClick={() => toggleAutoRenew(!wallet?.autoRenew)} disabled={savingAutoRenew} className={`relative w-12 h-6 rounded-full transition border ${wallet?.autoRenew ? 'bg-bull border-bull' : 'bg-bg-hover border-border-dark'} disabled:opacity-60`}>
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition shadow ${wallet?.autoRenew ? 'left-[26px]' : 'left-0.5'}`} />
                </button>
              </div>
              <div className="text-[11px] text-text-muted mt-1.5 leading-snug">Renewals debit this wallet. {wallet?.gracePeriodDays || 0}-day grace period.</div>
            </div>
          </div>

          <div className="mt-4 text-[11px] text-text-muted inline-flex items-center gap-1.5 flex-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
            Withdrawals are processed from your Main / trading wallet —
            <Link to="/wallet?action=transfer" className="font-semibold text-primary-600 hover:underline">transfer your earnings</Link>
            there first, then withdraw.
          </div>
        </div>

        {/* â”€â”€ Transaction history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <div id="bonus-history" className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
          <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
            <h3 className="text-base font-bold text-text-primary">Transaction History</h3>
            <span className="text-xs text-text-muted">{txns.length} record{txns.length === 1 ? '' : 's'}</span>
          </div>
          {txns.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-text-muted">
              No transactions yet. Referral and partner earnings will appear here automatically.
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
                  {txns.map((t) => {
                    const credit = t.transactionType === 'CREDIT';
                    return (
                      <tr key={t._id} className="hover:bg-bg-hover transition-colors">
                        <td className="px-5 py-2.5 text-text-secondary whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-md" style={{ background: credit ? '#16A34A14' : '#DC262614', color: credit ? '#16A34A' : '#DC2626' }}>
                            {REASON_LABEL[t.reason] || t.reason}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-text-muted max-w-[220px] truncate">{t.note || 'â€”'}</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold" style={{ color: credit ? '#16A34A' : '#DC2626' }}>
                          {credit ? '+' : 'âˆ’'}{sym}{fmt(t.amount)}
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
