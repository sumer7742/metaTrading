import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtMoney, fmtNum, fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

/**
 * Partner Dashboard — replaces the older /affiliate page with a tier-based
 * partner program view: level + revenue share %, referral / commission
 * history, level progress, top referees. Reads three endpoints:
 *
 *   GET /partner/dashboard    — cards + tier + stats
 *   GET /partner/referrals    — paginated referee list
 *   GET /partner/commissions  — paginated ledger
 *
 * The page subscribes to `subscriptionWallet` + `notifications` WS so the
 * cards (Today / Pending / Available) update the instant a bonus or
 * revenue-share commission lands.
 */
export default function Partner() {
  const [data, setData] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [tab, setTab] = useState('overview'); // 'overview' | 'referrals' | 'history' | 'tiers'
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    try {
      const [d, r, c] = await Promise.all([
        api.get('/partner/dashboard'),
        api.get('/partner/referrals'),
        api.get('/partner/commissions'),
      ]);
      setData(d.data.data);
      setReferrals(r.data.data || []);
      setCommissions(c.data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Live updates: any subscription wallet change (= a commission landed)
  // refreshes everything. Cheap because the dashboard pull is one round-trip.
  // wsClient.subscribe(channel, cb) returns the unsubscribe function
  // directly — there's no separate .on(). Wire both channels through
  // it and tear down on unmount.
  useEffect(() => {
    const onSubWallet = () => refresh();
    const onNotif = (data) => {
      if (data?.type === 'PARTNER_BONUS') refresh();
    };
    const offW = wsClient.subscribe('subscriptionWallet', onSubWallet);
    const offN = wsClient.subscribe('notifications',      onNotif);
    return () => {
      offW && offW();
      offN && offN();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const PUBLIC_ORIGIN = useMemo(() => {
    const explicit = (import.meta.env.VITE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (explicit) return explicit;
    const apiUrl = String(import.meta.env.VITE_API_URL || '');
    if (/^https?:\/\//i.test(apiUrl)) return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
    return window.location.origin;
  }, []);

  const code = data?.user?.referralCode || '';
  const link = code ? `${PUBLIC_ORIGIN}/register?ref=${code}` : '';

  const copy = async (text, label = 'Copied') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error('Copy failed'); }
  };

  if (loading || !data) {
    return (
      <div className="p-6 text-text-secondary">Loading partner dashboard…</div>
    );
  }

  const { level, stats, settings } = data;
  const enabled = settings?.enabled !== false;

  return (
    <div className="space-y-6 max-w-[1500px]">
      <PageHero
        eyebrow="Partner Program"
        title="Referral & Partner Dashboard"
        subtitle="Earn a one-time bonus when your referrals make their first deposit — plus a lifetime share of the trading revenue they generate."
      />

      {!enabled && (
        <div className="bg-warn/10 border border-warn/30 text-warn rounded-2xl p-4 text-sm font-semibold">
          The partner program is currently paused by the administrator. New bonuses won't be credited.
        </div>
      )}

      {/* Top strip: tier badge + referral code + share link */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <TierBadgeCard level={level} stats={stats} />
        <div className="lg:col-span-2 bg-white border border-border-dark rounded-2xl p-5 space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Your referral code</div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 px-3 py-2.5 rounded-xl bg-bg-hover border border-border-dark font-mono text-lg font-bold text-text-primary truncate">
                {code || '—'}
              </code>
              <button
                onClick={() => copy(code, 'Code copied')}
                disabled={!code}
                className="px-4 py-2.5 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated transition-all disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
              >
                <span className="keep-white" style={{ color: '#FFFFFF' }}>{copied ? '✓ Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Share link</div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 px-3 py-2.5 rounded-xl bg-bg-hover border border-border-dark font-mono text-xs text-text-secondary truncate">
                {link || '—'}
              </code>
              <button
                onClick={() => copy(link, 'Link copied')}
                disabled={!link}
                className="px-3 py-2.5 rounded-xl font-bold text-xs border border-border-dark text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                Copy link
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border-subtle">
            <ProgramFact label="First-deposit bonus" value={`${fmtMoney(settings.bonusAmount, 'USD')}`} sub="instant, one per referee" />
            <ProgramFact label="Minimum deposit" value={`${fmtMoney(settings.minDeposit, 'USD')}`} sub="to activate a referee" />
          </div>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Total referrals"    value={stats.totalReferrals} />
        <StatCard label="Active referrals"   value={stats.activeReferrals} tint="bull" />
        <StatCard label="Lifetime earnings"  value={fmtMoney(stats.lifetimeEarnings, stats.walletCurrency)} mono />
        <StatCard label="Pending commission" value={fmtMoney(stats.pendingCommission, stats.walletCurrency)} mono tint="warn" />
        <StatCard label="Available balance"  value={fmtMoney(stats.availableBalance, stats.walletCurrency)} mono tint="bull" />
        <StatCard label="Today"              value={fmtMoney(stats.todayEarnings, stats.walletCurrency)} mono />
        <StatCard label="This month"         value={fmtMoney(stats.monthlyEarnings, stats.walletCurrency)} mono />
        <StatCard label="Total bonuses"      value={fmtMoney(stats.totalBonus, stats.walletCurrency)} mono />
        <StatCard label="Revenue share"      value={fmtMoney(stats.totalRevenueShare, stats.walletCurrency)} mono />
        <StatCard label="Conversion"         value={`${(stats.conversionRate * 100).toFixed(0)}%`} />
      </div>

      {/* Tabs */}
      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        <div className="flex border-b border-border-dark">
          {[
            { id: 'overview',  label: 'Level progress' },
            { id: 'referrals', label: `Referrals (${referrals.length})` },
            { id: 'history',   label: `Commission history (${commissions.length})` },
            { id: 'tiers',     label: 'Tier breakdown' },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-bold transition-colors ${
                tab === t.id
                  ? 'text-text-primary border-b-2 border-primary-500'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-5">
          {tab === 'overview'  && <LevelProgress level={level} settings={settings} stats={stats} />}
          {tab === 'referrals' && <ReferralsTable rows={referrals} />}
          {tab === 'history'   && <CommissionTable rows={commissions} currency={stats.walletCurrency} />}
          {tab === 'tiers'     && <TiersTable tiers={settings.tiers} currentLevel={level.name} />}
        </div>
      </div>
    </div>
  );
}

// ─── Cards / atoms ────────────────────────────────────────────────────

function TierBadgeCard({ level, stats }) {
  const tone = TIER_TONE[level.name] || TIER_TONE.NONE;
  return (
    <div
      className="rounded-2xl p-5 relative overflow-hidden border"
      style={{
        background: `linear-gradient(135deg, ${tone.bgA} 0%, ${tone.bgB} 100%)`,
        borderColor: tone.border,
      }}
    >
      <div className="absolute inset-0 pointer-events-none opacity-40"
           style={{ background: `radial-gradient(circle at 100% 0%, ${tone.glow}, transparent 55%)` }} />
      <div className="relative">
        <div className="text-[11px] uppercase tracking-wider font-bold text-white/80">Partner level</div>
        <div className="mt-1 text-3xl font-extrabold tracking-tight keep-white" style={{ color: '#FFFFFF' }}>
          {level.name === 'NONE' ? 'No tier yet' : level.name}
        </div>
        <div className="mt-2 text-sm text-white/85 keep-white" style={{ color: '#FFFFFF' }}>
          {level.percent}% revenue share · {level.activeCount} active referral{level.activeCount === 1 ? '' : 's'}
        </div>
        {level.blocked && (
          <div className="mt-2 text-[11px] font-bold uppercase tracking-wider px-2 py-1 inline-block rounded-md bg-white/20 keep-white" style={{ color: '#FFFFFF' }}>
            Blocked — contact support
          </div>
        )}
        {level.locked && !level.blocked && (
          <div className="mt-2 text-[11px] font-bold uppercase tracking-wider px-2 py-1 inline-block rounded-md bg-white/20 keep-white" style={{ color: '#FFFFFF' }}>
            Manual override
          </div>
        )}
        {level.nextTier && !level.locked && (
          <div className="mt-3 text-xs text-white/85 keep-white" style={{ color: '#FFFFFF' }}>
            {level.nextTier.remainingToUpgrade} more active to reach <strong>{level.nextTier.name}</strong> ({level.nextTier.percent}%)
          </div>
        )}
      </div>
    </div>
  );
}

function ProgramFact({ label, value, sub }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="text-base font-bold text-text-primary tabular-nums mt-0.5">{value}</div>
      <div className="text-[10px] text-text-muted">{sub}</div>
    </div>
  );
}

function StatCard({ label, value, tint, mono }) {
  const tintMap = {
    bull: 'text-bull',
    warn: 'text-warn',
    bear: 'text-bear',
  };
  return (
    <div className="bg-white border border-border-dark rounded-2xl p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-lg font-bold ${tintMap[tint] || 'text-text-primary'} ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// ─── Level progress section ──────────────────────────────────────────

function LevelProgress({ level, settings, stats }) {
  if (level.name === 'BLOCKED') {
    return (
      <div className="text-sm text-bear">
        Your partner account is currently blocked. Please contact support.
      </div>
    );
  }
  const tiers = settings.tiers || [];
  const next = level.nextTier;
  const current = tiers.find((t) => t.name === level.name);
  const currentMin = current?.minActive ?? 0;
  const nextMin = next?.minActive ?? Math.max(level.activeCount, 1);
  const pct = nextMin > currentMin
    ? Math.min(100, Math.max(0, ((level.activeCount - currentMin) / (nextMin - currentMin)) * 100))
    : 100;

  return (
    <div className="space-y-5">
      {next ? (
        <div>
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-text-muted">Progress to <span className="text-text-primary">{next.name}</span></span>
            <span className="text-text-secondary">{level.activeCount} / {next.minActive} active</span>
          </div>
          <div className="mt-2 h-3 rounded-full bg-bg-hover overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${TIER_TONE[level.name]?.bgA || '#3B82F6'}, ${TIER_TONE[next.name]?.bgA || '#1D4ED8'})` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-text-muted">
            {next.remainingToUpgrade > 0
              ? `${next.remainingToUpgrade} more active referral${next.remainingToUpgrade === 1 ? '' : 's'} to upgrade to ${next.name} (${next.percent}% revenue share)`
              : 'Eligible for upgrade — refresh in a moment'}
          </div>
        </div>
      ) : (
        <div className="text-sm text-text-secondary">
          You're at the top tier. Every active referral keeps you at <strong>{level.name}</strong> with <strong>{level.percent}%</strong> revenue share.
        </div>
      )}

      <div className="border-t border-border-subtle pt-4">
        <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-3">How earnings stack up</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Mini label="Instant bonuses (referee first deposit)" value={fmtMoney(stats.totalBonus, stats.walletCurrency)} hint="Configurable by admin" />
          <Mini label={`Revenue share (${level.percent}% of fees)`} value={fmtMoney(stats.totalRevenueShare, stats.walletCurrency)} hint="Auto-credited on every trade" />
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, hint }) {
  return (
    <div className="bg-bg-hover rounded-xl p-3 border border-border-subtle">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="mt-1 text-base font-bold text-text-primary font-mono tabular-nums">{value}</div>
      <div className="text-[10px] text-text-muted mt-0.5">{hint}</div>
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────

function ReferralsTable({ rows }) {
  if (!rows.length) {
    return <div className="text-text-secondary text-sm py-6 text-center">No referrals yet. Share your link to invite traders.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold">
          <tr>
            <th className="text-left p-2">Referee</th>
            <th className="text-left p-2">Registered</th>
            <th className="text-left p-2">First deposit</th>
            <th className="text-right p-2">Deposited</th>
            <th className="text-right p-2">You earned</th>
            <th className="text-left p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="table-row">
              <td className="p-2">
                <div className="font-semibold text-text-primary">{r.name}</div>
                <div className="text-[10px] text-text-muted font-mono">{r.email}</div>
              </td>
              <td className="p-2 text-xs text-text-secondary">{fmtDate(r.registeredAt)}</td>
              <td className="p-2 text-xs">
                {r.firstDepositAt
                  ? <span className="text-text-primary">{fmtDate(r.firstDepositAt)}<br /><span className="text-[10px] text-text-muted">{fmtMoney(r.firstDepositAmount, 'USD')}</span></span>
                  : <span className="text-text-muted">—</span>}
              </td>
              <td className="p-2 text-right font-mono text-text-primary">{fmtMoney(r.totalDeposited, 'USD')}</td>
              <td className="p-2 text-right font-mono text-bull">{fmtMoney(r.commissionEarned, 'USD')}</td>
              <td className="p-2">
                {r.isActive
                  ? <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-bull/15 text-bull">Active</span>
                  : <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-bg-hover text-text-muted">Pending</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommissionTable({ rows, currency }) {
  if (!rows.length) {
    return <div className="text-text-secondary text-sm py-6 text-center">No commissions yet — they'll appear here as your referrals deposit and trade.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold">
          <tr>
            <th className="text-left p-2">When</th>
            <th className="text-left p-2">Type</th>
            <th className="text-left p-2">Referee</th>
            <th className="text-right p-2">Amount</th>
            <th className="text-right p-2">Rate</th>
            <th className="text-left p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="table-row">
              <td className="p-2 text-xs text-text-secondary font-mono whitespace-nowrap">{fmtDate(r.createdAt)}</td>
              <td className="p-2 text-xs font-bold">{SRC_LABEL[r.sourceType] || r.sourceType}</td>
              <td className="p-2 text-xs">{r.refereeName || '—'}</td>
              <td className="p-2 text-right font-mono text-bull">+{fmtNum(r.amount, 2)} <span className="text-[10px] text-text-muted">{r.currency || currency}</span></td>
              <td className="p-2 text-right font-mono text-text-secondary">{r.rate ? `${r.rate}%` : '—'}</td>
              <td className="p-2">
                {r.status === 'PAID'
                  ? <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-bull/15 text-bull">Paid</span>
                  : r.status === 'PENDING'
                  ? <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-warn/15 text-warn">Pending</span>
                  : <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-bear/15 text-bear">{r.status}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TiersTable({ tiers, currentLevel }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold">
          <tr>
            <th className="text-left p-2">Tier</th>
            <th className="text-right p-2">Active referrals needed</th>
            <th className="text-right p-2">Revenue share</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => {
            const tone = TIER_TONE[t.name] || TIER_TONE.NONE;
            const isCurrent = t.name === currentLevel;
            return (
              <tr key={t.name} className={`table-row ${isCurrent ? 'bg-primary-500/5' : ''}`}>
                <td className="p-2">
                  <span className="inline-flex items-center gap-2 font-bold">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: tone.bgA }} />
                    {t.name}
                    {isCurrent && <span className="text-[10px] font-bold text-primary-600">CURRENT</span>}
                  </span>
                </td>
                <td className="p-2 text-right font-mono text-text-primary">
                  {t.minActive}{t.maxActive > 0 ? `–${t.maxActive}` : '+'}
                </td>
                <td className="p-2 text-right font-mono font-bold text-bull">{t.percent}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const TIER_TONE = {
  NONE:    { bgA: '#94A3B8', bgB: '#64748B', border: '#94A3B8', glow: 'rgba(148,163,184,0.25)' },
  BRONZE:  { bgA: '#B45309', bgB: '#92400E', border: '#B45309', glow: 'rgba(180,83,9,0.35)' },
  SILVER:  { bgA: '#64748B', bgB: '#475569', border: '#64748B', glow: 'rgba(100,116,139,0.35)' },
  GOLD:    { bgA: '#CA8A04', bgB: '#A16207', border: '#CA8A04', glow: 'rgba(202,138,4,0.35)' },
  DIAMOND: { bgA: '#0EA5E9', bgB: '#0284C7', border: '#0EA5E9', glow: 'rgba(14,165,233,0.4)' },
  BLOCKED: { bgA: '#DC2626', bgB: '#991B1B', border: '#DC2626', glow: 'rgba(220,38,38,0.35)' },
};

const SRC_LABEL = {
  DEPOSIT_BONUS: 'First-deposit bonus',
  TRADE_FEE:     'Revenue share',
  SPREAD:        'Revenue share',
  ADJUSTMENT:    'Admin credit',
};
