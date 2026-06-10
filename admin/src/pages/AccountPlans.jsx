import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

/**
 * Account Plans management — dynamic CRUD over the AccountPlan
 * collection. Admin creates/edits/disables/reorders trading-account
 * tiers (Standard / IC / Pro / Pro IC / Free / Free IC + any custom
 * tier added later). Analytics strip shows accounts-per-tier.
 */
export default function AccountPlans() {
  const confirm = useConfirm();
  const [plans, setPlans] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // plan object (empty = new) or null
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [p, a] = await Promise.allSettled([
        api.get('/account-plans/admin'),
        api.get('/account-plans/admin/analytics'),
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
    totalAccounts: acc.totalAccounts + (a.totalAccounts || 0),
    activeAccounts: acc.activeAccounts + (a.activeAccounts || 0),
    plans: acc.plans + 1,
  }), { totalAccounts: 0, activeAccounts: 0, plans: 0 });

  const toggleStatus = async (plan) => {
    try {
      await api.patch(`/account-plans/admin/${plan._id}/status`, { isActive: !plan.isActive });
      toast.success(`${plan.name} ${plan.isActive ? 'disabled' : 'enabled'}`);
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const remove = async (plan) => {
    if (!(await confirm(`Delete plan "${plan.name}"? This is permanent.`))) return;
    try {
      await api.delete(`/account-plans/admin/${plan._id}`);
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
      await api.patch('/account-plans/admin/order', { order: order.map((p) => p._id) });
    } catch (e) {
      toast.error(errorMessage(e));
      load();
    }
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Trading Plans"
        title="Account Plans"
        subtitle="Dynamic trading-account tiers: leverage cap, fee model, deposit floor, and buy-only rule per tier. Changes apply instantly across the platform."
        actions={
          <button onClick={() => setEditing({})} className="btn-primary text-sm">
            + New Plan
          </button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Plans" value={stats.plans} />
        <StatCard label="Active Plans" value={plans.filter((p) => p.isActive).length} />
        <StatCard label="Total Accounts" value={stats.totalAccounts} />
        <StatCard label="Active Accounts" value={stats.activeAccounts} accent="emerald" />
      </div>

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

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
                <th className="text-left py-2.5 px-3 w-10"></th>
                <th className="text-left py-2.5 px-3">Plan</th>
                <th className="text-left py-2.5 px-3">Code</th>
                <th className="text-right py-2.5 px-3">Min Deposit</th>
                <th className="text-right py-2.5 px-3">Leverage</th>
                <th className="text-left py-2.5 px-3">Fee</th>
                <th className="text-center py-2.5 px-3">Buy-only</th>
                <th className="text-right py-2.5 px-3">Accounts</th>
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
                        <button onClick={() => move(realIdx, -1)} disabled={realIdx === 0} className="text-text-muted hover:text-primary-500 disabled:opacity-30 disabled:cursor-not-allowed" title="Up">▲</button>
                        <button onClick={() => move(realIdx, 1)} disabled={realIdx === plans.length - 1} className="text-text-muted hover:text-primary-500 disabled:opacity-30 disabled:cursor-not-allowed" title="Down">▼</button>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        {p.icon && <span className="text-lg">{p.icon}</span>}
                        <div>
                          <div className="font-bold text-text-primary flex items-center gap-1.5">
                            {p.name}
                            {p.isPopular && <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-warn/15 text-warn">Popular</span>}
                            {p.isRecommended && <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-600">Recommended</span>}
                          </div>
                          {p.description && <div className="text-[11px] text-text-muted truncate max-w-[280px]">{p.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-text-secondary">{p.code}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums">${p.minDeposit}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums">{p.maxLeverage ? `1:${p.maxLeverage}` : '1:∞'}</td>
                    <td className="py-2 px-3 text-text-secondary text-xs">{p.feeDisplay || `${p.feeKind} ${p.feeValue}`}</td>
                    <td className="py-2 px-3 text-center">{p.buyCloseOnly ? <span className="text-[10px] font-bold text-warn">Yes</span> : <span className="text-text-muted">—</span>}</td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums font-bold">{a.totalAccounts ?? 0}</td>
                    <td className="py-2 px-3 text-center">
                      <button
                        onClick={() => toggleStatus(p)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${p.isActive ? 'bg-emerald-500/15 text-emerald-600' : 'bg-text-muted/15 text-text-muted'}`}
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

// ── Plan create/edit form modal ────────────────────────────────────
function PlanForm({ plan, onClose, onSaved }) {
  const isNew = !plan._id;
  const [form, setForm] = useState({
    code:             plan.code || '',
    name:             plan.name || '',
    description:      plan.description || '',
    minDeposit:       plan.minDeposit ?? 0,
    maxLeverage:      plan.maxLeverage ?? '',
    feeKind:          plan.feeKind || 'PCT_OF_VALUE',
    feeValue:         plan.feeValue ?? 0,
    lossWaive:        !!plan.lossWaive,
    buyCloseOnly:     !!plan.buyCloseOnly,
    feeDisplay:       plan.feeDisplay || '',
    supportLabel:     plan.supportLabel || 'Standard support',
    instrumentsLabel: plan.instrumentsLabel || 'All instruments',
    accessLabel:      plan.accessLabel || '24/7 access',
    isActive:         plan.isActive !== false,
    sortOrder:        plan.sortOrder ?? 0,
    isPopular:        !!plan.isPopular,
    isRecommended:    !!plan.isRecommended,
    badge:            plan.badge || '',
    accentColor:      plan.accentColor || '',
    icon:             plan.icon || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.code || !form.name) {
      toast.error('Code and name required');
      return;
    }
    setSaving(true);
    const payload = {
      ...form,
      code: form.code.toUpperCase().trim(),
      minDeposit:  Number(form.minDeposit) || 0,
      maxLeverage: form.maxLeverage === '' ? null : Number(form.maxLeverage),
      feeValue:    Number(form.feeValue) || 0,
      sortOrder:   Number(form.sortOrder) || 0,
      accentColor: form.accentColor.trim() || null,
      icon:        form.icon.trim() || null,
    };
    try {
      if (isNew) {
        await api.post('/account-plans/admin', payload);
        toast.success('Plan created');
      } else {
        await api.put(`/account-plans/admin/${plan._id}`, payload);
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
          <Section title="Identity">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code (unique)" required>
                <input className="input uppercase" value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="STANDARD" disabled={!isNew} />
              </Field>
              <Field label="Name" required>
                <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Standard" />
              </Field>
              <Field label="Description" className="col-span-2">
                <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section title="Trading Rules">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum deposit (USD)">
                <input type="number" step="any" className="input" value={form.minDeposit} onChange={(e) => set('minDeposit', e.target.value)} />
              </Field>
              <Field label="Max leverage (blank = unlimited)">
                <input type="number" step="1" className="input" value={form.maxLeverage} onChange={(e) => set('maxLeverage', e.target.value)} placeholder="∞" />
              </Field>
            </div>
            <div className="mt-3">
              <Toggle checked={form.buyCloseOnly} onChange={(v) => set('buyCloseOnly', v)} label="Buy &amp; close only (IC tier — sells must reduce an open LONG)" />
            </div>
          </Section>

          <Section title="Fee Model">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind">
                <select className="input" value={form.feeKind} onChange={(e) => set('feeKind', e.target.value)}>
                  <option value="PCT_OF_VALUE">% of trade value</option>
                  <option value="FIXED_PER_TRADE">Fixed per trade</option>
                  <option value="PCT_OF_PROFIT">% of profit</option>
                </select>
              </Field>
              <Field label="Value (decimal — 0.00005 = 0.005%)">
                <input type="number" step="any" className="input" value={form.feeValue} onChange={(e) => set('feeValue', e.target.value)} />
              </Field>
              <Field label="Display label (shown on cards)" className="col-span-2">
                <input className="input" value={form.feeDisplay} onChange={(e) => set('feeDisplay', e.target.value)} placeholder="0.005% of trade value" />
              </Field>
            </div>
            <div className="mt-3">
              <Toggle checked={form.lossWaive} onChange={(v) => set('lossWaive', v)} label="Zero fee on losing trades (FREE tier behaviour)" />
            </div>
          </Section>

          <Section title="Display">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Support label">
                <input className="input" value={form.supportLabel} onChange={(e) => set('supportLabel', e.target.value)} />
              </Field>
              <Field label="Instruments label">
                <input className="input" value={form.instrumentsLabel} onChange={(e) => set('instrumentsLabel', e.target.value)} />
              </Field>
              <Field label="Access label">
                <input className="input" value={form.accessLabel} onChange={(e) => set('accessLabel', e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-3">
              <Field label="Badge ribbon">
                <input className="input" value={form.badge} onChange={(e) => set('badge', e.target.value)} placeholder="Most Popular" />
              </Field>
              <Field label="Icon / emoji">
                <input className="input" value={form.icon} onChange={(e) => set('icon', e.target.value)} placeholder="🚀" />
              </Field>
              <Field label="Accent colour (hex)">
                <input className="input" value={form.accentColor} onChange={(e) => set('accentColor', e.target.value)} placeholder="#1D4ED8" />
              </Field>
            </div>
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              <Toggle checked={form.isActive}      onChange={(v) => set('isActive', v)}      label="Active (visible to users)" />
              <Toggle checked={form.isPopular}     onChange={(v) => set('isPopular', v)}     label="Popular" />
              <Toggle checked={form.isRecommended} onChange={(v) => set('isRecommended', v)} label="Recommended" />
            </div>
            <Field label="Sort order" className="mt-3 max-w-[160px]">
              <input type="number" className="input" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
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

// ── Primitives ─────────────────────────────────────────────────────
function StatCard({ label, value, accent }) {
  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${accent === 'emerald' ? 'text-emerald-600' : 'text-text-primary'}`}>{value}</div>
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
