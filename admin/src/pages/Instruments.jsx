import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum } from '../utils/format';

const EMPTY = {
  symbol: '',
  name: '',
  baseCurrency: '',
  quoteCurrency: '',
  category: 'CRYPTO',
  mode: 'INTERNAL',
  bBookEnabled: false,
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Instruments</h1>
        <button onClick={() => setEditing({ ...EMPTY })} className="btn-primary">+ Add Instrument</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Symbol</th>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Category</th>
              <th className="text-left p-3">Mode</th>
              <th className="text-left p-3">B-Book</th>
              <th className="text-right p-3">Last Price</th>
              <th className="text-right p-3">Max Lev</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it._id} className="table-row">
                <td className="p-3 font-medium">{it.symbol}</td>
                <td className="p-3 text-gray-400">{it.name}</td>
                <td className="p-3 text-xs">{it.category}</td>
                <td className="p-3 text-xs">{it.mode}</td>
                <td className="p-3 text-xs">{it.bBookEnabled ? <span className="text-yellow-400">ON</span> : <span className="text-gray-500">OFF</span>}</td>
                <td className="p-3 text-right font-mono">{fmtNum(it.lastPrice, it.pricePrecision)}</td>
                <td className="p-3 text-right">1:{it.maxLeverage}</td>
                <td className="p-3 text-right space-x-1">
                  <button onClick={() => setEditing(it)} className="btn-ghost text-xs">Edit</button>
                  <button onClick={() => remove(it.symbol)} className="btn-ghost text-xs text-bear">Disable</button>
                </td>
              </tr>
            ))}
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
            <label className="label">Trading Mode</label>
            <select className="input" value={form.mode} onChange={update('mode')}>
              <option>INTERNAL</option>
              <option>EXTERNAL</option>
              <option>HYBRID</option>
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
          <div className="col-span-2 flex items-center gap-4 mt-2">
            <label className="flex items-center text-sm text-gray-300">
              <input type="checkbox" className="mr-2" checked={!!form.bBookEnabled} onChange={checkbox('bBookEnabled')} />
              B-Book Enabled
            </label>
            <label className="flex items-center text-sm text-gray-300">
              <input type="checkbox" className="mr-2" checked={!!form.isActive} onChange={checkbox('isActive')} />
              Active
            </label>
            {form.mode === 'INTERNAL' && form.bBookEnabled && (
              <span className="text-xs text-bear">⚠ B-Book in INTERNAL mode is unsafe per spec</span>
            )}
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
