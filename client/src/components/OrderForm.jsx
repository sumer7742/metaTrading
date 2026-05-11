import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtPriceDual, fmtMoneyDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

export default function OrderForm({ instrument, account, onPlaced, onPendingPriceChange }) {
  const maxLev = instrument?.maxLeverage || 100;
  const initialLev = Math.min(account?.leverage || 1, maxLev);
  const fxRate = useFxRate();

  const [side, setSide] = useState('BUY');
  // The order panel only exposes MARKET and LIMIT to the user. The backend
  // auto-resolves a "LIMIT" mode order to either LIMIT or STOP depending
  // on the price's relationship to the current bid/ask. STOP-tab is gone.
  const [orderMode, setOrderMode] = useState('LIMIT');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState(instrument?.lastPrice || '');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [leverage, setLeverage] = useState(initialLev);
  const [loading, setLoading] = useState(false);
  const [accountFree, setAccountFree] = useState(null);

  useEffect(() => {
    setLeverage((curr) => Math.min(curr, instrument?.maxLeverage || 100));
    setPrice(instrument?.lastPrice || '');
  }, [instrument?._id, instrument?.maxLeverage, instrument?.lastPrice]);

  // Fetch free balance for the selected account so we can show an
  // "Available" line and compute % presets accurately.
  useEffect(() => {
    if (!account?._id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/wallet/balances', {
          params: { accountId: account._id },
        });
        if (cancelled) return;
        const w = (data.data || []).find((b) => b.currency === account.baseCurrency);
        setAccountFree(w?.free || '0');
      } catch (_) { /* keep prior value */ }
    })();
    return () => { cancelled = true; };
  }, [account?._id, account?.baseCurrency]);

  // Push the live preview price up to parent so the chart can draw a
  // dashed line where the order would sit. Cleared on MARKET mode.
  useEffect(() => {
    if (!onPendingPriceChange) return;
    if (orderMode === 'MARKET') {
      onPendingPriceChange(null);
      return;
    }
    onPendingPriceChange(price ? { side, type: 'LIMIT', price } : null);
  }, [orderMode, side, price, onPendingPriceChange]);

  const submit = async (e) => {
    e.preventDefault();
    if (!account) return toast.error('No trading account selected');
    if (!quantity || Number(quantity) <= 0) return toast.error('Enter a valid quantity');
    if (orderMode === 'LIMIT') {
      if (!price || Number(price) <= 0) return toast.error('Enter a valid limit price');
      if (limitInvalidReason) return toast.error(limitInvalidReason);
    }
    setLoading(true);
    try {
      const payload = {
        accountId: account._id,
        symbol: instrument.symbol,
        side,
        // Backend auto-resolves orderMode='LIMIT' into LIMIT or STOP based
        // on side + price vs current bid/ask. The user only ever sees
        // MARKET / LIMIT in the UI.
        orderMode,
        quantity,
        leverage,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      if (orderMode === 'LIMIT') payload.price = price;
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

  // Cost estimate. Notional = qty × ref price (full position size);
  // margin = notional ÷ leverage (the actual locked amount).
  const refPrice =
    orderMode === 'MARKET'
      ? Number(instrument?.lastPrice || 0)
      : Number(price || 0);

  const qtyNum = Number(quantity || 0);
  const notional = refPrice && qtyNum ? refPrice * qtyNum : 0;
  const requiredMargin = notional / Math.max(leverage, 1);
  const free = Number(accountFree || 0);
  const remainingAfter = free - requiredMargin;
  const overBudget = requiredMargin > 0 && remainingAfter < 0;

  // Quick-pick quantity presets — based on what % of the user's free margin
  // they want to deploy. Inverted from margin → qty using current refPrice.
  const setPresetPct = (pct) => {
    if (!refPrice || !free) return;
    const wantedMargin = free * (pct / 100);
    const wantedQty = (wantedMargin * Math.max(leverage, 1)) / refPrice;
    if (wantedQty > 0) setQuantity(wantedQty.toFixed(4));
  };

  // ─── LIMIT direction validation ─────────────────────────────────────
  // Mirrors the server-side check: BUY LIMIT must be below current ask;
  // SELL LIMIT must be above current bid. Computed locally from the
  // instrument's lastPrice + spread so the form can warn the user before
  // they hit submit (and disable the button to prevent the inevitable
  // 400 round-trip). Stop orders skip this — direction rules are inverse
  // for STOP and we don't lock the user out of those.
  const currentBidAsk = useMemo(() => {
    const last = Number(instrument?.lastPrice || 0);
    if (!last) return { bid: 0, ask: 0 };
    const spread = Number(instrument?.spreadValue || 0);
    const half = spread / 2;
    if (instrument?.spreadType === 'PERCENTAGE') {
      return { bid: last * (1 - half), ask: last * (1 + half) };
    }
    return { bid: last - half, ask: last + half };
  }, [instrument?.lastPrice, instrument?.spreadValue, instrument?.spreadType]);

  /**
   * Resolve what the LIMIT-tab order will become and surface the right
   * helper text. Mirrors the backend's resolveLimitTabOrderType() so the
   * user sees the same outcome the server will compute.
   *
   * Returns { resolvedKind, hint, invalidReason }:
   *   resolvedKind:    'LIMIT' | 'STOP' | null
   *   hint:            user-facing copy explaining what the order will do
   *   invalidReason:   non-null = blocks submit (error message)
   */
  const limitResolution = useMemo(() => {
    if (orderMode !== 'LIMIT') return { resolvedKind: null, hint: '', invalidReason: '' };
    const limitPx = Number(price);
    if (!Number.isFinite(limitPx) || limitPx <= 0) return { resolvedKind: null, hint: '', invalidReason: '' };
    const { bid, ask } = currentBidAsk;
    if (!ask || !bid) return { resolvedKind: null, hint: '', invalidReason: '' };

    if (side === 'BUY') {
      if (limitPx === ask) {
        return {
          resolvedKind: null,
          hint: '',
          invalidReason: 'Limit price cannot be equal to current market price. Use Market order instead.',
        };
      }
      if (limitPx < ask) {
        return {
          resolvedKind: 'LIMIT',
          hint: 'Buy when price drops to this level',
          invalidReason: '',
        };
      }
      // limitPx > ask
      return {
        resolvedKind: 'STOP',
        hint: 'Buy when price breaks above this level',
        invalidReason: '',
      };
    }

    // SELL
    if (limitPx === bid) {
      return {
        resolvedKind: null,
        hint: '',
        invalidReason: 'Limit price cannot be equal to current market price. Use Market order instead.',
      };
    }
    if (limitPx > bid) {
      return {
        resolvedKind: 'LIMIT',
        hint: 'Sell when price rises to this level',
        invalidReason: '',
      };
    }
    // limitPx < bid
    return {
      resolvedKind: 'STOP',
      hint: 'Sell when price breaks below this level',
      invalidReason: '',
    };
  }, [orderMode, price, side, currentBidAsk]);

  const limitInvalidReason = limitResolution.invalidReason;

  // SL / TP distance shown as a % of refPrice — traders think in "1.5%
  // away from entry" more naturally than absolute prices.
  const slPct = useMemo(() => {
    if (!stopLoss || !refPrice) return null;
    const v = ((Number(stopLoss) - refPrice) / refPrice) * 100;
    return Number.isFinite(v) ? v : null;
  }, [stopLoss, refPrice]);
  const tpPct = useMemo(() => {
    if (!takeProfit || !refPrice) return null;
    const v = ((Number(takeProfit) - refPrice) / refPrice) * 100;
    return Number.isFinite(v) ? v : null;
  }, [takeProfit, refPrice]);

  // Live price formatter — INR primary + USD secondary if instrument is USD-quoted.
  const livePxDual = instrument
    ? fmtPriceDual(
        instrument.lastPrice || '0',
        instrument.quoteCurrency || 'USD',
        fxRate,
        instrument.pricePrecision || 2
      )
    : null;

  const acctSym = account?.baseCurrency === 'INR' ? '₹'
    : account?.baseCurrency === 'USD' ? '$'
    : (account?.baseCurrency + ' ');
  const fmtAcct = (v) =>
    `${acctSym}${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="card p-4">
      {/* Header — accent bar + title + live last price chip */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <span className="w-1 h-5 bg-primary-500 rounded-full" />
          <div className="text-sm font-bold text-text-primary uppercase tracking-wider">Place Order</div>
        </div>
        {livePxDual && (
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-wider text-text-muted font-bold leading-none">Last</div>
            <div className="text-xs font-mono text-text-primary leading-tight mt-0.5">{livePxDual.primary}</div>
          </div>
        )}
      </div>

      {/* BUY / SELL pill — yellow active glow proportional to side */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={`py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center gap-0.5 ${
            side === 'BUY'
              ? 'bg-bull text-white shadow-lg shadow-bull/30 scale-[1.02]'
              : 'bg-bg-hover text-text-secondary hover:bg-bg-panel hover:text-text-primary border border-border-dark'
          }`}
        >
          <span>BUY · LONG</span>
          <span className={`text-[9px] font-mono ${side === 'BUY' ? 'text-white/80' : 'text-text-muted'}`}>
            ↑ Profit if price rises
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={`py-3 rounded-lg font-bold text-sm transition-all flex flex-col items-center gap-0.5 ${
            side === 'SELL'
              ? 'bg-bear text-white shadow-lg shadow-bear/30 scale-[1.02]'
              : 'bg-bg-hover text-text-secondary hover:bg-bg-panel hover:text-text-primary border border-border-dark'
          }`}
        >
          <span>SELL · SHORT</span>
          <span className={`text-[9px] font-mono ${side === 'SELL' ? 'text-white/80' : 'text-text-muted'}`}>
            ↓ Profit if price falls
          </span>
        </button>
      </div>

      {/* Order mode tabs — only MARKET and LIMIT exposed to the user.
          A "LIMIT" with a price above the ask (BUY) or below the bid
          (SELL) is auto-routed by the server as a STOP under the hood. */}
      <div className="flex gap-0.5 mb-4 border-b border-border-dark">
        {['MARKET', 'LIMIT'].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setOrderMode(m);
              if (m === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
            }}
            className={`relative text-xs font-semibold px-4 py-2 transition-colors ${
              orderMode === m ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {m}
            {orderMode === m && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-500 rounded-t-full" />
            )}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {/* Limit price input — only when LIMIT mode is selected. The
            "current ask/bid" hint shows the side-relevant quote, and the
            helper line below explains in plain English what the order
            will do (drop-to-buy, breakout-buy, rise-to-sell, breakdown-
            sell). Border tints red when the price equals current market. */}
        {orderMode === 'LIMIT' && (
          <div>
            <label className="label flex items-center justify-between">
              <span>Limit Price</span>
              {currentBidAsk.ask > 0 && (
                <span className="text-text-muted normal-case font-mono text-[10px] tracking-normal">
                  {side === 'BUY'
                    ? `ask ${currentBidAsk.ask.toFixed(instrument?.pricePrecision || 2)}`
                    : `bid ${currentBidAsk.bid.toFixed(instrument?.pricePrecision || 2)}`}
                </span>
              )}
            </label>
            <input
              type="number"
              step="any"
              className={`input font-mono ${limitInvalidReason ? 'border-bear/50 focus:border-bear' : ''}`}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
            {limitInvalidReason ? (
              <div className="mt-1.5 text-[11px] text-bear flex items-start gap-1.5 leading-snug">
                <span className="shrink-0">⚠</span>
                <span>{limitInvalidReason}</span>
              </div>
            ) : limitResolution.hint ? (
              <div className="mt-1.5 text-[11px] text-text-secondary leading-snug">
                {limitResolution.hint}
              </div>
            ) : null}
          </div>
        )}

        {/* Quantity + quick presets */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label !mb-0">Quantity ({instrument?.baseCurrency})</label>
            <div className="flex gap-0.5">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setPresetPct(pct)}
                  disabled={!refPrice || !free}
                  className="text-[10px] font-bold px-2 py-0.5 rounded border border-border-dark text-text-muted hover:text-primary-500 hover:border-primary-500/40 hover:bg-primary-500/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={`Use ${pct}% of free margin`}
                >
                  {pct === 100 ? 'MAX' : `${pct}%`}
                </button>
              ))}
            </div>
          </div>
          <input
            type="number"
            step="any"
            className="input font-mono"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder={`min ${instrument?.minOrderSize || '0.001'}`}
            required
          />
        </div>

        {/* SL / TP with % distance hint */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label flex items-center justify-between">
              <span>Stop Loss</span>
              {slPct !== null && (
                <span className={`font-mono normal-case tracking-normal text-[10px] ${slPct < 0 ? 'text-bear' : 'text-text-muted'}`}>
                  {slPct >= 0 ? '+' : ''}{slPct.toFixed(2)}%
                </span>
              )}
            </label>
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
            <label className="label flex items-center justify-between">
              <span>Take Profit</span>
              {tpPct !== null && (
                <span className={`font-mono normal-case tracking-normal text-[10px] ${tpPct > 0 ? 'text-bull' : 'text-text-muted'}`}>
                  {tpPct >= 0 ? '+' : ''}{tpPct.toFixed(2)}%
                </span>
              )}
            </label>
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

        {/* Leverage slider with tick marks at common preset values */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label !mb-0">Leverage</label>
            <span className="text-sm font-mono font-bold text-primary-500">1:{leverage}</span>
          </div>
          <input
            type="range"
            min={1}
            max={instrument?.maxLeverage || 100}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-primary-500"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-1 font-mono">
            <span>1×</span>
            <span>{Math.round((instrument?.maxLeverage || 100) / 2)}×</span>
            <span>{instrument?.maxLeverage || 100}×</span>
          </div>
        </div>

        {/* Cost summary — notional, margin, post-trade free balance.
            Border tints red when over budget so it reads as a warning. */}
        <div
          className={`rounded-lg border p-3 space-y-1.5 ${
            overBudget
              ? 'border-bear/40 bg-bear/5'
              : 'border-border-dark bg-bg-panel'
          }`}
        >
          <Row label="Notional" value={notional > 0 ? fmtAcct(notional) : '—'} mono />
          <Row label="Required Margin" value={requiredMargin > 0 ? fmtAcct(requiredMargin) : '—'} mono bold />
          <div className="border-t border-border-subtle pt-1.5">
            <Row
              label="Available"
              value={accountFree != null ? fmtAcct(free) : '—'}
              mono
              valueClass="text-text-secondary"
            />
            {requiredMargin > 0 && (
              <Row
                label="After Order"
                value={fmtAcct(remainingAfter)}
                mono
                valueClass={overBudget ? 'text-bear font-bold' : 'text-bull'}
              />
            )}
          </div>
          {overBudget && (
            <div className="text-[10px] text-bear font-semibold mt-1">
              ⚠ Insufficient free margin
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || overBudget || !!limitInvalidReason}
          className={`w-full py-3 rounded-lg font-bold text-sm transition-all ${
            side === 'BUY'
              ? 'bg-bull hover:bg-emerald-600 shadow-md shadow-bull/30'
              : 'bg-bear hover:bg-red-600 shadow-md shadow-bear/30'
          } text-white disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed hover:scale-[1.01]`}
        >
          {loading ? 'Placing…' : `Place ${side === 'BUY' ? 'Buy' : 'Sell'} Order`}
        </button>
      </form>
    </div>
  );
}

function Row({ label, value, mono, bold, valueClass = 'text-text-primary' }) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-text-muted uppercase tracking-wider text-[10px] font-bold">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${bold ? 'font-bold' : ''} ${valueClass}`}>{value}</span>
    </div>
  );
}
