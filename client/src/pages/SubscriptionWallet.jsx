import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import WalletSidebar from '../components/WalletSidebar';

/**
 * Subscription Wallet — standalone wallet used exclusively for plan
 * purchases / renewals. Strictly isolated from the trading wallets so
 * topping up here cannot move trading balance and vice versa.
 */
export default function SubscriptionWallet() {
  const [wallet, setWallet] = useState(null);
  const [sub, setSub] = useState(null);
  const [effectivePlan, setEffectivePlan] = useState(null);
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [depositOpen, setDepositOpen] = useState(false);
  const [savingAutoRenew, setSavingAutoRenew] = useState(false);

  const refresh = async () => {
    try {
      const [w, me, h] = await Promise.allSettled([
        api.get('/subscription-wallet'),
        api.get('/subscriptions/me'),
        api.get('/subscriptions/history?limit=100'),
      ]);
      if (w.status === 'fulfilled') setWallet(w.value.data.data);
      if (me.status === 'fulfilled') {
        setSub(me.value.data.data.subscription);
        setEffectivePlan(me.value.data.data.effectivePlan);
      }
      if (h.status === 'fulfilled') setTxns(h.value.data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const toggleAutoRenew = async (next) => {
    setSavingAutoRenew(true);
    try {
      await api.post('/subscription-wallet/auto-renew', { enabled: next });
      toast.success(`Auto-renew ${next ? 'enabled' : 'disabled'}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingAutoRenew(false);
    }
  };

  const countdown = useMemo(() => {
    if (!sub?.expiresAt) return null;
    const ms = new Date(sub.expiresAt) - new Date();
    if (ms <= 0) return { expired: true, label: 'Expired' };
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    return { expired: false, days, hours, label: `${days}d ${hours}h` };
  }, [sub?.expiresAt]);

  if (loading) {
    return (
      <div className="grid grid-cols-12 gap-6">
        <WalletSidebar activeId="subscription" />
        <main className="col-span-12 lg:col-span-10 xl:col-span-10 min-w-0">
          <div className="text-text-muted p-4">Loading wallet…</div>
        </main>
      </div>
    );
  }

  const balanceNum = Number(wallet?.balance || 0);
  const lowThreshold = Number(wallet?.lowBalanceThreshold || 0);
  const isLow = wallet?.isLowBalance || balanceNum <= lowThreshold;
  const ccy = wallet?.currency || 'USD';
  const sym = ccy === 'USD' ? '$' : `${ccy} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const status = sub?.status || (effectivePlan?.code === 'FREE' ? 'FREE' : 'NONE');
  const statusTone = {
    ACTIVE:    { bg: '#16A34A18', fg: '#16A34A', label: 'Active' },
    TRIAL:     { bg: '#3B82F618', fg: '#3B82F6', label: 'Trial' },
    EXPIRED:   { bg: '#DC262618', fg: '#DC2626', label: 'Expired' },
    CANCELLED: { bg: '#92400E18', fg: '#92400E', label: 'Cancelled' },
    PENDING_PAYMENT: { bg: '#EA580C18', fg: '#EA580C', label: 'Payment pending' },
    FREE:      { bg: '#6B728018', fg: '#6B7280', label: 'Free plan' },
    NONE:      { bg: '#6B728018', fg: '#6B7280', label: 'No subscription' },
  }[status] || { bg: '#6B728018', fg: '#6B7280', label: status };

  return (
    <div className="grid grid-cols-12 gap-6">
      <WalletSidebar activeId="subscription" />
      <main className="col-span-12 lg:col-span-10 xl:col-span-10 min-w-0 space-y-5">
      <PageHero
        eyebrow="Subscription"
        title="Subscription Wallet"
        subtitle="A dedicated balance used only for plan purchases and renewals. Your trading wallet is never touched."
      />

      {/* ── Premium balance card ───────────────────────────────────── */}
      <div className="bg-white border-2 border-border-dark rounded-3xl p-6 md:p-8 shadow-card relative overflow-hidden">
        {/* Decorative ribbon */}
        <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full opacity-[0.07]"
             style={{ background: 'radial-gradient(circle, #3B82F6 0%, transparent 70%)' }} />

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
              Subscription wallet
            </div>
            <div className="mt-2 flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-5xl md:text-6xl font-extrabold text-text-primary tracking-tight">
                {sym}{fmt(balanceNum)}
              </span>
              <span className="text-sm text-text-muted">{ccy}</span>
            </div>
            <div className="mt-1 text-xs text-text-muted">
              Last updated {wallet?.updatedAt ? new Date(wallet.updatedAt).toLocaleString() : '—'}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setDepositOpen(true)}
              className="btn-primary text-sm shadow-elevated"
            >
              + Add Funds
            </button>
            <Link to="/plans" className="btn-secondary text-sm">View Plans</Link>
          </div>
        </div>

        {/* Low-balance warning */}
        {isLow && (
          <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
            <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700 shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
            </span>
            <div className="text-sm">
              <div className="font-bold text-amber-900">Low subscription balance</div>
              <div className="text-amber-800 text-[12px] mt-0.5">
                Your balance is at or below {sym}{fmt(lowThreshold)}. Top up to keep your subscription from being downgraded on renewal.
              </div>
            </div>
          </div>
        )}

        {/* Status strip — plan + auto-renew + countdown */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          <StatusTile
            label="Current plan"
            value={effectivePlan?.name || '—'}
            badge={statusTone}
            sub={sub?.billingCycle ? `${sub.billingCycle.toLowerCase()} billing` : null}
          />
          <StatusTile
            label="Renews in"
            value={countdown ? countdown.label : '—'}
            sub={sub?.expiresAt ? new Date(sub.expiresAt).toLocaleDateString() : 'No renewal scheduled'}
            tone={countdown?.expired ? 'bear' : 'primary'}
          />
          <div className="rounded-2xl border border-border-dark p-4 bg-bg-hover/30">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Auto-renew</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className={`text-sm font-bold ${wallet?.autoRenew ? 'text-bull' : 'text-text-muted'}`}>
                {wallet?.autoRenew ? 'Enabled' : 'Disabled'}
              </span>
              <button
                onClick={() => toggleAutoRenew(!wallet?.autoRenew)}
                disabled={savingAutoRenew}
                className={`relative w-12 h-6 rounded-full transition border ${
                  wallet?.autoRenew ? 'bg-bull border-bull' : 'bg-bg-hover border-border-dark'
                } disabled:opacity-60`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition shadow ${
                    wallet?.autoRenew ? 'left-[26px]' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="text-[11px] text-text-muted mt-1.5 leading-snug">
              Renewals debit this wallet. {wallet?.gracePeriodDays || 0}-day grace period.
            </div>
          </div>
        </div>
      </div>

      {/* ── Transaction history ────────────────────────────────────── */}
      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-text-primary">Transaction history</h2>
            <p className="text-[11px] text-text-muted">Every credit and debit on this wallet.</p>
          </div>
          <div className="text-[11px] text-text-muted">{txns.length} entr{txns.length === 1 ? 'y' : 'ies'}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-text-muted bg-bg-hover/40">
                <th className="text-left py-2.5 px-4 font-bold">Date</th>
                <th className="text-left py-2.5 px-4 font-bold">Reason</th>
                <th className="text-left py-2.5 px-4 font-bold">Plan</th>
                <th className="text-right py-2.5 px-4 font-bold">Amount</th>
                <th className="text-right py-2.5 px-4 font-bold">Balance</th>
                <th className="text-center py-2.5 px-4 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {txns.length === 0 && (
                <tr><td colSpan={6} className="py-10 text-center text-text-muted">No transactions yet</td></tr>
              )}
              {txns.map((t) => {
                const isCredit = t.transactionType === 'CREDIT' || t.transactionType === 'REFUND';
                return (
                  <tr key={t._id} className="border-b border-border-subtle hover:bg-bg-hover/30">
                    <td className="py-2 px-4 text-text-secondary tabular-nums whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 px-4">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${isCredit ? 'bg-bull' : 'bg-bear'}`} />
                        <span className="font-semibold text-text-primary">{t.reason?.replaceAll('_', ' ')}</span>
                      </span>
                      {t.note && <div className="text-[11px] text-text-muted mt-0.5">{t.note}</div>}
                    </td>
                    <td className="py-2 px-4 text-text-secondary">
                      {t.planCode ? `${t.planCode} · ${t.billingCycle || ''}` : '—'}
                    </td>
                    <td className={`py-2 px-4 text-right font-mono tabular-nums font-bold ${isCredit ? 'text-bull' : 'text-bear'}`}>
                      {isCredit ? '+' : '−'}{sym}{fmt(t.amount)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-text-secondary">
                      {t.balanceAfter != null ? `${sym}${fmt(t.balanceAfter)}` : '—'}
                    </td>
                    <td className="py-2 px-4 text-center">
                      <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                        t.status === 'SUCCESS' ? 'bg-bull/15 text-bull' :
                        t.status === 'FAILED'  ? 'bg-bear/15 text-bear' :
                                                 'bg-warn/15 text-warn'
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
      </div>

      {depositOpen && (
        <DepositModal
          currency={ccy}
          onClose={() => setDepositOpen(false)}
          onSuccess={() => {
            setDepositOpen(false);
            refresh();
          }}
        />
      )}
      </main>
    </div>
  );
}

function StatusTile({ label, value, sub, badge, tone }) {
  return (
    <div className="rounded-2xl border border-border-dark p-4 bg-bg-hover/30">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className={`text-lg font-bold ${tone === 'bear' ? 'text-bear' : 'text-text-primary'}`}>{value}</span>
        {badge && (
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ background: badge.bg, color: badge.fg }}
          >
            {badge.label}
          </span>
        )}
      </div>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function DepositModal({ currency, onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [walletsByAcc, setWalletsByAcc] = useState({});
  const [sourceAccountId, setSourceAccountId] = useState('');
  const sym = currency === 'USD' ? '$' : `${currency} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Load REAL trading accounts + their wallet balances so the user can
  // pick which trading account to pull from.
  useEffect(() => {
    (async () => {
      try {
        const [accRes, walRes] = await Promise.all([
          api.get('/user/accounts'),
          api.get('/wallet/balances'),
        ]);
        // Tier codes (STANDARD / PRO / FREE / etc) are all "live" accounts.
        // Only literal DEMO/VIRTUAL are practice and can't fund subscriptions.
        const reals = (accRes.data.data || []).filter(
          (a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false
        );
        setAccounts(reals);
        const map = {};
        for (const w of (walRes.data.data || [])) {
          map[String(w.accountId)] = w;
        }
        setWalletsByAcc(map);
        // Default to oldest real account.
        const oldest = [...reals].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        if (oldest) setSourceAccountId(oldest._id);
      } catch (e) {
        // Non-fatal — modal still works without account picker.
      }
    })();
  }, []);

  const source = accounts.find((a) => a._id === sourceAccountId);
  const sourceWallet = source ? walletsByAcc[source._id] : null;
  const sourceBalance = Number(sourceWallet?.balance || 0);
  const sourceCcy = source?.baseCurrency || 'USD';
  const n = Number(amount);
  const enough = Number.isFinite(n) && n > 0 && sourceBalance >= n;

  const submit = async () => {
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Enter a positive amount');
      return;
    }
    if (!sourceAccountId) {
      toast.error('Pick a trading account to fund from');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/subscription-wallet/deposit', {
        amount: n,
        sourceAccountId,
      });
      toast.success(`${sym}${n.toFixed(2)} moved from your trading account to the Subscription Wallet`);
      onSuccess();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const details = e.response?.data?.error?.details;
      if (code === 'INSUFFICIENT_TRADING_BALANCE' && details) {
        toast.error(
          `Not enough in ${details.accountNumber} — available ${details.currency} ${details.available}.`,
          { duration: 5000 }
        );
      } else if (code === 'NO_REAL_ACCOUNT') {
        toast.error('Open a real trading account first.');
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-border-dark max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Move funds to Subscription Wallet</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          {/* Source account picker */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">From trading account</div>
            {accounts.length === 0 ? (
              <div className="text-sm text-text-muted rounded-xl border border-dashed border-border-dark px-3 py-3">
                No real trading account yet. <Link to="/accounts/new" className="text-primary-600 font-semibold hover:underline">Open one →</Link>
              </div>
            ) : (
              <select
                value={sourceAccountId}
                onChange={(e) => setSourceAccountId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500"
              >
                {accounts.map((a) => {
                  const w = walletsByAcc[a._id];
                  const bal = Number(w?.balance || 0);
                  return (
                    <option key={a._id} value={a._id}>
                      {a.nickname || a.accountNumber} · {a.baseCurrency} {fmt(bal)}
                    </option>
                  );
                })}
              </select>
            )}
            {source && (
              <div className="text-[11px] text-text-muted mt-1">
                Available: <span className="font-mono font-bold text-text-secondary">{sourceCcy} {fmt(sourceBalance)}</span>
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Amount</div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">{sym.trim() || '$'}</span>
              <input
                type="number"
                step="0.01"
                min="1"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full pl-7 pr-3 py-2.5 rounded-xl border border-border-dark text-lg font-mono tabular-nums font-bold focus:outline-none focus:border-primary-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[10, 50, 100, 500].map((q) => (
              <button
                key={q}
                onClick={() => setAmount(String(q))}
                className="px-2 py-1.5 rounded-lg border border-border-dark text-xs font-semibold text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors"
              >
                {sym.trim() || '$'}{q}
              </button>
            ))}
          </div>
          {n > 0 && !enough && source && (
            <div className="rounded-md border border-bear/30 bg-bear/10 px-3 py-2 text-[12px] text-bear font-semibold">
              Insufficient balance in {source.nickname || source.accountNumber}. Top up your trading wallet first.
            </div>
          )}
          <p className="text-[11px] text-text-muted leading-snug">
            The amount is moved from your trading account into the Subscription Wallet — it can then only be used for plan purchases and renewals.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="btn-ghost text-sm">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !accounts.length || !enough}
            className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Moving…' : `Move ${sym.trim() || '$'}${amount || '0.00'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
