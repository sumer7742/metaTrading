import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [mySub, setMySub] = useState(null);
  const [effective, setEffective] = useState(null);
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState('MONTHLY');

  const refresh = async () => {
    try {
      const [p, m] = await Promise.all([
        api.get('/subscriptions/plans'),
        api.get('/subscriptions/me'),
      ]);
      setPlans(p.data.data);
      setMySub(m.data.data.subscription);
      setEffective(m.data.data.effectivePlan);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const subscribe = async (plan) => {
    if (Number(plan.monthlyPrice) > 0) {
      // For paid plans in dev, the mock payment provider auto-confirms
      // In production: redirect to Razorpay/Stripe checkout here
      const confirm = window.confirm(
        `Subscribe to ${plan.name} for $${billing === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice}/${billing === 'YEARLY' ? 'year' : 'month'}?\n\n` +
        `Note: In dev mode the mock payment provider auto-confirms. ` +
        `In production this would open Razorpay/Stripe checkout.`
      );
      if (!confirm) return;
    }
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: plan.code,
        billingCycle: billing,
        // Mock payment ref - in prod, comes from payment provider webhook
        paymentRef: { provider: 'MOCK', transactionId: `mock-${Date.now()}`, amount: plan.monthlyPrice, paidAt: new Date() },
      });
      toast.success(`Subscribed to ${plan.name}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const cancel = async () => {
    if (!confirm('Cancel your subscription? You will be downgraded to Free at the end of your billing period.')) return;
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

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Membership"
        title="Plans & Pricing"
        subtitle="Upgrade for lower trading fees, more accounts, premium support, and exclusive perks."
      />

      {/* Current plan banner */}
      {effective && (
        <div className="card p-5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs uppercase text-gray-500">Current plan</div>
            <div className="text-xl font-bold text-white mt-1">
              {effective.name}
              {mySub?.expiresAt && (
                <span className="text-xs font-normal text-gray-400 ml-3">
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

      {/* Billing toggle */}
      <div className="flex items-center gap-4">
        <span className={billing === 'MONTHLY' ? 'text-white font-semibold' : 'text-gray-500'}>Monthly</span>
        <button
          onClick={() => setBilling(billing === 'MONTHLY' ? 'YEARLY' : 'MONTHLY')}
          className="relative w-12 h-6 bg-bg-hover rounded-full transition"
        >
          <div className={`absolute top-0.5 w-5 h-5 bg-teal-accent rounded-full transition ${billing === 'YEARLY' ? 'left-6' : 'left-0.5'}`} />
        </button>
        <span className={billing === 'YEARLY' ? 'text-white font-semibold' : 'text-gray-500'}>
          Yearly <span className="text-bull text-xs ml-1">save ~17%</span>
        </span>
      </div>

      {/* Pricing cards */}
      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((plan) => {
          const price = billing === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice;
          const popular = plan.badge === 'Most Popular';
          const current = isCurrent(plan);
          return (
            <div
              key={plan._id}
              className={`card p-6 relative ${popular ? 'border-teal-accent' : ''}`}
            >
              {popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-teal-accent text-bg-dark text-xs px-3 py-1 rounded-full font-semibold">
                  {plan.badge}
                </div>
              )}
              <div className="text-xs uppercase text-gray-500 tracking-wider">{plan.code}</div>
              <h3 className="text-2xl font-bold text-white mt-1">{plan.name}</h3>
              <p className="text-sm text-gray-400 mt-1 min-h-[40px]">{plan.description}</p>

              <div className="my-5">
                <span className="text-4xl font-bold text-white">${Number(price).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>
                <span className="text-sm text-gray-500 ml-2">/ {billing === 'YEARLY' ? 'year' : 'month'}</span>
              </div>

              <ul className="space-y-2 mb-6">
                {(plan.highlights || []).map((h, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                    <span className="text-bull mt-0.5">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              {current ? (
                <button disabled className="btn-secondary w-full opacity-60 cursor-default">Current plan</button>
              ) : (
                <button
                  onClick={() => subscribe(plan)}
                  className={popular ? 'btn-primary w-full' : 'btn-secondary w-full'}
                >
                  {Number(plan.monthlyPrice) === 0 ? 'Switch to Free' : `Choose ${plan.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Feature comparison table */}
      <div className="card overflow-hidden mt-6">
        <div className="px-5 py-3 border-b border-border-dark">
          <h2 className="text-white font-semibold">Compare features</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-card text-xs uppercase text-gray-500">
                <th className="text-left py-2 px-4">Feature</th>
                {plans.map((p) => <th key={p._id} className="text-center py-2 px-4">{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              <FeatureRow label="Trading accounts" plans={plans} value={(p) => p.limits?.maxAccounts} />
              <FeatureRow label="Fee discount" plans={plans} value={(p) => `${(Number(p.features?.feeDiscountPercent || 0) * 100).toFixed(0)}%`} />
              <FeatureRow label="Max leverage override" plans={plans} value={(p) => p.limits?.maxLeverageOverride ? `1:${p.limits.maxLeverageOverride}` : 'Instrument default'} />
              <FeatureRow label="API access" plans={plans} value={(p) => p.features?.apiAccess ? '✓' : '—'} />
              <FeatureRow label="Priority support" plans={plans} value={(p) => p.features?.prioritySupport ? '✓' : '—'} />
              <FeatureRow label="Copy trading" plans={plans} value={(p) => p.features?.copyTradingEnabled ? '✓' : '—'} />
              <FeatureRow label="Affiliate bonus" plans={plans} value={(p) => `+${(Number(p.features?.affiliateBonus || 0) * 100).toFixed(0)}%`} />
              <FeatureRow label="Dedicated manager" plans={plans} value={(p) => p.features?.customSupport ? '✓' : '—'} />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FeatureRow({ label, plans, value }) {
  return (
    <tr className="table-row">
      <td className="py-2 px-4 text-gray-300">{label}</td>
      {plans.map((p) => <td key={p._id} className="py-2 px-4 text-center text-white font-mono text-xs">{value(p) ?? '—'}</td>)}
    </tr>
  );
}
