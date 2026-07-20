import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { orderToast } from '../utils/toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useTradeSettings } from '../store/tradeSettings';
import { useThemeStore } from '../store/theme';
import AssetIcon from './AssetIcon';
import WatchlistButton from './WatchlistButton';
import { useConfirm } from './ConfirmProvider';
import { getMarketSession } from '../utils/marketSession';

// Format an instrument-override expiry as "10 Jun 2026 22:00 UTC".
const fmtOverrideTime = (d) => {
  try {
    return new Date(d).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }) + ' UTC';
  } catch { return ''; }
};

export default function OrderForm({
  instrument,
  account,
  onPlaced,
  onPendingPriceChange,
  // Live order-preview callback — fires the full { side, mode, entry, tp,
  // sl } shape so the chart can draw Entry/TP/SL preview lines as the user
  // fills the form (gated behind the Show-on-Chart > Order preview toggle).
  // Purely visual — never places an order.
  onPreviewChange,
  // Drag-to-form sync: when the user drags an Entry/TP/SL preview pill on
  // the chart, the parent pushes the new absolute price here as
  // { price?, stopLoss?, takeProfit?, nonce }. A fresh nonce triggers a
  // one-shot apply into the form's state (display auto-syncs).
  externalLevels = null,
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


  // Leverage resolution (priority-based, instrument always wins):
  //   1. instrument.maxLeverage  — when set (>0), this is the final cap
  //                                even if it's higher OR lower than the
  //                                account would otherwise allow
  //   2. account/plan leverage   — leverageState.effectiveLeverage from
  //                                /user/leverage (plan default + admin
  //                                override)
  //   3. SYSTEM_DEFAULT          — final fallback when neither is set
  //
  // Demo accounts are no longer a hard-coded override: if an instrument
  // declares its own cap, demo accounts still respect it (per spec —
  // instrument leverage overrides everything). Demo only kicks in when
  // the instrument has nothing set, in which case it's unlimited.
  //
  // Platform supports 1:1 → 1:Unlimited (encoded as 999999). The
  // numeric input accepts the full range; the visual slider caps at
  // SLIDER_VISUAL_MAX so it stays usable. UNLIMITED_THRESHOLD is the
  // value at/above which the UI displays "Unlimited" instead of a number.
  const UNLIMITED_THRESHOLD = 999999;
  const SYSTEM_DEFAULT_LEVERAGE = 100;

  const isDemoAccount = account?.accountType === 'DEMO' || account?.accountType === 'VIRTUAL';
  // "Has instrument leverage" — null / undefined / 0 / negative all mean
  // "not set, fall back". Any positive finite number (including the
  // unlimited sentinel) is treated as an explicit instrument value.
  // `effectiveLeverage` reflects an ACTIVE scheduled override (lower or
  // higher) when one is running; otherwise it equals maxLeverage.
  const rawInstLev   = Number(instrument?.effectiveLeverage ?? instrument?.maxLeverage);
  const hasInstLev   = Number.isFinite(rawInstLev) && rawInstLev > 0;
  const accountCap   = Number(leverageState?.effectiveLeverage) || null;

  let MAX_LEVERAGE_UI;
  let capSource; // 'instrument' | 'account' | 'demo' | 'system'
  if (hasInstLev) {
    MAX_LEVERAGE_UI = rawInstLev;
    capSource       = 'instrument';
  } else if (isDemoAccount) {
    MAX_LEVERAGE_UI = UNLIMITED_THRESHOLD;
    capSource       = 'demo';
  } else if (accountCap && accountCap > 0) {
    MAX_LEVERAGE_UI = accountCap;
    capSource       = 'account';
  } else {
    MAX_LEVERAGE_UI = SYSTEM_DEFAULT_LEVERAGE;
    capSource       = 'system';
  }
  const SLIDER_VISUAL_MAX = Math.min(MAX_LEVERAGE_UI, 2000);
  // NOTE: `isUnlimited` (derived from the leverage state) is computed
  // AFTER the `leverage` useState declaration below — putting it here
  // hit a TDZ ReferenceError because `leverage` hadn't been initialized
  // yet at this point in the component body.
  // Initial slider position = account's default leverage, clamped to
  // the new ceiling. After the WS push arrives the re-clamp effect
  // below will snap it back into range if admin lowered the cap.
  const initialLev = Math.min(MAX_LEVERAGE_UI, Math.max(1, Number(account?.leverage) || 1));

  const [internalSide, setInternalSide] = useState(null); // no side until clicked
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
  // Both regular and one-click modes expose Market + Pending tabs so users
  // can queue limit orders even in one-click mode (the "one-click" part
  // just refers to skipping the confirm-dialog, not restricting to market).
  // Default to MARKET (the "Market" tab) — most orders are market; Pending
  // (LIMIT) is the deliberate, less-common choice.
  const [orderMode, setOrderMode] = useState('MARKET');
  const confirm = useConfirm();

  // Risk-calculator inputs — only shown when riskCalc mode is active.
  const [riskPct, setRiskPct] = useState('1');     // % of free margin to risk
  const [stopDistance, setStopDistance] = useState(''); // distance in price units
  // Quantity defaults to the instrument's minOrderSize (falling back to
  // 0.01 lots) so the user can fire a trade immediately without having
  // to type anything. They can still nudge / clear it.
  const [quantity, setQuantity] = useState(() => {
    const min = Number(instrument?.minOrderSize) || 0.01;
    return String(min);
  });
  const [price, setPrice] = useState(instrument?.lastPrice || '');
  // TP/SL display state — separate raw input vs absolute price.
  //   tpInput  / slInput  → exactly what the user typed in the current mode
  //   takeProfit / stopLoss → derived absolute price (sent to the backend,
  //                           drawn on the chart, used by autoTpSl)
  // Keeping `input` separate avoids the value-being-reformatted-while-typing
  // glitch that pure-derived state would cause (e.g. "5" → "5.0").
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  // Display modes:
  //   'price'   → raw asset price (default)
  //   'pips'    → distance from reference price in pips
  //   'money'   → desired USD profit (TP) / loss (SL)
  //   'percent' → same as money but expressed as % of free equity
  const [tpMode, setTpMode] = useState('price');
  const [slMode, setSlMode] = useState('price');
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [leverage, setLeverage] = useState(initialLev);
  // Indian cash-equity product type — Delivery (full cash) vs Intraday (leveraged
  // + auto square-off). Only shown/sent for NSE/BSE EQ.
  const [productType, setProductType] = useState('DELIVERY');
  const isIndianEquity = instrument?.segment === 'EQ'
    && (instrument?.exchange === 'NSE' || instrument?.exchange === 'BSE');
  const [loading, setLoading] = useState(false);
  const [accountFree, setAccountFree] = useState(null);

  // Derived flag — true when the user has set leverage to (or above)
  // the platform's "unlimited" sentinel. Must be declared AFTER
  // useState(leverage) to avoid a TDZ ReferenceError.
  const isUnlimited = leverage >= UNLIMITED_THRESHOLD;

  useEffect(() => {
    // Re-clamp whenever the cap can move — switching account, instrument,
    // or receiving a WS leverage update from admin. Snaps the slider
    // down (never up) so the form never submits a value above the cap.
    setLeverage((curr) => Math.min(MAX_LEVERAGE_UI, Math.max(1, curr)));
    setPrice(instrument?.lastPrice || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?._id, instrument?.lastPrice, account?._id, account?.leverage, leverageState?.effectiveLeverage]);

  // Hard guarantee — if leverage somehow exceeds the cap (e.g. an old
  // selection from before the cap arrived), snap it down. Only fires
  // when it's actually out-of-range so it can't loop.
  useEffect(() => {
    if (leverage > MAX_LEVERAGE_UI) setLeverage(MAX_LEVERAGE_UI);
  }, [leverage, MAX_LEVERAGE_UI]);

  // ── Instrument-level leverage override (from the enriched /instruments) ──
  // leverageOverride: { leverage, normalLeverage, endAt } — temporary cap.
  const leverageOverride = instrument?.leverageOverride || null;

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

  // Rich order-preview for the chart's Entry / TP / SL lines. Emits the
  // full level set live as the user edits volume / price / TP / SL. For
  // MARKET the entry tracks the live market price; for LIMIT it's the
  // limit price. Purely visual — no order is placed here.
  useEffect(() => {
    if (!onPreviewChange) return undefined;
    if (!side) { onPreviewChange(null); return undefined; } // no preview until a side is picked
    const mkt = Number(instrument?.lastPrice);
    const entry = orderMode === 'LIMIT'
      ? (Number(price) > 0 ? Number(price) : null)
      : (Number.isFinite(mkt) && mkt > 0 ? mkt : null);
    onPreviewChange({
      side,
      mode: orderMode,
      entry,
      tp: Number(takeProfit) > 0 ? Number(takeProfit) : null,
      sl: Number(stopLoss) > 0 ? Number(stopLoss) : null,
    });
  }, [side, orderMode, price, takeProfit, stopLoss, instrument?.lastPrice, onPreviewChange]);

  // Clear the preview when the form unmounts (panel closed / instrument
  // switch tears it down) so stale lines never linger on the chart.
  useEffect(() => () => { onPreviewChange && onPreviewChange(null); }, [onPreviewChange]);

  // sideOverride lets the one-click Sell/Buy price cards fire an order
  // with the clicked side without first waiting for `side` state to flush.
  // When called from the form's onSubmit it stays undefined and we use
  // the state-driven `side` as before.
  const submit = async (e, sideOverride) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const effectiveSide = sideOverride || side;
    if (!effectiveSide) return toast.error('Select Buy or Sell first');
    if (!account) return toast.error('No trading account selected');
    if (!quantity || Number(quantity) <= 0) return toast.error('Enter a valid quantity');
    if (orderMode === 'LIMIT') {
      if (!price || Number(price) <= 0) return toast.error('Enter a valid limit price');
      if (limitInvalidReason) return toast.error(limitInvalidReason);
    }
    // Indian order-safety (mirrors backend): tick size, circuit band, freeze qty.
    if (['NSE', 'BSE', 'NFO', 'BFO', 'MCX'].includes(instrument?.exchange)) {
      const tick = Number(instrument.tickSize) || 0;
      const uc = Number(instrument.upperCircuit) || 0;
      const lc = Number(instrument.lowerCircuit) || 0;
      const fz = Number(instrument.freezeQty) || 0;
      const px = orderMode === 'LIMIT' ? Number(price) : 0;
      if (px > 0) {
        if (tick > 0 && Math.abs(px / tick - Math.round(px / tick)) > 1e-6) return toast.error(`Price must be in multiples of ${tick}`);
        if (uc > 0 && px > uc) return toast.error(`Price above today's upper circuit (${uc})`);
        if (lc > 0 && px < lc) return toast.error(`Price below today's lower circuit (${lc})`);
      }
      if (fz > 0 && Number(quantity) > fz) return toast.error(`Max ${fz} per order (freeze limit) for ${instrument.symbol}`);
    }
    // Confirmation step — gated by "Confirm before order" setting AND
    // not in one-click mode (which by definition skips confirmation).
    if (confirmBeforeOrder && !isOneClick) {
      const sideLabel = effectiveSide === 'BUY' ? 'Buy' : 'Sell';
      const modeLabel = orderMode === 'LIMIT' ? `LIMIT @ ${price}` : 'MARKET';
      const ok = await confirm(`Confirm ${sideLabel} ${quantity} ${instrument?.baseCurrency} (${modeLabel}) with 1:${leverage} leverage?`);
      if (!ok) return;
    }
    setLoading(true);
    try {
      const payload = {
        accountId: account._id,
        symbol: instrument.symbol,
        side: effectiveSide,
        // Backend auto-resolves orderMode='LIMIT' into LIMIT or STOP based
        // on side + price vs current bid/ask. The user only ever sees
        // MARKET / LIMIT in the UI.
        orderMode,
        quantity,
        leverage,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      if (orderMode === 'LIMIT') payload.price = price;
      if (isIndianEquity) payload.productType = productType; // DELIVERY / INTRADAY
      // Skip 0 / negative / non-numeric — the truthy-string check used to
      // accept "0" and send a never-triggering threshold to the backend.
      if (Number(stopLoss) > 0)   payload.stopLoss = stopLoss;
      if (Number(takeProfit) > 0) payload.takeProfit = takeProfit;

      const { data } = await api.post('/trading/orders', payload);
      const sideWord = effectiveSide === 'BUY' ? 'Buy' : 'Sell';
      orderToast(`✓ ${sideWord} ${quantity} ${instrument.symbol} — Order ${data.data.status}`);
      onPlaced?.(data.data);
      // Reset form for the next entry — keep instrument/leverage/side
      // (sticky UX), reset quantity to the minimum-order default so the
      // user can fire again instantly, clear SL/TP so they don't bleed.
      setQuantity(String(Number(instrument?.minOrderSize) || 0.01));
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

  // ── TP/SL display-mode conversion helpers ──────────────────────────
  // Sign convention — for TP, profit moves price UP for BUY, DOWN for SELL.
  // SL flips that direction (loss is the opposite of profit). All
  // conversions reference the projected entry (refPrice).
  const _prec = Math.min(instrument?.pricePrecision || 2, 8);
  const _pipSize = Math.pow(10, -_prec);

  const _toPrice = (mode, raw, isTp) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) return '';
    if (mode === 'price') return v;
    if (!refPrice)        return '';
    const dirTp = side === 'BUY' ? 1 : -1;
    const dir   = isTp ? dirTp : -dirTp;
    if (mode === 'pips')  return refPrice + dir * v * _pipSize;
    if (mode === 'money') return qtyNum > 0 ? refPrice + dir * (v / qtyNum) : '';
    if (mode === 'percent') {
      if (!qtyNum || !free) return '';
      const targetPnl = (v / 100) * free;
      return refPrice + dir * (targetPnl / qtyNum);
    }
    return v;
  };
  // Format an amount with up to `dp` decimals but WITHOUT trailing zeros, so a
  // round value shows "100" instead of "100.00" (real cents stay: 100.5 →
  // "100.5", 100.25 → "100.25").
  const _trim = (n, dp) => {
    const r = Number(Number(n).toFixed(dp));
    return Number.isFinite(r) ? String(r) : '';
  };
  const _fromPrice = (mode, priceStr, isTp) => {
    const p = Number(priceStr);
    if (!Number.isFinite(p) || p === 0) return '';
    if (mode === 'price') return String(priceStr);
    if (!refPrice)        return '';
    const dirTp = side === 'BUY' ? 1 : -1;
    const dir   = isTp ? dirTp : -dirTp;
    const diff  = (p - refPrice) * dir;
    if (mode === 'pips')  return _trim(diff / _pipSize, 1);
    if (mode === 'money') return qtyNum > 0 ? _trim(diff * qtyNum, 2) : '';
    if (mode === 'percent') {
      if (!qtyNum || !free) return '';
      return _trim((diff * qtyNum / free) * 100, 2);
    }
    return String(priceStr);
  };

  // User typed in the TP/SL input — store the raw value as-is AND derive
  // the absolute price for backend submission / chart overlay.
  const _onInputChange = (mode, isTp, setInput, setPrice) => (raw) => {
    setInput(String(raw));
    if (raw === '' || raw === '-' || raw == null) { setPrice(''); return; }
    if (mode === 'price') { setPrice(String(raw)); return; }
    const px = _toPrice(mode, raw, isTp);
    if (px === '' || !Number.isFinite(Number(px))) { setPrice(''); return; }
    setPrice(Number(px).toFixed(_prec));
  };
  const tpOnChange = _onInputChange(tpMode, true,  setTpInput, setTakeProfit);
  const slOnChange = _onInputChange(slMode, false, setSlInput, setStopLoss);

  // User switched the dropdown — re-format the input string to match the
  // new mode based on the CURRENT absolute price. Display state stays in
  // sync without nuking the underlying takeProfit/stopLoss value.
  const _switchMode = (current, setMode, isTp, priceStr, setInput) => (next) => {
    if (next === current) return;
    if (!priceStr) { setMode(next); return; }
    const v = _fromPrice(next, priceStr, isTp);
    setInput(v);
    setMode(next);
  };
  const switchTpMode = _switchMode(tpMode, setTpMode, true,  takeProfit, setTpInput);
  const switchSlMode = _switchMode(slMode, setSlMode, false, stopLoss,   setSlInput);

  // External writers (autoTpSl, nudge buttons, partial-close, manual
  // overrides) call setTakeProfit/setStopLoss directly with an absolute
  // price. Mirror that into the input string so the field reflects it.
  useEffect(() => {
    setTpInput(_fromPrice(tpMode, takeProfit, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeProfit, tpMode, refPrice, qtyNum, free, side]);
  useEffect(() => {
    setSlInput(_fromPrice(slMode, stopLoss, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopLoss, slMode, refPrice, qtyNum, free, side]);

  // Apply a drag-originated level update from the chart preview pill. Force
  // the affected field back to 'price' mode so the dragged absolute price
  // shows verbatim, then write it — the _fromPrice effects above mirror it
  // into the display input. One-shot, keyed by nonce.
  const lastExtNonceRef = useRef(null);
  useEffect(() => {
    if (!externalLevels || externalLevels.nonce == null) return;
    if (externalLevels.nonce === lastExtNonceRef.current) return;
    lastExtNonceRef.current = externalLevels.nonce;
    if ('price' in externalLevels && externalLevels.price != null) {
      setPrice(String(externalLevels.price));
    }
    if ('takeProfit' in externalLevels) {
      setTpMode('price');
      setTakeProfit(externalLevels.takeProfit == null ? '' : String(externalLevels.takeProfit));
    }
    if ('stopLoss' in externalLevels) {
      setSlMode('price');
      setStopLoss(externalLevels.stopLoss == null ? '' : String(externalLevels.stopLoss));
    }
  }, [externalLevels]);

  // Short caption shown beneath each TP/SL row when a non-price mode is
  // active — surfaces the actual asset-price + a hint when the mode
  // can't be computed yet (no ref price, no quantity, no equity).
  const _modeCaption = (mode, isTp, priceStr) => {
    if (mode === 'price') return null;
    if (!refPrice) return 'Enter a reference price (or wait for the live quote) to use this mode.';
    if ((mode === 'money' || mode === 'percent') && !qtyNum) {
      return 'Enter a volume so the converter can size the P&L.';
    }
    if (mode === 'percent' && !free) {
      return 'Equity not loaded yet — check your account balance.';
    }
    if (!priceStr) return null;
    const p = Number(priceStr);
    return `≈ asset price ${Number.isFinite(p) ? p.toFixed(_prec) : '—'}`;
  };
  const tpCaption = _modeCaption(tpMode, true,  takeProfit);
  const slCaption = _modeCaption(slMode, false, stopLoss);

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
  const quoteCcy = instrument?.quoteCurrency || 'USD';
  const fmtQuote = (v) => `${Number(v).toFixed(2)} ${quoteCcy}`;
  // Notional is denominated in the INSTRUMENT's quote currency (e.g. USD for
  // BTCUSD), not the account currency — format it with that symbol so an INR
  // account doesn't show a USD figure with a ₹ sign.
  const quoteSym = quoteCcy === 'INR' ? '₹' : quoteCcy === 'USD' ? '$' : `${quoteCcy} `;
  const fmtQuoteAmt = (v) =>
    `${quoteSym}${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const commPctAmt = notional > 0 ? (notional * commPct / 100) : 0;

  // Indian cash equity: statutory pass-through estimate (STT/exchange/SEBI/GST).
  // Preview only — intraday sell-leg rates; backend computes the exact figure at
  // settle (services/indianCharges.js).
  const isIndianEq = instrument?.exchange === 'NSE' || instrument?.exchange === 'BSE';
  let statutory = 0;
  let statutoryLines = [];
  if (isIndianEq && notional > 0) {
    const delivery = productType === 'DELIVERY';
    const sttRate = delivery ? 0.001 : 0.00025; // delivery 0.1% (both legs) vs intraday 0.025% sell
    const stt  = notional * sttRate;
    const exch = notional * 0.0000297;   // NSE transaction charge
    const sebi = notional * 0.000001;    // SEBI turnover fee
    const gst  = (commFlat + commPctAmt + exch + sebi) * 0.18;
    statutory = stt + exch + sebi + gst;
    statutoryLines = [
      'Statutory charges (NSE est.)',
      `• STT (${delivery ? '0.1% both legs' : '0.025% sell'}): ${fmtQuote(stt)}`,
      `• Exchange + SEBI: ${fmtQuote(exch + sebi)}`,
      `• GST (18%): ${fmtQuote(gst)}`,
    ];
  }

  const feeEstimate = qtyNum > 0 && notional > 0
    ? commFlat + commPctAmt + spreadCost + statutory
    : 0;

  // Itemised fee breakdown for the "Fees ⓘ" tooltip.
  const feeHelp = [
    `Total fee = commission + charges + spread${isIndianEq ? ' + statutory' : ' cost'}`,
    ...(commPct > 0 ? ['Commission', `• Percentage (${commPct}% × ${fmtQuote(notional)} notional): ${fmtQuote(commPctAmt)}`] : []),
    ...(commFlat > 0 ? ['Charges', `• Fixed: ${fmtQuote(commFlat)}`] : []),
    'Spread',
    `• Spread cost (${spreadAbs.toFixed(prec)} ${quoteCcy} × ${qtyNum || 0} qty): ${fmtQuote(spreadCost)}`,
    ...statutoryLines,
    '──────────',
    `Total ≈ ${fmtQuote(feeEstimate)}`,
  ].filter(Boolean).join('\n');

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
        sell:    '#EF4444',
        sellHi:  '#F87171',
        buy:     '#22C55E',
        buyHi:   '#4ADE80',
      }
    : {
        pageBg:  '#F8FAFC',
        cardBg:  '#FFFFFF',
        cardBg2: '#F1F5F9',
        border:  '#E5E7EB',
        text:    '#0F172A',
        dim:     '#64748B',
        muted:   '#94A3B8',
        sell:    '#EF4444',
        sellHi:  '#F87171',
        buy:     '#22C55E',
        buyHi:   '#4ADE80',
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
      {/* ── Top header: icon + symbol + watchlist + close ───────────
          The bookmark sits right next to the symbol, directly above the
          Sell/Buy cards — i.e. the [Symbol] [Bookmark] [Buy] [Sell] layout.
          Opens the shared "Add to Watchlist" modal for the active instrument
          and shows a filled/active state when it's already saved. */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AssetIcon row={instrument} size={24} round />
          <div className="text-[16px] font-bold tracking-tight truncate" style={{ color: C.text }}>
            {instrument?.baseCurrency || instrument?.symbol}
          </div>
          {instrument?.symbol && (
            <WatchlistButton symbol={instrument.symbol} row={instrument} variant="ghost" size={18} persistent className="shrink-0" />
          )}
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

      {/* ── Market-closed banner (exchange-bound instruments) ──────── */}
      {(() => {
        const s = getMarketSession(instrument);
        if (s.isOpen) return null;
        return (
          <div
            className="mb-2.5 rounded px-3 py-2 text-[12px] font-medium flex items-center gap-2"
            style={{ background: 'rgba(234,88,12,0.10)', border: '1px solid #EA580C', color: '#EA580C' }}
          >
            <span>⏱</span>
            <span>{s.label}{s.detail ? ` — ${s.detail}` : ''}</span>
          </div>
        );
      })()}

      {/* ── Futures/options expiry line ──────────────────────────── */}
      {instrument?.expiryDate && (instrument?.segment === 'FUT' || instrument?.segment === 'OPT') && (() => {
        const exp = new Date(instrument.expiryDate);
        const days = Math.ceil((exp.getTime() - Date.now()) / 86400000);
        const dstr = exp.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        return (
          <div
            className="mb-2.5 rounded px-3 py-1.5 text-[11px] flex items-center justify-between"
            style={{ background: C.cardBg, border: `1px solid ${C.border}`, color: C.dim }}
          >
            <span>⏳ Expiry</span>
            <span style={{ color: days <= 2 && days >= 0 ? '#EA580C' : C.text }}>
              {dstr}{days >= 0 ? ` · ${days}d left` : ' · expired'}
            </span>
          </div>
        );
      })()}

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

      {/* ── Side-by-side Sell / Buy price cards ───────────────────
          In ONE-CLICK mode these cards ARE the trade-fire button:
          clicking Sell fires a SELL order with the current quantity,
          clicking Buy fires a BUY. In regular mode they just toggle
          the side selection for the bottom Confirm CTA. */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <SidePriceCard
          label="Sell"
          price={hasQuotes ? bid : null}
          prec={prec}
          active={side === 'SELL'}
          tone="sell"
          C={C}
          onClick={() => {
            setSide('SELL');
            if (isOneClick) submit(null, 'SELL');
          }}
        />
        <SidePriceCard
          label="Buy"
          price={hasQuotes ? ask : null}
          prec={prec}
          active={side === 'BUY'}
          tone="buy"
          C={C}
          onClick={() => {
            setSide('BUY');
            if (isOneClick) submit(null, 'BUY');
          }}
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

      {/* ── Market / Pending tabs — visible in both regular & one-click ── */}
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

        {/* ── Temporary leverage override banner ──────────────────── */}
        {leverageOverride && (
          <div
            className="rounded-md px-3 py-2 text-[12px] leading-snug"
            style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.40)', color: '#d97706' }}
          >
            <div className="font-bold flex items-center gap-1">⚠ Temporary Leverage Override Active</div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: C.text }}>
              <span>Current Leverage: <b>1:{leverageOverride.leverage}</b></span>
              <span style={{ color: C.dim }}>Normal: 1:{leverageOverride.normalLeverage}</span>
              {leverageOverride.endAt && <span style={{ color: C.dim }}>Expires: {fmtOverrideTime(leverageOverride.endAt)}</span>}
            </div>
          </div>
        )}

        {/* ── Product type (Indian cash equity only): Delivery vs Intraday ── */}
        {isIndianEquity && (
          <div className="flex gap-2">
            {[
              { id: 'DELIVERY', label: 'Delivery', hint: '1x · full cash' },
              { id: 'INTRADAY', label: 'Intraday', hint: '5x · auto sq-off 3:15' },
            ].map((p) => {
              const active = productType === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProductType(p.id)}
                  className={`flex-1 rounded-xl border px-3 py-2 text-left transition-colors ${
                    active ? 'border-primary-500 bg-primary-500/10' : 'border-border-dark hover:bg-bg-hover'
                  }`}
                >
                  <div className={`text-[13px] font-bold ${active ? 'text-primary-600' : 'text-text-primary'}`}>{p.label}</div>
                  <div className="text-[10px] text-text-muted">{p.hint}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Indian order-safety hint: today's circuit band + per-order freeze cap. */}
        {['NSE', 'BSE', 'NFO', 'BFO', 'MCX'].includes(instrument?.exchange)
          && (instrument?.upperCircuit || instrument?.freezeQty) && (
          <div className="text-[10px] text-text-muted px-1">
            {instrument?.lowerCircuit && instrument?.upperCircuit ? `Circuit ${instrument.lowerCircuit}–${instrument.upperCircuit}` : ''}
            {instrument?.freezeQty ? `${instrument?.upperCircuit ? '  ·  ' : ''}Max ${instrument.freezeQty}/order` : ''}
          </div>
        )}

        {/* ── Volume — unified segmented bar. For F&O the qty is in units
            (lots × lotSize); show the lot size + the lot equivalent. ──── */}
        {(() => {
          const isDeriv = instrument?.segment === 'FUT' || instrument?.segment === 'OPT';
          const lotSz = Number(instrument?.lotSize) || 1;
          const lots = isDeriv && qtyNum > 0 ? qtyNum / lotSz : 0;
          return (
            <FieldCard
              label={isDeriv ? `Volume (1 lot = ${lotSz})` : 'Volume'}
              subtext={isDeriv && lots > 0 ? `= ${lots.toLocaleString('en-IN', { maximumFractionDigits: 2 })} lot${lots === 1 ? '' : 's'}` : undefined}
              C={C}
            >
              <NumericRow
                C={C}
                value={quantity}
                onChange={setQuantity}
                onMinus={() => nudgeQty(-1)}
                onPlus={() => nudgeQty(1)}
                placeholder={instrument?.minOrderSize ? String(instrument.minOrderSize) : '0.01'}
                suffix={isDeriv ? 'Units' : 'Lots'}
                unified
                required
              />
            </FieldCard>
          );
        })()}

        {/* ── Take Profit ─────────────────────────────────────────── */}
        {!isOneClick && (
          <FieldCard
            label="Take Profit"
            help="Auto-closes the position in profit when price reaches this level."
            C={C}
            subtext={tpCaption}
          >
            <NumericRow
              C={C}
              value={tpInput}
              onChange={tpOnChange}
              onMinus={() => nudgePx(setTakeProfit, takeProfit, -1)}
              onPlus={()  => nudgePx(setTakeProfit, takeProfit,  1)}
              placeholder={tpMode === 'price' ? 'Not set'
                : tpMode === 'pips'           ? 'e.g. 50'
                : tpMode === 'money'          ? 'e.g. 25.00'
                : 'e.g. 0.5'}
              priceLabel
              priceLabelMode={tpMode}
              onPriceLabelChange={switchTpMode}
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
            subtext={slCaption}
          >
            <NumericRow
              C={C}
              value={slInput}
              onChange={slOnChange}
              onMinus={() => nudgePx(setStopLoss, stopLoss, -1)}
              onPlus={()  => nudgePx(setStopLoss, stopLoss,  1)}
              placeholder={slMode === 'price' ? 'Not set'
                : slMode === 'pips'           ? 'e.g. 30'
                : slMode === 'money'          ? 'e.g. 15.00'
                : 'e.g. 0.3'}
              priceLabel
              priceLabelMode={slMode}
              onPriceLabelChange={switchSlMode}
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

        {/* ── Primary CTA: Confirm Sell/Buy <qty> lots ─────────────
            Hidden in one-click mode — the top Sell/Buy price cards ARE
            the fire-button there. */}
        {!isOneClick && (
          <button
            type="submit"
            disabled={loading || overBudget || !!limitInvalidReason || !side}
            className="w-full py-2.5 rounded font-medium text-[14px] text-white transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: !side ? '#94A3B8' : sideIsBuy ? C.buy : C.sell }}
          >
            {loading
              ? 'Placing…'
              : !side
                ? 'Select Buy or Sell'
                : `Confirm ${sideIsBuy ? 'Buy' : 'Sell'}${quantity ? ` ${quantity} lots` : ''}`}
          </button>
        )}

        {/* ── Cancel button — same gating: one-click mode doesn't
            need it since clicking outside the panel / closing it via
            chevron does the same thing. */}
        {!isOneClick && onClose && (
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
            help={feeHelp}
          />
          <InfoRow
            C={C}
            label="Leverage"
            value={leverage >= UNLIMITED_THRESHOLD ? 'Unlimited' : `1:${leverage}`}
            help={
              capSource === 'instrument'
                ? `Instrument leverage: ${MAX_LEVERAGE_UI >= UNLIMITED_THRESHOLD ? 'Unlimited' : `1:${MAX_LEVERAGE_UI}`} (overrides account).`
                : capSource === 'demo'
                  ? 'Demo account · no leverage cap.'
                  : capSource === 'account'
                    ? `Account leverage: 1:${MAX_LEVERAGE_UI}.`
                    : `System default: 1:${MAX_LEVERAGE_UI}.`
            }
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
              {/* Leverage — full 1:1 → 1:Unlimited range. Slider stays
                  capped at SLIDER_VISUAL_MAX (≤2000) so it's draggable;
                  the numeric input and "Unlimited" chip cover the rest.
                  Effective leverage cap from /user/leverage still
                  applies — values above it are clamped on input. */}
              <div>
                {/* ── Header row: label + current value + source pill ── */}
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[12px] font-medium" style={{ color: C.dim }}>Leverage</span>
                    {isUnlimited ? (
                      <span className="text-[15px] font-bold tracking-tight" style={{ color: C.buy }}>
                        Unlimited
                      </span>
                    ) : (
                      <span className="inline-flex items-baseline gap-1 text-[15px] font-bold tracking-tight" style={{ color: C.buy }}>
                        <span className="opacity-60 text-[12px]">1:</span>
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
                          className="w-12 bg-transparent outline-none tabular-nums font-bold"
                          style={{ color: C.buy }}
                          aria-label="Leverage multiplier"
                        />
                      </span>
                    )}
                  </div>
                  {capSource === 'instrument' && (
                    <span
                      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: 'rgba(245,158,11,0.12)', color: '#B45309' }}
                      title="This instrument's cap overrides your account / plan."
                    >
                      Instrument
                    </span>
                  )}
                  {capSource === 'demo' && (
                    <span
                      className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: 'rgba(16,185,129,0.12)', color: '#047857' }}
                    >
                      Demo
                    </span>
                  )}
                </div>

                {/* ── Slider — hidden when Unlimited (it's meaningless
                    against an unbounded scale). Scale ticks compress to
                    1× / mid / max. ── */}
                {!isUnlimited && (
                  <>
                    <input
                      type="range"
                      min={1}
                      max={SLIDER_VISUAL_MAX}
                      value={Math.min(leverage, SLIDER_VISUAL_MAX)}
                      onChange={(e) => setLeverage(Number(e.target.value))}
                      className="w-full h-1.5"
                      style={{ accentColor: C.buy }}
                    />
                    <div className="flex justify-between text-[10px] mt-0.5" style={{ color: C.muted }}>
                      <span>1×</span><span>{Math.round(SLIDER_VISUAL_MAX / 2)}×</span><span>{SLIDER_VISUAL_MAX}×</span>
                    </div>
                  </>
                )}

                {/* ── Preset chip grid — uniform 3-column layout so all
                    six picks (1:1 · 1:10 · 1:100 · 1:500 · 1:1000 ·
                    1:Unlimited) align in two clean rows. ── */}
                <div className="grid grid-cols-3 gap-1.5 mt-2.5">
                  {(() => {
                    const unlockedUnlimited = MAX_LEVERAGE_UI >= UNLIMITED_THRESHOLD;
                    const chips = [
                      { label: '1:1',         value: 1,                     locked: false },
                      { label: '1:10',        value: 10,                    locked: 10 > MAX_LEVERAGE_UI },
                      { label: '1:100',       value: 100,                   locked: 100 > MAX_LEVERAGE_UI },
                      { label: '1:500',       value: 500,                   locked: 500 > MAX_LEVERAGE_UI },
                      { label: '1:1000',      value: 1000,                  locked: 1000 > MAX_LEVERAGE_UI },
                      { label: 'Unlimited',   value: UNLIMITED_THRESHOLD,   locked: !unlockedUnlimited, isUnl: true },
                    ];
                    return chips.map((c) => {
                      const active = c.isUnl ? isUnlimited : (!isUnlimited && leverage === c.value);
                      return (
                        <button
                          key={c.label}
                          type="button"
                          disabled={c.locked}
                          onClick={() => !c.locked && setLeverage(c.value)}
                          className="text-[11px] font-bold py-1.5 rounded transition-all"
                          style={{
                            background: active ? C.buy : C.cardBg,
                            color: c.locked ? C.muted : (active ? '#FFFFFF' : C.text),
                            border: `1px solid ${active ? C.buy : C.border}`,
                            opacity: c.locked ? 0.4 : 1,
                            cursor: c.locked ? 'not-allowed' : 'pointer',
                          }}
                          title={c.locked ? `Capped at 1:${MAX_LEVERAGE_UI}` : undefined}
                        >
                          {c.label}
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>

              {qtyNum > 0 && refPrice > 0 && (
                <div className="space-y-1">
                  <InfoRow C={C} label="Notional" value={fmtQuoteAmt(notional)} />
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

// Custom hover tooltip — replaces the native `title=""` (which can't be
// hovered, has a show delay, and looks plain). The popup sits flush above the
// "?" (no gap) so the cursor can move into it; styled to match the panel.
function HelpTip({ text, C }) {
  return (
    <span className="relative inline-flex group align-middle">
      <span
        className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[10px] cursor-help select-none"
        style={{ border: `1px solid ${C.muted}`, color: C.muted, opacity: 0.8 }}
        aria-label={text}
      >?</span>
      <span
        role="tooltip"
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity duration-150 absolute right-0 bottom-full z-50 w-64 whitespace-pre-line rounded-lg p-2.5 text-[11px] leading-snug shadow-xl"
        style={{ background: C.cardBg, color: C.text, border: `1px solid ${C.border}` }}
      >
        {text}
      </span>
    </span>
  );
}

function FieldCard({ label, help, error, subtext, C, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-normal" style={{ color: C.text }}>{label}</span>
        {help && <HelpTip text={help} C={C} />}
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

function NumericRow({
  value, onChange, onMinus, onPlus, placeholder, suffix, priceLabel,
  // priceLabelMode / onPriceLabelChange — when provided, the static
  // "Price" pill becomes an interactive dropdown letting the user pick
  // how the field is expressed (price / pips / money / % of equity).
  priceLabelMode, onPriceLabelChange,
  pill, unified, required, error, disabled, C,
}) {
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
          opacity: disabled ? 0.65 : 1,
          cursor: disabled ? 'not-allowed' : 'auto',
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
            disabled={disabled}
            readOnly={disabled}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[15px] font-semibold tabular-nums disabled:cursor-not-allowed"
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
        {/* Price segment — interactive dropdown when a mode is wired,
            falls back to a plain "Price" label otherwise. */}
        {priceLabel && (
          onPriceLabelChange
            ? <PriceModeDropdown C={C} mode={priceLabelMode || 'price'} onChange={onPriceLabelChange} />
            : <div className="shrink-0 flex items-center px-2 text-[13px] font-medium" style={{ color: C.dim }}>Price</div>
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
          disabled={disabled}
          aria-label="Decrease"
          className="shrink-0 w-11 flex items-center justify-center transition-colors hover:bg-black/[0.03] active:bg-black/[0.06] disabled:cursor-not-allowed"
          style={{ borderLeft: `1px solid ${C.border}`, color: C.text }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        {/* Plus segment */}
        <button
          type="button"
          onClick={onPlus}
          disabled={disabled}
          aria-label="Increase"
          className="shrink-0 w-11 flex items-center justify-center transition-colors hover:bg-black/[0.03] active:bg-black/[0.06] disabled:cursor-not-allowed"
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

/**
 * PriceModeDropdown — segment inside NumericRow that lets the user pick
 * how a TP/SL field is expressed (price / pips / money / % of equity).
 * Renders the current mode label + caret; clicking opens a floating
 * menu. Closes on outside click or ESC.
 */
const PRICE_MODE_OPTIONS = [
  { id: 'price',   label: 'By asset price' },
  { id: 'pips',    label: 'In pips' },
  { id: 'money',   label: 'In money' },
  { id: 'percent', label: 'In % of equity' },
];
const PRICE_MODE_SHORT = {
  price:   'Price',
  pips:    'Pips',
  money:   'Money',
  percent: '% Eq.',
};
function PriceModeDropdown({ C, mode, onChange }) {
  const [open, setOpen] = useState(false);
  // Anchored coords for the fixed-position panel. We compute them from
  // the trigger button's bounding rect each time we open the menu —
  // necessary because the NumericRow parent has overflow-hidden (for
  // its rounded corners) which would otherwise clip an absolutely-
  // positioned dropdown.
  const [coords, setCoords] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);

  const computeCoords = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };

  useEffect(() => {
    if (!open) return;
    computeCoords();
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onReflow = () => computeCoords();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="shrink-0 flex items-stretch">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-2 text-[13px] font-medium cursor-pointer transition-colors hover:bg-bg-hover/40"
        style={{ color: C.dim }}
      >
        <span>{PRICE_MODE_SHORT[mode] || 'Price'}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ color: C.dim, opacity: 0.7 }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && coords && (
        <div
          className="fixed rounded-md shadow-elevated overflow-hidden z-[60]"
          style={{
            top: coords.top,
            right: coords.right,
            width: 140,
            background: C.cardBg,
            border: `1px solid ${C.border}`,
            animation: 'pmdOpen 140ms ease-out',
            boxShadow: '0 10px 30px rgba(15,23,42,0.18), 0 2px 6px rgba(15,23,42,0.08)',
          }}
        >
          <style>{`@keyframes pmdOpen { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          {PRICE_MODE_OPTIONS.map((opt) => {
            const active = opt.id === mode;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => { onChange?.(opt.id); setOpen(false); }}
                className="w-full text-left px-2.5 py-1.5 text-[12px] transition-colors hover:bg-bg-hover/40"
                style={{
                  color: active ? C.buy : C.text,
                  background: active ? 'rgba(59,130,246,0.08)' : 'transparent',
                  fontWeight: active ? 600 : 500,
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
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
        {help && <HelpTip text={help} C={C} />}
      </span>
    </div>
  );
}


