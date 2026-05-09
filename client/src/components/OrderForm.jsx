import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

export default function OrderForm({ instrument, account, onPlaced, onPendingPriceChange }) {
  const maxLev = instrument?.maxLeverage || 100;
  const initialLev = Math.min(account?.leverage || 1, maxLev);

  const [side, setSide] = useState('BUY');
  const [type, setType] = useState('LIMIT');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState(instrument?.lastPrice || '');
  const [stopPrice, setStopPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [leverage, setLeverage] = useState(initialLev);
  const [loading, setLoading] = useState(false);

  // When instrument changes (user switches symbol), re-cap leverage so it never
  // exceeds the new instrument's max. Otherwise the form state stays at the old
  // value and the backend rejects with "Leverage exceeds max".
  useEffect(() => {
    setLeverage((curr) => Math.min(curr, instrument?.maxLeverage || 100));
    setPrice(instrument?.lastPrice || '');
    setStopPrice('');
  }, [instrument?._id, instrument?.maxLeverage, instrument?.lastPrice]);

  // Push the live preview price up to parent (so the chart can draw a dashed line
  // at the price the user is about to commit). Cleared on type=MARKET.
  useEffect(() => {
    if (!onPendingPriceChange) return;
    if (type === 'MARKET') {
      onPendingPriceChange(null);
      return;
    }
    const previewPrice = type === 'STOP' ? stopPrice : price;
    onPendingPriceChange(previewPrice ? { side, type, price: previewPrice } : null);
  }, [type, side, price, stopPrice, onPendingPriceChange]);

  const submit = async (e) => {
    e.preventDefault();
    if (!account) return toast.error('No trading account selected');
    if (!quantity || Number(quantity) <= 0) return toast.error('Enter a valid quantity');
    if (type === 'LIMIT' && (!price || Number(price) <= 0)) return toast.error('Enter a valid limit price');
    if (type === 'STOP' && (!stopPrice || Number(stopPrice) <= 0)) return toast.error('Enter a valid stop price');
    setLoading(true);
    try {
      const payload = {
        accountId: account._id,
        symbol: instrument.symbol,
        side,
        type,
        quantity,
        leverage,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      if (type === 'LIMIT') payload.price = price;
      if (type === 'STOP') {
        payload.stopPrice = stopPrice;
        // Optional limit price for STOP-LIMIT; if blank, backend treats as STOP-MARKET on trigger.
        if (price) payload.price = price;
      }
      if (stopLoss) payload.stopLoss = stopLoss;
      if (takeProfit) payload.takeProfit = takeProfit;

      const { data } = await api.post('/trading/orders', payload);
      toast.success(`Order ${data.data.status}`);
      onPlaced?.(data.data);
      setQuantity('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Cost estimate uses whichever price applies to the chosen type:
  //   MARKET → instrument lastPrice, LIMIT → price, STOP → stopPrice (the trigger).
  const refPrice =
    type === 'MARKET' ? Number(instrument?.lastPrice || 0)
    : type === 'STOP' ? Number(stopPrice || 0)
    : Number(price || 0);
  const estimatedCost =
    refPrice && quantity ? (refPrice * Number(quantity)) / Math.max(leverage, 1) : 0;

  return (
    <div className="card p-4">
      <div className="text-sm font-medium text-gray-300 mb-3">Place Order</div>

      {/* Side */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={`py-2 rounded font-semibold text-sm ${
            side === 'BUY' ? 'bg-bull text-white' : 'bg-bg-dark text-gray-400 hover:bg-bg-hover'
          }`}
        >
          BUY / LONG
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={`py-2 rounded font-semibold text-sm ${
            side === 'SELL' ? 'bg-bear text-white' : 'bg-bg-dark text-gray-400 hover:bg-bg-hover'
          }`}
        >
          SELL / SHORT
        </button>
      </div>

      {/* Type tabs */}
      <div className="flex space-x-1 mb-3 border-b border-border-dark">
        {['MARKET', 'LIMIT', 'STOP'].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setType(t);
              // STOP type auto-fills stopPrice with last traded price as a sensible default
              if (t === 'STOP' && !stopPrice && instrument?.lastPrice) setStopPrice(instrument.lastPrice);
              if (t === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
            }}
            className={`text-xs px-3 py-2 ${
              type === t ? 'text-white border-b-2 border-primary-500' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {type === 'STOP' && (
          <div>
            <label className="label">Stop Price (trigger)</label>
            <input
              type="number"
              step="any"
              className="input font-mono"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              placeholder={instrument?.lastPrice ? `e.g. ${instrument.lastPrice}` : ''}
              required
            />
          </div>
        )}
        {type === 'LIMIT' && (
          <div>
            <label className="label">Limit Price</label>
            <input
              type="number"
              step="any"
              className="input font-mono"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </div>
        )}
        {type === 'STOP' && (
          <div>
            <label className="label">Limit Price <span className="text-gray-500">(optional — blank = market on trigger)</span></label>
            <input
              type="number"
              step="any"
              className="input font-mono"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Leave blank for STOP-MARKET"
            />
          </div>
        )}
        <div>
          <label className="label">Quantity ({instrument?.baseCurrency})</label>
          <input
            type="number"
            step="any"
            className="input font-mono"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder={`min ${instrument?.minOrderSize}`}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Stop Loss</label>
            <input
              type="number"
              step="any"
              className="input font-mono"
              value={stopLoss}
              onChange={(e) => setStopLoss(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="label">Take Profit</label>
            <input
              type="number"
              step="any"
              className="input font-mono"
              value={takeProfit}
              onChange={(e) => setTakeProfit(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <div>
          <label className="label">Leverage: 1:{leverage}</label>
          <input
            type="range"
            min={1}
            max={instrument?.maxLeverage || 100}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-primary-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1x</span>
            <span>{instrument?.maxLeverage || 100}x</span>
          </div>
        </div>
        <div className="text-xs text-gray-400 bg-bg-dark p-2 rounded">
          <div className="flex justify-between">
            <span>Required Margin:</span>
            <span className="font-mono text-gray-200">
              {account?.baseCurrency === 'INR' ? '₹' : (account?.baseCurrency === 'USD' ? '$' : (account?.baseCurrency + ' '))}
              {Number(estimatedCost).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className={`w-full py-2.5 rounded font-semibold text-sm ${
            side === 'BUY' ? 'bg-bull hover:bg-emerald-600' : 'bg-bear hover:bg-red-600'
          } text-white disabled:opacity-50`}
        >
          {loading ? 'Placing...' : `${side} ${instrument?.symbol || ''}`}
        </button>
      </form>
    </div>
  );
}
