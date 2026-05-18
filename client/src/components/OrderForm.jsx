import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtPriceDual, fmtMoneyDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import AssetIcon from './AssetIcon';

export default function OrderForm({
  instrument,
  account,
  onPlaced,
  onPendingPriceChange,
  // Optional controlled side — when the parent (Trade page) provides a
  // `side` value, the inline BUY / SELL toggle inside the form is hidden
  // because the parent's chart-top Sell/Buy chip drives the side instead.
  side: controlledSide,
  onSideChange,
  // Optional close callback — when provided a small × renders inline
  // next to the asset name in the compact header.
  onClose,
}) {
  const maxLev = instrument?.maxLeverage || 100;
  const initialLev = Math.min(account?.leverage || 1, maxLev);
  const fxRate = useFxRate();

  const [internalSide, setInternalSide] = useState('BUY');
  const sideControlled = controlledSide === 'BUY' || controlledSide === 'SELL';
  const side = sideControlled ? controlledSide : internalSide;
  const setSide = (next) => {
    if (sideControlled) onSideChange?.(next);
    else setInternalSide(next);
  };
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
    // Card hugs its content (no `flex-1` — that left a tall blank
    // strip below the CTA after the cost-summary card was removed).
    // `max-h-full` + `overflow-y-auto` still let it scroll internally
    // if the form ever grows taller than the surrounding aside.
    <div className="card p-5 max-h-full overflow-y-auto">
      {/* Compact header — asset icon + symbol on the left, × close on the
          right (same row). Both sit on a single line. */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <AssetIcon row={instrument} size={20} round />
          <span className="text-sm font-bold text-text-primary tracking-tight truncate">
            {instrument?.symbol}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close panel"
            aria-label="Close order panel"
            className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* BUY / SELL split — always visible (matches Exness-style panel). */}
      <div className="grid grid-cols-2 gap-2.5 mb-5">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={`py-3.5 rounded-xl font-bold text-sm transition-all flex flex-col items-center gap-1 ${
            side === 'BUY'
              ? 'bg-bull text-white shadow-lg shadow-bull/35 scale-[1.02] ring-2 ring-bull/20'
              : 'bg-bg-card text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-border-dark'
          }`}
        >
          <span className="tracking-wide">BUY · LONG</span>
          <span className={`text-[10px] font-medium ${side === 'BUY' ? 'text-white/85' : 'text-text-muted'}`}>
            ↑ Profit if price rises
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={`py-3.5 rounded-xl font-bold text-sm transition-all flex flex-col items-center gap-1 ${
            side === 'SELL'
              ? 'bg-bear text-white shadow-lg shadow-bear/35 scale-[1.02] ring-2 ring-bear/20'
              : 'bg-bg-card text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-border-dark'
          }`}
        >
          <span className="tracking-wide">SELL · SHORT</span>
          <span className={`text-[10px] font-medium ${side === 'SELL' ? 'text-white/85' : 'text-text-muted'}`}>
            ↓ Profit if price falls
          </span>
        </button>
      </div>

      {/* Order mode tabs — segmented control style (pill on track). */}
      <div className="flex p-1 mb-5 rounded-lg bg-bg-card border border-border-dark">
        {['MARKET', 'LIMIT'].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setOrderMode(m);
              if (m === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
            }}
            className={`flex-1 text-xs font-bold py-2 rounded-md transition-all ${
              orderMode === m
                ? 'bg-white text-text-primary shadow-card'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {m}
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
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0">Quantity ({instrument?.baseCurrency})</label>
            <div className="flex gap-1">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setPresetPct(pct)}
                  disabled={!refPrice || !free}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-full border border-border-dark text-text-secondary hover:text-white hover:bg-primary-500 hover:border-primary-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
            className="input font-mono text-base"
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

        {/* Leverage slider — primary-tinted with the chosen multiplier
            displayed as a pill instead of inline text. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0">Leverage</label>
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-primary-500/10 text-primary-600 border border-primary-500/30">
              1:{leverage}
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={instrument?.maxLeverage || 100}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-primary-500 h-1.5"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-2 font-mono font-semibold">
            <span>1×</span>
            <span>{Math.round((instrument?.maxLeverage || 100) / 2)}×</span>
            <span>{instrument?.maxLeverage || 100}×</span>
          </div>
        </div>

        {/* Insufficient-margin warning — kept inline (the full cost
            summary card was removed). The Place-Order button itself is
            still disabled when overBudget, so the warning is the only
            extra cue the user needs. */}
        {overBudget && (
          <div className="text-[11px] text-bear font-bold flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
            Insufficient free margin
          </div>
        )}

        <button
          type="submit"
          disabled={loading || overBudget || !!limitInvalidReason}
          className={`w-full py-4 rounded-xl font-extrabold text-base tracking-wide transition-all ${
            side === 'BUY'
              ? 'bg-bull hover:bg-emerald-600 shadow-lg shadow-bull/35'
              : 'bg-bear hover:bg-red-600 shadow-lg shadow-bear/35'
          } text-white disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed hover:scale-[1.01] active:scale-[0.99]`}
        >
          {loading
            ? 'Placing…'
            : `Place ${side === 'BUY' ? 'Buy' : 'Sell'} Order`}
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
