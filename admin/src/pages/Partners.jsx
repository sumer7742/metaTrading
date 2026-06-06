import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

/**
 * Admin · Partners.
 *
 * Two endpoints power this page:
 *   GET /admin/partners            — table of partners + their levels
 *   GET /admin/partners/analytics  — program-wide totals + top earners
 *
 * Admin actions:
 *   PUT  /admin/partners/:id/level — pin / clear tier override
 *   POST /admin/partners/:id/block — exclude from earning commissions
 */
export default function Partners() {
  const [rows, setRows] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [filters, setFilters] = useState({ level: '', blocked: '', search: '' });
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const params = {};
      for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
      const [list, an] = await Promise.all([
        api.get('/admin/partners', { params }),
        api.get('/admin/partners/analytics'),
      ]);
      setRows(list.data.data || []);
      setAnalytics(an.data.data || null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); /* eslint-disable-next-line */ }, []);

  const overrideLevel = async (id, level, locked) => {
    try {
      await api.put(`/admin/partners/${id}/level`, { level, locked });
      toast.success(level ? `Tier pinned to ${level}` : 'Override cleared');
      fetchAll();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const toggleBlock = async (id, blocked) => {
    try {
      await api.post(`/admin/partners/${id}/block`, { blocked });
      toast.success(blocked ? 'Partner blocked' : 'Partner unblocked');
      fetchAll();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Wallet · Money"
        title="Partners"
        subtitle="Tier-based partner program — manage referrers, override levels, block offenders, and watch program liability."
      />

      {analytics && <AnalyticsStrip a={analytics} />}

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <FilterField label="Level" value={filters.level} onChange={(v) => setFilters({ ...filters, level: v })} as="select" options={[['','any'], ['BRONZE','Bronze'], ['SILVER','Silver'], ['GOLD','Gold'], ['PLATINUM','Platinum'], ['ELITE','Elite']]} />
          <FilterField label="Blocked" value={filters.blocked} onChange={(v) => setFilters({ ...filters, blocked: v })} as="select" options={[['','any'], ['true','Yes'], ['false','No']]} />
          <FilterField label="Search" value={filters.search} onChange={(v) => setFilters({ ...filters, search: v })} placeholder="name / email / code" />
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => { setFilters({ level: '', blocked: '', search: '' }); }}
              className="px-3 py-1.5 rounded text-xs font-semibold border border-border-dark text-text-secondary hover:text-white hover:border-border-accent transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={fetchAll}
              className="flex-1 px-4 py-1.5 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 hover:bg-primary-600 transition-colors"
            >
              {loading ? 'Loading…' : 'Apply'}
            </button>
          </div>
        </div>
      </div>

      {/* Top earners */}
      {analytics?.topEarners?.length > 0 && (
        <div className="card p-4">
          <h2 className="text-base font-semibold text-white mb-3">Top earners (lifetime)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            {analytics.topEarners.slice(0, 5).map((e, i) => (
              <div key={e.userId} className="bg-bg-dark border border-border-dark rounded p-3">
                <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold">#{i + 1} · {e.referralCode || e.userId.slice(-6)}</div>
                <div className="text-sm font-bold text-white truncate" title={e.name}>{e.name}</div>
                <div className="mt-1 text-base font-bold font-mono text-bull">${e.total}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold bg-bg-panel">
            <tr>
              <th className="text-left p-3">Partner</th>
              <th className="text-left p-3">Code</th>
              <th className="text-left p-3">Tier</th>
              <th className="text-right p-3">Prev-Mo Volume</th>
              <th className="text-right p-3">Lifetime</th>
              <th className="text-right p-3">Pending</th>
              <th className="text-left p-3">Joined</th>
              <th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className={`table-row ${r.blocked ? 'opacity-60' : ''}`}>
                <td className="p-3">
                  <div className="font-semibold text-text-primary">{r.name}</div>
                  <div className="text-[10px] text-text-muted font-mono">{r.email}</div>
                </td>
                <td className="p-3 text-xs font-mono text-text-secondary">{r.referralCode || '—'}</td>
                <td className="p-3">
                  <LevelBadge level={r.level} locked={r.locked} percent={r.percent} />
                </td>
                <td className="p-3 text-right font-mono text-text-primary">
                  ${Number(r.previousMonthVolume || 0).toLocaleString()}
                  <span className="block text-[10px] text-text-muted">{r.totalReferrals} referral{r.totalReferrals === 1 ? '' : 's'}</span>
                </td>
                <td className="p-3 text-right font-mono text-bull">${r.lifetimeEarnings}</td>
                <td className="p-3 text-right font-mono text-warn">${r.pendingEarnings}</td>
                <td className="p-3 text-xs text-text-secondary font-mono whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                <td className="p-3 text-right">
                  <PartnerActions row={r} onOverride={overrideLevel} onBlock={toggleBlock} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length && (
          <div className="text-center text-text-secondary py-10 text-sm">
            <div className="text-text-muted">No partners yet</div>
            <div className="text-xs text-text-muted mt-1">As users refer signups, they'll appear here.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsStrip({ a }) {
  const chips = [
    { label: 'Partners',              value: a.totalPartners },
    { label: 'Total referrals',       value: a.totalReferrals },
    { label: 'Bonuses paid',          value: `$${a.bonusesPaid}`,   tint: 'text-bull' },
    { label: 'Profit',                value: `$${a.revenueShared}`, tint: 'text-bull' },
    { label: 'Commission liability',  value: `$${a.commissionLiability}`, tint: 'text-warn' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {chips.map((c) => (
        <div key={c.label} className="card p-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{c.label}</div>
          <div className={`mt-1 text-lg font-bold font-mono ${c.tint || 'text-white'}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function LevelBadge({ level, locked, percent }) {
  const tone = TIER_TONE[level] || TIER_TONE.NONE;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase font-bold px-2 py-1 rounded"
      style={{ background: `${tone.bg}30`, color: tone.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone.fg }} />
      {level} · {percent}%{locked && ' 🔒'}
    </span>
  );
}

function PartnerActions({ row, onOverride, onBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-text-secondary hover:text-white px-3 py-1 rounded border border-border-dark hover:border-border-accent transition-colors"
      >
        Manage ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-bg-panel border border-border-dark rounded shadow-lg z-10">
          <div className="px-3 py-2 text-[10px] text-text-muted uppercase tracking-wider font-bold border-b border-border-dark">Lock tier (override monthly calc)</div>
          {['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'ELITE'].map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => { onOverride(row._id, lvl, true); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-xs text-white hover:bg-bg-dark transition-colors"
            >
              Pin to {lvl}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { onOverride(row._id, null, false); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-xs text-text-secondary hover:bg-bg-dark transition-colors border-t border-border-dark"
          >
            Clear override (auto)
          </button>
          <button
            type="button"
            onClick={() => { onBlock(row._id, !row.blocked); setOpen(false); }}
            className={`w-full text-left px-3 py-2 text-xs font-semibold transition-colors border-t border-border-dark ${
              row.blocked ? 'text-bull hover:bg-bull/10' : 'text-bear hover:bg-bear/10'
            }`}
          >
            {row.blocked ? 'Unblock partner' : 'Block partner'}
          </button>
        </div>
      )}
    </div>
  );
}

function FilterField({ label, value, onChange, as = 'input', options = [], placeholder }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1">{label}</label>
      {as === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none"
        >
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none"
        />
      )}
    </div>
  );
}

const TIER_TONE = {
  NONE:     { bg: '#94A3B8', fg: '#94A3B8' },
  BRONZE:   { bg: '#B45309', fg: '#F59E0B' },
  SILVER:   { bg: '#64748B', fg: '#94A3B8' },
  GOLD:     { bg: '#CA8A04', fg: '#FBBF24' },
  PLATINUM: { bg: '#0E7490', fg: '#2DD4BF' },
  ELITE:    { bg: '#4338CA', fg: '#A78BFA' },
  DIAMOND:  { bg: '#0EA5E9', fg: '#38BDF8' },
  BLOCKED:  { bg: '#DC2626', fg: '#F87171' },
};
