import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

export default function Plans() {
  const confirm = useConfirm();
  const [plans, setPlans] = useState([]);
  const [mySub, setMySub] = useState(null);
  const [effective, setEffective] = useState(null);
  const [subWallet, setSubWallet] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState('MONTHLY');
  // Confirmation modal state — gates the wallet-debit so the user sees
  // exactly what they'll be charged before money moves.
  const [confirmPlan, setConfirmPlan] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Recharge modal triggered on INSUFFICIENT_SUBSCRIPTION_BALANCE.
  const [rechargePrompt, setRechargePrompt] = useState(null);

  const refresh = async () => {
    try {
      const [p, m, h] = await Promise.all([
        api.get('/subscriptions/plans'),
        api.get('/subscriptions/me'),
        // Billing history is non-fatal — a failure here shouldn't blank the page.
        api.get('/subscriptions/history', { params: { limit: 100 } }).catch(() => ({ data: { data: [] } })),
      ]);
      setPlans(p.data.data);
      setMySub(m.data.data.subscription);
      setEffective(m.data.data.effectivePlan);
      setSubWallet(m.data.data.subscriptionWallet || null);
      setHistory(Array.isArray(h.data.data) ? h.data.data : []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Free / Post-Paid switch — no upfront payment, no confirmation modal.
  // Post-Paid is billed per-trade, so activation is just a plan flip.
  const switchToFree = async (plan) => {
    const isPostPaid = plan.code === 'POSTPAID' || plan.features?.postPaid;
    const prompt = isPostPaid
      ? `Activate ${plan.name}? You'll be billed per trade plus a monthly maintenance fee.`
      : `Switch to ${plan.name}? Your paid features will end immediately.`;
    if (!(await confirm(prompt))) return;
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: plan.code,
        billingCycle: billing,
      });
      toast.success(isPostPaid ? `${plan.name} activated` : `Switched to ${plan.name}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Paid plan — open confirmation modal with wallet balance + price.
  const openConfirm = (plan) => setConfirmPlan(plan);

  // Submit handler — debits the Subscription Wallet and creates the sub.
  // On insufficient balance the backend returns a structured 402 with the
  // shortfall — we surface a recharge popup that deep-links to the
  // standalone Subscription Wallet page.
  const confirmAndPay = async () => {
    if (!confirmPlan) return;
    setSubmitting(true);
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: confirmPlan.code,
        billingCycle: billing,
        paymentMethod: 'subscription_wallet',
      });
      const price = billing === 'YEARLY' ? confirmPlan.yearlyPrice : confirmPlan.monthlyPrice;
      toast.success(`Subscribed to ${confirmPlan.name} · ${Number(price).toFixed(2)} deducted from your Main Wallet`);
      setConfirmPlan(null);
      refresh();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const details = e.response?.data?.error?.details;
      if (code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
        setConfirmPlan(null);
        setRechargePrompt({
          plan: confirmPlan,
          billing,
          balance: details?.balance ?? subWallet?.balance ?? '0',
          needed: details?.needed ?? String(billing === 'YEARLY' ? confirmPlan.yearlyPrice : confirmPlan.monthlyPrice),
          shortfall: details?.shortfall ?? '0',
          currency: details?.currency ?? subWallet?.currency ?? 'USD',
        });
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!(await confirm('Cancel your subscription? You will be downgraded to Free at the end of your billing period.'))) return;
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
  const balanceNum = Number(subWallet?.balance || 0);
  const walletCcy = subWallet?.currency || 'USD';
  const walletSym = walletCcy === 'USD' ? '$' : `${walletCcy} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Plan billing history — charges, renewals and refunds pulled from the Main
  // Wallet ledger. Deposits / withdrawals live on the wallet page, so we keep
  // this focused on plan-related money movement only.
  const BILLING_REASONS = new Set(['SUBSCRIPTION_CHARGE', 'RENEWAL', 'REFUND']);
  const REASON_LABEL = {
    SUBSCRIPTION_CHARGE: 'Subscription',
    RENEWAL: 'Renewal',
    REFUND: 'Refund',
  };
  const billingRows = (history || []).filter((t) => BILLING_REASONS.has(t.reason));

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
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase text-gray-500 tracking-wider">Billing Source: Main Wallet</div>
            {subWallet?.isLowBalance && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warn/15 text-warn">Low</span>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div className="text-xl font-bold text-text-primary font-mono tabular-nums">
              {walletSym}{fmt(balanceNum)}
            </div>
            <Link to="/subscription-wallet" className="text-sm text-primary-500 hover:underline font-semibold">Top up →</Link>
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            Plan renewals are deducted from your Main Wallet.
          </div>
          <div className="text-[11px] text-warn mt-1.5">
            ⚠ Ensure sufficient balance is available in your Main Wallet before the renewal date.
          </div>
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
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const isPostPaid = plan.code === 'POSTPAID' || plan.features?.postPaid;
          const price = billing === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice;
          const priceNum = Number(price || 0);
          const isFree = priceNum === 0 && !isPostPaid;
          const popular = plan.badge === 'Most Popular';
          const current = isCurrent(plan);
          const canAfford = isFree || isPostPaid || balanceNum >= priceNum;
          return (
            <div
              key={plan._id}
              className={`card p-6 relative transition-all ${popular ? 'border-primary-500 shadow-elevated' : ''} ${isPostPaid ? 'border-warn/40' : ''} ${current ? 'ring-2 ring-bull/40' : ''}`}
            >
              {popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary-500 text-white text-xs px-3 py-1 rounded-full font-semibold shadow">
                  {plan.badge}
                </div>
              )}
              {isPostPaid && !popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-warn text-white text-xs px-3 py-1 rounded-full font-semibold shadow">
                  Pay as you trade
                </div>
              )}
              <div className="text-xs uppercase text-text-muted tracking-wider">{plan.code}</div>
              <h3 className="text-2xl font-bold text-text-primary mt-1">{plan.name}</h3>
              <p className="text-sm text-text-secondary mt-1 min-h-[40px]">{plan.description}</p>

              <div className="my-5 min-h-[60px]">
                {isPostPaid ? (
                  <PostPaidRateBlock plan={plan} />
                ) : (
                  <>
                    <span className="text-4xl font-bold text-text-primary">
                      ${Number(price).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                    </span>
                    <span className="text-sm text-text-muted ml-2">/ {billing === 'YEARLY' ? 'year' : 'month'}</span>
                  </>
                )}
              </div>

              <ul className="space-y-2 mb-6">
                {(plan.highlights || [])
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
              ) : isPostPaid ? (
                <button onClick={() => switchToFree(plan)} className="btn-primary w-full">
                  Activate Post Paid
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
              <FeatureRow label="Maintenance fee" plans={plans} value={(p) => p.features?.maintenanceFee ? 'Applies' : 'Zero'} />
              <FeatureRow label="Trading accounts" plans={plans} value={(p) => p.limits?.maxAccounts == null ? 'Unlimited' : p.limits.maxAccounts} />
              <FeatureRow label="All instruments" plans={plans} value={() => '✓'} />
              <FeatureRow label="24/7 access" plans={plans} value={() => '✓'} />
              <FeatureRow label="API access" plans={plans} value={(p) => p.features?.apiAccess ? '✓' : '—'} />
              <FeatureRow label="Devices login" plans={plans} value={(p) => p.limits?.maxDevices == null ? 'Unlimited' : p.limits.maxDevices} />
              <FeatureRow label="Support" plans={plans} value={(p) => (p.features?.customSupport || p.features?.postPaid) ? 'Dedicated' : 'Standard'} />
              {/* "Max leverage" row removed — leverage now lives at the
                  instrument level (per-symbol cap) and the account-type
                  picker, so showing a static per-plan value here was
                  misleading. */}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Billing history — plan charges, renewals & refunds ───────────────── */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="text-text-primary font-bold tracking-tight">Billing history</h2>
            <p className="text-[11px] text-text-muted mt-0.5">Plan charges, renewals and refunds from your Main Wallet.</p>
          </div>
          {billingRows.length > 0 && (
            <span className="text-[11px] text-text-muted">{billingRows.length} record{billingRows.length === 1 ? '' : 's'}</span>
          )}
        </div>
        {billingRows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-text-muted">
            No billing history yet. Your plan charges and renewals will appear here.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-bg-card text-xs uppercase text-text-muted border-b border-border-dark">
                  <th className="text-left py-2.5 px-4 font-bold tracking-wide">Date</th>
                  <th className="text-left py-2.5 px-4 font-bold tracking-wide">Description</th>
                  <th className="text-right py-2.5 px-4 font-bold tracking-wide">Amount</th>
                  <th className="text-center py-2.5 px-4 font-bold tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody>
                {billingRows.map((t) => {
                  const isDebit = t.transactionType === 'DEBIT';
                  const sym = (t.currency || 'USD') === 'USD' ? '$' : `${t.currency} `;
                  const d = new Date(t.createdAt);
                  const statusCls = t.status === 'FAILED' ? 'bg-bear/15 text-bear'
                    : t.status === 'PENDING' ? 'bg-warn/15 text-warn'
                    : 'bg-bull/15 text-bull';
                  return (
                    <tr key={t._id} className="border-b border-border-dark/60 last:border-0 hover:bg-bg-hover/40">
                      <td className="py-2.5 px-4 whitespace-nowrap align-top">
                        <div className="text-text-secondary">{d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                        <div className="text-[11px] text-text-muted">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      </td>
                      <td className="py-2.5 px-4 align-top">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary">
                          {REASON_LABEL[t.reason] || t.reason}
                        </span>
                        {t.note && <div className="text-text-secondary mt-1">{t.note}</div>}
                      </td>
                      <td className={`py-2.5 px-4 text-right font-mono tabular-nums font-semibold whitespace-nowrap align-top ${isDebit ? 'text-bear' : 'text-bull'}`}>
                        {isDebit ? '−' : '+'}{sym}{fmt(t.amount)}
                      </td>
                      <td className="py-2.5 px-4 text-center align-top">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${statusCls}`}>
                          {t.status || 'SUCCESS'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Confirmation modal — locks in price + shows balance before / after ─ */}
      {confirmPlan && (
        <ConfirmPayModal
          plan={confirmPlan}
          billing={billing}
          wallet={subWallet}
          submitting={submitting}
          onConfirm={confirmAndPay}
          onClose={() => !submitting && setConfirmPlan(null)}
        />
      )}

      {/* Recharge popup — triggered when the Subscription Wallet doesn't
          have enough to cover the plan. Renewal stays disabled until the
          shortfall is funded. */}
      {rechargePrompt && (
        <RechargePromptModal
          {...rechargePrompt}
          onClose={() => setRechargePrompt(null)}
        />
      )}
    </div>
  );
}

function RechargePromptModal({ plan, billing, balance, needed, shortfall, currency, onClose }) {
  const sym = currency === 'USD' ? '$' : `${currency} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-border-dark max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Recharge required</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="bg-bear/10 border border-bear/30 rounded-lg p-3 text-bear text-[13px] font-semibold">
            Not enough balance in your Main Wallet to subscribe to {plan?.name}.
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Stat label="Balance" value={`${sym}${fmt(balance)}`} tone="muted" />
            <Stat label="Plan price" value={`${sym}${fmt(needed)}`} tone="primary" />
            <Stat label="Top up by" value={`${sym}${fmt(shortfall)}`} tone="bear" />
          </div>
          <p className="text-[11px] text-text-muted leading-snug">
            Plan purchases and renewals are deducted from your Main Wallet. Top up your Main Wallet to continue.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Maybe later</button>
          <Link to="/subscription-wallet" onClick={onClose} className="btn-primary text-sm">
            Add funds →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const cls = {
    bear:    'text-bear',
    primary: 'text-text-primary',
    muted:   'text-text-secondary',
  }[tone] || 'text-text-primary';
  return (
    <div className="rounded-lg border border-border-subtle p-2">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 font-mono tabular-nums font-bold ${cls}`}>{value}</div>
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
            Plan renewals are deducted from your Main Wallet ({ccy}) immediately. The Bonus Wallet is never charged. Subscription activates the moment the payment clears — there's no refund window for partial use.
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

function PostPaidRateBlock({ plan }) {
  const rates = plan.postPaidRates || {};
  const perDevice = Number(rates.perDevicePerMonth || 0);
  const perAccount = Number(rates.perAccountPerMonth || 0);
  const minFee = Number(rates.minimumMonthlyFee || 0);
  const ccy = rates.currency || 'USD';
  const sym = ccy === 'USD' ? '$' : `${ccy} `;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-text-primary leading-tight">{sym}{perDevice}</span>
        <span className="text-xs text-text-muted">per device / month</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-text-primary leading-tight">{sym}{perAccount}</span>
        <span className="text-xs text-text-muted">per account / month</span>
      </div>
      <div className="text-[11px] text-text-muted pt-1 leading-snug">
        Minimum <span className="font-semibold text-text-secondary">{sym}{minFee}/month</span> maintenance fee — whichever is higher.
      </div>
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
