import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import WalletSidebar from '../components/WalletSidebar';
import LeverageDropdown, { UNLIMITED_LEVERAGE } from '../components/LeverageDropdown';

/**
 * Page 2 of the new-account flow — pick mode (Real/Demo) then fill
 * in details (nickname, base currency, leverage) and submit. Both
 * sections live on one page so the user can see the full configuration
 * at a glance; the Real/Demo card row sits above the form fields.
 */
export default function NewAccountConfigure() {
  const { tierCode } = useParams();
  const navigate = useNavigate();

  const [plan, setPlan] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('REAL');           // 'REAL' | 'DEMO'
  const [nickname, setNickname] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [leverage, setLeverage] = useState(100);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pl, ac] = await Promise.allSettled([
          api.get('/account-plans'),
          api.get('/user/accounts'),
        ]);
        if (cancelled) return;
        if (pl.status === 'fulfilled') {
          const all = pl.value.data.data || [];
          const target = all.find((p) => p.code === tierCode);
          if (!target) {
            toast.error(`Plan "${tierCode}" not found`);
            navigate('/accounts/new', { replace: true });
            return;
          }
          setPlan(target);
          setNickname(target.name);
          // Default leverage: tiers with a cap (e.g. Standard 1:100) start
          // at the cap; uncapped tiers default to Unlimited so the user
          // doesn't have to manually pick it.
          setLeverage(target.maxLeverage != null ? target.maxLeverage : UNLIMITED_LEVERAGE);
        }
        if (ac.status === 'fulfilled') {
          const accs = ac.value.data.data || [];
          setAccounts(accs);
          if (accs.length) {
            const bs = await Promise.allSettled(
              accs.map((a) => api.get('/wallet/balances', { params: { accountId: a._id } }))
            );
            if (cancelled) return;
            const flat = [];
            bs.forEach((r) => { if (r.status === 'fulfilled') flat.push(...(r.value.data?.data || [])); });
            setBalances(flat);
          }
        }
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tierCode, navigate]);

  const totalBalance = useMemo(
    () => balances.reduce((sum, b) => sum + (Number(b.balance) || 0), 0),
    [balances]
  );

  const usage = useMemo(() => {
    const out = {};
    accounts.forEach((a) => { out[a.accountType] = (out[a.accountType] || 0) + 1; });
    return out;
  }, [accounts]);

  // Keep nickname in sync with mode unless user has typed a custom value.
  useEffect(() => {
    if (!plan) return;
    setNickname((curr) => {
      const defaults = [plan.name, `${plan.name} Practice`];
      if (!curr || defaults.includes(curr)) {
        return mode === 'DEMO' ? `${plan.name} Practice` : plan.name;
      }
      return curr;
    });
  }, [mode, plan]);

  // Demo accounts always run at 1:Unlimited leverage — no tier caps apply
  // to practice money. Snap leverage to Unlimited on entering DEMO mode,
  // and restore the tier default on switching back to REAL.
  useEffect(() => {
    if (!plan) return;
    if (mode === 'DEMO') {
      setLeverage(UNLIMITED_LEVERAGE);
    } else {
      setLeverage(plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE);
    }
  }, [mode, plan]);

  const create = async () => {
    if (!plan) return;
    setSubmitting(true);
    try {
      const isDemo = mode === 'DEMO';
      // Default leverage on submit: tier cap if one exists, otherwise
      // Unlimited. Mirrors the on-load default so an untouched form
      // submits with the expected per-tier default.
      const defaultLev = plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE;
      const payload = isDemo
        ? {
            accountType: 'DEMO',
            baseCurrency,
            // Demo is permanently unlimited regardless of FE state.
            leverage: UNLIMITED_LEVERAGE,
            nickname: nickname.trim() || `${plan.name} Practice`,
            initialBalance: 100000,
          }
        : {
            accountType: plan.code,
            baseCurrency,
            leverage: Number(leverage) || defaultLev,
            nickname: nickname.trim() || plan.name,
          };
      await api.post('/user/accounts', payload);
      toast.success(`${isDemo ? 'Demo' : plan.name} account created`);
      navigate('/wallet?view=accounts');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !plan) {
    return (
      <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6">
        <WalletSidebar activeId={null} />
        <main className="col-span-12 lg:col-span-10 xl:col-span-10 min-w-0">
          {loading
            ? <div className="text-text-muted p-6">Loading…</div>
            : <div className="text-text-muted p-6">Plan not found. <Link to="/accounts/new" className="text-primary-500 underline">Pick a tier →</Link></div>}
        </main>
      </div>
    );
  }

  const isDemo = mode === 'DEMO';
  const accent = plan.accentColor
    || (plan.code.startsWith('FREE') ? '#10B981'
      : plan.code.startsWith('PRO')  ? '#1D4ED8'
      : '#1D4ED8');
  const minDep = Number(plan.minDeposit || 0);
  const shortfall = minDep - totalBalance;
  const belowMin = !isDemo && minDep > 0 && totalBalance < minDep;
  const tierCap = isDemo ? null : (plan.maxLeverage || null);

  return (
    <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6">
      <WalletSidebar activeId={null} />

      <main className="col-span-12 lg:col-span-10 xl:col-span-10 space-y-6 min-w-0">
        <PageHero
          eyebrow={`New ${plan.name} Account`}
          title="Account configuration"
          subtitle="Pick a mode and fine-tune the trading rules. You can change leverage later from account settings."
          actions={
            <Link to="/accounts/new" className="btn-ghost text-sm">← Change tier</Link>
          }
        />

        {/* Tier summary chip */}
        <div className="card p-4 flex items-center gap-3" style={{ borderColor: accent }}>
          {plan.icon && <span className="text-2xl">{plan.icon}</span>}
          <div className="flex-1 min-w-0">
            <div className="font-extrabold text-text-primary">{plan.name}</div>
            <div className="text-[11px] text-text-muted">
              Min ${minDep} · {plan.maxLeverage ? `1:${plan.maxLeverage}` : '1:Unlimited'} · Fee {plan.feeDisplay}
              {plan.buyCloseOnly && <span className="ml-2 text-warn font-bold">· Buy-only</span>}
            </div>
          </div>
          {usage[plan.code] > 0 && (
            <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded-full bg-bull/15 text-bull">
              ✓ {usage[plan.code]} active
            </span>
          )}
        </div>

        {/* Section 1 — MODE */}
        <Section title="Account mode" desc="Real funds vs. virtual practice money. Demo accounts skip tier rules and start with $100,000 virtual seed.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ModeCard
              title="Real Account"
              tagline="Live trading"
              body="Trade with deposited funds. Profits and losses settle to your real wallet. Tier rules (leverage cap, fees, restrictions) apply."
              icon="💼"
              accent={accent}
              active={mode === 'REAL'}
              onClick={() => setMode('REAL')}
            />
            <ModeCard
              title="Demo Account"
              tagline="Practice trading"
              body="Virtual funds, no real deposit. Identical trading engine — useful for testing strategies risk-free."
              icon="🎯"
              accent="#10B981"
              active={mode === 'DEMO'}
              onClick={() => setMode('DEMO')}
              badge="No deposit needed"
            />
          </div>
        </Section>

        {/* Section 2 — DETAILS */}
        <Section title="Account details" desc="Nickname helps you spot this account in the picker. Leverage caps out at 1:Unlimited.">
          {belowMin && (
            <div className="rounded-xl bg-warn/10 border border-warn/30 px-4 py-3 text-[12px] flex items-start gap-2 mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-warn shrink-0 mt-0.5">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <div className="font-bold text-warn">Below minimum deposit</div>
                <div className="text-text-secondary mt-0.5">
                  Wallet balance roughly <strong>${totalBalance.toFixed(2)}</strong>. Tier needs ${minDep} — you can still create the account and fund the <strong>${shortfall.toFixed(2)}</strong> later.
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nickname">
              <input
                className="w-full px-3.5 py-2.5 rounded-xl border border-border-dark bg-white text-sm focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 focus:outline-none transition-all"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder={plan.name}
              />
            </Field>
            <Field label="Base currency">
              <select
                className="w-full px-3.5 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 focus:outline-none transition-all"
                value={baseCurrency}
                onChange={(e) => setBaseCurrency(e.target.value)}
              >
                <option>USD</option><option>INR</option><option>EUR</option><option>GBP</option>
              </select>
            </Field>
            <Field label="Leverage" className="sm:col-span-2">
              {isDemo ? (
                // Demo accounts are permanently 1:Unlimited — show a
                // read-only chip instead of the picker.
                <div className="w-full px-3.5 py-2.5 rounded-xl border border-border-dark bg-bg-hover/40 text-sm font-semibold flex items-center justify-between cursor-not-allowed select-none">
                  <span className="text-text-primary">1:Unlimited</span>
                  <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-600 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                    Fixed
                  </span>
                </div>
              ) : (
                <LeverageDropdown value={leverage} onChange={setLeverage} maxLeverage={tierCap} />
              )}
              {isDemo ? (
                <div className="text-[10px] text-text-muted mt-1.5">
                  Demo accounts always run at <strong>1:Unlimited</strong> leverage — no caps on practice money.
                </div>
              ) : tierCap != null && (
                <div className="text-[10px] text-text-muted mt-1.5">
                  This tier caps leverage at <strong>1:{tierCap}</strong> — options above are locked.
                </div>
              )}
            </Field>
          </div>
        </Section>

        {/* Sticky action bar */}
        <div className="sticky bottom-0 -mx-2 px-2 pb-2 sm:relative sm:bottom-auto sm:px-0 sm:pb-0">
          <div className="card p-3 flex items-center justify-end gap-2 backdrop-blur-sm bg-white/90 sm:bg-white">
            <Link to="/accounts/new" className="px-4 py-2 rounded-lg border border-border-dark text-text-primary font-semibold text-sm hover:bg-bg-hover transition-colors">Back</Link>
            <button
              onClick={create}
              disabled={submitting}
              className="keep-white px-5 py-2.5 rounded-lg font-bold text-sm disabled:opacity-50 transition-opacity"
              style={{ background: isDemo ? '#10B981' : accent, color: '#FFFFFF' }}
            >
              {submitting ? 'Creating…' : isDemo ? 'Create Demo Account' : 'Create Real Account'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Local primitives ─────────────────────────────────────────────
function Section({ title, desc, children }) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-base font-extrabold text-text-primary">{title}</h2>
        {desc && <p className="text-[12px] text-text-muted mt-0.5">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

function ModeCard({ title, tagline, body, icon, accent, active, badge, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative text-left p-4 rounded-2xl border-2 bg-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated"
      style={{
        borderColor: active ? accent : '#E5E7EB',
        boxShadow: active ? `0 0 0 3px ${accent}22` : undefined,
      }}
    >
      {badge && (
        <span className="absolute -top-2.5 right-3 text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full text-white shadow" style={{ background: accent }}>
          {badge}
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <span className="text-2xl">{icon}</span>
        <div>
          <div className="text-base font-extrabold text-text-primary">{title}</div>
          <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: accent }}>{tagline}</div>
        </div>
      </div>
      <p className="text-[12px] text-text-secondary mt-3 leading-snug">{body}</p>
      {active && (
        <div className="mt-3 inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider" style={{ color: accent }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          Selected
        </div>
      )}
    </button>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">{label}</div>
      {children}
    </label>
  );
}
