import { useState } from 'react';
import toast from 'react-hot-toast';
import { brokerApi } from '../../services/broker';
import { errorMessage } from '../../services/api';
import { Card } from './brokerUi';

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'];
const PRODUCTS = [
  { v: 'INTRADAY', label: 'Intraday (MIS)' },
  { v: 'DELIVERY', label: 'Delivery (CNC)' },
  { v: 'MARGIN', label: 'Margin' },
  { v: 'MTF', label: 'MTF' },
];
const ORDER_TYPES = [
  { v: 'MARKET', label: 'Market' },
  { v: 'LIMIT', label: 'Limit' },
  { v: 'SL', label: 'Stop-loss (SL)' },
  { v: 'SL_M', label: 'Stop-loss market (SL-M)' },
];

const needsPrice = (t) => t === 'LIMIT' || t === 'SL';
const needsTrigger = (t) => t === 'SL' || t === 'SL_M';

/**
 * Order pad — places an order through the connected broker.
 *
 * The frontend NEVER talks to a broker: this posts to our own `/api/orders`
 * with an optional `broker` field, and the backend's BrokerRouter dispatches
 * to the right adapter. Same form works for every broker.
 */
export default function BrokerOrderPad({ broker, onPlaced }) {
  const [side, setSide] = useState('BUY');
  const [form, setForm] = useState({
    symbol: '', exchange: 'NSE', qty: '', orderType: 'MARKET',
    productType: 'INTRADAY', price: '', triggerPrice: '', validity: 'DAY',
  });
  const [submitting, setSubmitting] = useState(false);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.symbol.trim()) return toast.error('Enter a symbol');
    if (!(Number(form.qty) > 0)) return toast.error('Enter a valid quantity');
    if (needsPrice(form.orderType) && !(Number(form.price) > 0)) return toast.error('This order type needs a price');
    if (needsTrigger(form.orderType) && !(Number(form.triggerPrice) > 0)) return toast.error('This order type needs a trigger price');

    const payload = {
      broker: broker || undefined,
      symbol: form.symbol.trim().toUpperCase(),
      exchange: form.exchange,
      side,
      qty: Number(form.qty),
      orderType: form.orderType,
      productType: form.productType,
      validity: form.validity,
      ...(needsPrice(form.orderType) ? { price: Number(form.price) } : {}),
      ...(needsTrigger(form.orderType) ? { triggerPrice: Number(form.triggerPrice) } : {}),
    };

    setSubmitting(true);
    try {
      const ack = await brokerApi.place(payload);
      toast.success(`${side} ${payload.qty} ${payload.symbol} · ${String(ack.status || 'submitted').replace(/_/g, ' ').toLowerCase()}`);
      set('qty', '');
      onPlaced?.(ack);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-border-dark bg-white text-sm text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition-shadow';
  const labelCls = 'block text-[11px] font-semibold text-text-secondary mb-1';

  return (
    <Card title="Place order" subtitle={broker ? `Routes to your ${broker} account` : 'Routes to your default broker'}>
      <form onSubmit={submit} className="px-4 sm:px-5 py-4 space-y-3.5">
        {/* BUY / SELL toggle */}
        <div className="grid grid-cols-2 gap-2">
          {['BUY', 'SELL'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`py-2 rounded-lg text-sm font-bold transition-colors ${
                side === s
                  ? (s === 'BUY' ? 'bg-bull text-white' : 'bg-bear text-white')
                  : 'bg-bg-card text-text-secondary hover:bg-bg-hover border border-border-subtle'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className={labelCls}>Symbol</label>
            <input className={inputCls} placeholder="RELIANCE" value={form.symbol}
              onChange={(e) => set('symbol', e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className={labelCls}>Exchange</label>
            <select className={inputCls} value={form.exchange} onChange={(e) => set('exchange', e.target.value)}>
              {EXCHANGES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Quantity</label>
            <input className={inputCls} type="number" min="1" step="1" placeholder="0" value={form.qty}
              onChange={(e) => set('qty', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Product</label>
            <select className={inputCls} value={form.productType} onChange={(e) => set('productType', e.target.value)}>
              {PRODUCTS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Order type</label>
            <select className={inputCls} value={form.orderType} onChange={(e) => set('orderType', e.target.value)}>
              {ORDER_TYPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Validity</label>
            <select className={inputCls} value={form.validity} onChange={(e) => set('validity', e.target.value)}>
              <option value="DAY">Day</option>
              <option value="IOC">IOC</option>
            </select>
          </div>
        </div>

        {(needsPrice(form.orderType) || needsTrigger(form.orderType)) && (
          <div className="grid grid-cols-2 gap-2">
            {needsPrice(form.orderType) && (
              <div>
                <label className={labelCls}>Price (₹)</label>
                <input className={inputCls} type="number" min="0" step="0.05" placeholder="0.00" value={form.price}
                  onChange={(e) => set('price', e.target.value)} />
              </div>
            )}
            {needsTrigger(form.orderType) && (
              <div>
                <label className={labelCls}>Trigger price (₹)</label>
                <input className={inputCls} type="number" min="0" step="0.05" placeholder="0.00" value={form.triggerPrice}
                  onChange={(e) => set('triggerPrice', e.target.value)} />
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className={`w-full py-3 rounded-lg text-sm font-bold text-white transition-colors disabled:opacity-60 ${
            side === 'BUY' ? 'bg-bull hover:brightness-95' : 'bg-bear hover:brightness-95'
          }`}
        >
          {submitting ? 'Placing…' : `${side} ${form.symbol || 'order'}`}
        </button>
      </form>
    </Card>
  );
}
