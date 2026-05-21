import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum } from '../utils/format';
import PageHero from '../components/PageHero';

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
  commissionPerTrade: '0',
  commissionPercent: '0',
  maxLeverage: 100,
  // Per-instrument routing override — mirrors the user-level override.
  // INHERIT = use the global Settings → Routing Mode. An explicit
  // value (A_BOOK / B_BOOK / HYBRID) wins over the global for THIS symbol.
  routingOverride: 'INHERIT',
  isActive: true,
};

export default function Instruments() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    const { data } = await api.get('/instruments');
    setItems(data.data);
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
    if (!confirm(`Disable ${symbol}?`)) return;
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
              <th className="text-center p-3">Routing</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const routing = it.routingOverride || 'INHERIT';
              const routingTone =
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
                  <td className="p-3 text-right">1:{it.maxLeverage}</td>
                  <td className="p-3 text-center">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${routingTone}`}>
                      {routing}
                    </span>
                  </td>
                  <td className="p-3 text-right space-x-1">
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
        <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="p-5 grid grid-cols-2 gap-3">
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
            <label className="label">Min Order Size</label>
            <input className="input font-mono" value={form.minOrderSize} onChange={update('minOrderSize')} />
          </div>
          <div>
            <label className="label">Max Order Size</label>
            <input className="input font-mono" value={form.maxOrderSize} onChange={update('maxOrderSize')} />
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
            <label className="label">Commission Per Trade</label>
            <input className="input font-mono" value={form.commissionPerTrade} onChange={update('commissionPerTrade')} />
          </div>
          <div>
            <label className="label">Commission %</label>
            <input className="input font-mono" value={form.commissionPercent} onChange={update('commissionPercent')} />
          </div>
          <div>
            <label className="label">Max Leverage</label>
            <input type="number" className="input" value={form.maxLeverage} onChange={update('maxLeverage')} />
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
          {/* B-Book / Mode toggles (legacy fields) removed — per-instrument
              routing is now controlled by the Routing Override above. */}
          <div className="col-span-2 flex items-center gap-4 mt-2">
            <label className="flex items-center text-sm text-gray-300">
              <input type="checkbox" className="mr-2" checked={!!form.isActive} onChange={checkbox('isActive')} />
              Active
            </label>
          </div>
          <div className="col-span-2 flex justify-end space-x-2 pt-3 border-t border-border-dark">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}
