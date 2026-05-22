import { useEffect, useMemo, useRef, useState } from 'react';
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
  // (1% loss, 2% profit) the moment they enter a quantity. The ref guard
  // is what makes the × clear button stick — without it, the effect would
  // re-run after `setStopLoss('')` (because stopLoss/takeProfit used to
  // sit in the deps array) and immediately re-fill the field.
  const autoFillDoneRef = useRef(false);
  const prevSideRef = useRef(side);
  useEffect(() => {
    // Side flip resets the "done" flag so the new side gets correctly
    // signed defaults. Empty fields get re-filled; existing values stay
    // because the inner !stopLoss / !takeProfit checks still gate writes.
    if (prevSideRef.current !== side) {
      autoFillDoneRef.current = false;
      prevSideRef.current = side;
    }
    if (!autoTpSl) {
      autoFillDoneRef.current = false;
      return;
    }
    if (!quantity || Number(quantity) <= 0) {
      autoFillDoneRef.current = false;
      return;
    }
    if (autoFillDoneRef.current) return;
    const px = orderMode === 'MARKET'
      ? Number(instrument?.lastPrice || 0)
      : Number(price || 0);
    if (!px) return;
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
    autoFillDoneRef.current = true;
    // stopLoss / takeProfit deliberately omitted — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTpSl, side, quantity, price, orderMode, instrument?.lastPrice, instrument?.pricePrecision]);

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
      // Skip 0 / negative / non-numeric — the truthy-string check used to
      // accept "0" and send a never-triggering threshold to the backend.
      if (Number(stopLoss) > 0)   payload.stopLoss = stopLoss;
      if (Number(takeProfit) > 0) payload.takeProfit = takeProfit;

      const { data } = await api.post('/trading/orders', payload);
      toast.success(`Order ${data.data.status}`);
      onPlaced?.(data.data);
      // Reset form for the next entry — keep instrument/leverage/side
      // (sticky UX), clear amount + SL/TP so they don't bleed across orders.
      setQuantity('');
      setStopLoss('');
      setTakeProfit('');
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
    <div className="card p-4 max-h-full overflow-y-auto">
      {/* Premium header — asset icon in a tinted halo, big symbol on
          left, vertically-centered live price + % chip on right, sharp
          close-X. The thin gradient divider below acts as a section
          separator without taking extra vertical space. */}
      <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-border-subtle">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-full bg-primary-500/10 blur-md scale-110" aria-hidden="true" />
            <div className="relative">
              <AssetIcon row={instrument} size={28} round />
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold text-text-primary tracking-tight truncate leading-tight">
              {instrument?.symbol}
            </div>
            {Number.isFinite(Number(instrument?.lastPrice)) && (
              <div className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums mt-0.5">
                <span className="text-text-secondary font-semibold">
                  {Number(instrument.lastPrice).toFixed(Math.min(instrument?.pricePrecision || 2, 5))}
                </span>
                {Number.isFinite(Number(instrument?.change24h)) && (
                  <span
                    className="inline-flex items-center gap-0.5 font-bold text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      color: Number(instrument.change24h) >= 0 ? '#16A34A' : '#DC2626',
                      background: Number(instrument.change24h) >= 0 ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)',
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
            className="shrink-0 w-7 h-7 rounded-md hover:bg-bg-hover flex items-center justify-center text-text-muted hover:text-text-primary transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* Bid / Spread / Ask — three-column inline strip with clear labels
          above the values. Sharp corners + plain white background — less
          visual noise against the surrounding card. */}
      {(() => {
        const bid = Number(instrument?.bid);
        const ask = Number(instrument?.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) return null;
        const prec = Math.min(instrument?.pricePrecision || 2, 5);
        const mid = (bid + ask) / 2;
        const spread = ask - bid;
        const spreadBps = mid > 0 ? (spread / mid) * 10000 : 0;
        return (
          <div className="grid grid-cols-3 mb-3 rounded border border-border-subtle overflow-hidden">
            <div className="text-center py-2 border-r border-border-subtle bg-gradient-to-b from-bull/5 to-transparent">
              <div className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted leading-none">Bid</div>
              <div className="font-mono font-extrabold text-[13px] text-bull tabular-nums mt-1 leading-none">{bid.toFixed(prec)}</div>
            </div>
            <div className="text-center py-2 border-r border-border-subtle bg-white">
              <div className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted leading-none">Spread</div>
              <div className="font-mono font-extrabold text-[13px] text-text-primary tabular-nums mt-1 leading-none">
                {spreadBps.toFixed(1)}<span className="text-[9px] text-text-muted ml-0.5 font-bold">bps</span>
              </div>
            </div>
            <div className="text-center py-2 bg-gradient-to-b from-bear/5 to-transparent">
              <div className="text-[9px] uppercase tracking-[0.15em] font-bold text-text-muted leading-none">Ask</div>
              <div className="font-mono font-extrabold text-[13px] text-bear tabular-nums mt-1 leading-none">{ask.toFixed(prec)}</div>
            </div>
          </div>
        );
      })()}

      {/* Order Mode dropdown — slim version (no big icon padding). */}
      <div className="mb-2 relative">
        <select
          value={openOrderMode}
          onChange={(e) => setOpenOrderMode('trading.openOrderMode', e.target.value)}
          aria-label="Order entry mode"
          className="appearance-none cursor-pointer w-full pl-2.5 pr-7 py-1.5 rounded border border-border-subtle bg-white text-[11px] font-bold text-text-secondary hover:border-primary-500/40 focus:outline-none focus:border-primary-500 transition-all"
        >
          <option value="regular">Regular form</option>
          <option value="oneClick">⚡ One-click</option>
          <option value="riskCalc">Risk calculator</option>
        </select>
        <svg
          width="11" height="11" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* BUY / SELL — two prominent buttons. Each gets bold treatment
          on the active side (full color fill + glow) while the inactive
          side stays neutral but readable. */}
      {/* BUY / SELL — premium gradient-active buttons. Two-line content
          (label + subtitle) gives back the broker feel without bloating
          height too much. Active side uses a vertical gradient + crisp
          drop-shadow; inactive stays clean with a subtle hover hint. */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          type="button"
          onClick={() => setSide('BUY')}
          className={`relative py-3 rounded font-extrabold tracking-wide transition-all overflow-hidden border ${
            side === 'BUY'
              ? 'text-white border-bull/0 shadow-[0_3px_10px_rgba(16,185,129,0.30)]'
              : 'bg-white border-border-subtle text-text-secondary hover:border-bull/50 hover:text-bull hover:bg-bull/[0.03]'
          }`}
          style={side === 'BUY' ? { background: 'linear-gradient(180deg, #10B981 0%, #059669 100%)' } : undefined}
        >
          <div className="flex flex-col items-center leading-tight">
            <span className="text-[13px]">↑ BUY</span>
            <span className={`text-[9px] font-medium tracking-normal ${side === 'BUY' ? 'text-white/80' : 'text-text-muted'} mt-0.5`}>
              Long position
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setSide('SELL')}
          className={`relative py-3 rounded font-extrabold tracking-wide transition-all overflow-hidden border ${
            side === 'SELL'
              ? 'text-white border-bear/0 shadow-[0_3px_10px_rgba(239,68,68,0.30)]'
              : 'bg-white border-border-subtle text-text-secondary hover:border-bear/50 hover:text-bear hover:bg-bear/[0.03]'
          }`}
          style={side === 'SELL' ? { background: 'linear-gradient(180deg, #EF4444 0%, #DC2626 100%)' } : undefined}
        >
          <div className="flex flex-col items-center leading-tight">
            <span className="text-[13px]">↓ SELL</span>
            <span className={`text-[9px] font-medium tracking-normal ${side === 'SELL' ? 'text-white/80' : 'text-text-muted'} mt-0.5`}>
              Short position
            </span>
          </div>
        </button>
      </div>

      {/* MARKET / LIMIT — premium segmented control inside a soft track.
          Active mode rides as a colored pill with a subtle inner glow. */}
      {!isOneClick && (
        <div className="relative flex p-0.5 mb-3 rounded border border-border-subtle bg-bg-hover/40">
          {['MARKET', 'LIMIT'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setOrderMode(m);
                if (m === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
              }}
              className={`flex-1 text-[11px] font-extrabold py-1.5 rounded-[3px] tracking-[0.1em] transition-all ${
                orderMode === m
                  ? 'bg-white text-text-primary shadow-[0_1px_3px_rgba(0,0,0,0.10)]'
                  : 'text-text-muted hover:text-text-primary'
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

        {/* Quantity — compact: label inline with the unit, presets as
            tiny pills above the input. Reduces vertical stack vs the
            previous separate row layout. */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="label !mb-0 flex items-baseline gap-1.5">
              <span>Quantity</span>
              <span className="font-mono text-[10px] text-text-muted normal-case tracking-normal">({instrument?.baseCurrency})</span>
            </label>
            <div className="flex gap-0.5">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setPresetPct(pct)}
                  disabled={!refPrice || !free}
                  className="text-[9.5px] font-bold px-1.5 py-0.5 rounded text-text-muted hover:text-white hover:bg-primary-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

        {/* Leverage — premium block. Top row: label + editable pill on
            the right. Slider below it with min/mid/max ticks underneath
            for clear range awareness. */}
        <div className="rounded border border-border-subtle bg-white p-2.5">
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0 flex items-baseline gap-1.5">
              <span>Leverage</span>
              <span className="text-[9px] text-text-muted normal-case tracking-normal font-mono">max 1:{MAX_LEVERAGE_UI}</span>
            </label>
            <span className="inline-flex items-center gap-0.5 text-[12px] font-mono font-extrabold px-2 py-0.5 rounded bg-primary-500/10 text-primary-600 border border-primary-500/30 focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500/25">
              <span className="opacity-70">1:</span>
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
                className="w-12 bg-transparent text-right outline-none font-mono font-extrabold text-primary-600 tabular-nums"
                aria-label="Leverage multiplier"
              />
              <span className="opacity-70">×</span>
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
          <div className="flex justify-between text-[10px] text-text-muted mt-1.5 font-mono font-semibold">
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
          <div className="rounded border border-border-subtle bg-gradient-to-b from-bg-hover/30 to-white px-3 py-2.5 space-y-1.5 text-[11.5px]">
            <div className="text-[9px] uppercase tracking-[0.18em] font-bold text-text-muted mb-1">Order summary</div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted font-medium">Notional</span>
              <span className="font-mono font-bold text-text-primary tabular-nums">{fmtAcct(notional)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted font-medium">Margin required</span>
              <span className="font-mono font-bold text-text-primary tabular-nums">{fmtAcct(requiredMargin)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-muted font-medium">Free after</span>
              <span
                className="font-mono font-extrabold tabular-nums"
                style={{ color: overBudget ? '#DC2626' : '#16A34A' }}
              >
                {fmtAcct(remainingAfter)}
              </span>
            </div>
            {/* SL / TP estimated outcomes — pinned together at the
                bottom of the summary card with a thin top border. */}
            {((Number(stopLoss) > 0) || (Number(takeProfit) > 0)) && (
              <div className="flex items-center justify-between pt-1 mt-1 border-t border-border-subtle gap-3">
                {Number(stopLoss) > 0 && (() => {
                  const sl = Number(stopLoss);
                  const slPnl = side === 'BUY' ? (sl - refPrice) * qtyNum : (refPrice - sl) * qtyNum;
                  return (
                    <span className="flex items-center gap-1 font-mono font-bold text-bear tabular-nums">
                      <span className="text-[9px] text-text-muted font-sans font-medium">SL</span>
                      {slPnl >= 0 ? '+' : ''}{fmtAcct(slPnl)}
                    </span>
                  );
                })()}
                {Number(takeProfit) > 0 && (() => {
                  const tp = Number(takeProfit);
                  const tpPnl = side === 'BUY' ? (tp - refPrice) * qtyNum : (refPrice - tp) * qtyNum;
                  return (
                    <span className="flex items-center gap-1 font-mono font-bold text-bull tabular-nums ml-auto">
                      <span className="text-[9px] text-text-muted font-sans font-medium">TP</span>
                      {tpPnl >= 0 ? '+' : ''}{fmtAcct(tpPnl)}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* Insufficient-margin warning */}
        {overBudget && (
          <div className="rounded bg-bear/10 border border-bear/30 px-3 py-2 text-[11px] text-bear font-bold flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
            Insufficient free margin
          </div>
        )}

        <button
          type="submit"
          disabled={loading || overBudget || !!limitInvalidReason}
          className={`w-full py-3 rounded font-extrabold text-[14px] tracking-wide transition-all text-white disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed`}
          style={
            loading || overBudget || !!limitInvalidReason
              ? { background: side === 'BUY' ? '#10B981' : '#EF4444' }
              : side === 'BUY'
                ? { background: 'linear-gradient(180deg, #10B981 0%, #059669 100%)', boxShadow: '0 4px 14px rgba(16,185,129,0.35)' }
                : { background: 'linear-gradient(180deg, #EF4444 0%, #DC2626 100%)', boxShadow: '0 4px 14px rgba(239,68,68,0.35)' }
          }
        >
          {loading
            ? 'Placing…'
            : isOneClick
              ? `⚡ Quick ${side === 'BUY' ? 'Buy' : 'Sell'}`
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


