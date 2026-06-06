import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtMoney, fmtDate } from '../utils/format';

/**
 * Partner / Referral Dashboard — VOLUME-DRIVEN.
 *
 * Partner level + revenue-share % progress on TOTAL REFERRAL TRADING VOLUME
 * (not referral count). Primary data source:
 *
 *   GET /partner/volume-dashboard  — level, volume, tiers, stats, per-referral
 *                                    performance, 6-month series (charts)
 *   GET /partner/commissions       — recent commission ledger (optional)
 *
 * The redesign keeps the existing commission/payout engine untouched — it only
 * changes how progression is computed and presented. Live updates ride the
 * `subscriptionWallet` / `notifications` WS channels.
 */

// ─── Volume-tier visual language (metallic) ──────────────────────────
// Keyed by the tier names the API returns. `from/to` drive the metallic
// badge + card gradient, `accent` the glow/active ring, `text` the on-badge
// foreground. Order matters for the level grid.
const LEVEL_META = {
  BRONZE:   { label: 'Bronze',   from: '#D08B45', to: '#7C3A12', accent: '#F0A357', glow: 'rgba(217,119,6,0.45)',  text: '#3B1A06' },
  SILVER:   { label: 'Silver',   from: '#CBD5E1', to: '#64748B', accent: '#E2E8F0', glow: 'rgba(148,163,184,0.5)', text: '#1F2937' },
  GOLD:     { label: 'Gold',     from: '#FCD34D', to: '#B7791F', accent: '#FDE68A', glow: 'rgba(245,158,11,0.55)', text: '#3B2A06' },
  PLATINUM: { label: 'Platinum', from: '#6EE7DF', to: '#0E7490', accent: '#A5F3EC', glow: 'rgba(45,212,191,0.5)',  text: '#06322F' },
  ELITE:    { label: 'Elite',    from: '#A78BFA', to: '#4338CA', accent: '#C4B5FD', glow: 'rgba(124,58,237,0.55)', text: '#1E1B4B' },
};
const ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'ELITE'];
const metaFor = (name) => LEVEL_META[String(name || '').toUpperCase()] || LEVEL_META.BRONZE;

// ─── Formatters ──────────────────────────────────────────────────────
const usdFull = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const usdCompact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1) + 'K';
  return '$' + Math.round(v).toLocaleString('en-US');
};
function relTime(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
}

// ─── Smooth count-up (animates from prev → next on change) ───────────
function useCountUp(target, { duration = 800 } = {}) {
  const [val, setVal] = useState(Number(target) || 0);
  const fromRef = useRef(Number(target) || 0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) { setVal(to); return undefined; }
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// ═══════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════
export default function Partner() {
  const [d, setD] = useState(null);
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [vd, c] = await Promise.all([
        api.get('/partner/volume-dashboard'),
        api.get('/partner/commissions?limit=8').catch(() => ({ data: { data: [] } })),
      ]);
      setD(vd.data.data);
      setCommissions(c.data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const offW = wsClient.subscribe('subscriptionWallet', () => refresh());
    const offB = wsClient.subscribe('bonusWallet', () => refresh());
    const offN = wsClient.subscribe('notifications', (m) => { if (m?.type === 'PARTNER_BONUS') refresh(); });
    return () => { offW && offW(); offB && offB(); offN && offN(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const PUBLIC_ORIGIN = useMemo(() => {
    const explicit = (import.meta.env.VITE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (explicit) return explicit;
    const apiUrl = String(import.meta.env.VITE_API_URL || '');
    if (/^https?:\/\//i.test(apiUrl)) return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
    return window.location.origin;
  }, []);

  if (loading || !d) return <DashboardSkeleton />;

  const code = d.referralCode || '';
  const link = code ? `${PUBLIC_ORIGIN}/register?ref=${code}` : '';
  const cur = d.walletCurrency || 'USD';

  return (
    <div className="space-y-6 max-w-[1500px] mx-auto pb-10">
      {d.enabled === false && (
        <div className="bg-warn/10 border border-warn/30 text-warn rounded-2xl p-4 text-sm font-semibold">
          The partner program is currently paused by the administrator. New commissions won't be credited.
        </div>
      )}

      {/* ── HERO: level badge + revenue share + volume progress ── */}
      <HeroCard d={d} />

      {/* ── FIRST DEPOSIT REWARD (campaign banner) ── */}
      <FirstDepositRewardCard bonus={d.firstDepositBonus} cur={cur} />

      {/* ── PARTNER LEVELS ── */}
      <LevelsSection d={d} />

      {/* ── STATISTICS ── */}
      <StatsSection d={d} cur={cur} />

      {/* ── CHARTS ── */}
      <ChartsSection series={d.monthlySeries} cur={cur} />

      {/* ── PERFORMANCE + COMMISSION OVERVIEW ── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2">
          <ReferralPerformance rows={d.referralPerformance} cur={cur} />
        </div>
        <div className="space-y-5">
          <CommissionOverview d={d} cur={cur} />
          <RecentCommissions rows={commissions} cur={cur} />
        </div>
      </div>

      {/* ── REFERRAL LINK + QR ── */}
      <ReferralLinkSection code={code} link={link} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FIRST DEPOSIT REWARD — campaign banner (admin-configurable)
// ═══════════════════════════════════════════════════════════════════
function FirstDepositRewardCard({ bonus, cur }) {
  if (!bonus || bonus.enabled === false) return null;
  const amt = Number(bonus.amount) || 0;
  if (amt <= 0) return null;
  const currency = bonus.currency || cur || 'USD';
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-emerald-500/30 shadow-card"
      style={{ background: 'linear-gradient(120deg, rgba(16,185,129,0.12), rgba(5,150,105,0.03))' }}
    >
      <div className="absolute -right-10 -top-12 w-44 h-44 rounded-full blur-3xl opacity-50 pointer-events-none"
           style={{ background: 'rgba(16,185,129,0.28)' }} />
      <div className="relative p-5 flex items-center gap-4">
        <span className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 text-3xl shadow-card keep-white"
              style={{ background: 'linear-gradient(135deg,#34D399,#059669)' }}>🎁</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-extrabold text-text-primary">First Deposit Reward</h3>
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-bull/15 text-bull">Active</span>
          </div>
          <p className="text-sm text-text-secondary mt-0.5">
            Earn <strong className="text-bull">{fmtMoney(amt, currency)}</strong> when your referral makes their first deposit of{' '}
            <strong className="text-text-primary">{fmtMoney(bonus.minDeposit, currency)}</strong> or more.
          </p>
          <p className="text-[11px] text-text-muted mt-1">
            Paid to you automatically, once per referral, on their first qualifying deposit.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HERO
// ═══════════════════════════════════════════════════════════════════
function HeroCard({ d }) {
  const m = metaFor(d.partnerLevel);
  const next = d.nextLevel;
  const vol = useCountUp(d.previousMonthVolume ?? d.totalReferralVolume);
  const pct = useCountUp(d.progressPercent, { duration: 900 });
  const [barReady, setBarReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBarReady(true), 80); return () => clearTimeout(t); }, []);

  return (
    <div
      className="relative overflow-hidden rounded-3xl border border-white/10 shadow-elevated"
      style={{ background: 'linear-gradient(135deg, #0B1220 0%, #111A2E 52%, #1B2740 100%)' }}
    >
      {/* premium glows */}
      <div className="absolute -top-24 -right-16 w-96 h-96 rounded-full pointer-events-none blur-3xl opacity-60"
           style={{ background: `radial-gradient(circle, ${m.glow}, transparent 65%)` }} />
      <div className="absolute -bottom-32 -left-10 w-96 h-96 rounded-full pointer-events-none blur-3xl opacity-40"
           style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 65%)' }} />
      <div className="absolute inset-0 pointer-events-none opacity-[0.06]"
           style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)', backgroundSize: '44px 44px' }} />

      <div className="relative p-6 sm:p-8 grid grid-cols-1 lg:grid-cols-[auto,1fr] gap-7 items-center">
        {/* Left — metallic badge + level */}
        <div className="flex items-center gap-5">
          <MetallicBadge tier={d.partnerLevel} size={104} />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.2em] font-bold keep-white" style={{ color: 'rgba(255,255,255,0.55)' }}>
              Current Tier {d.tierLocked ? '· 🔒 Locked' : ''}
            </div>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="text-3xl sm:text-4xl font-extrabold tracking-tight keep-white" style={{ color: '#fff' }}>
                {m.label}
              </span>
              <span className="text-xs font-bold uppercase tracking-wider keep-white px-2 py-0.5 rounded-md"
                    style={{ color: '#fff', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)' }}>
                Partner
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-extrabold keep-white" style={{ color: m.accent }}>{d.revenueSharePercent}%</span>
              <span className="text-sm keep-white" style={{ color: 'rgba(255,255,255,0.7)' }}>revenue share on referral fees</span>
            </div>
            {next ? (
              <div className="mt-3 inline-flex items-center gap-2 text-xs font-semibold keep-white px-3 py-1.5 rounded-full"
                   style={{ color: '#fff', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}>
                <span style={{ color: metaFor(next.name).accent }}>▲</span>
                Next: <strong>{metaFor(next.name).label}</strong> · {next.percent}% at {usdCompact(next.minVolume)}+
              </div>
            ) : (
              <div className="mt-3 inline-flex items-center gap-2 text-xs font-bold keep-white px-3 py-1.5 rounded-full"
                   style={{ color: '#fff', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}>
                👑 Top tier unlocked — maximum revenue share
              </div>
            )}
          </div>
        </div>

        {/* Right — volume progress */}
        <div className="rounded-2xl p-5 backdrop-blur-xl"
             style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)' }}>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] font-bold keep-white" style={{ color: 'rgba(255,255,255,0.55)' }}>
                Previous Month Volume
              </div>
              <div className="mt-1 text-3xl sm:text-[2.1rem] font-extrabold font-mono tabular-nums keep-white" style={{ color: '#fff' }}>
                {usdFull(vol)}
              </div>
              <div className="mt-1 text-[11px] keep-white" style={{ color: 'rgba(255,255,255,0.6)' }}>
                Determines this month's tier
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-[0.18em] font-bold keep-white" style={{ color: 'rgba(255,255,255,0.55)' }}>
                {next ? `${metaFor(next.name).label} requirement` : 'Tier requirement'}
              </div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums keep-white" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {next ? usdFull(next.minVolume) : 'MAX'}
              </div>
              <div className="mt-1 text-[11px] keep-white" style={{ color: 'rgba(255,255,255,0.6)' }}>
                This month so far: <strong style={{ color: 'rgba(255,255,255,0.85)' }}>{usdFull(d.currentMonthVolume || 0)}</strong>
              </div>
            </div>
          </div>

          {/* animated bar */}
          <div className="mt-4 relative h-3.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.10)' }}>
            <div
              className="h-full rounded-full transition-[width] duration-1000 ease-out relative"
              style={{
                width: `${barReady ? d.progressPercent : 0}%`,
                background: `linear-gradient(90deg, ${m.from}, ${m.accent})`,
                boxShadow: `0 0 16px ${m.glow}`,
              }}
            >
              <div className="absolute inset-0 opacity-40"
                   style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)' }} />
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between text-xs keep-white" style={{ color: 'rgba(255,255,255,0.75)' }}>
            <span className="font-bold" style={{ color: m.accent }}>{pct.toFixed(1)}% complete</span>
            {next ? (
              <span>
                <strong className="keep-white" style={{ color: '#fff' }}>{usdFull(d.volumeToNextLevel)}</strong> more to unlock{' '}
                <strong className="keep-white" style={{ color: metaFor(next.name).accent }}>{metaFor(next.name).label} ({next.percent}%)</strong>
              </span>
            ) : (
              <span>You've reached the highest partner tier.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Metallic badge — gradient disc + shine + tier initial + ring.
function MetallicBadge({ tier, size = 96 }) {
  const m = metaFor(tier);
  const id = `mb-${String(tier)}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full blur-xl opacity-70" style={{ background: m.glow }} />
      <svg width={size} height={size} viewBox="0 0 100 100" className="relative drop-shadow-lg">
        <defs>
          <radialGradient id={`${id}-g`} cx="35%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="28%" stopColor={m.from} />
            <stop offset="100%" stopColor={m.to} />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="46" fill={`url(#${id}-g)`} stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        {/* shine */}
        <ellipse cx="38" cy="30" rx="22" ry="12" fill="rgba(255,255,255,0.35)" />
        <text x="50" y="62" textAnchor="middle" fontSize="34" fontWeight="900" fontFamily="Inter, sans-serif" fill={m.text}>
          {m.label.charAt(0)}
        </text>
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PARTNER LEVELS
// ═══════════════════════════════════════════════════════════════════
function LevelsSection({ d }) {
  const tiers = (d.tiers && d.tiers.length ? d.tiers : ORDER.map((n) => ({ name: n, minVolume: 0, percent: 0 })))
    .slice()
    .sort((a, b) => a.minVolume - b.minVolume);
  const currentIdx = tiers.findIndex((t) => t.name === d.partnerLevel);

  return (
    <section>
      <SectionTitle title="Partner Levels" sub="Your tier is set on the 1st of each month from the PREVIOUS month's referral trading volume, then fixed for the whole month." />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
        {tiers.map((t, i) => (
          <LevelCard key={t.name} tier={t} state={i < currentIdx ? 'cleared' : i === currentIdx ? 'current' : 'locked'} />
        ))}
      </div>
    </section>
  );
}

function LevelCard({ tier, state }) {
  const m = metaFor(tier.name);
  const isCurrent = state === 'current';
  const isLocked = state === 'locked';
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border p-4 transition-all duration-300 ${
        isCurrent ? 'shadow-elevated -translate-y-0.5' : 'hover:-translate-y-1 hover:shadow-card'
      } ${isLocked ? 'opacity-70' : ''}`}
      style={{
        background: isCurrent
          ? `linear-gradient(150deg, ${m.from} 0%, ${m.to} 100%)`
          : '#fff',
        borderColor: isCurrent ? 'transparent' : 'rgb(var(--color-border-dark))',
        ...(isCurrent ? { boxShadow: `0 10px 30px ${m.glow}` } : {}),
      }}
    >
      {!isCurrent && (
        <div className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${m.from}, ${m.to})` }} />
      )}
      <div className="relative flex items-center justify-between">
        <MetallicBadge tier={tier.name} size={isCurrent ? 46 : 40} />
        {isCurrent ? (
          <span className="text-[9px] font-extrabold uppercase tracking-wider px-2 py-1 rounded-full keep-white"
                style={{ color: '#fff', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)' }}>
            Current
          </span>
        ) : isLocked ? (
          <LockIcon />
        ) : (
          <CheckIcon />
        )}
      </div>
      <div className={`mt-3 text-base font-extrabold ${isCurrent ? 'keep-white' : 'text-text-primary'}`} style={isCurrent ? { color: '#fff' } : undefined}>
        {m.label}
      </div>
      <div className={`text-xs font-semibold ${isCurrent ? 'keep-white' : 'text-text-muted'}`} style={isCurrent ? { color: 'rgba(255,255,255,0.85)' } : undefined}>
        {tier.minVolume > 0 ? `${usdCompact(tier.minVolume)}+ volume` : 'Starter tier'}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className={`text-2xl font-extrabold ${isCurrent ? 'keep-white' : ''}`}
              style={isCurrent ? { color: '#fff' } : { color: m.to }}>
          {tier.percent}%
        </span>
        <span className={`text-[11px] font-semibold ${isCurrent ? 'keep-white' : 'text-text-muted'}`} style={isCurrent ? { color: 'rgba(255,255,255,0.8)' } : undefined}>
          rev share
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════
function StatsSection({ d, cur }) {
  const cards = [
    { label: 'Previous Month Volume',    value: usdFull(d.previousMonthVolume), icon: ICONS.volume, tint: 'blue' },
    { label: 'Current Month (tracking)', value: usdFull(d.currentMonthVolume),   icon: ICONS.calendar, tint: 'violet' },
    { label: 'Commission Rate',          value: `${d.revenueSharePercent}%`,     icon: ICONS.coins, tint: 'green' },
    { label: 'Revenue Share Earned',     value: fmtMoney(d.revenueShareEarned ?? d.totalCommissionEarned, cur), icon: ICONS.coins, tint: 'green' },
    { label: 'Total Referrals',          value: String(d.totalReferrals ?? 0),   icon: ICONS.network, tint: 'slate' },
    { label: 'Pending Commission',       value: fmtMoney(d.pendingCommission, cur), icon: ICONS.clock, tint: 'amber' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
      {cards.map((c) => <StatTile key={c.label} {...c} />)}
    </div>
  );
}

const TINTS = {
  green:  { fg: '#16A34A', bg: 'rgba(0,200,83,0.12)' },
  blue:   { fg: '#2563EB', bg: 'rgba(37,99,235,0.12)' },
  violet: { fg: '#7C3AED', bg: 'rgba(124,58,237,0.12)' },
  amber:  { fg: '#D97706', bg: 'rgba(217,119,6,0.12)' },
  slate:  { fg: '#475569', bg: 'rgba(71,85,105,0.12)' },
};

function StatTile({ label, value, icon, tint = 'slate' }) {
  const t = TINTS[tint] || TINTS.slate;
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border-dark bg-white p-4 shadow-card hover:shadow-elevated hover:-translate-y-0.5 transition-all duration-300">
      <div className="absolute -right-6 -top-6 w-20 h-20 rounded-full opacity-0 group-hover:opacity-100 transition-opacity blur-2xl" style={{ background: t.bg }} />
      <div className="relative flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: t.bg, color: t.fg }}>
          {icon}
        </span>
        <span className="text-[11px] uppercase tracking-wider font-bold text-text-muted leading-tight">{label}</span>
      </div>
      <div className="relative mt-3 text-xl font-extrabold font-mono tabular-nums text-text-primary truncate">{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════════════════════════════
function ChartsSection({ series = [], cur }) {
  const safe = series.length ? series : [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <ChartCard title="Trading Volume Growth" sub="Referral notional volume · last 6 months"
                 total={usdFull(safe.reduce((s, p) => s + (p.volume || 0), 0))}>
        <AreaChart data={safe.map((p) => ({ label: p.label, value: p.volume }))} stroke="#2563EB" fill="rgba(37,99,235,0.18)" fmt={usdCompact} />
      </ChartCard>
      <ChartCard title="Commission Earnings" sub="Earned per month · last 6 months"
                 total={fmtMoney(safe.reduce((s, p) => s + (Number(p.commission) || 0), 0), cur)} tint="#16A34A">
        <BarChart data={safe.map((p) => ({ label: p.label, value: Number(p.commission) || 0 }))} color="#16A34A" fmt={(v) => fmtMoney(v, cur)} />
      </ChartCard>
    </div>
  );
}

function ChartCard({ title, sub, total, tint = '#2563EB', children }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-bold text-text-primary">{title}</h3>
          <p className="text-[11px] text-text-muted mt-0.5">{sub}</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Total</div>
          <div className="text-base font-extrabold font-mono tabular-nums" style={{ color: tint }}>{total}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function AreaChart({ data = [], stroke = '#2563EB', fill = 'rgba(37,99,235,0.18)', fmt = (v) => v }) {
  const W = 320, H = 120, P = 6;
  if (!data.length) return <EmptyChart />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const stepX = (W - P * 2) / Math.max(1, data.length - 1);
  const y = (v) => H - P - (v / max) * (H - P * 2 - 14);
  const pts = data.map((d, i) => [P + i * stepX, y(d.value)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 130 }} preserveAspectRatio="none">
        <path d={area} fill={fill} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r="3" fill="#fff" stroke={stroke} strokeWidth="2" />
            <title>{`${data[i].label}: ${fmt(data[i].value)}`}</title>
          </g>
        ))}
      </svg>
      <ChartAxis labels={data.map((d) => d.label)} />
    </div>
  );
}

function BarChart({ data = [], color = '#16A34A', fmt = (v) => v }) {
  if (!data.length) return <EmptyChart />;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div>
      <div className="flex items-end justify-between gap-2" style={{ height: 130 }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group" title={`${d.label}: ${fmt(d.value)}`}>
            <div className="w-full max-w-[34px] rounded-t-md transition-all duration-700 ease-out relative"
                 style={{ height: `${Math.max(2, (d.value / max) * 100)}%`, background: `linear-gradient(180deg, ${color}, ${color}99)` }}>
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-bold text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                {fmt(d.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <ChartAxis labels={data.map((d) => d.label)} />
    </div>
  );
}

function ChartAxis({ labels }) {
  return (
    <div className="flex justify-between mt-2 px-0.5">
      {labels.map((l, i) => <span key={i} className="text-[10px] text-text-muted font-medium">{l}</span>)}
    </div>
  );
}
function EmptyChart() {
  return <div className="h-[150px] flex items-center justify-center text-xs text-text-muted">No data yet — activity will appear here.</div>;
}

// ═══════════════════════════════════════════════════════════════════
// REFERRAL PERFORMANCE
// ═══════════════════════════════════════════════════════════════════
function ReferralPerformance({ rows = [], cur }) {
  const top = rows.slice(0, 10);
  const maxVol = Math.max(...rows.map((r) => r.volume || 0), 1);
  return (
    <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden h-full">
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Referral Performance</h3>
          <p className="text-[11px] text-text-muted mt-0.5">Top traders by trading volume</p>
        </div>
        <span className="text-[11px] font-semibold text-text-muted">{rows.length} referral{rows.length === 1 ? '' : 's'}</span>
      </div>
      {top.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-text-muted">
          No referrals yet — share your link to start earning.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] text-text-muted uppercase tracking-[0.14em] font-bold bg-bg-card">
              <tr>
                <th className="text-left px-5 py-3">Trader</th>
                <th className="text-left px-3 py-3">Trading volume</th>
                <th className="text-right px-3 py-3">Commission</th>
                <th className="text-right px-3 py-3 hidden sm:table-cell">Last activity</th>
                <th className="text-right px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.id} className="border-t border-border-subtle hover:bg-bg-hover transition-colors">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.name} />
                      <div className="min-w-0">
                        <div className="font-semibold text-text-primary truncate max-w-[160px]">{r.name}</div>
                        <div className="text-[10px] text-text-muted font-mono truncate max-w-[160px]">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-mono font-bold text-text-primary tabular-nums">{usdFull(r.volume)}</div>
                    <div className="mt-1 h-1.5 w-28 rounded-full bg-bg-hover overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(r.volume / maxVol) * 100}%`, background: 'linear-gradient(90deg,#3B82F6,#1D4ED8)' }} />
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-mono font-bold text-bull tabular-nums">{fmtMoney(r.commission, cur)}</td>
                  <td className="px-3 py-3 text-right text-xs text-text-secondary hidden sm:table-cell">{relTime(r.lastActivityAt)}</td>
                  <td className="px-5 py-3 text-right">
                    {r.status === 'ACTIVE'
                      ? <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-bull/15 text-bull">Active</span>
                      : <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-bg-hover text-text-muted">Idle</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Avatar({ name }) {
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
  const hue = [...String(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold keep-white"
          style={{ color: '#fff', background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 42%))` }}>
      {initials}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMMISSION OVERVIEW
// ═══════════════════════════════════════════════════════════════════
function CommissionOverview({ d, cur }) {
  const rows = [
    { label: 'Total earned', value: fmtMoney(d.totalCommissionEarned, cur), tint: 'text-bull' },
    { label: 'This month', value: fmtMoney(d.monthlyCommission, cur), tint: 'text-text-primary' },
    { label: 'Paid out', value: fmtMoney(d.paidCommission, cur), tint: 'text-text-primary' },
    { label: 'Pending', value: fmtMoney(d.pendingCommission, cur), tint: 'text-warn' },
  ];
  return (
    <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
        <h3 className="text-sm font-bold text-text-primary">Commission Overview</h3>
        <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-1 rounded-md bg-primary-500/10 text-primary-600">
          {d.revenueSharePercent}% share
        </span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-border-subtle">
        {rows.map((r) => (
          <div key={r.label} className="p-4">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{r.label}</div>
            <div className={`mt-1 text-lg font-extrabold font-mono tabular-nums ${r.tint}`}>{r.value}</div>
          </div>
        ))}
      </div>
      <div className="px-4 py-3 bg-bg-hover/40 border-t border-border-subtle flex items-center justify-between">
        <span className="text-[11px] text-text-muted font-semibold">Available balance</span>
        <span className="text-sm font-extrabold font-mono text-bull">{fmtMoney(d.availableBalance, cur)}</span>
      </div>
    </div>
  );
}

function RecentCommissions({ rows = [], cur }) {
  if (!rows.length) return null;
  const SRC = { DEPOSIT_BONUS: 'First-deposit bonus', TRADE_FEE: 'Revenue share', SPREAD: 'Revenue share', ADJUSTMENT: 'Admin credit' };
  return (
    <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border-subtle">
        <h3 className="text-sm font-bold text-text-primary">Recent commissions</h3>
      </div>
      <div className="divide-y divide-border-subtle">
        {rows.slice(0, 6).map((r) => (
          <div key={r._id} className="px-5 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-primary truncate">{SRC[r.sourceType] || r.sourceType}</div>
              <div className="text-[10px] text-text-muted truncate">{r.refereeName || '—'} · {fmtDate(r.createdAt)}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm font-bold font-mono text-bull">+{fmtMoney(r.amount, r.currency || cur)}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: r.status === 'PAID' ? '#16A34A' : '#3B82F6' }}>{r.status}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// REFERRAL LINK + QR
// ═══════════════════════════════════════════════════════════════════
function ReferralLinkSection({ code, link }) {
  const [copied, setCopied] = useState('');
  const copy = async (text, key, label) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch { toast.error('Copy failed'); }
  };
  const share = async () => {
    if (!link) return;
    if (navigator.share) {
      try { await navigator.share({ title: 'Join me on the platform', text: 'Trade with my referral link', url: link }); return; } catch { /* cancelled */ }
    }
    copy(link, 'link', 'Link copied — paste it anywhere');
  };

  return (
    <section>
      <SectionTitle title="Invite & Earn" sub="Share your link — earn revenue share on every referral's trading volume." />
      <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[1fr,auto]">
          {/* left: code + link + actions */}
          <div className="p-5 sm:p-6 space-y-4 min-w-0">
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Referral code</div>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 px-4 py-3 rounded-xl bg-bg-hover border border-border-dark font-mono text-xl font-extrabold tracking-wider text-text-primary truncate">
                  {code || '—'}
                </code>
                <button onClick={() => copy(code, 'code', 'Code copied')} disabled={!code}
                        className="px-4 py-3 rounded-xl font-bold text-sm text-white shadow-card hover:shadow-elevated active:scale-95 transition-all disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>
                  <span className="keep-white" style={{ color: '#fff' }}>{copied === 'code' ? '✓ Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Referral link</div>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 px-4 py-3 rounded-xl bg-bg-hover border border-border-dark font-mono text-xs text-text-secondary truncate">
                  {link || '—'}
                </code>
                <button onClick={() => copy(link, 'link', 'Link copied')} disabled={!link}
                        className="px-4 py-3 rounded-xl font-bold text-sm border border-border-dark text-text-primary hover:bg-bg-hover active:scale-95 transition-all disabled:opacity-50">
                  {copied === 'link' ? '✓' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={share} disabled={!link}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm text-white shadow-card hover:shadow-elevated active:scale-95 transition-all disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg,#16A34A,#15803D)' }}>
                <span className="keep-white" style={{ color: '#fff' }}>{ICONS.share} Share</span>
              </button>
              <ShareLink href={link && `https://wa.me/?text=${encodeURIComponent('Trade with my referral link: ' + link)}`} label="WhatsApp" />
              <ShareLink href={link && `https://t.me/share/url?url=${encodeURIComponent(link)}`} label="Telegram" />
              <ShareLink href={link && `https://twitter.com/intent/tweet?url=${encodeURIComponent(link)}`} label="X / Twitter" />
            </div>
          </div>

          {/* right: QR */}
          <div className="p-5 sm:p-6 border-t md:border-t-0 md:border-l border-border-subtle flex flex-col items-center justify-center gap-3 bg-bg-hover/30">
            <QRCode value={link} />
            <div className="text-[11px] text-text-muted font-semibold text-center">Scan to open<br />your referral link</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShareLink({ href, label }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
       className="inline-flex items-center px-3.5 py-2.5 rounded-xl font-semibold text-xs border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover hover:border-border-accent active:scale-95 transition-all">
      {label}
    </a>
  );
}

// Dependency-free QR via a render service (the link is public/shareable).
// Falls back to a clean placeholder if the image can't load (offline).
function QRCode({ value }) {
  const [failed, setFailed] = useState(false);
  if (!value) {
    return <div className="w-[160px] h-[160px] rounded-xl border-2 border-dashed border-border-dark flex items-center justify-center text-[11px] text-text-muted text-center p-3">Referral code unavailable</div>;
  }
  if (failed) {
    return (
      <div className="w-[160px] h-[160px] rounded-xl border border-border-dark bg-white flex flex-col items-center justify-center gap-2 p-3 text-center">
        <span className="text-text-muted">{ICONS.qr}</span>
        <span className="text-[10px] text-text-muted">QR unavailable offline — use the link above</span>
      </div>
    );
  }
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=8&qzone=1&color=0F172A&bgcolor=FFFFFF&data=${encodeURIComponent(value)}`;
  return (
    <div className="p-2.5 rounded-2xl bg-white border border-border-dark shadow-card">
      <img src={src} alt="Referral QR code" width={160} height={160} loading="lazy" onError={() => setFailed(true)}
           className="rounded-lg block" style={{ width: 160, height: 160 }} />
    </div>
  );
}

// ─── Shared atoms ────────────────────────────────────────────────────
function SectionTitle({ title, sub }) {
  return (
    <div className="mb-3.5">
      <h2 className="text-lg font-extrabold text-text-primary tracking-tight">{title}</h2>
      {sub && <p className="text-xs text-text-secondary mt-0.5">{sub}</p>}
    </div>
  );
}

const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const CheckIcon = () => (
  <span className="w-5 h-5 rounded-full bg-bull/15 text-bull flex items-center justify-center">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  </span>
);

const I = (paths, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {paths.map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const ICONS = {
  volume:   I(['M3 3v18h18', 'M7 14l3-3 3 3 5-6']),
  calendar: I(['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18']),
  coins:    I(['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']),
  users:    I(['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75']),
  network:  I(['M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M5 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M12 8v4', 'M6.5 16l4-3', 'M17.5 16l-4-3']),
  clock:    I(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2']),
  share:    I(['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'M16 6l-4-4-4 4', 'M12 2v13']),
  qr:       I(['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3z', 'M21 14v7h-4']),
};

// ─── Loading skeleton ────────────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className="space-y-6 max-w-[1500px] mx-auto animate-pulse">
      <div className="h-48 rounded-3xl bg-bg-hover" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3.5">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-32 rounded-2xl bg-bg-hover" />)}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3.5">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-bg-hover" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="h-64 rounded-2xl bg-bg-hover" />
        <div className="h-64 rounded-2xl bg-bg-hover" />
      </div>
    </div>
  );
}
