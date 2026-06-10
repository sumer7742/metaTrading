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
  maxLeverage: 999999, // Unlimited by default
  // Fixed-volume lock — when on, every new order on this symbol is forced
  // to `fixedVolumeValue` and the client volume input is read-only.
  fixedVolumeEnabled: false,
  fixedVolumeValue: '0',
  // Optional daily volume caps (lots), separate for BUY and SELL. Off = unlimited.
  dailyVolumeLimitEnabled: false,
  dailyBuyLimit: '',
  dailySellLimit: '',
  // Per-instrument routing override — mirrors the user-level override.
  // INHERIT = use the global Settings → Routing Mode. An explicit value
  // (INTERNAL_MATCHING / A_BOOK / B_BOOK / HYBRID) wins over the global
  // for THIS symbol.
  routingOverride: 'INHERIT',
  isActive: true,
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
const STATUS_TONE = {
  active:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  upcoming: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  expired:  'bg-gray-600/30 text-gray-400 border-gray-600',
  disabled: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

export default function Instruments() {
  const confirm = useConfirm();
  const [items, setItems] = useState([]);
  const [liveVol, setLiveVol] = useState({}); // symbol -> { buy, sell, net }
  const [editing, setEditing] = useState(null);
  const [overridesFor, setOverridesFor] = useState(null);

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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Symbol</th>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Category</th>
              <th className="text-right p-3">Last Price</th>
              <th className="text-right p-3">Max Lev</th>
              <th className="text-right p-3">Commission</th>
              <th className="text-right p-3">Daily Buy/Sell Vol</th>
              <th className="text-right p-3">Live Buy</th>
              <th className="text-right p-3">Live Sell</th>
              <th className="text-right p-3">Net (B−S)</th>
              <th className="text-center p-3">Routing</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const lv = liveVol[it.symbol] || { buy: 0, sell: 0 };
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
                    {(it.commissionType || (Number(it.commissionPercent) > 0 ? 'PERCENTAGE' : 'FIXED')) === 'FIXED' ? (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30" title="Fixed commission per trade">
                        ${fmtNum(it.commissionPerTrade || 0, 2)} flat
                      </span>
                    ) : (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30" title="Percentage of trade value">
                        {(Number(it.commissionPercent || 0) * 100).toFixed(3)}%
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

function InstrumentEditor({ data, onSave, onClose }) {
  const [form, setForm] = useState(data);
  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const checkbox = (k) => (e) => setForm({ ...form, [k]: e.target.checked });

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
          <div>
            <label className="label">Commission Type</label>
            <select className="input" value={form.commissionType || 'PERCENTAGE'} onChange={update('commissionType')}>
              <option value="PERCENTAGE">Percentage (% of trade value)</option>
              <option value="FIXED">Fixed (flat per trade)</option>
            </select>
            <div className="text-[10px] text-gray-500 mt-1">Only one method charges — the other is ignored.</div>
          </div>
          <div>
            {form.commissionType === 'FIXED' ? (
              <>
                <label className="label">Commission Per Trade <span className="text-emerald-500 font-bold">· active</span></label>
                <input className="input font-mono" value={form.commissionPerTrade} onChange={update('commissionPerTrade')} placeholder="e.g. 0.10" />
                <div className="text-[10px] text-gray-500 mt-1">Flat fee charged per trade.</div>
              </>
            ) : (
              <>
                <label className="label">Commission % <span className="text-emerald-500 font-bold">· active</span></label>
                <input className="input font-mono" value={form.commissionPercent} onChange={update('commissionPercent')} placeholder="e.g. 0.0005 = 0.05%" />
                <div className="text-[10px] text-gray-500 mt-1">Commission = trade value × this rate.</div>
              </>
            )}
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
            <label className="label">External Feed Symbol</label>
            <input className="input" value={form.externalFeedSymbol || ''} onChange={update('externalFeedSymbol')} placeholder="e.g. BTCUSDT" />
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
