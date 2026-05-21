import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [mySub, setMySub] = useState(null);
  const [effective, setEffective] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState('MONTHLY');
  // Confirmation modal state — gates the wallet-debit so the user sees
  // exactly what they'll be charged before money moves.
  const [confirmPlan, setConfirmPlan] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    try {
      const [p, m] = await Promise.all([
        api.get('/subscriptions/plans'),
        api.get('/subscriptions/me'),
      ]);
      setPlans(p.data.data);
      setMySub(m.data.data.subscription);
      setEffective(m.data.data.effectivePlan);
      setWallet(m.data.data.wallet || null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Free-plan switch — no payment, no confirmation modal needed.
  const switchToFree = async (plan) => {
    if (!window.confirm(`Switch to ${plan.name}? Your paid features will end immediately.`)) return;
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: plan.code,
        billingCycle: billing,
      });
      toast.success(`Switched to ${plan.name}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Paid plan — open confirmation modal with wallet balance + price.
  const openConfirm = (plan) => setConfirmPlan(plan);

  // Submit handler — actually debits the wallet and creates the sub.
  const confirmAndPay = async () => {
    if (!confirmPlan) return;
    setSubmitting(true);
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: confirmPlan.code,
        billingCycle: billing,
        paymentMethod: 'wallet',
      });
      const price = billing === 'YEARLY' ? confirmPlan.yearlyPrice : confirmPlan.monthlyPrice;
      toast.success(`Subscribed to ${confirmPlan.name} · ${Number(price).toFixed(2)} deducted from wallet`);
      setConfirmPlan(null);
      refresh();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      if (code === 'INSUFFICIENT_FUNDS') {
        toast.error('Not enough wallet balance. Top up first.', { duration: 5000 });
      } else if (code === 'NO_REAL_ACCOUNT') {
        toast.error('You need a real trading account to pay from wallet.', { duration: 5000 });
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm('Cancel your subscription? You will be downgraded to Free at the end of your billing period.')) return;
    try {
      await api.post('/subscriptions/cancel', { reason: 'User requested' });
      toast.success('Subscription cancelled');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (loading) return <div className="text-gray-400 p-4">Loading…</div>;

  const isCurrent = (plan) => effective?.code === plan.code;
  const balanceNum = Number(wallet?.free || wallet?.balance || 0);
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Membership"
        title="Plans & Pricing"
        subtitle="Upgrade for lower trading fees, more accounts, premium support, and exclusive perks."
      />

      {/* Current plan + wallet balance side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {effective && (
          <div className="card p-5 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-xs uppercase text-gray-500 tracking-wider">Current plan</div>
              <div className="text-xl font-bold text-text-primary mt-1">
                {effective.name}
                {mySub?.expiresAt && (
                  <span className="text-xs font-normal text-text-muted ml-3">
                    Renews {new Date(mySub.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            {mySub && mySub.status === 'ACTIVE' && effective.code !== 'FREE' && (
              <button onClick={cancel} className="btn-secondary text-sm">Cancel subscription</button>
            )}
          </div>
        )}
        <div className="card p-5">
          <div className="text-xs uppercase text-gray-500 tracking-wider">Wallet · paying account</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="text-xl font-bold text-text-primary font-mono tabular-nums">
              {wallet ? `${wallet.currency} ${fmt(balanceNum)}` : 'No real account'}
            </div>
            <Link to="/wallet" className="text-sm text-primary-500 hover:underline font-semibold">Top up →</Link>
          </div>
          {wallet && (
            <div className="text-[11px] text-text-muted mt-1">
              Upgrades are deducted from this balance instantly.
            </div>
          )}
        </div>
      </div>

      {/* Billing toggle */}
      <div className="flex items-center gap-4">
        <span className={billing === 'MONTHLY' ? 'text-text-primary font-semibold' : 'text-text-muted'}>Monthly</span>
        <button
          onClick={() => setBilling(billing === 'MONTHLY' ? 'YEARLY' : 'MONTHLY')}
          className="relative w-12 h-6 bg-bg-hover rounded-full transition border border-border-dark"
        >
          <div className={`absolute top-0.5 w-5 h-5 bg-primary-500 rounded-full transition shadow ${billing === 'YEARLY' ? 'left-[26px]' : 'left-0.5'}`} />
        </button>
        <span className={billing === 'YEARLY' ? 'text-text-primary font-semibold' : 'text-text-muted'}>
          Yearly <span className="text-bull text-xs ml-1">save ~17%</span>
        </span>
      </div>

      {/* Pricing cards */}
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((plan) => {
          const price = billing === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice;
          const priceNum = Number(price || 0);
          const isFree = priceNum === 0;
          const popular = plan.badge === 'Most Popular';
          const current = isCurrent(plan);
          const canAfford = isFree || balanceNum >= priceNum;
          return (
            <div
              key={plan._id}
              className={`card p-6 relative transition-all ${popular ? 'border-primary-500 shadow-elevated' : ''} ${current ? 'ring-2 ring-bull/40' : ''}`}
            >
              {popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary-500 text-white text-xs px-3 py-1 rounded-full font-semibold shadow">
                  {plan.badge}
                </div>
              )}
              <div className="text-xs uppercase text-text-muted tracking-wider">{plan.code}</div>
              <h3 className="text-2xl font-bold text-text-primary mt-1">{plan.name}</h3>
              <p className="text-sm text-text-secondary mt-1 min-h-[40px]">{plan.description}</p>

              <div className="my-5">
                <span className="text-4xl font-bold text-text-primary">
                  ${Number(price).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                </span>
                <span className="text-sm text-text-muted ml-2">/ {billing === 'YEARLY' ? 'year' : 'month'}</span>
              </div>

              <ul className="space-y-2 mb-6">
                {(plan.highlights || [])
                  // Strip the removed "Copy trading" feature. Leverage
                  // IS plan-tied (see backend leverageService) so it
                  // stays in the highlights.
                  .filter((h) => !/copy[\s-]*trading/i.test(h))
                  .map((h, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                      <span className="text-bull mt-0.5 shrink-0">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      </span>
                      <span>{h}</span>
                    </li>
                  ))}
              </ul>

              {current ? (
                <button disabled className="btn-secondary w-full opacity-60 cursor-default">
                  ✓ Current plan
                </button>
              ) : isFree ? (
                <button onClick={() => switchToFree(plan)} className="btn-secondary w-full">
                  Switch to Free
                </button>
              ) : (
                <div className="space-y-2">
                  <button
                    onClick={() => openConfirm(plan)}
                    disabled={!canAfford}
                    className={`w-full ${popular ? 'btn-primary' : 'btn-secondary'} disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    {canAfford ? `Pay from wallet · $${fmt(priceNum)}` : 'Insufficient balance'}
                  </button>
                  {!canAfford && (
                    <Link to="/wallet" className="block text-center text-[11px] text-primary-500 font-semibold hover:underline">
                      Top up to upgrade →
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Feature comparison table */}
      <div className="card overflow-hidden mt-6">
        <div className="px-5 py-3 border-b border-border-dark">
          <h2 className="text-text-primary font-bold tracking-tight">Compare features</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-hover/40 text-xs uppercase text-text-muted">
                <th className="text-left py-2 px-4 font-bold tracking-wide">Feature</th>
                {plans.map((p) => <th key={p._id} className="text-center py-2 px-4 font-bold tracking-wide">{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              <FeatureRow label="Trading accounts" plans={plans} value={(p) => p.limits?.maxAccounts} />
              <FeatureRow label="Max leverage" plans={plans} value={(p) => `1:${p.limits?.defaultLeverage || 100}`} />
              <FeatureRow label="Fee discount" plans={plans} value={(p) => `${(Number(p.features?.feeDiscountPercent || 0) * 100).toFixed(0)}%`} />
              <FeatureRow label="API access" plans={plans} value={(p) => p.features?.apiAccess ? '✓' : '—'} />
              <FeatureRow label="Priority support" plans={plans} value={(p) => p.features?.prioritySupport ? '✓' : '—'} />
              <FeatureRow label="Affiliate bonus" plans={plans} value={(p) => `+${(Number(p.features?.affiliateBonus || 0) * 100).toFixed(0)}%`} />
              <FeatureRow label="Dedicated manager" plans={plans} value={(p) => p.features?.customSupport ? '✓' : '—'} />
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Confirmation modal — locks in price + shows balance before / after ─ */}
      {confirmPlan && (
        <ConfirmPayModal
          plan={confirmPlan}
          billing={billing}
          wallet={wallet}
          submitting={submitting}
          onConfirm={confirmAndPay}
          onClose={() => !submitting && setConfirmPlan(null)}
        />
      )}
    </div>
  );
}

function ConfirmPayModal({ plan, billing, wallet, submitting, onConfirm, onClose }) {
  const price = Number(billing === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice);
  const balance = Number(wallet?.free || wallet?.balance || 0);
  const after = balance - price;
  const canAfford = balance >= price;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ccy = wallet?.currency || 'USD';

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="card max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-base font-bold text-text-primary">Confirm subscription</h2>
          <button onClick={onClose} disabled={submitting} className="text-text-muted hover:text-text-primary text-xl disabled:opacity-30">×</button>
        </div>
        <div className="p-5 space-y-4">
          {/* Plan summary */}
          <div className="bg-bg-hover/40 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Plan</div>
            <div className="text-lg font-bold text-text-primary mt-0.5">{plan.name}</div>
            <div className="text-[11px] text-text-muted mt-0.5">
              Billing: <span className="font-semibold text-text-secondary">{billing === 'YEARLY' ? 'Yearly' : 'Monthly'}</span>
            </div>
          </div>

          {/* Cost + balance check */}
          <div className="space-y-2 text-sm font-mono">
            <Row label="Amount due"      value={`$${fmt(price)}`}         tone="primary" />
            <Row label="Wallet balance"  value={`${ccy} ${fmt(balance)}`} tone="neutral" />
            <Row label="After payment"   value={`${ccy} ${fmt(Math.max(0, after))}`} tone={canAfford ? 'bull' : 'bear'} />
          </div>

          {!canAfford && (
            <div className="rounded-md border border-bear/30 bg-bear/10 px-3 py-2 text-[12px] text-bear">
              Insufficient balance. <Link to="/wallet" className="font-bold underline">Top up your wallet →</Link>
            </div>
          )}

          <p className="text-[11px] text-text-muted leading-snug">
            Funds are deducted from your primary real trading account
            ({ccy}) immediately. Subscription activates the moment the
            payment clears — there's no refund window for partial use.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="btn-ghost text-sm">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={!canAfford || submitting}
            className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Paying…' : `Pay $${fmt(price)} & subscribe`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone }) {
  const toneCls = {
    primary: 'text-text-primary font-bold',
    bull:    'text-bull font-bold',
    bear:    'text-bear font-bold',
    neutral: 'text-text-secondary',
  }[tone] || 'text-text-primary';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className={toneCls}>{value}</span>
    </div>
  );
}

function FeatureRow({ label, plans, value }) {
  return (
    <tr className="border-b border-border-subtle hover:bg-bg-hover/40">
      <td className="py-2 px-4 text-text-secondary">{label}</td>
      {plans.map((p) => <td key={p._id} className="py-2 px-4 text-center text-text-primary font-mono text-xs">{value(p) ?? '—'}</td>)}
    </tr>
  );
}
