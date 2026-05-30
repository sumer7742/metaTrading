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

/**
 * DepositModal — multi-step deposit flow for the Subscription Wallet,
 * mirroring the regular wallet's manual deposit process:
 *   1. Method  → pick UPI / Bank / Crypto / Skrill / Neteller / Trading wallet
 *   2. Amount  → enter the amount + presets
 *   3. Proof   → for manual methods: paste tx reference, sender details,
 *                upload screenshot. Trading-wallet transfer is instant.
 *   4. Confirm → review + submit
 *
 * Manual methods create a PENDING deposit that an admin verifies (same
 * flow as trading-wallet deposits). Trading-wallet transfer is instant
 * and uses the existing transfer endpoint.
 */
const DEPOSIT_METHODS = [
  { id: 'UPI',           label: 'UPI',                sub: 'Instant · Free',         min: 100, kind: 'manual', emoji: '📱' },
  { id: 'BANK',          label: 'Bank Transfer',      sub: 'NEFT / IMPS · 1-3 hrs',  min: 100, kind: 'manual', emoji: '🏦' },
  { id: 'CRYPTO',        label: 'Crypto (USDT)',      sub: 'TRC20 · ~5 min',         min: 10,  kind: 'manual', emoji: '🪙' },
  { id: 'SKRILL',        label: 'Skrill',             sub: 'Instant',                min: 10,  kind: 'manual', emoji: '💳' },
  { id: 'NETELLER',      label: 'Neteller',           sub: 'Instant',                min: 10,  kind: 'manual', emoji: '💳' },
  { id: 'TRADING',       label: 'Trading account',    sub: 'Instant transfer',       min: 1,   kind: 'instant', emoji: '↔️' },
];

function DepositModal({ currency, onClose, onSuccess }) {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState(null);
  const [amount, setAmount] = useState('');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotMimeType, setScreenshotMimeType] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Trading account state (only used when method === 'TRADING')
  const [accounts, setAccounts] = useState([]);
  const [walletsByAcc, setWalletsByAcc] = useState({});
  const [sourceAccountId, setSourceAccountId] = useState('');

  const sym = currency === 'USD' ? '$' : `${currency} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  useEffect(() => {
    if (method?.id !== 'TRADING') return;
    (async () => {
      try {
        const [accRes, walRes] = await Promise.all([
          api.get('/user/accounts'),
          api.get('/wallet/balances'),
        ]);
        const reals = (accRes.data.data || []).filter(
          (a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false
        );
        setAccounts(reals);
        const map = {};
        for (const w of (walRes.data.data || [])) map[String(w.accountId)] = w;
        setWalletsByAcc(map);
        const oldest = [...reals].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        if (oldest) setSourceAccountId(oldest._id);
      } catch { /* non-fatal */ }
    })();
  }, [method?.id]);

  const onScreenshot = (file) => {
    if (!file) { setScreenshot(null); setScreenshotMimeType(null); return; }
    if (file.size > 1.5 * 1024 * 1024) {
      toast.error('Screenshot must be < 1.5 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setScreenshot(reader.result);
      setScreenshotMimeType(file.type);
    };
    reader.readAsDataURL(file);
  };

  const n = Number(amount);

  const submitInstant = async () => {
    if (!sourceAccountId) return toast.error('Pick a trading account');
    setSubmitting(true);
    try {
      await api.post('/subscription-wallet/deposit', { amount: n, sourceAccountId });
      toast.success(`${sym}${n.toFixed(2)} moved to Subscription Wallet`);
      onSuccess();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const details = e.response?.data?.error?.details;
      if (code === 'INSUFFICIENT_TRADING_BALANCE' && details) {
        toast.error(`Not enough in ${details.accountNumber} — available ${details.currency} ${details.available}.`, { duration: 5000 });
      } else if (code === 'NO_REAL_ACCOUNT') {
        toast.error('Open a real trading account first.');
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitManual = async () => {
    setSubmitting(true);
    try {
      await api.post('/subscription-wallet/manual-deposit', {
        amount: n,
        currency,
        method: method.id,
        txReference: txReference.trim(),
        senderName: senderName.trim() || undefined,
        senderUpiId: senderUpiId.trim() || undefined,
        senderBankAccount: senderBankAccount.trim() || undefined,
        screenshot,
        screenshotMimeType,
      });
      toast.success('Deposit submitted — pending admin verification');
      onSuccess();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (!Number.isFinite(n) || n <= 0) return toast.error('Enter a positive amount');
    if (method?.id === 'TRADING') return submitInstant();
    if (!txReference.trim()) return toast.error('Transaction reference is required');
    if (!screenshot) return toast.error('Upload a payment screenshot');
    submitManual();
  };

  // Step navigation
  const canNext = () => {
    if (step === 0) return !!method;
    if (step === 1) return Number.isFinite(n) && n > 0 && (!method?.min || n >= method.min);
    if (step === 2) return method?.id === 'TRADING'
      ? !!sourceAccountId
      : !!txReference.trim() && !!screenshot;
    return true;
  };
  const next = () => setStep((s) => Math.min(3, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const STEPS = ['Method', 'Amount', 'Proof', 'Review'];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-border-dark max-w-md w-full max-h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header + step indicator */}
        <div className="px-5 py-3.5 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-text-primary">Add funds to Subscription Wallet</h3>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <div key={s} className="flex-1 flex items-center gap-1.5">
                <span
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                    i < step ? 'bg-bull text-white'
                      : i === step ? 'bg-primary-500 text-white'
                      : 'bg-bg-hover text-text-muted'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </span>
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${i === step ? 'text-text-primary' : 'text-text-muted'}`}>
                  {s}
                </span>
                {i < STEPS.length - 1 && <span className="flex-1 h-px bg-border-subtle" />}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {step === 0 && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">Pick how you want to fund this wallet.</p>
              {DEPOSIT_METHODS.map((m) => {
                const active = method?.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 transition-all text-left ${
                      active ? 'border-primary-500 bg-primary-500/5' : 'border-border-dark hover:border-primary-500/40'
                    }`}
                  >
                    <span className="text-xl shrink-0">{m.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-text-primary">{m.label}</div>
                      <div className="text-[11px] text-text-muted">{m.sub}</div>
                    </div>
                    {m.kind === 'instant' && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">Instant</span>
                    )}
                    {active && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-primary-500">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {step === 1 && method && (
            <>
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Amount</div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">{sym.trim() || '$'}</span>
                  <input
                    type="number"
                    step="0.01"
                    min={method.min}
                    autoFocus
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={String(method.min)}
                    className="w-full pl-7 pr-3 py-2.5 rounded-xl border border-border-dark text-lg font-mono tabular-nums font-bold focus:outline-none focus:border-primary-500"
                  />
                </div>
                <div className="grid grid-cols-4 gap-2 mt-2">
                  {[method.min, method.min * 5, method.min * 10, method.min * 50].map((q, i) => (
                    <button
                      key={i}
                      onClick={() => setAmount(String(q))}
                      className="px-2 py-1.5 rounded-lg border border-border-dark text-xs font-semibold text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors"
                    >
                      {sym.trim() || '$'}{q}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-text-muted mt-2">
                  Minimum {sym.trim() || '$'}{method.min}
                </p>
              </div>
            </>
          )}

          {step === 2 && method && method.id === 'TRADING' && (
            <>
              <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">From trading account</div>
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
                    return <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} · {a.baseCurrency} {fmt(Number(w?.balance || 0))}</option>;
                  })}
                </select>
              )}
            </>
          )}

          {step === 2 && method && method.id !== 'TRADING' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-primary-500/30 bg-primary-500/5 px-3 py-2.5 text-[12px] text-text-secondary leading-snug">
                Send <span className="font-bold text-text-primary">{sym}{n.toFixed(2)}</span> via {method.label}, then upload proof. An admin will verify and credit your Subscription Wallet.
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Transaction reference *</div>
                <input
                  value={txReference}
                  onChange={(e) => setTxReference(e.target.value)}
                  placeholder={method.id === 'UPI' ? 'UPI reference number' : method.id === 'BANK' ? 'NEFT / IMPS / UTR number' : method.id === 'CRYPTO' ? 'Transaction hash' : 'Transaction ID'}
                  className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500"
                />
              </div>
              {method.id === 'UPI' && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender UPI ID</div>
                  <input
                    value={senderUpiId}
                    onChange={(e) => setSenderUpiId(e.target.value)}
                    placeholder="username@upi"
                    className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500"
                  />
                </div>
              )}
              {method.id === 'BANK' && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender bank a/c (last 4)</div>
                  <input
                    value={senderBankAccount}
                    onChange={(e) => setSenderBankAccount(e.target.value)}
                    placeholder="1234"
                    maxLength={4}
                    className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500"
                  />
                </div>
              )}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender name (optional)</div>
                <input
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  placeholder="Name on the source account"
                  className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500"
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Payment screenshot *</div>
                <label className={`flex items-center justify-center gap-2 px-3 py-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
                  screenshot ? 'border-bull/40 bg-bull/5' : 'border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5'
                }`}>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onScreenshot(e.target.files?.[0])}
                  />
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={screenshot ? 'text-bull' : 'text-text-muted'}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span className={`text-sm font-semibold ${screenshot ? 'text-bull' : 'text-text-secondary'}`}>
                    {screenshot ? 'Screenshot attached · click to replace' : 'Click to upload (max 1.5 MB)'}
                  </span>
                </label>
              </div>
            </div>
          )}

          {step === 3 && method && (
            <div className="space-y-2.5 text-sm">
              <Row label="Method"   value={`${method.emoji} ${method.label}`} />
              <Row label="Amount"   value={`${sym}${fmt(n)}`} tone="primary" />
              {method.id === 'TRADING' ? (
                <Row label="From"   value={(accounts.find((a) => a._id === sourceAccountId)?.nickname) || '—'} />
              ) : (
                <>
                  <Row label="Reference" value={txReference} mono />
                  <Row label="Proof"     value={screenshot ? 'Attached' : 'Missing'} tone={screenshot ? 'bull' : 'bear'} />
                </>
              )}
              <p className="text-[11px] text-text-muted leading-snug pt-2 border-t border-border-subtle">
                {method.id === 'TRADING'
                  ? 'Funds transfer instantly. Your trading wallet is debited and Subscription Wallet credited in one step.'
                  : 'Submission goes to admin for verification. You\'ll get a notification when the deposit is credited.'}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle flex justify-between gap-2">
          <button
            onClick={step === 0 ? onClose : back}
            disabled={submitting}
            className="btn-ghost text-sm"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          {step < 3 ? (
            <button
              onClick={next}
              disabled={!canNext()}
              className="btn-primary text-sm disabled:opacity-50"
            >
              Continue →
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={submitting}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : method?.kind === 'instant' ? `Transfer ${sym}${fmt(n)}` : `Submit deposit`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone, mono }) {
  const toneCls = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : tone === 'primary' ? 'text-text-primary' : 'text-text-secondary';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted text-[12px]">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} font-bold ${toneCls} truncate max-w-[60%]`}>{value}</span>
    </div>
  );
}
