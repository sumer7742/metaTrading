import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Subscription plans management — full admin control over the plans
 * users see in the pricing page. CRUD + reorder + soft-disable +
 * per-plan analytics (active users / monthly revenue / churn).
 */
export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // plan object (new = empty) or null
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [p, a] = await Promise.allSettled([
        api.get('/subscriptions/admin/plans'),
        api.get('/subscriptions/admin/plans/analytics'),
      ]);
      if (p.status === 'fulfilled') setPlans(p.value.data.data);
      if (a.status === 'fulfilled') setAnalytics(a.value.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return plans;
    const q = query.toLowerCase();
    return plans.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.code || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
  }, [plans, query]);

  const stats = analytics.reduce((acc, a) => ({
    activeUsers: acc.activeUsers + (a.active || 0),
    revenue:     acc.revenue + Number(a.monthlyRevenue || 0),
    plans:       acc.plans + 1,
  }), { activeUsers: 0, revenue: 0, plans: 0 });

  const toggleStatus = async (plan) => {
    try {
      await api.patch(`/subscriptions/admin/plans/${plan._id}/status`, {
        isActive: !plan.isActive,
      });
      toast.success(`${plan.name} ${plan.isActive ? 'disabled' : 'enabled'}`);
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const remove = async (plan) => {
    if (!window.confirm(`Delete plan "${plan.name}"? This is permanent.`)) return;
    try {
      await api.delete(`/subscriptions/admin/plans/${plan._id}`);
      toast.success('Plan deleted');
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const move = async (idx, dir) => {
    const next = idx + dir;
    if (next < 0 || next >= plans.length) return;
    const order = [...plans];
    [order[idx], order[next]] = [order[next], order[idx]];
    setPlans(order); // optimistic
    try {
      await api.patch('/subscriptions/admin/plans/order', {
        order: order.map((p) => p._id),
      });
    } catch (e) {
      toast.error(errorMessage(e));
      load(); // revert via fresh fetch
    }
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Subscriptions"
        title="Plans Management"
        subtitle="Full control over what users see in the pricing page. Create, edit, reorder, enable/disable, and watch live revenue."
        actions={
          <button onClick={() => setEditing({})} className="btn-primary text-sm">
            + New Plan
          </button>
        }
      />

      {/* Analytics strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Plans" value={stats.plans} />
        <StatCard label="Active Users" value={stats.activeUsers} />
        <StatCard label="Est. Monthly Revenue" value={`$${stats.revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} accent="emerald" />
        <StatCard label="Active Plans" value={plans.filter((p) => p.isActive).length} />
      </div>

      {/* Search bar */}
      <div className="card p-3 flex items-center gap-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted shrink-0"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, code, or description…"
          className="flex-1 bg-transparent outline-none text-sm"
        />
        <span className="text-[11px] text-text-muted">{filtered.length} of {plans.length}</span>
      </div>

      {/* Plans table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
                <th className="text-left py-2.5 px-3 w-10"></th>
                <th className="text-left py-2.5 px-3">Plan</th>
                <th className="text-left py-2.5 px-3">Code</th>
                <th className="text-right py-2.5 px-3">Monthly</th>
                <th className="text-right py-2.5 px-3">Yearly</th>
                <th className="text-right py-2.5 px-3">Leverage</th>
                <th className="text-right py-2.5 px-3">Active</th>
                <th className="text-right py-2.5 px-3">Revenue</th>
                <th className="text-center py-2.5 px-3">Status</th>
                <th className="text-right py-2.5 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && plans.length === 0 && (
                <tr><td colSpan={10} className="py-10 text-center text-text-muted">Loading plans…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={10} className="py-10 text-center text-text-muted">No plans found</td></tr>
              )}
              {filtered.map((p) => {
                const a = analytics.find((x) => String(x._id) === String(p._id)) || {};
                const realIdx = plans.indexOf(p);
                return (
                  <tr key={p._id} className="border-b border-border-subtle hover:bg-bg-hover/40 transition-colors">
                    <td className="py-2 px-3">
                      <div className="flex flex-col gap-0.5">
                        <button
                          onClick={() => move(realIdx, -1)}
                          disabled={realIdx === 0}
                          className="text-text-muted hover:text-primary-500 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Move up"
                        >▲</button>
                        <button
                          onClick={() => move(realIdx, 1)}
                          disabled={realIdx === plans.length - 1}
                          className="text-text-muted hover:text-primary-500 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Move down"
                        >▼</button>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        {p.icon && <span className="text-lg">{p.icon}</span>}
                        <div>
                          <div className="font-bold text-text-primary flex items-center gap-1.5">
                            {p.name}
                            {p.isPopular && (
                              <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warn/15 text-warn">Popular</span>
                            )}
                            {p.isRecommended && (
                              <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-600">Recommended</span>
                            )}
                          </div>
                          {p.description && <div className="text-[11px] text-text-muted truncate max-w-[280px]">{p.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-text-secondary">{p.code}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums">${p.monthlyPrice}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-text-muted">${p.yearlyPrice}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums">1:{p.limits?.defaultLeverage || 100}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums font-bold text-text-primary">{a.active ?? 0}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-emerald-600 font-bold">${a.monthlyRevenue ?? '0.00'}</td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => toggleStatus(p)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
                          p.isActive ? 'bg-emerald-500/15 text-emerald-600' : 'bg-text-muted/15 text-text-muted'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-emerald-500' : 'bg-text-muted'}`} />
                        {p.isActive ? 'Active' : 'Disabled'}
                      </button>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button onClick={() => setEditing(p)} className="btn-ghost text-[11px]">Edit</button>
                        <button onClick={() => remove(p)} className="text-[11px] font-bold px-2 py-1 rounded text-bear hover:bg-bear/10 transition-colors">Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== null && (
        <PlanForm
          plan={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Plan create/edit form modal ────────────────────────────────────
function PlanForm({ plan, onClose, onSaved }) {
  const isNew = !plan._id;
  const [form, setForm] = useState({
    code:           plan.code || '',
    name:           plan.name || '',
    description:    plan.description || '',
    monthlyPrice:   plan.monthlyPrice || '0',
    yearlyPrice:    plan.yearlyPrice || '0',
    sortOrder:      plan.sortOrder ?? 0,
    badge:          plan.badge || '',
    isPopular:      !!plan.isPopular,
    isRecommended:  !!plan.isRecommended,
    isActive:       plan.isActive !== false,
    accentColor:    plan.accentColor || '',
    icon:           plan.icon || '',
    // limits
    maxAccounts:           plan.limits?.maxAccounts ?? 2,
    maxAccountsUnlimited:  plan.limits?.maxAccounts == null,
    maxDevices:            plan.limits?.maxDevices ?? 3,
    maxDevicesUnlimited:   plan.limits?.maxDevices == null,
    defaultLeverage:       plan.limits?.defaultLeverage ?? 100,
    withdrawalDailyLimit:  plan.limits?.withdrawalDailyLimit || '',
    tradingDailyLimit:     plan.limits?.tradingDailyLimit || '',
    // features
    feeDiscountPercent:    plan.features?.feeDiscountPercent || '0',
    affiliateBonus:        plan.features?.affiliateBonus || '0',
    apiAccess:             !!plan.features?.apiAccess,
    prioritySupport:       !!plan.features?.prioritySupport,
    copyTradingEnabled:    !!plan.features?.copyTradingEnabled,
    customSupport:         !!plan.features?.customSupport,
    postPaid:              !!plan.features?.postPaid,
    maintenanceFee:        !!plan.features?.maintenanceFee,
    // post-paid rates
    perDevicePerMonth:     plan.postPaidRates?.perDevicePerMonth || '0',
    perAccountPerMonth:    plan.postPaidRates?.perAccountPerMonth || '0',
    minimumMonthlyFee:     plan.postPaidRates?.minimumMonthlyFee || '0',
    postPaidCurrency:      plan.postPaidRates?.currency || 'USD',
    // highlights as multiline text
    highlightsText:        (plan.highlights || []).join('\n'),
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.code || !form.name) {
      toast.error('Code and name are required');
      return;
    }
    setSaving(true);
    const payload = {
      code: form.code.toUpperCase().trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      monthlyPrice: String(form.monthlyPrice || 0),
      yearlyPrice: String(form.yearlyPrice || 0),
      sortOrder: Number(form.sortOrder) || 0,
      badge: form.badge.trim() || undefined,
      isPopular: !!form.isPopular,
      isRecommended: !!form.isRecommended,
      isActive: !!form.isActive,
      accentColor: form.accentColor.trim() || null,
      icon: form.icon.trim() || null,
      limits: {
        maxAccounts: form.maxAccountsUnlimited ? null : (Number(form.maxAccounts) || 2),
        maxDevices:  form.maxDevicesUnlimited  ? null : (Number(form.maxDevices)  || 3),
        defaultLeverage: Number(form.defaultLeverage) || 100,
        withdrawalDailyLimit: form.withdrawalDailyLimit ? String(form.withdrawalDailyLimit) : null,
        tradingDailyLimit:    form.tradingDailyLimit ? String(form.tradingDailyLimit) : null,
      },
      features: {
        feeDiscountPercent: String(form.feeDiscountPercent || 0),
        affiliateBonus:     String(form.affiliateBonus || 0),
        apiAccess:          !!form.apiAccess,
        prioritySupport:    !!form.prioritySupport,
        copyTradingEnabled: !!form.copyTradingEnabled,
        customSupport:      !!form.customSupport,
        postPaid:           !!form.postPaid,
        maintenanceFee:     !!form.maintenanceFee,
      },
      postPaidRates: {
        perDevicePerMonth:  String(form.perDevicePerMonth || 0),
        perAccountPerMonth: String(form.perAccountPerMonth || 0),
        minimumMonthlyFee:  String(form.minimumMonthlyFee || 0),
        currency:           (form.postPaidCurrency || 'USD').toUpperCase(),
      },
      highlights: form.highlightsText.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    try {
      if (isNew) {
        await api.post('/subscriptions/admin/plans', payload);
        toast.success('Plan created');
      } else {
        await api.put(`/subscriptions/admin/plans/${plan._id}`, payload);
        toast.success('Plan updated');
      }
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border-dark flex items-center justify-between bg-bg-panel/60">
          <h3 className="text-lg font-extrabold text-text-primary">{isNew ? 'Create Plan' : `Edit ${plan.name}`}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Basics */}
          <Section title="Basic info">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code (unique)" required>
                <input className="input uppercase" value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="GOLD" disabled={!isNew} />
              </Field>
              <Field label="Name" required>
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Gold" />
              </Field>
              <Field label="Description" className="col-span-2">
                <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Power traders. Higher leverage…" />
              </Field>
            </div>
          </Section>

          {/* Pricing */}
          <Section title="Pricing (USD)">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Monthly">
                <input type="number" step="any" className="input" value={form.monthlyPrice} onChange={(e) => set('monthlyPrice', e.target.value)} />
              </Field>
              <Field label="Yearly">
                <input type="number" step="any" className="input" value={form.yearlyPrice} onChange={(e) => set('yearlyPrice', e.target.value)} />
              </Field>
              <Field label="Sort order">
                <input type="number" className="input" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
              </Field>
            </div>
          </Section>

          {/* Limits */}
          <Section title="Limits">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max trading accounts">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="input flex-1"
                    value={form.maxAccountsUnlimited ? '' : form.maxAccounts}
                    onChange={(e) => set('maxAccounts', e.target.value)}
                    disabled={form.maxAccountsUnlimited}
                    placeholder={form.maxAccountsUnlimited ? 'Unlimited' : ''}
                  />
                  <Toggle checked={form.maxAccountsUnlimited} onChange={(v) => set('maxAccountsUnlimited', v)} label="∞" />
                </div>
              </Field>
              <Field label="Max devices login (concurrent)">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="input flex-1"
                    value={form.maxDevicesUnlimited ? '' : form.maxDevices}
                    onChange={(e) => set('maxDevices', e.target.value)}
                    disabled={form.maxDevicesUnlimited}
                    placeholder={form.maxDevicesUnlimited ? 'Unlimited' : ''}
                  />
                  <Toggle checked={form.maxDevicesUnlimited} onChange={(v) => set('maxDevicesUnlimited', v)} label="∞" />
                </div>
              </Field>
              <Field label="Default leverage (1:X)">
                <input type="number" className="input" value={form.defaultLeverage} onChange={(e) => set('defaultLeverage', e.target.value)} />
              </Field>
              <Field label="Withdrawal daily limit (USD)">
                <input type="number" step="any" className="input" value={form.withdrawalDailyLimit} onChange={(e) => set('withdrawalDailyLimit', e.target.value)} placeholder="empty = unlimited" />
              </Field>
              <Field label="Trading daily limit (USD)" className="col-span-2">
                <input type="number" step="any" className="input" value={form.tradingDailyLimit} onChange={(e) => set('tradingDailyLimit', e.target.value)} placeholder="empty = unlimited" />
              </Field>
            </div>
          </Section>

          {/* Features */}
          <Section title="Features">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fee discount % (0.20 = 20%)">
                <input type="number" step="any" className="input" value={form.feeDiscountPercent} onChange={(e) => set('feeDiscountPercent', e.target.value)} />
              </Field>
              <Field label="Affiliate bonus % (0.05 = 5%)">
                <input type="number" step="any" className="input" value={form.affiliateBonus} onChange={(e) => set('affiliateBonus', e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Toggle checked={form.apiAccess}          onChange={(v) => set('apiAccess', v)}          label="API access" />
              <Toggle checked={form.prioritySupport}    onChange={(v) => set('prioritySupport', v)}    label="Priority support" />
              <Toggle checked={form.copyTradingEnabled} onChange={(v) => set('copyTradingEnabled', v)} label="Copy trading" />
              <Toggle checked={form.customSupport}     onChange={(v) => set('customSupport', v)}      label="Dedicated support" />
              <Toggle checked={form.maintenanceFee}     onChange={(v) => set('maintenanceFee', v)}     label="Maintenance fee applies" />
              <Toggle checked={form.postPaid}           onChange={(v) => set('postPaid', v)}           label="Post-paid (usage billed)" />
            </div>
          </Section>

          {/* Post-paid billing rates — only relevant when the post-paid
              feature flag is on. Shown unconditionally so admins can
              configure rates before flipping the flag. */}
          {form.postPaid && (
            <Section title="Post-paid billing rates">
              <div className="grid grid-cols-4 gap-3">
                <Field label="Per device / month">
                  <input type="number" step="any" className="input" value={form.perDevicePerMonth} onChange={(e) => set('perDevicePerMonth', e.target.value)} />
                </Field>
                <Field label="Per account / month">
                  <input type="number" step="any" className="input" value={form.perAccountPerMonth} onChange={(e) => set('perAccountPerMonth', e.target.value)} />
                </Field>
                <Field label="Min monthly fee">
                  <input type="number" step="any" className="input" value={form.minimumMonthlyFee} onChange={(e) => set('minimumMonthlyFee', e.target.value)} />
                </Field>
                <Field label="Currency">
                  <input className="input uppercase" value={form.postPaidCurrency} onChange={(e) => set('postPaidCurrency', e.target.value)} placeholder="USD" />
                </Field>
              </div>
              <p className="text-[11px] text-text-muted mt-2 leading-snug">
                Monthly bill = max(min fee, per-device × devices + per-account × accounts). Usage charges replace the minimum fee only when they exceed it.
              </p>
            </Section>
          )}

          {/* Marketing */}
          <Section title="Marketing">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Badge text">
                <input className="input" value={form.badge} onChange={(e) => set('badge', e.target.value)} placeholder="Best Value" />
              </Field>
              <Field label="Icon / emoji">
                <input className="input" value={form.icon} onChange={(e) => set('icon', e.target.value)} placeholder="👑" />
              </Field>
              <Field label="Accent color (hex)">
                <input className="input" value={form.accentColor} onChange={(e) => set('accentColor', e.target.value)} placeholder="#FCD535" />
              </Field>
            </div>
            <div className="flex items-center gap-4 mt-3">
              <Toggle checked={form.isPopular}     onChange={(v) => set('isPopular', v)}     label="Mark as Popular" />
              <Toggle checked={form.isRecommended} onChange={(v) => set('isRecommended', v)} label="Mark as Recommended" />
              <Toggle checked={form.isActive}      onChange={(v) => set('isActive', v)}      label="Active (visible to users)" />
            </div>
            <Field label="Highlights (one per line)" className="mt-3">
              <textarea
                className="input min-h-[100px]"
                value={form.highlightsText}
                onChange={(e) => set('highlightsText', e.target.value)}
                placeholder={`5 trading accounts\nUp to 1:200 leverage\n20% fee discount`}
              />
            </Field>
          </Section>
        </div>

        <div className="border-t border-border-dark px-6 py-3 flex items-center justify-end gap-2 bg-bg-panel/60">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Saving…' : isNew ? 'Create Plan' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny primitives ───────────────────────────────────────────────
function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${
        accent === 'emerald' ? 'text-emerald-600' : 'text-text-primary'
      }`}>{value}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted mb-2">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children, className = '', required }) {
  return (
    <label className={`block ${className}`}>
      <div className="text-[11px] font-semibold text-text-secondary mb-1">
        {label} {required && <span className="text-bear">*</span>}
      </div>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
      <span
        onClick={() => onChange(!checked)}
        className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${checked ? 'bg-primary-500' : 'bg-border-dark'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </span>
      <span className="text-text-primary">{label}</span>
    </label>
  );
}
