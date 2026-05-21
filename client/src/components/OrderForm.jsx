import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtPriceDual, fmtMoneyDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import { useTradeSettings } from '../store/tradeSettings';
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
  // ── Leverage cap ────────────────────────────────────────────────
  // Pulled from /user/leverage which encapsulates the precedence:
  //   1. customLeverage (admin override) — always wins
  //   2. Active plan's defaultLeverage   — FREE=50, PREMIUM=200, VIP=500
  //   3. Fallback (100)
  // Also subscribed to a per-user WS channel so admin overrides land
  // in real-time without a page refresh.
  const [leverageState, setLeverageState] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/user/leverage')
      .then((r) => { if (!cancelled) setLeverageState(r.data?.data || null); })
      .catch(() => { /* fall through to plan-less ceiling */ });
    // Real-time updates from admin actions. Backend publishes to
    // `user:leverage:<userId>` via notifyUser(). The wsClient's
    // onmessage handler strips the userId suffix and looks up callbacks
    // under the base `user:leverage`, so the FE must subscribe to that
    // prefixed name — `'leverage'` alone won't match.
    const unsub = wsClient.subscribe('user:leverage', (data) => {
      if (!cancelled && data) setLeverageState(data);
    });
    // Belt-and-braces: also re-fetch when the window regains focus
    // (covers cases where the WS was disconnected during a leverage
    // change, e.g. brief network glitch / laptop wake).
    const onFocus = () => {
      api.get('/user/leverage')
        .then((r) => { if (!cancelled) setLeverageState(r.data?.data || null); })
        .catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      if (unsub) unsub();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Cap comes purely from the user's effectiveLeverage (admin override
  // wins over plan default, plan wins over fallback). Per spec, this
  // is the SINGLE source of truth — the instrument's own maxLeverage
  // field is NOT applied here, so admin/plan changes always reflect
  // immediately regardless of what's seeded on each instrument row.
  const MAX_LEVERAGE_UI = leverageState?.effectiveLeverage || 100;
  // Initial slider position = account's default leverage, clamped to
  // the new ceiling. After the WS push arrives the re-clamp effect
  // below will snap it back into range if admin lowered the cap.
  const initialLev = Math.min(MAX_LEVERAGE_UI, Math.max(1, Number(account?.leverage) || 1));
  const fxRate = useFxRate();

  const [internalSide, setInternalSide] = useState('BUY');
  const sideControlled = controlledSide === 'BUY' || controlledSide === 'SELL';
  const side = sideControlled ? controlledSide : internalSide;
  const setSide = (next) => {
    if (sideControlled) onSideChange?.(next);
    else setInternalSide(next);
  };
  // Order-entry mode comes from the global Trade Settings store so the
  // user's choice persists across sessions and stays in sync with the
  // Settings panel's dropdown. Three modes:
  //   - regular   → full form (default)
  //   - oneClick  → simplified one-tap market entry (no confirmation)
  //   - riskCalc  → full form + risk-sizing helper above Quantity
  const openOrderMode = useTradeSettings((s) => s.trading.openOrderMode);
  const setOpenOrderMode = useTradeSettings((s) => s.set);
  const confirmBeforeOrder = useTradeSettings((s) => s.autoTrading.confirmOrder);
  // Auto Trading > Enable one-click trading — separate toggle from
  // openOrderMode that also forces one-click behavior. Either flag
  // collapsing the form into one-click mode is enough.
  const autoOneClick = useTradeSettings((s) => s.autoTrading.oneClick);
  const autoTpSl = useTradeSettings((s) => s.autoTrading.autoTpSl);
  const isOneClick = openOrderMode === 'oneClick' || autoOneClick;
  const isRiskCalc = openOrderMode === 'riskCalc';
  // The order panel only exposes MARKET and LIMIT to the user. The backend
  // auto-resolves a "LIMIT" mode order to either LIMIT or STOP depending
  // on the price's relationship to the current bid/ask. STOP-tab is gone.
  // One-click mode forces MARKET — no limit price selection.
  const [orderMode, setOrderMode] = useState(isOneClick ? 'MARKET' : 'LIMIT');
  // Auto-force MARKET when user flips into oneClick mode
  useEffect(() => {
    if (isOneClick && orderMode !== 'MARKET') setOrderMode('MARKET');
  }, [isOneClick, orderMode]);

  // Risk-calculator inputs — only shown when riskCalc mode is active.
  const [riskPct, setRiskPct] = useState('1');     // % of free margin to risk
  const [stopDistance, setStopDistance] = useState(''); // distance in price units
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState(instrument?.lastPrice || '');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [leverage, setLeverage] = useState(initialLev);
  const [loading, setLoading] = useState(false);
  const [accountFree, setAccountFree] = useState(null);

  useEffect(() => {
    // Re-clamp whenever the cap can move — switching account, instrument,
    // or receiving a WS leverage update from admin. Snaps the slider
    // down (never up) so the form never submits a value above the cap.
    setLeverage((curr) => Math.min(MAX_LEVERAGE_UI, Math.max(1, curr)));
    setPrice(instrument?.lastPrice || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?._id, instrument?.lastPrice, account?._id, account?.leverage, leverageState?.effectiveLeverage]);

  // ── Auto TP / SL ──────────────────────────────────────────────────
  // When the user enables Settings > Auto Trading > "Set TP/SL automatically",
  // the form auto-populates Stop Loss + Take Profit with safe defaults
  // (1% loss, 2% profit) the moment they enter a quantity. Manually edited
  // values are never overwritten — we only fill when the field is empty.
  useEffect(() => {
    if (!autoTpSl) return;
    const px = orderMode === 'MARKET'
      ? Number(instrument?.lastPrice || 0)
      : Number(price || 0);
    if (!px || !quantity || Number(quantity) <= 0) return;
    const prec = Math.min(instrument?.pricePrecision || 2, 5);
    const slDist = px * 0.01;  // 1% stop
    const tpDist = px * 0.02;  // 2% target (1:2 R/R)
    if (side === 'BUY') {
      if (!stopLoss)   setStopLoss((px - slDist).toFixed(prec));
      if (!takeProfit) setTakeProfit((px + tpDist).toFixed(prec));
    } else {
      if (!stopLoss)   setStopLoss((px + slDist).toFixed(prec));
      if (!takeProfit) setTakeProfit((px - tpDist).toFixed(prec));
    }
  }, [autoTpSl, side, quantity, price, orderMode, instrument?.lastPrice, instrument?.pricePrecision, stopLoss, takeProfit]);

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
    // Confirmation step — gated by "Confirm before order" setting AND
    // not in one-click mode (which by definition skips confirmation).
    if (confirmBeforeOrder && !isOneClick) {
      const sideLabel = side === 'BUY' ? 'Buy' : 'Sell';
      const modeLabel = orderMode === 'LIMIT' ? `LIMIT @ ${price}` : 'MARKET';
      const ok = window.confirm(`Confirm ${sideLabel} ${quantity} ${instrument?.baseCurrency} (${modeLabel}) with 1:${leverage} leverage?`);
      if (!ok) return;
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
      {/* Header row — asset icon + symbol on the left, live price chip
          + close on the right. Live price comes from the instrument
          snapshot (updates whenever Trade.jsx refreshes the row). */}
      <div className="flex items-center justify-between gap-2 mb-3.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <AssetIcon row={instrument} size={24} round />
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-text-primary tracking-tight truncate leading-none">
              {instrument?.symbol}
            </div>
            {Number.isFinite(Number(instrument?.lastPrice)) && (
              <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums mt-1">
                <span className="text-text-primary font-bold">
                  {Number(instrument.lastPrice).toFixed(Math.min(instrument?.pricePrecision || 2, 5))}
                </span>
                {Number.isFinite(Number(instrument?.change24h)) && (
                  <span
                    className="font-bold text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      color: Number(instrument.change24h) >= 0 ? '#16A34A' : '#DC2626',
                      background: Number(instrument.change24h) >= 0 ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)',
                    }}
                  >
                    {Number(instrument.change24h) >= 0 ? '▲' : '▼'} {Math.abs(Number(instrument.change24h)).toFixed(2)}%
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close panel"
            aria-label="Close order panel"
            className="shrink-0 w-7 h-7 rounded-full hover:bg-bg-hover flex items-center justify-center text-text-muted hover:text-text-primary transition-all hover:rotate-90 duration-300"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* Bid / Ask strip — quick reference for the user when placing
          limit orders or eyeballing the current spread. Mid is the
          average of the two; spread is shown in basis points. */}
      {(() => {
        const bid = Number(instrument?.bid);
        const ask = Number(instrument?.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) return null;
        const prec = Math.min(instrument?.pricePrecision || 2, 5);
        const mid = (bid + ask) / 2;
        const spread = ask - bid;
        const spreadBps = mid > 0 ? (spread / mid) * 10000 : 0;
        return (
          <div className="grid grid-cols-3 gap-1.5 mb-3.5">
            <div className="rounded-lg bg-bull/8 border border-bull/20 px-2 py-2 flex flex-col items-center gap-0.5">
              <span className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted">Bid</span>
              <span className="font-mono font-bold text-[12px] text-bull tabular-nums leading-none">{bid.toFixed(prec)}</span>
            </div>
            <div className="rounded-lg bg-bg-hover/60 border border-border-subtle px-2 py-2 flex flex-col items-center gap-0.5">
              <span className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted">Mid</span>
              <span className="font-mono font-bold text-[12px] text-text-primary tabular-nums leading-none">{mid.toFixed(prec)}</span>
              <span className="text-[9px] font-mono text-text-muted">{spreadBps.toFixed(1)} bps</span>
            </div>
            <div className="rounded-lg bg-bear/8 border border-bear/20 px-2 py-2 flex flex-col items-center gap-0.5">
              <span className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted">Ask</span>
              <span className="font-mono font-bold text-[12px] text-bear tabular-nums leading-none">{ask.toFixed(prec)}</span>
            </div>
          </div>
        );
      })()}

      {/* ── Order Mode dropdown with leading icon ─────────────────────
          Switches between Regular / One-click / Risk-calculator forms.
          Persisted via the global Trade Settings store. */}
      <div className="mb-3 relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-primary-600 pointer-events-none">
          {openOrderMode === 'oneClick' ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>
          ) : openOrderMode === 'riskCalc' ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /><line x1="8" y1="6" x2="16" y2="6" /><line x1="8" y1="10" x2="10" y2="10" /><line x1="13" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="10" y2="14" /><line x1="13" y1="14" x2="16" y2="14" /><line x1="8" y1="18" x2="10" y2="18" /><line x1="13" y1="18" x2="16" y2="18" /></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" /></svg>
          )}
        </span>
        <select
          value={openOrderMode}
          onChange={(e) => setOpenOrderMode('trading.openOrderMode', e.target.value)}
          aria-label="Order entry mode"
          className="appearance-none cursor-pointer w-full pl-9 pr-7 py-2 rounded-lg border border-border-dark bg-bg-hover/30 text-xs font-bold text-text-primary hover:border-primary-500/40 hover:bg-primary-500/5 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 transition-all"
        >
          <option value="regular">Regular form</option>
          <option value="oneClick">One-click form</option>
          <option value="riskCalc">Risk calculator</option>
        </select>
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* BUY / SELL split — compact two-line buttons. */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={`py-2.5 rounded-xl font-extrabold text-[13px] transition-all flex flex-col items-center justify-center gap-0.5 leading-tight tracking-wide ${
            side === 'BUY'
              ? 'bg-bull text-white shadow-md shadow-bull/30 ring-2 ring-bull/20'
              : 'bg-white text-text-secondary hover:bg-bull/5 hover:text-bull hover:border-bull/40 border border-border-dark'
          }`}
        >
          <span>BUY · LONG</span>
          <span className={`text-[9px] font-medium normal-case tracking-normal ${side === 'BUY' ? 'text-white/80' : 'text-text-muted'}`}>
            ↑ Profit if price rises
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={`py-2.5 rounded-xl font-extrabold text-[13px] transition-all flex flex-col items-center justify-center gap-0.5 leading-tight tracking-wide ${
            side === 'SELL'
              ? 'bg-bear text-white shadow-md shadow-bear/30 ring-2 ring-bear/20'
              : 'bg-white text-text-secondary hover:bg-bear/5 hover:text-bear hover:border-bear/40 border border-border-dark'
          }`}
        >
          <span>SELL · SHORT</span>
          <span className={`text-[9px] font-medium normal-case tracking-normal ${side === 'SELL' ? 'text-white/80' : 'text-text-muted'}`}>
            ↓ Profit if price falls
          </span>
        </button>
      </div>

      {/* Order mode tabs — segmented control style (pill on track).
          Hidden in one-click mode (forces MARKET only). */}
      {!isOneClick && (
        <div className="relative flex p-1 mb-4 rounded-xl bg-bg-hover/60 border border-border-subtle">
          {['MARKET', 'LIMIT'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setOrderMode(m);
                if (m === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
              }}
              className={`flex-1 text-[12px] font-bold py-1.5 rounded-lg tracking-wide transition-all ${
                orderMode === m
                  ? 'bg-white text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      {/* ── Risk calculator panel — appears above the form fields when
          riskCalc mode is active. Auto-derives a recommended quantity
          from: free margin × risk% / stop distance. */}
      {isRiskCalc && (() => {
        const free = Number(accountFree || 0);
        const px = Number(price || instrument?.lastPrice || 0);
        const riskAmt = free * (Number(riskPct) || 0) / 100;
        const dist = Number(stopDistance) || 0;
        const recommendedQty = dist > 0 ? (riskAmt / dist) : 0;
        return (
          <div className="mb-5 rounded-xl border border-primary-500/30 bg-primary-500/5 p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-primary-600">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
              Risk Calculator
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-semibold text-text-secondary">
                Risk %
                <div className="relative mt-1">
                  <input
                    type="number"
                    step="any"
                    value={riskPct}
                    onChange={(e) => setRiskPct(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md border border-border-dark bg-white text-xs font-mono"
                  />
                </div>
              </label>
              <label className="text-[11px] font-semibold text-text-secondary">
                Stop distance ({instrument?.quoteCurrency})
                <input
                  type="number"
                  step="any"
                  value={stopDistance}
                  onChange={(e) => setStopDistance(e.target.value)}
                  placeholder="0.00"
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-border-dark bg-white text-xs font-mono"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] pt-1">
              <div>
                <div className="text-text-muted uppercase tracking-wider font-bold">Risk amount</div>
                <div className="font-mono font-bold text-bear">{fmtAcct(riskAmt)}</div>
              </div>
              <div className="text-right">
                <div className="text-text-muted uppercase tracking-wider font-bold">Suggested qty</div>
                <button
                  type="button"
                  onClick={() => recommendedQty > 0 && setQuantity(recommendedQty.toFixed(4))}
                  disabled={!recommendedQty}
                  className="font-mono font-bold text-primary-600 hover:underline disabled:no-underline disabled:opacity-50"
                  title={recommendedQty > 0 ? 'Click to apply' : 'Enter stop distance'}
                >
                  {recommendedQty > 0 ? recommendedQty.toFixed(4) : '—'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

        {/* SL / TP with % distance hint — hidden in one-click mode */}
        {!isOneClick && (
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
        )}

        {/* Leverage slider — primary-tinted with the chosen multiplier
            displayed as a pill instead of inline text. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0">Leverage</label>
            {/* Editable pill — user can type any value up to the UI cap.
                Empty input falls back to 1× on blur. */}
            <span className="inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-full bg-primary-500/10 text-primary-600 border border-primary-500/30 focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/15">
              <span>1:</span>
              <input
                type="number"
                min={1}
                max={MAX_LEVERAGE_UI}
                step={1}
                value={leverage}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setLeverage(Math.max(1, Math.min(MAX_LEVERAGE_UI, Math.round(v))));
                }}
                onBlur={() => { if (!leverage || leverage < 1) setLeverage(1); }}
                className="w-16 bg-transparent text-right outline-none font-mono font-bold text-primary-600"
                aria-label="Leverage multiplier"
              />
              <span>×</span>
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={MAX_LEVERAGE_UI}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-primary-500 h-1.5"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-2 font-mono font-semibold">
            <span>1×</span>
            <span>{Math.round(MAX_LEVERAGE_UI / 2)}×</span>
            <span>{MAX_LEVERAGE_UI}×</span>
          </div>
        </div>

        {/* ── Trade summary card — concise readout of cost + remaining
            balance + estimated SL/TP PnL. Surfaces the impact of the
            order before the user commits. Only renders when there's
            a meaningful preview (qty + price both set). */}
        {qtyNum > 0 && refPrice > 0 && (
          <div className="rounded-xl bg-bg-hover/50 border border-border-subtle p-3.5 space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-text-muted mb-1.5">Order Summary</div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary font-medium">Notional</span>
              <span className="font-mono font-bold text-text-primary tabular-nums">{fmtAcct(notional)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary font-medium">Margin required</span>
              <span className="font-mono font-semibold text-text-primary tabular-nums">{fmtAcct(requiredMargin)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary font-medium">Free after</span>
              <span
                className="font-mono font-bold tabular-nums"
                style={{ color: overBudget ? '#DC2626' : '#16A34A' }}
              >
                {fmtAcct(remainingAfter)}
              </span>
            </div>
            {/* Estimated SL / TP outcomes, when set */}
            {(Number.isFinite(Number(stopLoss)) && Number(stopLoss) > 0) && (() => {
              const sl = Number(stopLoss);
              const slPnl = side === 'BUY' ? (sl - refPrice) * qtyNum : (refPrice - sl) * qtyNum;
              return (
                <div className="flex items-center justify-between text-xs pt-2 border-t border-border-subtle">
                  <span className="text-text-secondary font-medium flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-bear" />
                    If SL hits
                  </span>
                  <span className="font-mono font-bold text-bear tabular-nums">
                    {slPnl >= 0 ? '+' : ''}{fmtAcct(slPnl)}
                  </span>
                </div>
              );
            })()}
            {(Number.isFinite(Number(takeProfit)) && Number(takeProfit) > 0) && (() => {
              const tp = Number(takeProfit);
              const tpPnl = side === 'BUY' ? (tp - refPrice) * qtyNum : (refPrice - tp) * qtyNum;
              return (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary font-medium flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-bull" />
                    If TP hits
                  </span>
                  <span className="font-mono font-bold text-bull tabular-nums">
                    {tpPnl >= 0 ? '+' : ''}{fmtAcct(tpPnl)}
                  </span>
                </div>
              );
            })()}
          </div>
        )}

        {/* Insufficient-margin warning */}
        {overBudget && (
          <div className="rounded-lg bg-bear/10 border border-bear/30 px-3 py-2 text-[11px] text-bear font-bold flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
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
            : isOneClick
              ? `⚡ ${side === 'BUY' ? 'Quick Buy' : 'Quick Sell'} at Market`
              : `Place ${side === 'BUY' ? 'Buy' : 'Sell'} Order`}
        </button>
        {isOneClick && (
          <div className="text-[10px] text-text-muted text-center mt-1">
            One-click mode · order fires immediately at market price
          </div>
        )}
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


