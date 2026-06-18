import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum } from '../utils/format';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

// Instrument shape — routing fields (mode, bBookEnabled) are intentionally
// excluded. Routing is now a platform-wide setting; instruments only carry
// symbol/feed/pricing config.
const EMPTY = {
  symbol: '',
  name: '',
  baseCurrency: '',
  quoteCurrency: '',
  category: 'CRYPTO',
  pricePrecision: 2,
  quantityPrecision: 4,
  minOrderSize: '0.001',
  maxOrderSize: '1000000',
  lotSize: '0.001',
  spreadType: 'FIXED',
  spreadValue: '0',
  commissionType: 'PERCENTAGE',
  commissionPerTrade: '0',
  commissionPercent: '0',
  commissionOverrides: [],
  maxLeverage: 999999, // Unlimited by default
  // Fixed-volume lock — when on, every new order on this symbol is forced
  // to `fixedVolumeValue` and the client volume input is read-only.
  fixedVolumeEnabled: false,
  fixedVolumeValue: '0',
  // Optional daily volume caps (lots), separate for BUY and SELL. Off = unlimited.
  dailyVolumeLimitEnabled: false,
  dailyBuyLimit: '',
  dailySellLimit: '',
  lifetimeVolumeLimitEnabled: false,
  lifetimeBuyLimit: '',
  lifetimeSellLimit: '',
  // Per-instrument routing override — mirrors the user-level override.
  // INHERIT = use the global Settings → Routing Mode. An explicit value
  // (INTERNAL_MATCHING / A_BOOK / B_BOOK / HYBRID) wins over the global
  // for THIS symbol.
  routingOverride: 'INHERIT',
  isActive: true,
  // Live price feed. For crypto set provider=BINANCE + feed symbol (e.g. SOLUSDT)
  // → the Binance WS feed streams real bid/ask/depth/candles for this instrument.
  externalProvider: '',
  externalFeedSymbol: '',
};

// ── UTC datetime helpers (admin schedules are entered/displayed in UTC) ──
const isoToInput = (iso) => { try { return new Date(iso).toISOString().slice(0, 16); } catch { return ''; } };
const inputToIso = (v) => {
  if (!v) return null;
  const s = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00.000Z` : v; // treat input as UTC
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const fmtUtc = (d) => {
  try {
    return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
  } catch { return ''; }
};
// Volume (lots) — dynamic precision so big totals stay clean and small
// fractional lots don't collapse to 0.
const fmtVol = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const d = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return n.toFixed(d);
};

// Global lifetime usage indicator for one side (BUY/SELL): Total Limit / Used /
// Remaining / Usage %, a colour-thresholded progress bar and a status badge.
// `limit` comes live from the editor input; `used` = instrument total (all users).
const nLots = (v) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
function LifetimeUsageSide({ label, limit, used, tone }) {
  const accent = tone === 'rose' ? 'text-rose-400' : 'text-emerald-400';
  const u = Number(used) || 0;
  const lim = Number(limit) || 0;

  if (lim <= 0) {
    return (
      <div className="rounded-lg border border-border-dark bg-bg-card p-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className={`text-[11px] font-bold ${accent}`}>{label}</span>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">UNLIMITED</span>
        </div>
        <div className="text-[10px] text-text-muted">Unlimited — Usage Tracking Only</div>
        <div className="text-xs font-mono text-white mt-0.5">Used: {nLots(u)} lots</div>
      </div>
    );
  }

  const remaining = Math.max(0, lim - u);
  const pct = (u / lim) * 100;
  // 0–70 green · 70–90 orange · 90–100 red · 100%+ limit reached
  let badge, badgeCls, barCls;
  if (pct >= 100)      { badge = 'LIMIT REACHED'; badgeCls = 'bg-rose-500/20 text-rose-400 ring-1 ring-rose-500/40'; barCls = 'bg-rose-500'; }
  else if (pct >= 90)  { badge = 'CRITICAL';      badgeCls = 'bg-rose-500/15 text-rose-400';   barCls = 'bg-rose-500'; }
  else if (pct >= 70)  { badge = 'WARNING';       badgeCls = 'bg-amber-500/15 text-amber-400'; barCls = 'bg-amber-500'; }
  else                 { badge = 'NORMAL';        badgeCls = 'bg-emerald-500/15 text-emerald-400'; barCls = 'bg-emerald-500'; }

  return (
    <div className="rounded-lg border border-border-dark bg-bg-card p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-[11px] font-bold ${accent}`}>{label}</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeCls}`}>{badge}</span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px] mb-1.5">
        <div><div className="text-text-muted">Limit</div><div className="font-mono text-white">{nLots(lim)}</div></div>
        <div><div className="text-text-muted">Used</div><div className="font-mono text-white">{nLots(u)}</div></div>
        <div><div className="text-text-muted">Left</div><div className="font-mono text-white">{nLots(remaining)}</div></div>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-bg-hover">
        <div className={`h-full rounded-full ${barCls} transition-all duration-300`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="text-[10px] text-right mt-0.5 font-mono text-text-muted">{pct.toFixed(1)}% used</div>
    </div>
  );
}
const STATUS_TONE = {
  active:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  upcoming: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  expired:  'bg-gray-600/30 text-gray-400 border-gray-600',
  disabled: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

export default function Instruments() {
  const confirm = useConfirm();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [liveVol, setLiveVol] = useState({}); // symbol -> { buy, sell, net }
  const [editing, setEditing] = useState(null);
  const [overridesFor, setOverridesFor] = useState(null);
  // Bulk routing-override selection (keyed by symbol).
  const [selected, setSelected] = useState(() => new Set());
  const [bulkRoute, setBulkRoute] = useState('B_BOOK');
  const [bulkSaving, setBulkSaving] = useState(false);

  const toggleSel = (symbol) => setSelected((s) => { const n = new Set(s); n.has(symbol) ? n.delete(symbol) : n.add(symbol); return n; });
  const applyBulkRouting = async () => {
    setBulkSaving(true);
    try {
      const { data } = await api.post('/instruments/bulk-routing', { symbols: [...selected], routingOverride: bulkRoute });
      toast.success(`Routing → ${bulkRoute} for ${data.data.modified} instrument(s)`);
      setSelected(new Set());
      load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBulkSaving(false); }
  };

  const load = async () => {
    const [inst, lv] = await Promise.allSettled([
      api.get('/instruments'),
      api.get('/admin/instruments/live-volume'),
    ]);
    if (inst.status === 'fulfilled') setItems(inst.value.data.data);
    if (lv.status === 'fulfilled') setLiveVol(lv.value.data.data || {});
  };
  useEffect(() => { load(); }, []);

  const save = async (data) => {
    try {
      if (data._id) {
        await api.put(`/instruments/${data.symbol}`, data);
      } else {
        await api.post('/instruments', data);
      }
      toast.success('Saved');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (symbol) => {
    if (!(await confirm(`Disable ${symbol}?`))) return;
    try {
      await api.delete(`/instruments/${symbol}`);
      toast.success('Disabled');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Search filter — symbol / name / category (case-insensitive).
  const q = search.trim().toLowerCase();
  const filtered = q
    ? items.filter((it) => `${it.symbol || ''} ${it.name || ''} ${it.category || ''}`.toLowerCase().includes(q))
    : items;

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Operations"
        title="Instruments"
        subtitle="Add or edit tradable symbols, configure routing, leverage, spread, and B-book settings per instrument."
        actions={
          <button onClick={() => setEditing({ ...EMPTY })} className="btn-primary text-sm">+ Add Instrument</button>
        }
      />

      {selected.size > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-white">{selected.size} selected</span>
          <span className="text-text-muted text-sm">Set routing →</span>
          <select className="input w-52" value={bulkRoute} onChange={(e) => setBulkRoute(e.target.value)}>
            <option value="INHERIT">INHERIT</option>
            <option value="INTERNAL_MATCHING">INTERNAL_MATCHING</option>
            <option value="A_BOOK">A_BOOK</option>
            <option value="B_BOOK">B_BOOK</option>
            <option value="HYBRID">HYBRID</option>
          </select>
          <button onClick={applyBulkRouting} disabled={bulkSaving} className="btn-primary text-sm">{bulkSaving ? 'Applying…' : `Apply to ${selected.size}`}</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost text-sm">Clear</button>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            className="input pl-9"
            placeholder="Search symbol, name or category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-white" aria-label="Clear search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        <span className="text-text-muted text-xs">{filtered.length} of {items.length}</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="p-3 w-8">
                <input type="checkbox"
                  checked={filtered.length > 0 && filtered.every((it) => selected.has(it.symbol))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((it) => it.symbol)) : new Set())} />
              </th>
              <th className="text-left p-3">Symbol</th>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Category</th>
              <th className="text-right p-3">Last Price</th>
              <th className="text-right p-3">Max Lev</th>
              <th className="text-right p-3">Commission</th>
              <th className="text-right p-3">Daily Buy/Sell Vol</th>
              <th className="text-right p-3">Live Buy</th>
              <th className="text-right p-3">Live Sell</th>
              <th className="text-right p-3" title="A-book buy volume">A Buy</th>
              <th className="text-right p-3" title="A-book sell volume">A Sell</th>
              <th className="text-right p-3" title="B-book buy volume">B Buy</th>
              <th className="text-right p-3" title="B-book sell volume">B Sell</th>
              <th className="text-right p-3">Net (B−S)</th>
              <th className="text-center p-3">Routing</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={17} className="p-8 text-center text-text-muted">No instruments match “{search}”.</td></tr>
            )}
            {filtered.map((it) => {
              const lv = liveVol[it.symbol] || { buy: 0, sell: 0, aBuy: 0, aSell: 0, bBuy: 0, bSell: 0 };
              const netVol = (Number(lv.buy) || 0) - (Number(lv.sell) || 0);
              const routing = it.routingOverride || 'INHERIT';
              const routingTone =
                routing === 'INTERNAL_MATCHING' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
                routing === 'A_BOOK'  ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
                routing === 'B_BOOK'  ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' :
                routing === 'HYBRID'  ? 'bg-violet-500/15 text-violet-400 border-violet-500/30' :
                                        'bg-bg-card text-gray-500 border-border-dark';
              return (
                <tr key={it._id} className="table-row">
                  <td className="p-3"><input type="checkbox" checked={selected.has(it.symbol)} onChange={() => toggleSel(it.symbol)} /></td>
                  <td className="p-3 font-medium">{it.symbol}</td>
                  <td className="p-3 text-gray-400">{it.name}</td>
                  <td className="p-3 text-xs">{it.category}</td>
                  <td className="p-3 text-right font-mono">{fmtNum(it.lastPrice, it.pricePrecision)}</td>
                  <td className="p-3 text-right">
                    {it.leverageOverride ? (
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30" title={`Override until ${fmtUtc(it.leverageOverride.endAt)}`}>
                        ⚠ 1:{it.leverageOverride.leverage}
                      </span>
                    ) : Number(it.maxLeverage) >= 999999 || !it.maxLeverage
                      ? <span className="text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600">Unlimited</span>
                      : `1:${it.maxLeverage}`}
                    {it.fixedVolume?.enabled && (
                      <div className="text-[10px] text-violet-400 mt-0.5" title="Fixed volume active">Vol {it.fixedVolume.value}</div>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {(it.commissionOverrides?.length || 0) > 0 ? (
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30" title={`Overrides: ${it.commissionOverrides.map((o) => `${o.accountType} ${o.commissionType === 'FIXED' ? '$' + o.commissionValue : o.commissionType === 'PCT_OF_PROFIT' ? (Number(o.commissionValue) * 100).toFixed(2) + '% of profit' : (Number(o.commissionValue) * 100).toFixed(3) + '%'}`).join(', ')}`}>
                        {it.commissionOverrides.length} override{it.commissionOverrides.length > 1 ? 's' : ''}
                      </span>
                    ) : (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted border border-border-dark" title="Inherits each account type's own commission">
                        Inherited
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {it.dailyVolumeLimitEnabled ? (
                      <div className="leading-tight text-[11px] font-mono">
                        <div className="text-emerald-400">
                          B: {Number(it.dailyBuyLimit) > 0 ? `${fmtNum(it.dailyBuyLimit, 0)}` : '∞'}
                          <span className="text-gray-500"> (used {fmtNum(it.dailyBuyUsed || 0, 0)})</span>
                        </div>
                        <div className="text-rose-400">
                          S: {Number(it.dailySellLimit) > 0 ? `${fmtNum(it.dailySellLimit, 0)}` : '∞'}
                          <span className="text-gray-500"> (used {fmtNum(it.dailySellUsed || 0, 0)})</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600">Unlimited</span>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono text-emerald-400">{fmtVol(lv.buy)}</td>
                  <td className="p-3 text-right font-mono text-rose-400">{fmtVol(lv.sell)}</td>
                  <td className="p-3 text-right font-mono text-emerald-400/70">{fmtVol(lv.aBuy)}</td>
                  <td className="p-3 text-right font-mono text-rose-400/70">{fmtVol(lv.aSell)}</td>
                  <td className="p-3 text-right font-mono text-emerald-400/70">{fmtVol(lv.bBuy)}</td>
                  <td className="p-3 text-right font-mono text-rose-400/70">{fmtVol(lv.bSell)}</td>
                  <td className={`p-3 text-right font-mono font-semibold ${netVol > 0 ? 'text-emerald-400' : netVol < 0 ? 'text-rose-400' : 'text-gray-400'}`}>
                    {netVol > 0 ? '+' : ''}{fmtVol(netVol)}
                  </td>
                  <td className="p-3 text-center">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${routingTone}`}>
                      {routing}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-1">
                    <button onClick={() => setOverridesFor(it)} className="btn-ghost text-xs text-amber-400">Overrides</button>
                    <button onClick={() => setEditing(it)} className="btn-ghost text-xs">Edit</button>
                    <button onClick={() => remove(it.symbol)} className="btn-ghost text-xs text-bear">Disable</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && <InstrumentEditor data={editing} onSave={save} onClose={() => setEditing(null)} />}
      {overridesFor && <OverridesModal instrument={overridesFor} onClose={() => { setOverridesFor(null); load(); }} />}
    </div>
  );
}

// Human-readable inherited commission for an account plan.
const planFeeText = (p) => {
  if (p?.feeDisplay) return p.feeDisplay;
  const v = Number(p?.feeValue || 0);
  if (p?.feeKind === 'FIXED_PER_TRADE') return `$${v} per trade`;
  if (p?.feeKind === 'PCT_OF_PROFIT') return `${(v * 100).toFixed(2)}% of profit`;
  return `${(v * 100).toFixed(3)}% of trade value`;
};

// Per-account-type commission config. Each account type inherits its own
// commission by default; admin can override it for THIS instrument only.
function CommissionOverrides({ value, onChange }) {
  const [plans, setPlans] = useState(null);
  useEffect(() => {
    api.get('/account-plans/admin')
      .then(({ data }) => setPlans((data.data || []).filter((p) => p.isActive !== false)))
      .catch(() => setPlans([]));
  }, []);
  const ovFor = (code) => value.find((o) => String(o.accountType).toUpperCase() === String(code).toUpperCase());
  const setOverride = (code, patch) => {
    const others = value.filter((o) => String(o.accountType).toUpperCase() !== String(code).toUpperCase());
    const cur = ovFor(code) || { accountType: code, commissionType: 'PERCENTAGE', commissionValue: 0 };
    onChange([...others, { ...cur, ...patch, accountType: code }]);
  };
  const removeOverride = (code) => onChange(value.filter((o) => String(o.accountType).toUpperCase() !== String(code).toUpperCase()));

  return (
    <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
      <div className="text-sm font-semibold text-white mb-1">Commission per Account Type</div>
      <p className="text-[11px] text-text-muted mb-3 leading-snug">
        Every instrument <span className="font-semibold">inherits</span> each account type's own commission. Set an
        <span className="font-semibold"> Override</span> below to change the fee for THIS instrument — it applies to that
        account type only; other account types stay on their default.
      </p>
      {plans === null ? (
        <div className="text-xs text-text-muted">Loading account types…</div>
      ) : !plans.length ? (
        <div className="text-xs text-text-muted">No account types found. Create them under Account Plans.</div>
      ) : (
        <div className="space-y-2">
          {plans.map((p) => {
            const ov = ovFor(p.code);
            const isOverride = !!ov;
            return (
              <div key={p.code} className="rounded-lg border border-border-dark bg-bg-card p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white truncate">{p.name} <span className="text-text-muted font-mono">({p.code})</span></div>
                    <div className="text-[10px] text-text-muted">Inherited: {planFeeText(p)}</div>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] shrink-0">
                    <button type="button" onClick={() => removeOverride(p.code)}
                      className={`px-2 py-1 rounded ${!isOverride ? 'bg-primary-500 text-bg-dark font-bold' : 'bg-bg-hover text-text-secondary'}`}>
                      Use Default
                    </button>
                    <button type="button" onClick={() => { if (!isOverride) setOverride(p.code, {}); }}
                      className={`px-2 py-1 rounded ${isOverride ? 'bg-primary-500 text-bg-dark font-bold' : 'bg-bg-hover text-text-secondary'}`}>
                      Override
                    </button>
                  </div>
                </div>
                {isOverride && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <select className="input !py-1.5 text-xs" value={ov.commissionType} onChange={(e) => setOverride(p.code, { commissionType: e.target.value })}>
                      <option value="PERCENTAGE">Percentage (% of trade value)</option>
                      <option value="FIXED">Fixed (flat per trade)</option>
                      <option value="PCT_OF_PROFIT">Percentage of Profit (% of realized profit)</option>
                    </select>
                    <input className="input !py-1.5 text-xs font-mono" value={ov.commissionValue}
                      onChange={(e) => setOverride(p.code, { commissionValue: e.target.value })}
                      placeholder={ov.commissionType === 'FIXED' ? 'e.g. 5  ($/trade)' : 'e.g. 0.01 = 1%'} />
                    <div className="col-span-2 text-[10px] text-text-muted">
                      {ov.commissionType === 'FIXED'
                        ? 'Flat fee charged per trade for this account type.'
                        : ov.commissionType === 'PCT_OF_PROFIT'
                          ? 'Commission = realized profit × this rate (0.01 = 1%). Charged ONLY on profitable closes — loss / breakeven = 0.'
                          : 'Commission = trade value × this rate (0.0001 = 0.01%).'}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InstrumentEditor({ data, onSave, onClose }) {
  const [form, setForm] = useState(data);
  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const checkbox = (k) => (e) => setForm({ ...form, [k]: e.target.checked });

  // Global executed volume for THIS instrument (all users, all-time) — drives
  // the live usage indicator below the lifetime limit fields.
  const [usedVol, setUsedVol] = useState({ buy: 0, sell: 0 });
  useEffect(() => {
    if (!data?.symbol) return;
    let alive = true;
    const load = () => api.get(`/instruments/${data.symbol}/volume-usage`)
      .then((r) => { if (alive) setUsedVol({ buy: Number(r.data?.data?.lifetime?.buy?.used || 0), sell: Number(r.data?.data?.lifetime?.sell?.used || 0) }); })
      .catch(() => {});
    load();
    const id = setInterval(load, 5000); // refresh live as orders execute
    return () => { alive = false; clearInterval(id); };
  }, [data?.symbol]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{form._id ? 'Edit Instrument' : 'New Instrument'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Normalise the daily volume cap: disabled → 0/unlimited; enabled →
            // numeric lots (empty/invalid coerced to 0 so the Number cast is safe).
            onSave({
              ...form,
              dailyVolumeLimitEnabled: !!form.dailyVolumeLimitEnabled,
              dailyBuyLimit:  form.dailyVolumeLimitEnabled ? (Number(form.dailyBuyLimit) || 0) : 0,
              dailySellLimit: form.dailyVolumeLimitEnabled ? (Number(form.dailySellLimit) || 0) : 0,
              lifetimeVolumeLimitEnabled: !!form.lifetimeVolumeLimitEnabled,
              lifetimeBuyLimit:  form.lifetimeVolumeLimitEnabled ? (Number(form.lifetimeBuyLimit) || 0) : 0,
              lifetimeSellLimit: form.lifetimeVolumeLimitEnabled ? (Number(form.lifetimeSellLimit) || 0) : 0,
              commissionOverrides: (form.commissionOverrides || [])
                .filter((o) => o && o.accountType)
                .map((o) => ({
                  accountType: o.accountType,
                  commissionType: ['FIXED', 'PERCENTAGE', 'PCT_OF_PROFIT'].includes(o.commissionType) ? o.commissionType : 'PERCENTAGE',
                  commissionValue: Number(o.commissionValue) || 0,
                })),
            });
          }}
          className="p-5 grid grid-cols-2 gap-3"
        >
          <div>
            <label className="label">Symbol</label>
            <input className="input font-mono uppercase" value={form.symbol} onChange={update('symbol')} required disabled={!!form._id} />
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" value={form.name} onChange={update('name')} required />
          </div>
          <div>
            <label className="label">Base Currency</label>
            <input className="input" value={form.baseCurrency} onChange={update('baseCurrency')} required />
          </div>
          <div>
            <label className="label">Quote Currency</label>
            <input className="input" value={form.quoteCurrency} onChange={update('quoteCurrency')} required />
          </div>
          <div>
            <label className="label">Category</label>
            <select className="input" value={form.category} onChange={update('category')}>
              <option>CRYPTO</option>
              <option>FOREX</option>
              <option>STOCK</option>
              <option>INDEX</option>
              <option>COMMODITY</option>
            </select>
          </div>
          <div>
            <label className="label">Price Precision</label>
            <input type="number" className="input" value={form.pricePrecision} onChange={update('pricePrecision')} />
          </div>
          <div>
            <label className="label">Quantity Precision</label>
            <input type="number" className="input" value={form.quantityPrecision} onChange={update('quantityPrecision')} />
          </div>
          <div>
            <label className="label">Min Volume (Lot)</label>
            <input className="input font-mono" value={form.minOrderSize} onChange={update('minOrderSize')} placeholder="e.g. 0.01" />
          </div>
          <div>
            <label className="label">Max Volume (Lot)</label>
            <input className="input font-mono" value={form.maxOrderSize} onChange={update('maxOrderSize')} placeholder="e.g. 100" />
          </div>

          <div>
            <label className="label">Spread Type</label>
            <select className="input" value={form.spreadType} onChange={update('spreadType')}>
              <option>FIXED</option>
              <option>PERCENTAGE</option>
            </select>
          </div>
          <div>
            <label className="label">Spread Value</label>
            <input className="input font-mono" value={form.spreadValue} onChange={update('spreadValue')} />
          </div>
          <div className="col-span-2">
            <CommissionOverrides
              value={form.commissionOverrides || []}
              onChange={(arr) => setForm((f) => ({ ...f, commissionOverrides: arr }))}
            />
          </div>
          <div>
            <label className="label">Max Leverage</label>
            {(() => {
              const UNLIMITED = 999999;
              const isUnl = Number(form.maxLeverage) >= UNLIMITED || !form.maxLeverage;
              return (
                <div className="flex items-center gap-2">
                  {isUnl ? (
                    <div className="input flex-1 flex items-center justify-between font-bold text-emerald-500">
                      <span>Unlimited</span>
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, maxLeverage: 100 }))}
                        className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded bg-bg-hover hover:bg-bg-panel text-text-secondary"
                      >
                        Set custom
                      </button>
                    </div>
                  ) : (
                    <input
                      type="number"
                      min="1"
                      max={UNLIMITED}
                      className="input flex-1 font-mono"
                      value={form.maxLeverage}
                      onChange={update('maxLeverage')}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, maxLeverage: isUnl ? 100 : UNLIMITED }))}
                    className={`text-[10px] uppercase tracking-wider font-bold px-2.5 py-2 rounded border transition-colors ${
                      isUnl
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-500'
                        : 'border-border-dark bg-bg-card text-text-secondary hover:border-emerald-500/40 hover:text-emerald-500'
                    }`}
                  >
                    {isUnl ? '✓ Unlimited' : 'Unlimited'}
                  </button>
                </div>
              );
            })()}
            <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
              Default <span className="font-semibold">Unlimited</span> — instrument leverage has the highest priority and overrides account/plan caps.
            </p>
          </div>
          <div>
            <label className="label">Price Feed Provider</label>
            <select className="input" value={form.externalProvider || ''} onChange={update('externalProvider')}>
              <option value="">None (no live feed)</option>
              <option value="BINANCE">BINANCE (crypto — live)</option>
            </select>
            <div className="text-[10px] text-gray-500 mt-1 leading-snug">
              Set <b>BINANCE</b> + the feed symbol below to stream real prices
              (crypto). Picked up by the live feed within ~60s — no restart.
            </div>
          </div>
          <div>
            <label className="label">External Feed Symbol</label>
            <input className="input" value={form.externalFeedSymbol || ''} onChange={update('externalFeedSymbol')} placeholder="e.g. SOLUSDT" />
            <div className="text-[10px] text-gray-500 mt-1 leading-snug">
              The provider's symbol — e.g. <b>SOLUSDT</b> for SOL on Binance.
            </div>
          </div>
          <div>
            <label className="label">Routing Override</label>
            <select
              className="input"
              value={form.routingOverride || 'INHERIT'}
              onChange={update('routingOverride')}
            >
              <option value="INHERIT">INHERIT</option>
              <option value="INTERNAL_MATCHING">INTERNAL_MATCHING</option>
              <option value="A_BOOK">A_BOOK</option>
              <option value="B_BOOK">B_BOOK</option>
              <option value="HYBRID">HYBRID</option>
            </select>
            <div className="text-[10px] text-gray-500 mt-1 leading-snug">
              INHERIT = use global Settings → Routing Mode. An explicit
              value forces THIS symbol regardless of the global setting
              (still subject to per-user override).
            </div>
          </div>
          {/* ── Daily Volume Limit (optional; off = unlimited) ── */}
          <div className="col-span-2 rounded-lg border border-border-dark bg-bg-dark p-3 mt-1">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm font-semibold text-white">Enable Daily Buy/Sell Volume Limit</span>
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={!!form.dailyVolumeLimitEnabled}
                onChange={checkbox('dailyVolumeLimitEnabled')}
              />
            </label>
            {form.dailyVolumeLimitEnabled ? (
              <div className="mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label text-emerald-400">Daily BUY Limit (Lots)</label>
                    <input
                      type="number" min="0" step="any"
                      className="input font-mono"
                      value={form.dailyBuyLimit}
                      onChange={update('dailyBuyLimit')}
                      placeholder="e.g. 100000"
                    />
                  </div>
                  <div>
                    <label className="label text-rose-400">Daily SELL Limit (Lots)</label>
                    <input
                      type="number" min="0" step="any"
                      className="input font-mono"
                      value={form.dailySellLimit}
                      onChange={update('dailySellLimit')}
                      placeholder="e.g. 50000"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
                  Separate platform-wide caps on daily OPENING volume per UTC day (all users): BUY orders capped by the
                  BUY limit, SELL orders by the SELL limit. A side set to <span className="font-semibold">0</span> = unlimited.
                  Orders are rejected once that side's used volume reaches its limit. Closes are never blocked.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-text-muted mt-2">
                <span className="font-semibold text-emerald-500">Unlimited</span> — no daily buy/sell volume restriction on this instrument.
              </p>
            )}
          </div>
          {/* ── Lifetime Volume Limit (per user, all-time; off = unlimited) ── */}
          <div className="col-span-2 rounded-lg border border-border-dark bg-bg-dark p-3 mt-1">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm font-semibold text-white">Enable Lifetime Buy/Sell Volume Limit</span>
              <input
                type="checkbox"
                className="w-4 h-4"
                checked={!!form.lifetimeVolumeLimitEnabled}
                onChange={checkbox('lifetimeVolumeLimitEnabled')}
              />
            </label>
            {form.lifetimeVolumeLimitEnabled ? (
              <div className="mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label text-emerald-400">Lifetime BUY Limit (Lots)</label>
                    <input
                      type="number" min="0" step="any"
                      className="input font-mono"
                      value={form.lifetimeBuyLimit}
                      onChange={update('lifetimeBuyLimit')}
                      placeholder="e.g. 1000000"
                    />
                  </div>
                  <div>
                    <label className="label text-rose-400">Lifetime SELL Limit (Lots)</label>
                    <input
                      type="number" min="0" step="any"
                      className="input font-mono"
                      value={form.lifetimeSellLimit}
                      onChange={update('lifetimeSellLimit')}
                      placeholder="e.g. 1000000"
                    />
                  </div>
                </div>
                {/* Live global usage indicator — limit from the inputs above,
                    used = this instrument's total executed volume (all users). */}
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <LifetimeUsageSide label="BUY" limit={form.lifetimeBuyLimit} used={usedVol.buy} tone="emerald" />
                  <LifetimeUsageSide label="SELL" limit={form.lifetimeSellLimit} used={usedVol.sell} tone="rose" />
                </div>
                <p className="text-[11px] text-text-muted mt-2 leading-snug">
                  Platform-wide caps on total OPENING volume across ALL users, all time: once the instrument's BUY volume
                  reaches the BUY limit, NO user can open more BUYs on this symbol (SELL likewise). A side set to{' '}
                  <span className="font-semibold">0</span> = unlimited (usage still tracked). Closes are never blocked;
                  existing positions are unaffected. Changes apply to future orders only (past volume is never rewritten).
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-text-muted mt-2">
                <span className="font-semibold text-emerald-500">Unlimited</span> — no platform-wide lifetime buy/sell volume restriction.
              </p>
            )}
          </div>

          {/* B-Book / Mode toggles (legacy fields) removed — per-instrument
              routing is now controlled by the Routing Override above.
              The "Active" toggle is removed too; new/edited instruments stay
              active and the table's Disable action handles deactivation. */}
          <div className="col-span-2 flex justify-end space-x-2 pt-3 border-t border-border-dark">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Scheduled overrides (leverage + volume) management ──────────────────
function OverridesModal({ instrument, onClose }) {
  // Leverage-only. Volume is a simple (non-scheduled) Fixed Volume setting on
  // the instrument editor — see the Fixed Volume section there.
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Scheduled Leverage Overrides · <span className="font-mono">{instrument.symbol}</span></h2>
            <p className="text-[11px] text-gray-500 mt-0.5">Times are UTC. Only NEW positions during an active window are affected — open trades are untouched. (Volume is set in the instrument's Fixed Volume section — no schedule.)</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <div className="p-5">
          <OverridePanel kind="leverage" instrument={instrument} />
        </div>
      </div>
    </div>
  );
}

function OverridePanel({ kind, instrument }) {
  const confirm = useConfirm();
  const isLev = kind === 'leverage';
  const base = isLev ? 'leverage-overrides' : 'volume-overrides';
  const field = isLev ? 'leverage' : 'volume';
  const blank = { value: '', startAt: '', endAt: '', reason: '', enabled: true };
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get(`/admin/instruments/${instrument.symbol}/${base}`);
      setRows(data.data.overrides || []);
    } catch (e) { toast.error(errorMessage(e)); setRows([]); }
  };
  useEffect(() => { setRows(null); setForm(blank); setEditingId(null); load(); /* eslint-disable-next-line */ }, [kind]);

  const submit = async (e) => {
    e.preventDefault();
    const startAt = inputToIso(form.startAt);
    const endAt = inputToIso(form.endAt);
    if (!form.value || !startAt || !endAt) return toast.error('Value, start and end are required');
    const payload = { [field]: form.value, startAt, endAt, reason: form.reason, enabled: form.enabled };
    setBusy(true);
    try {
      if (editingId) await api.put(`/admin/${base}/${editingId}`, payload);
      else await api.post(`/admin/instruments/${instrument.symbol}/${base}`, payload);
      toast.success(editingId ? 'Override updated' : 'Override scheduled');
      setForm(blank); setEditingId(null); load();
    } catch (e2) { toast.error(errorMessage(e2)); }
    finally { setBusy(false); }
  };

  const edit = (o) => {
    setForm({ value: String(o[field]), startAt: isoToInput(o.startAt), endAt: isoToInput(o.endAt), reason: o.reason || '', enabled: o.enabled });
    setEditingId(o._id);
  };
  const toggle = async (o) => { try { await api.put(`/admin/${base}/${o._id}`, { enabled: !o.enabled }); load(); } catch (e) { toast.error(errorMessage(e)); } };
  const del = async (o) => { if (!(await confirm('Delete this override?'))) return; try { await api.delete(`/admin/${base}/${o._id}`); load(); } catch (e) { toast.error(errorMessage(e)); } };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3 rounded-lg border border-border-dark bg-bg-dark p-3">
        <div className="col-span-2 text-xs font-semibold text-white">{editingId ? 'Edit override' : 'New override'}</div>
        <div>
          <label className="label">{isLev ? 'Override Leverage (1:N)' : 'Override Volume (Lot)'}</label>
          <input className="input font-mono" type="number" step="any" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder={isLev ? 'e.g. 100' : 'e.g. 0.01'} />
        </div>
        <div>
          <label className="label">Reason</label>
          <input className="input" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. High volatility (CPI)" />
        </div>
        <div>
          <label className="label">Start (UTC)</label>
          <input type="datetime-local" className="input" value={form.startAt} onChange={(e) => setForm((f) => ({ ...f, startAt: e.target.value }))} />
        </div>
        <div>
          <label className="label">End (UTC)</label>
          <input type="datetime-local" className="input" value={form.endAt} onChange={(e) => setForm((f) => ({ ...f, endAt: e.target.value }))} />
        </div>
        <label className="flex items-center text-xs text-gray-300">
          <input type="checkbox" className="mr-2" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          Enabled
        </label>
        <div className="flex justify-end gap-2 items-end">
          {editingId && <button type="button" onClick={() => { setForm(blank); setEditingId(null); }} className="btn-ghost text-xs">Cancel</button>}
          <button type="submit" disabled={busy} className="btn-primary text-xs">{editingId ? 'Update' : 'Schedule'}</button>
        </div>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-2">Status</th>
              <th className="text-right p-2">{isLev ? 'Leverage' : 'Volume'}</th>
              <th className="text-left p-2">Start (UTC)</th>
              <th className="text-left p-2">End (UTC)</th>
              <th className="text-left p-2">Reason</th>
              <th className="text-right p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={6} className="p-4 text-center text-gray-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="p-6 text-center text-gray-500">No {isLev ? 'leverage' : 'volume'} overrides scheduled.</td></tr>
            ) : rows.map((o) => (
              <tr key={o._id} className="border-b border-border-dark/60">
                <td className="p-2"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${STATUS_TONE[o.status] || ''}`}>{o.status}</span></td>
                <td className="p-2 text-right font-mono">{isLev ? `1:${o.leverage}` : o.volume}</td>
                <td className="p-2 text-xs text-gray-400">{fmtUtc(o.startAt)}</td>
                <td className="p-2 text-xs text-gray-400">{fmtUtc(o.endAt)}</td>
                <td className="p-2 text-xs text-gray-400 truncate max-w-[160px]" title={o.reason}>{o.reason || '—'}</td>
                <td className="p-2 text-right space-x-1 whitespace-nowrap">
                  <button onClick={() => toggle(o)} className="btn-ghost text-xs">{o.enabled ? 'Disable' : 'Enable'}</button>
                  <button onClick={() => edit(o)} className="btn-ghost text-xs">Edit</button>
                  <button onClick={() => del(o)} className="btn-ghost text-xs text-bear">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
