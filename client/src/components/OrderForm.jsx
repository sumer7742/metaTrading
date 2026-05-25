import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useTradeSettings } from '../store/tradeSettings';
import { useThemeStore } from '../store/theme';
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

  const acctSym = account?.baseCurrency === 'INR' ? '₹'
    : account?.baseCurrency === 'USD' ? '$'
    : (account?.baseCurrency + ' ');
  const fmtAcct = (v) =>
    `${acctSym}${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Bid / Ask / Spread derived for the Sell / Buy side cards ───
  // Prefer the instrument's live bid/ask when present; otherwise fall back
  // to the derived bid/ask from `lastPrice ± spread/2` (`currentBidAsk`).
  // This stops the cards from showing "—" when only one of bid/ask is missing
  // — the user always sees a real price as long as lastPrice exists.
  const rawBid = Number(instrument?.bid);
  const rawAsk = Number(instrument?.ask);
  const bid = Number.isFinite(rawBid) && rawBid > 0 ? rawBid : currentBidAsk.bid;
  const ask = Number.isFinite(rawAsk) && rawAsk > 0 ? rawAsk : currentBidAsk.ask;
  const hasQuotes = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0;
  const prec = Math.min(instrument?.pricePrecision || 2, 5);
  const spreadAbs = hasQuotes ? Math.max(0, ask - bid) : 0;
  // Sentiment split — derived from how close last is to ask vs bid.
  // No order-book depth in this build; this gives a deterministic value
  // that moves with price so the bar isn't visually frozen.
  const last = Number(instrument?.lastPrice || 0);
  const buyPct = hasQuotes && (ask - bid) > 0
    ? Math.max(15, Math.min(85, ((last - bid) / (ask - bid)) * 100))
    : 50;
  const sellPct = 100 - buyPct;

  // Quantity +/- step uses the instrument's minOrderSize so a tap nudges
  // by one minimum lot. Falls back to 0.01.
  const qtyStep = Number(instrument?.minOrderSize) || 0.01;
  const nudgeQty = (sign) => {
    const next = Math.max(0, (Number(quantity) || 0) + sign * qtyStep);
    setQuantity(next ? next.toFixed(4).replace(/\.?0+$/, '') : '');
  };
  // SL/TP +/- nudge by 1 unit of pricePrecision (0.01 for 2-dp, etc.).
  const pxStep = 1 / Math.pow(10, prec);
  const nudgePx = (setter, getter, sign) => {
    const curr = Number(getter) || Number(refPrice) || 0;
    const next = Math.max(0, curr + sign * pxStep);
    setter(next ? next.toFixed(prec) : '');
  };

  // Real fee estimate — flat commission + percent commission + spread cost.
  // Denominated in the instrument's quote currency (USD for BTCUSD, etc.).
  const commFlat = Number(instrument?.commissionPerTrade || 0);
  const commPct  = Number(instrument?.commissionPercent  || 0);
  const spreadCost = hasQuotes && qtyNum > 0 ? spreadAbs * qtyNum : 0;
  const feeEstimate = qtyNum > 0 && notional > 0
    ? commFlat + (notional * commPct / 100) + spreadCost
    : 0;
  const quoteCcy = instrument?.quoteCurrency || 'USD';
  const fmtQuote = (v) => `${Number(v).toFixed(2)} ${quoteCcy}`;

  const sideIsBuy = side === 'BUY';
  const [moreOpen, setMoreOpen] = useState(false);

  // Theme-aware palette — flips to dark tokens when the user toggles theme
  // via the sun/moon button in the header (or the Settings > Appearance
  // dropdown). Accent colors (sell coral, buy blue) stay the same so brand
  // identity is consistent across modes.
  const theme = useThemeStore((s) => s.theme);
  const isDark = theme === 'dark';
  const C = isDark
    ? {
        pageBg:  '#131A29',
        cardBg:  '#1A2235',
        cardBg2: '#1F2A40',
        border:  '#2A3548',
        text:    '#F8FAFC',
        dim:     '#94A3B8',
        muted:   '#64748B',
        sell:    '#E56655',
        sellHi:  '#E5715B',
        buy:     '#2563EB',
        buyHi:   '#3B82F6',
      }
    : {
        pageBg:  '#F8FAFC',
        cardBg:  '#FFFFFF',
        cardBg2: '#F1F5F9',
        border:  '#E5E7EB',
        text:    '#0F172A',
        dim:     '#64748B',
        muted:   '#94A3B8',
        sell:    '#E56655',
        sellHi:  '#E5715B',
        buy:     '#2563EB',
        buyHi:   '#3B82F6',
      };

  // Toggle handler — flips intent in tradeSettings (persisted), which then
  // pushes the new effective theme to the theme store via applyAppearance.
  const toggleTheme = () => {
    const setAppearance = useTradeSettings.getState().set;
    setAppearance('trading.appearance', isDark ? 'light' : 'dark');
  };

  return (
    <div
      className="op-shell relative max-h-full overflow-x-hidden overflow-y-auto rounded-md p-3"
      style={{ background: C.pageBg, border: `1px solid ${C.border}` }}
    >
      {/* ── Top header: icon + symbol + close ───────────────────── */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AssetIcon row={instrument} size={24} round />
          <div className="text-[16px] font-bold tracking-tight truncate" style={{ color: C.text }}>
            {instrument?.baseCurrency || instrument?.symbol}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close order panel"
            className="shrink-0 w-7 h-7 flex items-center justify-center transition-opacity hover:opacity-100"
            style={{ color: C.dim, opacity: 0.85 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {/* ── Order entry mode dropdown ────────────────────────────── */}
      <div className="relative mb-2.5">
        <select
          value={openOrderMode}
          onChange={(e) => setOpenOrderMode('trading.openOrderMode', e.target.value)}
          aria-label="Order entry mode"
          className="appearance-none cursor-pointer w-full pl-3 pr-9 py-2 rounded text-[13px] font-medium focus:outline-none transition-colors"
          style={{ background: C.cardBg, border: `1px solid ${C.border}`, color: C.text }}
        >
          <option value="regular">Regular form</option>
          <option value="oneClick">One-click form</option>
          <option value="riskCalc">Risk calculator</option>
        </select>
        <svg
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: C.dim }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* ── Side-by-side Sell / Buy price cards ─────────────────── */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <SidePriceCard
          label="Sell"
          price={hasQuotes ? bid : null}
          prec={prec}
          active={!sideIsBuy}
          tone="sell"
          C={C}
          onClick={() => setSide('SELL')}
        />
        <SidePriceCard
          label="Buy"
          price={hasQuotes ? ask : null}
          prec={prec}
          active={sideIsBuy}
          tone="buy"
          C={C}
          onClick={() => setSide('BUY')}
        />
      </div>

      {/* ── Sentiment bar with centered spread chip ─────────────── */}
      {/* Exness-style: spread pill sits dead-center between the Sell/Buy
          cards, overlapping the gap. Negative top-margin pulls it up so it
          tucks into the gap between the cards (which sit above this row),
          z-10 keeps it above the sentiment bar. */}
      {hasQuotes && (
        <div className="relative mb-3">
          {/* Centered spread chip — overlaps gap between Sell/Buy cards */}
          <div className="absolute left-1/2 -translate-x-1/2 -top-4 z-10">
            <div
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap tabular-nums shadow-sm"
              style={{ background: C.cardBg, color: C.text, border: `1px solid ${C.border}` }}
            >
              {spreadAbs.toFixed(prec)} {instrument?.quoteCurrency || ''}
            </div>
          </div>
          <div className="flex items-center justify-between text-[12px] font-medium mb-1.5">
            <span style={{ color: C.sell }}>{sellPct.toFixed(0)}%</span>
            <span style={{ color: C.buy }}>{buyPct.toFixed(0)}%</span>
          </div>
          <div className="relative h-[3px] rounded-full overflow-hidden" style={{ background: C.cardBg }}>
            <div className="absolute inset-y-0 left-0 transition-all duration-500" style={{ width: `${sellPct}%`, background: C.sell }} />
            <div className="absolute inset-y-0 right-0 transition-all duration-500" style={{ width: `${buyPct}%`, background: C.buy }} />
          </div>
        </div>
      )}

      {/* ── Market / Pending tabs ────────────────────────────────── */}
      {!isOneClick && (
        <div className="grid grid-cols-2 gap-0 mb-3 rounded overflow-hidden" style={{ background: C.cardBg, border: `1px solid ${C.border}` }}>
          {[
            { id: 'MARKET', label: 'Market'  },
            { id: 'LIMIT',  label: 'Pending' },
          ].map((m) => {
            const active = orderMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setOrderMode(m.id);
                  if (m.id === 'LIMIT' && !price && instrument?.lastPrice) setPrice(instrument.lastPrice);
                }}
                className="text-[13px] font-medium py-1.5 transition-colors"
                style={{
                  background: active ? C.cardBg2 : 'transparent',
                  color: active ? C.text : C.dim,
                  border: active ? `1px solid ${C.border}` : 'none',
                  margin: active ? '-1px' : 0,
                  borderRadius: active ? '6px' : 0,
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Risk-calculator collapse (only when riskCalc mode) ──── */}
      {isRiskCalc && (() => {
        const free = Number(accountFree || 0);
        const riskAmt = free * (Number(riskPct) || 0) / 100;
        const dist = Number(stopDistance) || 0;
        const recommendedQty = dist > 0 ? (riskAmt / dist) : 0;
        return (
          <div className="mb-4 rounded p-3 space-y-2" style={{ background: C.cardBg, border: `1px solid ${C.border}` }}>
            <div className="text-[12px] font-medium" style={{ color: C.dim }}>Risk Calculator</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number" step="any"
                value={riskPct}
                onChange={(e) => setRiskPct(e.target.value)}
                placeholder="Risk %"
                className="w-full px-2 py-2 rounded-sm text-[13px] focus:outline-none"
                style={{ background: C.pageBg, border: `1px solid ${C.border}`, color: C.text }}
              />
              <input
                type="number" step="any"
                value={stopDistance}
                onChange={(e) => setStopDistance(e.target.value)}
                placeholder="Stop dist"
                className="w-full px-2 py-2 rounded-sm text-[13px] focus:outline-none"
                style={{ background: C.pageBg, border: `1px solid ${C.border}`, color: C.text }}
              />
            </div>
            <div className="flex items-center justify-between text-[12px]">
              <span style={{ color: C.dim }}>Risk · {fmtAcct(riskAmt)}</span>
              <button
                type="button"
                onClick={() => recommendedQty > 0 && setQuantity(recommendedQty.toFixed(4))}
                disabled={!recommendedQty}
                className="font-medium hover:underline disabled:no-underline disabled:opacity-50"
                style={{ color: C.buy }}
              >
                Use {recommendedQty > 0 ? recommendedQty.toFixed(4) : '—'} lots
              </button>
            </div>
          </div>
        );
      })()}

      <form onSubmit={submit} className="space-y-2.5">
        {/* ── Limit price (Pending only) ──────────────────────────── */}
        {orderMode === 'LIMIT' && (
          <FieldCard
            label="Limit Price"
            error={limitInvalidReason}
            subtext={!limitInvalidReason ? limitResolution.hint : null}
            C={C}
          >
            <NumericRow
              C={C}
              value={price}
              onChange={setPrice}
              onMinus={() => nudgePx(setPrice, price, -1)}
              onPlus={()  => nudgePx(setPrice, price,  1)}
              placeholder={instrument?.lastPrice ? Number(instrument.lastPrice).toFixed(prec) : '0.00'}
              pill="Limit"
              unified
              required
              error={!!limitInvalidReason}
            />
          </FieldCard>
        )}

        {/* ── Volume (Lots) — unified segmented bar ──────────────── */}
        <FieldCard label="Volume" C={C}>
          <NumericRow
            C={C}
            value={quantity}
            onChange={setQuantity}
            onMinus={() => nudgeQty(-1)}
            onPlus={() => nudgeQty(1)}
            placeholder={instrument?.minOrderSize ? String(instrument.minOrderSize) : '0.01'}
            suffix="Lots"
            unified
            required
          />
        </FieldCard>

        {/* ── Take Profit ─────────────────────────────────────────── */}
        {!isOneClick && (
          <FieldCard
            label="Take Profit"
            help="Auto-closes the position in profit when price reaches this level."
            C={C}
          >
            <NumericRow
              C={C}
              value={takeProfit}
              onChange={setTakeProfit}
              onMinus={() => nudgePx(setTakeProfit, takeProfit, -1)}
              onPlus={()  => nudgePx(setTakeProfit, takeProfit,  1)}
              placeholder="Not set"
              priceLabel
              unified
            />
          </FieldCard>
        )}

        {/* ── Stop Loss ──────────────────────────────────────────── */}
        {!isOneClick && (
          <FieldCard
            label="Stop Loss"
            help="Caps the loss by auto-closing the position when price hits this level."
            C={C}
          >
            <NumericRow
              C={C}
              value={stopLoss}
              onChange={setStopLoss}
              onMinus={() => nudgePx(setStopLoss, stopLoss, -1)}
              onPlus={()  => nudgePx(setStopLoss, stopLoss,  1)}
              placeholder="Not set"
              priceLabel
              unified
            />
          </FieldCard>
        )}

        {/* ── Insufficient margin warning ─────────────────────────── */}
        {overBudget && (
          <div className="rounded px-3 py-2.5 text-[12px] font-medium flex items-center gap-2" style={{ background: 'rgba(229,102,85,0.08)', border: `1px solid ${C.sell}`, color: C.sell }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
            Insufficient free margin
          </div>
        )}

        {/* ── Primary CTA: Confirm Sell/Buy <qty> lots ───────────── */}
        <button
          type="submit"
          disabled={loading || overBudget || !!limitInvalidReason}
          className="w-full py-2.5 rounded font-medium text-[14px] text-white transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: sideIsBuy ? C.buy : C.sell }}
        >
          {loading
            ? 'Placing…'
            : isOneClick
              ? `Quick ${sideIsBuy ? 'Buy' : 'Sell'}${quantity ? ` ${quantity} lots` : ''}`
              : `Confirm ${sideIsBuy ? 'Buy' : 'Sell'}${quantity ? ` ${quantity} lots` : ''}`}
        </button>

        {/* ── Cancel button ──────────────────────────────────────── */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2 rounded font-medium text-[13px] transition-colors"
            style={{ background: C.cardBg, color: C.text, border: `1px solid ${C.border}` }}
          >
            Cancel
          </button>
        )}

        {/* ── Bottom info: Fees · Leverage · Margin · More ───────── */}
        <div className="pt-1 text-[13px] space-y-1.5">
          <InfoRow
            C={C}
            label="Fees"
            value={feeEstimate > 0 ? `≈ ${fmtQuote(feeEstimate)}` : '—'}
            help={`Commission ${commFlat} + ${commPct}% · spread ${spreadAbs.toFixed(prec)} ${quoteCcy}/unit`}
          />
          <InfoRow
            C={C}
            label="Leverage"
            value={`1:${leverage}`}
            help={`Max for your plan: 1:${MAX_LEVERAGE_UI}.`}
          />
          <InfoRow
            C={C}
            label="Margin"
            value={requiredMargin > 0 ? fmtQuote(requiredMargin) : '—'}
            help="Locked while the position is open."
          />
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[13px] underline underline-offset-2 hover:no-underline pt-1 transition-opacity hover:opacity-80"
            style={{ color: C.dim }}
          >
            {moreOpen ? 'Less' : 'More'}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {moreOpen && (
            <div className="pt-3 mt-1 space-y-3" style={{ borderTop: `1px solid ${C.border}` }}>
              {/* Leverage slider */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px]" style={{ color: C.dim }}>Leverage</span>
                  <span className="inline-flex items-center gap-0.5 text-[12px] font-medium px-2 py-0.5 rounded-sm" style={{ background: C.cardBg, color: C.buy, border: `1px solid ${C.border}` }}>
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
                      className="w-12 bg-transparent text-right outline-none tabular-nums"
                      style={{ color: C.buy }}
                      aria-label="Leverage multiplier"
                    />
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={MAX_LEVERAGE_UI}
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="w-full h-1.5"
                  style={{ accentColor: C.buy }}
                />
                <div className="flex justify-between text-[11px] mt-1" style={{ color: C.muted }}>
                  <span>1×</span><span>{Math.round(MAX_LEVERAGE_UI / 2)}×</span><span>{MAX_LEVERAGE_UI}×</span>
                </div>
              </div>

              {qtyNum > 0 && refPrice > 0 && (
                <div className="space-y-1">
                  <InfoRow C={C} label="Notional" value={fmtAcct(notional)} />
                  <InfoRow
                    C={C}
                    label="Free after"
                    value={fmtAcct(remainingAfter)}
                    valueColor={overBudget ? C.sell : C.buy}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {isOneClick && (
          <div className="text-[11px] text-center" style={{ color: C.muted }}>
            One-click mode · order fires immediately at market price
          </div>
        )}
      </form>

      <style>{`
        .op-shell { scrollbar-width: thin; scrollbar-color: rgba(148,163,184,0.3) transparent; }
        .op-shell::-webkit-scrollbar { width: 5px; }
        .op-shell::-webkit-scrollbar-track { background: transparent; }
        .op-shell::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.3); border-radius: 9999px; }
        .op-shell::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,0.5); }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Presentational sub-components
// ──────────────────────────────────────────────────────────────────

function SidePriceCard({ label, price, prec, active, tone, C, onClick }) {
  const isBuy = tone === 'buy';
  const accent = isBuy ? C.buy : C.sell;
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative overflow-hidden rounded px-2.5 py-2 text-left transition-all duration-150"
      style={{
        background: active ? accent : C.cardBg,
        border: `1px solid ${accent}`,
        height: '62px',
      }}
    >
      <div className="text-[12px] font-normal mb-0.5" style={{ color: active ? 'rgba(255,255,255,0.85)' : C.dim }}>
        {label}
      </div>
      <div
        className="text-right text-[16px] font-medium tabular-nums leading-tight"
        style={{ color: active ? '#FFFFFF' : (isBuy ? C.buy : C.text) }}
      >
        {price !== null && Number.isFinite(price)
          ? price.toLocaleString('en-US', { minimumFractionDigits: prec, maximumFractionDigits: prec })
          : '—'}
      </div>
    </button>
  );
}

function FieldCard({ label, help, error, subtext, C, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-normal" style={{ color: C.text }}>{label}</span>
        {help && (
          <span
            title={help}
            aria-label={help}
            className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] cursor-help transition-opacity hover:opacity-100"
            style={{ border: `1px solid ${C.muted}`, color: C.muted, opacity: 0.75 }}
          >
            ?
          </span>
        )}
      </div>
      {children}
      {error && (
        <div className="mt-1.5 text-[12px] flex items-start gap-1.5 leading-snug" style={{ color: C.sell }}>
          <span className="shrink-0">⚠</span>
          <span>{error}</span>
        </div>
      )}
      {!error && subtext && (
        <div className="mt-1.5 text-[12px] leading-snug" style={{ color: C.dim }}>{subtext}</div>
      )}
    </div>
  );
}

function NumericRow({ value, onChange, onMinus, onPlus, placeholder, suffix, priceLabel, pill, unified, required, error, C }) {
  // Unified variant — single bordered bar with internal vertical dividers
  // between the input, suffix, minus, and plus segments (Exness-style
  // volume selector). Used when `unified` is true, typically with a suffix
  // like "Lots".
  if (unified) {
    return (
      <div
        className="flex items-stretch rounded-md overflow-hidden transition-all focus-within:ring-2 focus-within:ring-primary-500/15"
        style={{
          background: C.cardBg,
          border: `1px solid ${error ? C.sell : C.border}`,
          height: '42px',
          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
        }}
      >
        {/* Input segment — pr-2 leaves breathing room so trailing digits
            don't visually merge into the next segment. */}
        <div className="flex-1 min-w-0 flex items-center pl-3 pr-2">
          <input
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[15px] font-semibold tabular-nums"
            style={{ color: error ? C.sell : C.text }}
          />
        </div>
        {/* Pill segment — e.g. "Limit". No left divider; the only internal
            divider is the one before the minus button. */}
        {pill && (
          <div className="shrink-0 flex items-center px-2 text-[13px] font-medium" style={{ color: C.dim }}>
            {pill}
          </div>
        )}
        {/* Price segment — e.g. TP/SL "Price" label */}
        {priceLabel && (
          <div className="shrink-0 flex items-center px-2 text-[13px] font-medium" style={{ color: C.dim }}>
            Price
          </div>
        )}
        {/* Suffix segment — e.g. "Lots" */}
        {suffix && (
          <div className="shrink-0 flex items-center px-2 text-[13px] font-medium" style={{ color: C.dim }}>
            {suffix}
          </div>
        )}
        {/* Minus segment */}
        <button
          type="button"
          onClick={onMinus}
          aria-label="Decrease"
          className="shrink-0 w-11 flex items-center justify-center transition-colors hover:bg-black/[0.03] active:bg-black/[0.06]"
          style={{ borderLeft: `1px solid ${C.border}`, color: C.text }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        {/* Plus segment */}
        <button
          type="button"
          onClick={onPlus}
          aria-label="Increase"
          className="shrink-0 w-11 flex items-center justify-center transition-colors hover:bg-black/[0.03] active:bg-black/[0.06]"
          style={{ borderLeft: `1px solid ${C.border}`, color: C.text }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /><line x1="12" y1="5" x2="12" y2="19" /></svg>
        </button>
      </div>
    );
  }

  // Default variant — separated input + standalone -/+ buttons
  return (
    <div className="flex items-stretch gap-1.5">
      <div
        className="flex-1 min-w-0 flex items-center px-2.5 rounded transition-colors"
        style={{ background: C.cardBg, border: `1px solid ${error ? C.sell : C.border}`, height: '36px' }}
      >
        <input
          type="number"
          step="any"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[14px] tabular-nums"
          style={{ color: error ? C.sell : C.text }}
        />
        {pill && (
          <span
            className="shrink-0 inline-flex items-center text-[12px] font-medium ml-1.5 px-2 py-0.5 rounded-sm"
            style={{ background: C.cardBg2, color: C.text, border: `1px solid ${C.border}` }}
          >
            {pill}
          </span>
        )}
        {priceLabel && (
          <span
            className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium ml-1.5 px-2 py-0.5 rounded-sm"
            style={{ background: C.cardBg2, color: C.text, border: `1px solid ${C.border}` }}
          >
            Price
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </span>
        )}
        {suffix && (
          <span className="shrink-0 text-[13px] ml-2" style={{ color: C.dim }}>{suffix}</span>
        )}
      </div>
      <NudgeButton onClick={onMinus} aria-label="Decrease" C={C}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </NudgeButton>
      <NudgeButton onClick={onPlus} aria-label="Increase" C={C}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /><line x1="12" y1="5" x2="12" y2="19" /></svg>
      </NudgeButton>
    </div>
  );
}

function NudgeButton({ children, onClick, C, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      className="shrink-0 rounded transition-colors flex items-center justify-center hover:opacity-100"
      style={{ background: C.cardBg, border: `1px solid ${C.border}`, color: C.text, width: '36px', height: '36px', opacity: 0.95 }}
    >
      {children}
    </button>
  );
}

function InfoRow({ label, value, help, C, valueColor }) {
  return (
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1" style={{ color: C.dim }}>
        {label}:
      </span>
      <span className="inline-flex items-center gap-1.5 tabular-nums" style={{ color: valueColor || C.text }}>
        {value}
        {help && (
          <span
            title={help}
            aria-label={help}
            className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] cursor-help"
            style={{ border: `1px solid ${C.muted}`, color: C.muted, opacity: 0.7 }}
          >
            ?
          </span>
        )}
      </span>
    </div>
  );
}


