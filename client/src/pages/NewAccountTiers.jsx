import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import WalletSidebar from '../components/WalletSidebar';

/**
 * Page 1 of the new-account flow — premium tier picker styled as
 * grouped list rows (Standard accounts / Professional accounts / etc).
 * Each row is a radio-style selectable card with the spec columns
 * pulled straight from the AccountPlan catalogue.
 */
export default function NewAccountTiers() {
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCode, setSelectedCode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, a] = await Promise.allSettled([
          api.get('/account-plans'),
          api.get('/user/accounts'),
        ]);
        if (cancelled) return;
        if (p.status === 'fulfilled') {
          const list = p.value.data.data || [];
          setPlans(list);
          // Default-select the first plan so the Continue CTA is immediately usable.
          if (list.length && !selectedCode) setSelectedCode(list[0].code);
        }
        if (a.status === 'fulfilled') setAccounts(a.value.data.data || []);
      } catch (e) {
        if (!cancelled) toast.error(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const usage = useMemo(() => {
    const out = {};
    accounts.forEach((a) => { out[a.accountType] = (out[a.accountType] || 0) + 1; });
    return out;
  }, [accounts]);

  // Bucket the catalogue into named sections. Codes outside the canonical
  // 6 (e.g. legacy DEMO) get an "Other" group so they remain visible.
  const groups = useMemo(() => {
    const standard = [];
    const professional = [];
    const free = [];
    const other = [];
    for (const p of plans) {
      if (p.code === 'STANDARD' || p.code === 'STANDARD_IC') standard.push(p);
      else if (p.code === 'PRO' || p.code === 'PRO_IC') professional.push(p);
      else if (p.code === 'FREE' || p.code === 'FREE_IC') free.push(p);
      else other.push(p);
    }
    return [
      { title: 'Standard accounts',    plans: standard },
      { title: 'Professional accounts', plans: professional },
      { title: 'Free accounts',         plans: free },
      ...(other.length ? [{ title: 'Other',     plans: other }] : []),
    ].filter((g) => g.plans.length);
  }, [plans]);

  const continueToConfigure = () => {
    if (!selectedCode) return;
    navigate(`/accounts/new/${encodeURIComponent(selectedCode)}`);
  };

  return (
    <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6">
      <WalletSidebar activeId={null} />

      <main className="col-span-12 lg:col-span-10 xl:col-span-10 space-y-6 min-w-0 pb-24">
        {/* ── Header row ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="flex items-center gap-3">
            <Link
              to="/wallet"
              className="w-9 h-9 rounded-full border border-border-dark flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
              aria-label="Back"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </Link>
            <h1 className="text-3xl font-extrabold tracking-tight text-text-primary">Open account</h1>
          </div>
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="hidden sm:inline-flex items-center gap-1.5 text-sm font-semibold text-primary-600 hover:text-primary-700"
          >
            Contract specifications
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>

        {loading ? (
          <div className="text-text-muted px-2 py-8">Loading account tiers…</div>
        ) : groups.length === 0 ? (
          <div className="card p-12 text-center text-text-muted">No tiers available. Ask an admin to enable some.</div>
        ) : (
          groups.map((g) => (
            <Section
              key={g.title}
              title={g.title}
              plans={g.plans}
              selectedCode={selectedCode}
              setSelectedCode={setSelectedCode}
              usage={usage}
            />
          ))
        )}

        {/* ── Sticky Continue bar ─────────────────────────────── */}
        {!loading && plans.length > 0 && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-[640px]">
            <div className="card flex items-center justify-between gap-3 p-3 shadow-elevated backdrop-blur bg-white/95 border border-border-dark">
              <div className="text-[12px] text-text-muted truncate">
                {selectedCode ? (
                  <>Selected: <span className="font-bold text-text-primary">{plans.find((p) => p.code === selectedCode)?.name || selectedCode}</span></>
                ) : (
                  <>Pick an account type to continue</>
                )}
              </div>
              <button
                onClick={continueToConfigure}
                disabled={!selectedCode}
                className="keep-white px-5 py-2.5 rounded-xl font-bold text-sm bg-primary-600 hover:bg-primary-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: '#FFFFFF' }}
              >
                Continue →
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ── Section: grouped list of TierRows ───────────────────────────── */
//
// Layout uses identical flex widths between the header row and every
// data row so the columns line up cleanly:
//   [radio 20px] [icon 48px] [name+desc flex] [minDep 120px] [maxLev 140px] [commission 220px]
function Section({ title, plans, selectedCode, setSelectedCode, usage }) {
  return (
    <section>
      <h2 className="text-base font-extrabold text-text-primary tracking-tight mb-3 px-1">{title}</h2>
      <div className="card overflow-hidden">
        {/* Column header */}
        <div className="hidden md:flex items-center gap-5 px-5 py-3 border-b border-border-subtle bg-bg-hover/30">
          <span className="w-5 shrink-0" />
          <span className="w-12 shrink-0" />
          <span className="flex-1 min-w-0" />
          <span className="w-[120px] shrink-0 text-[11px] uppercase tracking-wider font-bold text-text-muted">Min deposit</span>
          <span className="w-[140px] shrink-0 text-[11px] uppercase tracking-wider font-bold text-text-muted">Max leverage</span>
          <span className="w-[220px] shrink-0 text-[11px] uppercase tracking-wider font-bold text-text-muted">Commission</span>
        </div>
        <div className="divide-y divide-border-subtle">
          {plans.map((p) => (
            <TierRow
              key={p._id || p.code}
              plan={p}
              selected={selectedCode === p.code}
              onSelect={() => setSelectedCode(p.code)}
              ownedCount={usage[p.code] || 0}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Single tier row ─────────────────────────────────────────────── */
function TierRow({ plan, selected, onSelect, ownedCount }) {
  const accent = plan.accentColor || tintForCode(plan.code);
  const minDep = Number(plan.minDeposit || 0);
  const lev = plan.maxLeverage ? `1:${plan.maxLeverage}` : '1:Unlimited';
  const commission = plan.feeDisplay || '—';
  const initials = (plan.name || plan.code || 'A').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left transition-colors ${
        selected ? 'bg-primary-500/[0.06]' : 'hover:bg-bg-hover'
      }`}
    >
      {/* Desktop / tablet — flex row that mirrors the column header */}
      <div className="hidden md:flex items-center gap-5 px-5 py-4">
        {/* Radio */}
        <span
          className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
            selected ? 'border-primary-600 bg-primary-600' : 'border-border-dark bg-white'
          }`}
        >
          {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
        </span>

        {/* Tier badge */}
        <span
          className="shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center text-base font-extrabold shadow-sm"
          style={{ background: `linear-gradient(135deg, ${accent}22 0%, ${accent}10 100%)`, color: accent }}
        >
          {initials}
        </span>

        {/* Name + description + feature chips (flex grows) */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-extrabold text-text-primary">{plan.name}</span>
            {plan.badge && (
              <span className="keep-white text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: accent, color: '#FFFFFF' }}>
                {plan.badge}
              </span>
            )}
            {ownedCount > 0 && (
              <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">
                ✓ {ownedCount} active
              </span>
            )}
          </div>
          <p className="text-[12px] text-text-muted mt-0.5 leading-snug line-clamp-2">
            {plan.description || '—'}
          </p>
          <FeatureChips plan={plan} />
        </div>

        {/* Fixed-width spec cells aligning with column headers */}
        <div className="w-[120px] shrink-0">
          <Cell value={minDep > 0 ? `${minDep} USD` : 'No min'} />
        </div>
        <div className="w-[140px] shrink-0">
          <Cell value={lev} />
        </div>
        <div className="w-[220px] shrink-0">
          <Cell value={commission} muted wrap />
        </div>
      </div>

      {/* Mobile — stacked layout. No spread, just deposit / leverage / commission. */}
      <div className="md:hidden px-4 py-4">
        <div className="flex items-center gap-3">
          <span
            className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
              selected ? 'border-primary-600 bg-primary-600' : 'border-border-dark bg-white'
            }`}
          >
            {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
          </span>
          <span
            className="shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-extrabold shadow-sm"
            style={{ background: `linear-gradient(135deg, ${accent}22 0%, ${accent}10 100%)`, color: accent }}
          >
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-extrabold text-text-primary">{plan.name}</span>
              {ownedCount > 0 && (
                <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">✓ {ownedCount}</span>
              )}
            </div>
            <p className="text-[11px] text-text-muted mt-0.5 leading-snug line-clamp-2">{plan.description || '—'}</p>
            <FeatureChips plan={plan} compact />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
          <SpecLite label="Min deposit"  value={minDep > 0 ? `${minDep} USD` : 'No min'} />
          <SpecLite label="Max leverage" value={lev} />
          <SpecLite label="Commission"   value={commission} />
        </div>
      </div>
    </button>
  );
}

/* ── Feature chips: Buy/Sell · All instruments · 24/7 · Support ──── */
function FeatureChips({ plan, compact }) {
  const items = [
    plan.buyCloseOnly
      ? { label: 'Buy-close only', tone: 'warn' }
      : { label: 'Buy / Sell · no restrictions', tone: 'bull' },
    { label: plan.instrumentsLabel || 'All instruments' },
    { label: plan.accessLabel      || '24/7 access' },
    { label: plan.supportLabel     || 'Standard support' },
  ];
  return (
    <div className={`mt-2 flex flex-wrap gap-1.5 ${compact ? 'text-[9.5px]' : 'text-[10px]'}`}>
      {items.map((it, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 font-semibold px-1.5 py-0.5 rounded border ${
            it.tone === 'warn'
              ? 'border-warn/30 bg-warn/10 text-warn'
              : it.tone === 'bull'
              ? 'border-bull/30 bg-bull/10 text-bull'
              : 'border-border-subtle bg-bg-hover text-text-secondary'
          }`}
        >
          <span className="w-1 h-1 rounded-full bg-current opacity-60" />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Cell({ value, muted, wrap }) {
  return (
    <span
      className={`text-sm font-semibold tabular-nums ${muted ? 'text-text-secondary' : 'text-text-primary'} ${
        wrap ? 'whitespace-normal leading-snug' : 'truncate'
      }`}
    >
      {value}
    </span>
  );
}

function SpecLite({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="text-[12px] font-semibold text-text-primary leading-snug mt-0.5 break-words">{value}</div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function tintForCode(code) {
  if (!code) return '#64748B';
  if (code.startsWith('FREE')) return '#10B981';
  if (code.startsWith('PRO'))  return '#1D4ED8';
  return '#64748B';
}
