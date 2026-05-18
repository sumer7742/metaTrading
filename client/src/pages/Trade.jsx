import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import PriceChart from '../components/PriceChart';
import OrderForm from '../components/OrderForm';
import NotificationCenter from '../components/NotificationCenter';
import MarketWatch from '../components/MarketWatch';
import { fmtNum, fmtPnlSimple, fmtMoney, fmtPriceDual, fmtMoneyDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import { useThemeStore } from '../store/theme';
import { Link } from 'react-router-dom';
import { recordRecentlyViewed } from '../hooks/useRecentlyViewed';
import AssetIcon from '../components/AssetIcon';

// Drawing-tools rail — the icon row that sits to the left of the chart.
// Selection state is tracked locally so the rail feels alive even though
// the underlying lightweight-charts drawing primitives aren't wired yet.
const ToolIcon = ({ d, ...p }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const DRAW_TOOLS = [
  { key: 'cursor',  label: 'Cursor',         icon: <ToolIcon d="M3 3l7 17 2-8 8-2z" /> },
  { key: 'cross',   label: 'Crosshair',      icon: <ToolIcon d={['M12 2v20', 'M2 12h20']} /> },
  { key: 'trend',   label: 'Trend line',     icon: <ToolIcon d="M4 20L20 4" /> },
  { key: 'hline',   label: 'Horizontal',     icon: <ToolIcon d="M3 12h18" /> },
  { key: 'vline',   label: 'Vertical',       icon: <ToolIcon d="M12 3v18" /> },
  { key: 'fib',     label: 'Fibonacci',      icon: <ToolIcon d={['M3 5h18', 'M3 9h18', 'M3 13h18', 'M3 17h18']} /> },
  { key: 'rect',    label: 'Rectangle',      icon: <ToolIcon d="M4 4h16v16H4z" /> },
  { key: 'ellipse', label: 'Ellipse',        icon: <ToolIcon d="M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z" /> },
  { key: 'text',    label: 'Text',           icon: <ToolIcon d={['M5 5h14', 'M12 5v14']} /> },
  { key: 'ruler',   label: 'Measure',        icon: <ToolIcon d={['M3 21L21 3', 'M9 15l-2 2', 'M13 11l-2 2', 'M17 7l-2 2']} /> },
  { key: 'magnet',  label: 'Magnet',         icon: <ToolIcon d={['M5 9V4h4v8M15 4h4v5', 'M5 12a7 7 0 0 0 14 0']} /> },
  { key: 'eraser',  label: 'Clear drawings', icon: <ToolIcon d={['M20 20H7L3 16l9-9 9 9z', 'M14 14L9 9']} /> },
];

export default function Trade() {
  const [params, setParams] = useSearchParams();
  const symbol = params.get('symbol') || 'BTCUSD';
  const [timeframe, setTimeframe] = useState('1m');
  const [instruments, setInstruments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  // Restore the user's last-selected trading account from localStorage on
  // mount so a page refresh / re-login keeps them on the right account
  // instead of always snapping back to the first (often the demo).
  const ACCOUNT_KEY = 'tradepro:selected-account';
  const [selectedAccountId, _setSelectedAccountId] = useState(() => {
    if (typeof window === 'undefined') return null;
    try { return localStorage.getItem(ACCOUNT_KEY) || null; } catch (_) { return null; }
  });
  const setSelectedAccountId = (id) => {
    _setSelectedAccountId(id);
    try { if (id) localStorage.setItem(ACCOUNT_KEY, id); } catch (_) {}
  };
  const [openOrders, setOpenOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [tab, setTab] = useState('positions');
  // Map of symbol -> latest live price (for ALL positions, not just selected chart)
  const [priceMap, setPriceMap] = useState({});
  const [livePrice, setLivePrice] = useState(null);
  // Live preview from OrderForm: { side, type, price } while user is typing.
  // Shown as a dotted price line on the chart so the user can see exactly
  // where their LIMIT/STOP would sit before they click Place.
  const [pendingPreview, setPendingPreview] = useState(null);
  // Market watch popover state.
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchSearch, setWatchSearch] = useState('');
  // Instruments-panel category filter. 'ALL' shows every active
  // instrument; 'FAV' shows only starred symbols; any other value
  // filters to that asset class (FOREX, CRYPTO, COMMODITY, INDEX,
  // STOCK, …) derived live from the instruments dataset so we never
  // hard-code a list that could drift.
  const [instrumentCategory, setInstrumentCategory] = useState('ALL');
  // Favourites — Set of symbol strings. Shares the same localStorage
  // key (`tradepro:favorites`) as the MarketWatch widget so stars
  // toggled in either place stay in sync.
  const [favorites, setFavorites] = useState(() => {
    if (typeof window === 'undefined') return new Set();
    try { return new Set(JSON.parse(localStorage.getItem('tradepro:favorites') || '[]')); }
    catch (_) { return new Set(); }
  });
  const toggleFavorite = useCallback((sym) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      try { localStorage.setItem('tradepro:favorites', JSON.stringify([...next])); } catch (_) {}
      return next;
    });
  }, []);
  // Cross-tab / cross-component sync — if MarketWatch toggles a star
  // in another tab, mirror it here.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== 'tradepro:favorites') return;
      try { setFavorites(new Set(JSON.parse(e.newValue || '[]'))); }
      catch (_) {}
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // Chart layout mode — independent flags for each side panel + a
  // fullscreen toggle. The "Expand" toolbar button collapses both side
  // panels at once for a chart-focused view; the per-panel × handles
  // collapse each side independently.
  const [chartView, setChartView] = useState(
    // Auto-enter fullscreen when the user lands via the header's Terminal
    // button (URL flag `?view=terminal`). Strip the flag after we apply it
    // so a normal navigation away + back doesn't lock the user in.
    params.get('view') === 'terminal' ? 'fullscreen' : 'normal'
  );
  const [showInstruments, setShowInstruments] = useState(true);
  const [showOrderPanel, setShowOrderPanel] = useState(true);

  // Clean the `view=terminal` flag from the URL once we've consumed it, so
  // the user can exit fullscreen and stay on /trade in normal mode.
  useEffect(() => {
    if (params.get('view') === 'terminal') {
      const next = new URLSearchParams(params);
      next.delete('view');
      setParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track every symbol the user lands on for the Explore "Recently viewed"
  // rail. localStorage-backed, no backend hit.
  useEffect(() => {
    if (symbol) recordRecentlyViewed(symbol);
  }, [symbol]);
  const [activeDrawTool, setActiveDrawTool] = useState('cursor');
  // Order side (BUY/SELL) is owned by the chart-top quick-trade chip so
  // the chip and the order form stay in sync.
  const [orderSide, setOrderSide] = useState('BUY');
  // In fullscreen the side OrderForm aside is hidden — instead the
  // BUY/SELL chip pops the order form as a glass overlay floating on
  // top of the chart, TradingView-style. This flag controls that
  // overlay; auto-resets when the user exits fullscreen so a stale
  // overlay doesn't reappear next time they re-enter.
  const [showFloatingOrder, setShowFloatingOrder] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // The account dropdown has two sub-views: 'metrics' (Exness-style
  // numbers + quick-actions) and 'switch' (account picker list).
  // Resets to 'metrics' every time the menu closes.
  const [accountMenuView, setAccountMenuView] = useState('metrics');
  const [hideBalance, setHideBalance] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('tradepro:hide-balance') === '1'; }
    catch (_) { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tradepro:hide-balance', hideBalance ? '1' : '0'); } catch (_) {}
  }, [hideBalance]);
  useEffect(() => {
    if (!accountMenuOpen) setAccountMenuView('metrics');
  }, [accountMenuOpen]);
  const accountMenuRef = useRef(null);

  // ── Resizable bottom panel (Open / Pending / Closed) ──────────────────
  // Persisted in localStorage so the user's preferred chart-to-tabs split
  // survives reloads — matches TradingView / Exness behaviour.
  const BOTTOM_KEY = 'tradepro:bottom-panel';
  const [bottomState, setBottomState] = useState(() => {
    if (typeof window === 'undefined') return { height: 240, collapsed: false };
    try {
      const raw = localStorage.getItem(BOTTOM_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          height: Math.max(80, Math.min(640, Number(parsed.height) || 240)),
          collapsed: Boolean(parsed.collapsed),
        };
      }
    } catch (_) { /* ignore */ }
    return { height: 240, collapsed: false };
  });
  useEffect(() => {
    try { localStorage.setItem(BOTTOM_KEY, JSON.stringify(bottomState)); } catch (_) {}
  }, [bottomState]);
  const chartGroupRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  // Drag handler — listens to mouse/touch and updates the bottom height.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev) => {
      const clientY = ev.touches?.[0]?.clientY ?? ev.clientY;
      if (!clientY || !chartGroupRef.current) return;
      const rect = chartGroupRef.current.getBoundingClientRect();
      // Bottom panel height = container bottom - cursor Y. Clamp so the
      // chart keeps at least 180 px and the bottom keeps at least 60 px.
      const newH = Math.max(60, Math.min(rect.height - 180, rect.bottom - clientY));
      setBottomState((s) => ({ ...s, height: newH, collapsed: false }));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);
  useEffect(() => {
    if (!accountMenuOpen) return;
    const onDoc = (e) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [accountMenuOpen]);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // ── Tabs (open symbols in the top bar) ────────────────────────────────
  // Persisted in localStorage so the user's open tabs survive page reloads
  // and logout/login. The active tab is whichever matches `?symbol=` in
  // the URL.
  const TABS_KEY = 'tradepro:trade-tabs';
  const [tabs, setTabs] = useState(() => {
    if (typeof window === 'undefined') return [symbol];
    try {
      const raw = localStorage.getItem(TABS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) {
        // Ensure the URL's current symbol is in the tab list so the user
        // always sees a tab for whatever they're looking at.
        return parsed.includes(symbol) ? parsed : [...parsed, symbol];
      }
    } catch (_) { /* ignore */ }
    return [symbol];
  });

  // Persist whenever tabs change.
  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch (_) {}
  }, [tabs]);

  // Make sure the currently-viewed symbol always has a tab. Catches the
  // case where the URL changes via back/forward to a symbol not in tabs.
  useEffect(() => {
    if (symbol && !tabs.includes(symbol)) {
      setTabs((prev) => [...prev, symbol]);
    }
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Open a tab — adds the symbol if it isn't already open, then activates it. */
  const openTab = (sym) => {
    if (!sym) return;
    setTabs((prev) => (prev.includes(sym) ? prev : [...prev, sym]));
    setParams({ symbol: sym });
  };

  /** Close a tab. If it was the active one, fall back to the previous tab
   *  (or the next, if it was the first). Never leaves the user with zero
   *  tabs — closing the last tab is a no-op. */
  const closeTab = (sym, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.indexOf(sym);
      if (idx === -1) return prev;
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      if (sym === symbol) {
        const fallback = next[idx - 1] || next[0];
        if (fallback) setParams({ symbol: fallback });
      }
      return next;
    });
  };

  const instrument = useMemo(() => instruments.find((i) => i.symbol === symbol), [instruments, symbol]);
  // Lookup map so PositionsTable / OrdersTable can resolve quoteCurrency
  // and pricePrecision per row without prop-drilling individual fields.
  const instrumentsBySymbol = useMemo(() => {
    const out = {};
    for (const i of instruments) out[i.symbol] = i;
    return out;
  }, [instruments]);
  const account = useMemo(() => accounts.find((a) => a._id === selectedAccountId) || accounts[0], [
    accounts,
    selectedAccountId,
  ]);
  const fxRate = useFxRate();

  // Free wallet balance for the active account — shown in the chart's
  // top-right info strip as "Margin". Refetched on account switch and on
  // any 'wallet' WS event below.
  const [walletFree, setWalletFree] = useState('0');
  useEffect(() => {
    if (!account?._id) return;
    let cancelled = false;
    const fetchFree = async () => {
      try {
        const { data } = await api.get('/wallet/balances', { params: { accountId: account._id } });
        if (cancelled) return;
        const w = (data.data || []).find((b) => b.currency === account.baseCurrency);
        setWalletFree(w?.free || '0');
      } catch (_) { /* keep prior */ }
    };
    fetchFree();
    const unsub = wsClient.subscribe('wallet', fetchFree);
    return () => { cancelled = true; unsub && unsub(); };
  }, [account?._id, account?.baseCurrency]);

  // Per-account free balance map — populated once when accounts load
  // (and refreshed on any 'wallet' WS event). `/user/accounts` returns a
  // possibly-stale `balance` field, so the dropdown was showing 0 for
  // non-active accounts even when funds existed on the wallet side.
  // The map is keyed by account _id and stores the free balance in the
  // account's base currency.
  const [accountBalances, setAccountBalances] = useState({});
  useEffect(() => {
    if (!accounts || !accounts.length) return;
    let cancelled = false;
    const fetchAll = async () => {
      try {
        const results = await Promise.allSettled(
          accounts.map((a) => api.get('/wallet/balances', { params: { accountId: a._id } }))
        );
        if (cancelled) return;
        const next = {};
        results.forEach((r, i) => {
          if (r.status !== 'fulfilled') return;
          const a = accounts[i];
          const w = (r.value.data?.data || []).find((b) => b.currency === a.baseCurrency);
          if (w?.free != null) next[a._id] = w.free;
        });
        setAccountBalances(next);
      } catch (_) { /* keep prior */ }
    };
    fetchAll();
    const unsub = wsClient.subscribe('wallet', fetchAll);
    return () => { cancelled = true; unsub && unsub(); };
  }, [accounts]);

  // Compose the info strip shown in the chart's top-right corner.
  // Margin is the free wallet balance (what the user can deploy on a new
  // trade); leverage and brokerage reflect the selected instrument.
  const chartInfoStrip = useMemo(() => {
    if (!instrument || !account) return null;
    const free = fmtMoneyDual(walletFree, account.baseCurrency, fxRate);
    const commission = Number(instrument.commissionPercent || 0);
    return {
      margin: free.primary,
      leverage: `1:${instrument.maxLeverage}`,
      brokerage: commission > 0 ? `${commission}%` : '$0.00',
    };
  }, [instrument, account, walletFree, fxRate]);

  // Initial load
  useEffect(() => {
    (async () => {
      const [i, a] = await Promise.all([api.get('/instruments'), api.get('/user/accounts')]);
      setInstruments(i.data.data);
      setAccounts(a.data.data);
      // Prefer the saved selection if it still exists in the user's list;
      // only fall back to the first account when the saved one is gone.
      if (a.data.data.length) {
        const savedId = (() => { try { return localStorage.getItem(ACCOUNT_KEY); } catch (_) { return null; } })();
        const stillExists = savedId && a.data.data.some((acc) => acc._id === savedId);
        setSelectedAccountId(stillExists ? savedId : a.data.data[0]._id);
      }
    })();
  }, []);

  const refresh = async () => {
    const [o, p] = await Promise.all([api.get('/trading/orders/open'), api.get('/trading/positions')]);
    setOpenOrders(o.data.data);
    setPositions(p.data.data);
  };

  useEffect(() => {
    refresh();
  }, []);

  // Subscribe to live ticker for the selected chart symbol.
  // Resetting livePrice on symbol switch is critical — otherwise the chart's
  // `live:last` price line keeps showing the previous symbol's price (e.g.
  // a $80k BTC line on a $1.17 EURUSD chart) until the next tick arrives,
  // which stretches the y-axis and looks broken. Same for the order-form
  // preview line — a $80k preview shouldn't linger on a $1.17 EURUSD chart.
  useEffect(() => {
    if (!symbol) return;
    setLivePrice(null);
    setPendingPreview(null);
    const unsub = wsClient.subscribe(`ticker:${symbol}`, (data) => {
      setLivePrice(data.lastPrice);
      // Also update priceMap for PnL calculation
      setPriceMap((prev) => ({ ...prev, [symbol]: data.lastPrice }));
    });
    return () => {
      unsub();
    };
  }, [symbol]);

  // Subscribe to ALL symbols where the user has open positions so PnL ticks
  // for every row, not just the chart's symbol. Depend on the stable
  // joined-symbol key (not the `positions` array) so a refresh that returns
  // an identical symbol set doesn't tear down + rebuild every WS subscription.
  const positionSymbolsKey = useMemo(
    () => [...new Set(positions.map((p) => p.symbol))].sort().join('|'),
    [positions]
  );
  useEffect(() => {
    if (!positionSymbolsKey) return;
    const symbols = positionSymbolsKey.split('|');
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        setPriceMap((prev) => ({ ...prev, [sym]: data.lastPrice }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [positionSymbolsKey]);

  // Subscribe to private 'positions', 'orders' and 'wallet' channels so the
  // table + chart refresh on FILLED/STOP_TRIGGERED/OCO_CANCELLED etc. Without
  // the 'orders' subscription, a triggered STOP would leave a stale price-line
  // on the chart until the next manual interaction.
  useEffect(() => {
    const unsub = wsClient.subscribe('positions', () => refresh());
    const orders = wsClient.subscribe('orders', () => refresh());
    const wallet = wsClient.subscribe('wallet', () => refresh());
    return () => {
      unsub && unsub();
      orders && orders();
      wallet && wallet();
    };
  }, []);

  // Compute live PnL for each position using latest price from priceMap.
  // `markPx` (not `livePrice`) is named explicitly to avoid shadowing the
  // chart's livePrice state — the two represent different things.
  const positionsWithLivePnl = useMemo(() =>
    positions.map((p) => {
      const markPx = priceMap[p.symbol] || p.markPrice || p.entryPrice;
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const mark = Number(markPx);
      if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(mark)) {
        return { ...p, markPrice: markPx, unrealizedPnl: '0' };
      }
      const livePnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      return { ...p, markPrice: markPx, unrealizedPnl: String(livePnl) };
    }),
    [positions, priceMap]
  );

  // Whenever the chart's surrounding layout flips (side panels open/close,
  // fullscreen on/off), the chart container's box changes but the
  // lightweight-charts canvas doesn't always pick it up reliably during
  // the same animation frame. Fire a sequence of resize events so the
  // ResizeObserver + window listener both re-measure the container and
  // shrink/grow the canvas to match. Without this the chart retained its
  // expanded height after collapsing back to normal.
  useEffect(() => {
    const ping = () => {
      try { window.dispatchEvent(new Event('resize')); } catch (_) {}
    };
    const ids = [
      requestAnimationFrame(ping),
      setTimeout(ping, 80),
      setTimeout(ping, 250),
    ];
    return () => {
      cancelAnimationFrame(ids[0]);
      clearTimeout(ids[1]);
      clearTimeout(ids[2]);
    };
  }, [showInstruments, showOrderPanel, chartView]);

  // Keyboard shortcuts: F = fullscreen toggle, E = expand toggle,
  // Esc = back to normal, 1/2/3/4/5/6 = timeframe quick-jump.
  // Disabled while the user is typing in an input — we don't want to
  // accidentally hijack form entry.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const editable =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (editable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'f':
        case 'F':
          e.preventDefault();
          setChartView((v) => (v === 'fullscreen' ? 'normal' : 'fullscreen'));
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          // If either panel is open, close both. Otherwise re-open both.
          if (showInstruments || showOrderPanel) {
            setShowInstruments(false);
            setShowOrderPanel(false);
          } else {
            setShowInstruments(true);
            setShowOrderPanel(true);
          }
          break;
        case 'Escape':
          if (chartView !== 'normal') {
            e.preventDefault();
            setChartView('normal');
          } else if (!showInstruments || !showOrderPanel) {
            e.preventDefault();
            setShowInstruments(true);
            setShowOrderPanel(true);
          }
          break;
        case '1': setTimeframe('1m'); break;
        case '2': setTimeframe('5m'); break;
        case '3': setTimeframe('15m'); break;
        case '4': setTimeframe('1h'); break;
        case '5': setTimeframe('4h'); break;
        case '6': setTimeframe('1d'); break;
        default: break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chartView, showInstruments, showOrderPanel]);

  const cancelOrder = async (id) => {
    try {
      await api.delete(`/trading/orders/${id}`);
      toast.success('Order cancelled');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const closePosition = async (id) => {
    try {
      await api.post(`/trading/positions/${id}/close`);
      toast.success('Position closing');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const modifyPositionSlTp = async (position) => {
    const sl = window.prompt(`Stop Loss for ${position.symbol} (blank to remove)`, position.stopLoss || '');
    if (sl === null) return; // user cancelled
    const tp = window.prompt(`Take Profit for ${position.symbol} (blank to remove)`, position.takeProfit || '');
    if (tp === null) return;
    try {
      await api.put(`/trading/positions/${position._id}`, {
        stopLoss: sl === '' ? null : sl,
        takeProfit: tp === '' ? null : tp,
      });
      toast.success('SL/TP updated');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  // Live bid/ask map for the instruments panel — derived from the lastPrice
  // tickers we already subscribe to, plus the spread rules per instrument.
  const instrumentRows = useMemo(() => {
    return instruments
      .filter((i) => i.isActive !== false)
      .map((i) => {
        const px = Number(priceMap[i.symbol] || i.lastPrice || 0);
        const half = Number(i.spreadValue || 0) / 2;
        const bid = i.spreadType === 'PERCENTAGE' ? px * (1 - half) : px - half;
        const ask = i.spreadType === 'PERCENTAGE' ? px * (1 + half) : px + half;
        return { ...i, bid, ask, last: px };
      });
  }, [instruments, priceMap]);

  // Distinct categories present in the dataset — drives the dropdown
  // options so a freshly-added asset class (e.g. ETF) appears
  // automatically with no UI change.
  const instrumentCategories = useMemo(() => {
    const set = new Set();
    for (const r of instrumentRows) {
      const c = String(r.category || '').toUpperCase();
      if (c) set.add(c);
    }
    return Array.from(set).sort();
  }, [instrumentRows]);

  // Reset the filter if the currently-selected asset-class category
  // disappears (e.g. switched accounts and the new one has no crypto).
  // 'ALL' and 'FAV' are always valid — 'FAV' is a pseudo-category
  // backed by localStorage, not by the instruments list, so it must
  // not be reset away.
  useEffect(() => {
    if (
      instrumentCategory !== 'ALL' &&
      instrumentCategory !== 'FAV' &&
      !instrumentCategories.includes(instrumentCategory)
    ) {
      setInstrumentCategory('ALL');
    }
  }, [instrumentCategories, instrumentCategory]);

  // Account equity numbers for the footer strip. We compute live so the
  // footer reflects real wallet free + unrealized PnL on every tick.
  const equityNums = useMemo(() => {
    if (!account) return null;
    const free = Number(walletFree || 0);
    const upnl = positionsWithLivePnl.reduce((acc, p) => acc + Number(p.unrealizedPnl || 0), 0);
    const usedMargin = positions.reduce((acc, p) => {
      const px = Number(p.entryPrice || 0) * Number(p.quantity || 0);
      const lev = Math.max(Number(p.leverage || 1), 1);
      return acc + px / lev;
    }, 0);
    const equity = free + upnl + usedMargin;
    const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : null;
    return {
      equity,
      free,
      balance: free + usedMargin,
      used: usedMargin,
      marginLevel,
      base: account.baseCurrency || 'USD',
    };
  }, [account, walletFree, positionsWithLivePnl, positions]);

  const isFullscreen = chartView === 'fullscreen';
  // Hide the floating order overlay the moment fullscreen is left so
  // it doesn't pop back up next time the user re-enters.
  useEffect(() => {
    if (!isFullscreen && showFloatingOrder) setShowFloatingOrder(false);
  }, [isFullscreen, showFloatingOrder]);

  // ── True browser fullscreen (Fullscreen API) ───────────────────────
  // The CSS `fixed inset-0 z-50` we apply below fills the BROWSER
  // viewport but leaves tabs, bookmarks bar, and OS taskbar visible.
  // To get the immersive TradingView-style edge-to-edge view the user
  // wants we also engage `Element.requestFullscreen()`. `chartView` is
  // the single source of truth — these effects bridge it to the API:
  //   1. When `isFullscreen` flips on, request browser fullscreen on
  //      the trade root.
  //   2. When it flips off, exit browser fullscreen if we're still in.
  //   3. A `fullscreenchange` listener catches user-initiated exits
  //      (Esc, F11, browser UI) and syncs our state back to 'normal',
  //      so the UI doesn't get stuck thinking it's still fullscreen.
  const tradeRootRef = useRef(null);
  useEffect(() => {
    const root = tradeRootRef.current;
    if (!root) return;
    const currentFsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (isFullscreen && !currentFsEl) {
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) {
        try { Promise.resolve(req.call(root)).catch(() => {}); } catch (_) {}
      }
    } else if (!isFullscreen && currentFsEl) {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) {
        try { Promise.resolve(ex.call(document)).catch(() => {}); } catch (_) {}
      }
    }
  }, [isFullscreen]);
  useEffect(() => {
    const onChange = () => {
      const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      // User left browser fullscreen externally (Esc, F11, browser
      // chrome). Mirror that into chartView so the rest of the UI
      // (panels, header, footer) restores cleanly.
      if (!inFs) setChartView((v) => (v === 'fullscreen' ? 'normal' : v));
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  // Esc closes the floating overlay (but not fullscreen — fullscreen is
  // handled by its own keymap elsewhere). Lets users get back to a
  // chart-only view without juggling two close buttons.
  useEffect(() => {
    if (!showFloatingOrder) return;
    const onKey = (e) => { if (e.key === 'Escape') setShowFloatingOrder(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showFloatingOrder]);
  // Wrap the side-change handler so clicking BUY/SELL on the chip in
  // fullscreen pops the floating overlay (instead of just silently
  // toggling state with no visible UI, which is what happened before
  // because the side OrderForm aside is force-hidden in fullscreen).
  const handleOrderSideChange = useCallback((side) => {
    setOrderSide(side);
    if (isFullscreen) setShowFloatingOrder(true);
  }, [isFullscreen]);
  // "Expanded" = either side panel collapsed. The chart toolbar button
  // flips both at once; per-panel × buttons flip each side independently.
  const panelsCollapsed = !showInstruments && !showOrderPanel;

  return (
    <div
      ref={tradeRootRef}
      // Explicit fixed viewport height (`h-screen` = 100vh).
      // Tight gap + zero bottom padding so the equity footer sits flush
      // against the viewport edge (no wasted space below the page).
      // In browser-fullscreen mode the element fills the screen via
      // the Fullscreen API — `fixed inset-0` still applies as a
      // fallback for the brief frame before requestFullscreen resolves
      // (or when it's denied, e.g. URL-triggered without a gesture).
      className={`flex flex-col gap-1 min-h-0 overflow-hidden transition-[padding] duration-200 ease-out ${
        isFullscreen
          ? 'fixed inset-0 z-50 bg-bg-dark p-1'
          : 'h-screen pt-1 px-1 pb-0'
      }`}
    >
      {/* ── Slim top bar — brand mark + instrument quick-pick + account.
          Since the global Layout header is hidden on /trade, this bar
          is the only way back to the rest of the app. */}
      <div className={`${isFullscreen ? 'hidden' : 'flex'} items-center justify-between gap-4 bg-white border-b border-border-dark px-4 sm:px-6 h-16 shrink-0 -mx-1 -mt-1`}>
        {/* Brand mark — links back to /dashboard so the user always has
            a path out of the terminal even without the global nav. */}
        <Link
          to="/dashboard"
          title="Back to dashboard"
          className="flex items-center gap-2 shrink-0 pr-2 mr-1 border-r border-border-dark"
        >
          <span
            className="relative w-8 h-8 rounded-[10px] flex items-center justify-center font-extrabold shrink-0"
            style={{
              background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 55%, #1E3A8A 100%)',
              boxShadow: '0 2px 6px rgba(29, 78, 216, 0.30)',
              color: '#FFFFFF',
            }}
          >
            <span className="text-base leading-none" style={{ fontFamily: 'Georgia, serif', color: '#FFFFFF' }}>T</span>
          </span>
        </Link>

        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0">
          {tabs.map((sym) => {
            const inst = instrumentsBySymbol[sym] || { symbol: sym };
            const active = sym === symbol;
            const change = Number(inst.change24h);
            const positive = Number.isFinite(change) ? change >= 0 : null;
            const canClose = tabs.length > 1;
            return (
              <div
                key={sym}
                role="button"
                tabIndex={0}
                onClick={() => setParams({ symbol: sym })}
                onKeyDown={(e) => { if (e.key === 'Enter') setParams({ symbol: sym }); }}
                className={`group shrink-0 inline-flex items-center gap-2 pl-2.5 pr-1 py-1.5 rounded-lg text-sm transition-all border cursor-pointer ${
                  active
                    ? 'border-primary-500 bg-primary-500/5 text-text-primary font-semibold'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                <AssetIcon row={inst} size={20} round />
                <span className="font-medium">{sym}</span>
                {Number.isFinite(change) && (
                  <span
                    className="text-[10px] font-semibold"
                    style={{ color: positive ? '#16A34A' : '#DC2626' }}
                  >
                    {positive ? '+' : ''}{change.toFixed(2)}%
                  </span>
                )}
                {canClose && (
                  <button
                    type="button"
                    onClick={(e) => closeTab(sym, e)}
                    title={`Close ${sym}`}
                    className={`shrink-0 p-1 rounded-md transition-colors ${
                      active
                        ? 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                        : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
            );
          })}
          {/* Add-tab "+" — opens the instruments panel if collapsed and
              focuses its search input so the user can pick a symbol to add. */}
          <button
            type="button"
            onClick={() => {
              if (!showInstruments) setShowInstruments(true);
              setTimeout(() => {
                const el = document.querySelector('aside input[placeholder="Search…"]');
                if (el) { el.focus(); el.select?.(); }
              }, 60);
            }}
            title="Add symbol tab"
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </button>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Custom account picker — shows account name + balance, and
              persists the selection across refresh. */}
          <div className="relative" ref={accountMenuRef}>
            {(() => {
              const acc = account;
              const name = acc?.nickname || acc?.accountNumber || '—';
              const ccy = acc?.baseCurrency || 'USD';
              // Prefer the live wallet free balance (kept fresh via the
              // 'wallet' WS subscription) over the stored snapshot on
              // the account object, which can lag behind deposits.
              const balance = Number(
                walletFree
                  ?? (acc?._id ? accountBalances[acc._id] : null)
                  ?? acc?.balance
                  ?? acc?.equity
                  ?? 0
              );
              const fmtBal = balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <button
                  type="button"
                  onClick={() => setAccountMenuOpen((o) => !o)}
                  className="flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-lg border border-border-dark bg-white hover:bg-bg-hover transition-colors text-left"
                >
                  <div className="flex flex-col leading-tight min-w-0">
                    <span className="text-sm font-extrabold text-text-primary truncate max-w-[180px] tracking-tight">
                      {name} <span className="text-text-muted font-semibold">· {acc?.accountType}</span>
                    </span>
                    <span className="text-[13px] font-mono font-extrabold text-primary-600 mt-1 tabular-nums">
                      {ccy} {hideBalance ? '••••' : fmtBal}
                    </span>
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-text-muted shrink-0"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              );
            })()}
            {accountMenuOpen && (() => {
              const ccy = account?.baseCurrency || 'USD';
              const balanceN = Number(
                walletFree
                  ?? (account?._id ? accountBalances[account._id] : null)
                  ?? account?.balance
                  ?? account?.equity
                  ?? 0
              );
              const equityN = equityNums?.equity ?? balanceN;
              const marginUsedN = equityNums?.used ?? 0;
              const freeMarginN = equityNums?.free ?? balanceN;
              const marginLvl = equityNums?.marginLevel;
              const accLeverage = account?.leverage || account?.maxLeverage || 200;
              const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const mask = (s) => (hideBalance ? '••••' : s);
              return (
                <div className="absolute right-0 top-full mt-1 z-40 w-[300px] bg-white border border-border-dark rounded-xl shadow-elevated overflow-hidden">
                  {accountMenuView === 'metrics' ? (
                    <>
                      {/* Metrics rows */}
                      <div className="px-4 py-3 space-y-2.5">
                        {[
                          ['Balance',         `${mask(fmt(balanceN))} ${ccy}`],
                          ['Equity',          `${mask(fmt(equityN))} ${ccy}`],
                          ['Margin',          `${mask(fmt(marginUsedN))} ${ccy}`],
                          ['Free margin',     `${mask(fmt(freeMarginN))} ${ccy}`],
                          ['Margin level',    marginLvl != null ? `${mask(fmt(marginLvl))}%` : '—'],
                          ['Account leverage', `1:${accLeverage}`],
                        ].map(([label, value]) => (
                          <div key={label} className="flex items-center justify-between gap-2 text-[13px]">
                            <span className="text-text-secondary">{label}</span>
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-text-primary tabular-nums">{value}</span>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted/60 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Withdraw / Deposit quick actions */}
                      <div className="px-4 pb-3 flex items-start justify-center gap-8">
                        <Link
                          to="/wallet?action=withdraw"
                          onClick={() => setAccountMenuOpen(false)}
                          className="flex flex-col items-center gap-1.5 group"
                        >
                          <span className="w-11 h-11 rounded-full bg-bg-hover border border-border-dark group-hover:bg-primary-500/10 group-hover:border-primary-500/40 transition-colors flex items-center justify-center text-text-primary">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12l4-4 4 4" /><path d="M12 16V8" /></svg>
                          </span>
                          <span className="text-[12px] font-medium text-text-primary">Withdraw</span>
                        </Link>
                        <Link
                          to="/wallet"
                          onClick={() => setAccountMenuOpen(false)}
                          className="flex flex-col items-center gap-1.5 group"
                        >
                          <span className="w-11 h-11 rounded-full bg-bg-hover border border-border-dark group-hover:bg-primary-500/10 group-hover:border-primary-500/40 transition-colors flex items-center justify-center text-text-primary">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12l4 4 4-4" /><path d="M12 8v8" /></svg>
                          </span>
                          <span className="text-[12px] font-medium text-text-primary">Deposit</span>
                        </Link>
                      </div>

                      <div className="border-t border-border-subtle" />

                      {/* Hide balance toggle */}
                      <button
                        type="button"
                        onClick={() => setHideBalance((v) => !v)}
                        className="w-full px-4 py-2.5 flex items-center justify-between text-[13px] hover:bg-bg-hover transition-colors"
                      >
                        <span className="text-text-primary">Hide balance</span>
                        <span
                          className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${
                            hideBalance ? 'bg-primary-500' : 'bg-border-dark'
                          }`}
                        >
                          <span
                            className={`keep-white absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                              hideBalance ? 'translate-x-[18px]' : 'translate-x-0.5'
                            }`}
                          />
                        </span>
                      </button>

                      <Link
                        to="/reports"
                        onClick={() => setAccountMenuOpen(false)}
                        className="w-full px-4 py-2.5 flex items-center justify-between text-[13px] hover:bg-bg-hover transition-colors"
                      >
                        <span className="text-text-primary">Transaction History</span>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted"><path d="M7 17L17 7" /><path d="M7 7h10v10" /></svg>
                      </Link>
                      <Link
                        to="/reports"
                        onClick={() => setAccountMenuOpen(false)}
                        className="w-full px-4 py-2.5 flex items-center justify-between text-[13px] hover:bg-bg-hover transition-colors"
                      >
                        <span className="text-text-primary">Download Trading Log</span>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted"><path d="M7 17L17 7" /><path d="M7 7h10v10" /></svg>
                      </Link>

                      <div className="border-t border-border-subtle" />

                      <button
                        type="button"
                        onClick={() => setAccountMenuView('switch')}
                        className="w-full px-4 py-3 flex items-center justify-between text-[14px] font-semibold hover:bg-bg-hover transition-colors"
                      >
                        <span className="text-text-primary">Switch account</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-text-secondary"><path d="M9 18l6-6-6-6" /></svg>
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Switch-account sub-view */}
                      <button
                        type="button"
                        onClick={() => setAccountMenuView('metrics')}
                        className="w-full px-3 py-2.5 flex items-center gap-2 text-[13px] font-semibold text-text-primary hover:bg-bg-hover transition-colors border-b border-border-subtle"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-text-secondary"><path d="M15 18l-6-6 6-6" /></svg>
                        Accounts
                      </button>
                      {accounts.map((a) => {
                        const isActive = a._id === selectedAccountId;
                        const name = a.nickname || a.accountNumber || '—';
                        const acCcy = a.baseCurrency || 'USD';
                        const balance = Number(
                          (a._id === selectedAccountId ? walletFree : null)
                            ?? accountBalances[a._id]
                            ?? a.balance
                            ?? a.equity
                            ?? 0
                        );
                        const fmtBal = balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        return (
                          <button
                            key={a._id}
                            type="button"
                            onClick={() => { setSelectedAccountId(a._id); setAccountMenuOpen(false); }}
                            className={`w-full flex items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors ${
                              isActive ? 'bg-primary-500/10' : 'hover:bg-bg-hover'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-text-primary truncate">{name}</div>
                              <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mt-0.5">{a.accountType}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-sm font-mono font-bold text-text-primary tabular-nums">{mask(fmtBal)}</div>
                              <div className="text-[10px] font-semibold text-text-muted mt-0.5">{acCcy}</div>
                            </div>
                            {isActive && (
                              <span className="self-center text-primary-600 shrink-0">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="hidden md:flex">
            <NotificationCenter />
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="hidden md:inline-flex p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
            )}
          </button>
          {/* Deposit CTA — opens the wallet's inline deposit flow. */}
          <Link
            to="/wallet"
            title="Deposit funds"
            className="inline-flex items-center gap-1.5 px-2.5 sm:px-4 py-1.5 rounded-lg font-bold text-sm shadow-card hover:shadow-elevated transition-all shrink-0"
            style={{
              background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 55%, #1E3A8A 100%)',
              color: '#FFFFFF',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            <span className="hidden sm:inline">Deposit</span>
          </Link>
        </div>
      </div>

      {/* ── Main terminal: instruments | chart+tabs | order form ────────
          Stacks vertically on mobile/tablet; horizontal terminal on lg+.
          min-h-0 across all breakpoints keeps the page locked to exactly
          viewport height (no scroll). */}
      <div className="flex-1 flex flex-col lg:flex-row gap-1 min-h-0">
        {/* Left re-open tab — shown only when Instruments is collapsed */}
        {!showInstruments && !isFullscreen && (
          <button
            type="button"
            onClick={() => setShowInstruments(true)}
            title="Show instruments"
            className="hidden lg:flex w-7 shrink-0 self-start flex-col items-center justify-center gap-2 py-3 glass border border-border-dark rounded-xl text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            <span className="text-[9px] uppercase tracking-[0.2em] font-bold whitespace-nowrap" style={{ writingMode: 'vertical-rl' }}>
              Instruments
            </span>
          </button>
        )}

        {/* Left — INSTRUMENTS panel (closes individually + via Expand) */}
        <aside className={`${(!showInstruments || isFullscreen) ? 'hidden' : 'hidden lg:flex'} w-[280px] shrink-0 glass border border-border-dark rounded-xl flex-col overflow-hidden`}>
          <div className="px-3 py-2.5 border-b border-border-dark flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.15em] font-extrabold text-text-primary">
                Instruments
              </span>
              <span className="text-text-secondary text-xs font-semibold">{instrumentRows.length}</span>
            </div>
            <button
              type="button"
              onClick={() => setShowInstruments(false)}
              title="Close panel"
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              aria-label="Close instruments panel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="p-2 border-b border-border-subtle space-y-2">
            <input
              type="text"
              value={watchSearch}
              onChange={(e) => setWatchSearch(e.target.value)}
              placeholder="Search…"
              className="input w-full text-xs py-1.5"
            />
            {/* Category dropdown — narrows the list to a single asset
                class. Native <select> picks up the app's input styling
                for consistency with the search box above. */}
            <div className="relative">
              <select
                value={instrumentCategory}
                onChange={(e) => setInstrumentCategory(e.target.value)}
                className="input w-full text-xs py-1.5 pr-7 appearance-none cursor-pointer"
                aria-label="Filter instruments by category"
              >
                <option value="ALL">All categories</option>
                <option value="FAV">★ Favourites{favorites.size ? ` (${favorites.size})` : ''}</option>
                {instrumentCategories.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
              <svg
                width="12" height="12" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>
          <div className="px-3 py-2 grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider font-bold text-text-secondary bg-bg-card border-b border-border-subtle">
            <div className="col-span-5">Symbol</div>
            <div className="col-span-3 text-right">Bid</div>
            <div className="col-span-4 text-right">Ask</div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {instrumentRows
              .filter((r) => {
                if (instrumentCategory === 'FAV') {
                  if (!favorites.has(r.symbol)) return false;
                } else if (instrumentCategory !== 'ALL') {
                  const cat = String(r.category || '').toUpperCase();
                  if (cat !== instrumentCategory) return false;
                }
                const q = (watchSearch || '').trim().toUpperCase();
                if (!q) return true;
                return r.symbol.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q);
              })
              .map((r) => {
                const active = r.symbol === symbol;
                const change = Number(r.change24h);
                const positive = Number.isFinite(change) ? change >= 0 : null;
                const prec = Math.min(r.pricePrecision || 2, 5);
                const isFav = favorites.has(r.symbol);
                const open = () => openTab(r.symbol);
                return (
                  <div
                    key={r.symbol}
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                    className={`w-full grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center transition-colors text-left cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
                      active
                        ? 'bg-primary-500/10 text-text-primary'
                        : 'hover:bg-bg-hover text-text-secondary'
                    }`}
                  >
                    <div className="col-span-5 min-w-0 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleFavorite(r.symbol); }}
                        title={isFav ? 'Remove from favourites' : 'Add to favourites'}
                        aria-label={isFav ? 'Remove from favourites' : 'Add to favourites'}
                        className={`shrink-0 p-0.5 rounded transition-colors ${
                          isFav ? 'text-primary-500' : 'text-text-muted hover:text-primary-500'
                        }`}
                      >
                        <svg
                          width="14" height="14" viewBox="0 0 24 24"
                          fill={isFav ? 'currentColor' : 'none'}
                          stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round"
                        >
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </button>
                      <AssetIcon row={r} size={22} round />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{r.symbol}</div>
                      {Number.isFinite(change) && (
                        <div
                          className="text-[10px] font-semibold"
                          style={{ color: positive ? '#16A34A' : '#DC2626' }}
                        >
                          {positive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
                        </div>
                      )}
                      </div>
                    </div>
                    <div
                      className="col-span-3 text-right font-mono text-[11px]"
                      style={{ color: '#16A34A' }}
                    >
                      {fmtNum(r.bid, prec)}
                    </div>
                    <div
                      className="col-span-4 text-right font-mono text-[11px]"
                      style={{ color: '#DC2626' }}
                    >
                      {fmtNum(r.ask, prec)}
                    </div>
                  </div>
                );
              })}
          </div>
        </aside>

        {/* Center — chart + bottom tabs (with draggable splitter) */}
        <div ref={chartGroupRef} className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="relative flex-1 min-h-0 flex">
            {/* Chart area — expand / fullscreen icons now live inside the
                PriceChart toolbar's right cluster (no floating overlay
                that could overlap the Sell/Buy chip). */}
            <div className="relative flex-1 min-w-0 bg-bg-card border border-border-dark rounded-xl overflow-hidden">
              {instrument && (
                <PriceChart
                  symbol={symbol}
                  timeframe={timeframe}
                  onTimeframeChange={setTimeframe}
                  livePrice={livePrice || instrument.lastPrice}
                  openOrders={openOrders}
                  positions={positionsWithLivePnl}
                  pendingPreview={pendingPreview}
                  pricePrecision={instrument.pricePrecision}
                  infoStrip={chartInfoStrip}
                  instrument={instrument}
                  orderSide={orderSide}
                  onOrderSideChange={handleOrderSideChange}
                  hideQuickTrade={(showOrderPanel && !isFullscreen) || (isFullscreen && showFloatingOrder)}
                  expanded={panelsCollapsed}
                  onToggleExpand={() => {
                    if (showInstruments || showOrderPanel) {
                      setShowInstruments(false);
                      setShowOrderPanel(false);
                    } else {
                      setShowInstruments(true);
                      setShowOrderPanel(true);
                    }
                  }}
                  fullscreen={isFullscreen}
                  onToggleFullscreen={() => setChartView((v) => (v === 'fullscreen' ? 'normal' : 'fullscreen'))}
                />
              )}

              {/* ── Floating order overlay (fullscreen only) ─────────
                  In fullscreen the side-panel OrderForm is hidden, so a
                  click on the chart's BUY/SELL chip pops THIS panel —
                  glass card pinned to the right edge of the chart with
                  a 200 ms fade+slide in. The chart underneath is not
                  resized: this overlay is `absolute`, so the chart
                  keeps its full bounds and stays interactive (panning,
                  zooming, indicators) behind the panel. */}
              {isFullscreen && instrument && account && (
                <div
                  className={`absolute top-1/2 right-[30%] w-[340px] max-w-[calc(100vw-1.5rem)] max-h-[calc(100%-1.5rem)] z-30 -translate-y-1/2 transition-all duration-200 ease-out ${
                    showFloatingOrder
                      ? 'opacity-100 translate-x-0 pointer-events-auto'
                      : 'opacity-0 translate-x-6 pointer-events-none'
                  }`}
                  aria-hidden={!showFloatingOrder}
                  role="dialog"
                  aria-label="Place order"
                >
                  {/* Wrapper hugs OrderForm's content height (no
                      `h-full`) so the glass card matches the form's
                      natural size instead of stretching to the bottom
                      of the chart and leaving a blank strip below the
                      Place Order button. `max-h-` on the parent +
                      OrderForm's own `overflow-y-auto` handle tiny
                      viewports. */}
                  <div className="glass border border-border-dark rounded-xl shadow-2xl overflow-hidden flex flex-col backdrop-blur-xl">
                    <OrderForm
                      instrument={instrument}
                      account={account}
                      onPlaced={refresh}
                      onPendingPriceChange={setPendingPreview}
                      side={orderSide}
                      onSideChange={setOrderSide}
                      onClose={() => setShowFloatingOrder(false)}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Drag handle — vertical resize between chart and tabs.
              ALWAYS visible (except in chart-fullscreen, where there's
              nothing below it to resize) — even when the bottom panel
              is collapsed, the user can grab it and drag up to expand. */}
          {!isFullscreen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize"
              onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
              onTouchStart={(e) => { e.preventDefault(); setDragging(true); }}
              onDoubleClick={() => setBottomState({ height: 240, collapsed: false })}
              className={`group h-1.5 rounded-full cursor-row-resize transition-colors flex items-center justify-center ${
                dragging ? 'bg-primary-500/40' : 'bg-transparent hover:bg-primary-500/15'
              }`}
            >
              <span className={`block w-12 h-1 rounded-full transition-colors ${
                dragging ? 'bg-primary-500' : 'bg-border-dark group-hover:bg-primary-500/60'
              }`} />
            </div>
          )}

          {/* Open / Pending / Closed tabs (hidden in fullscreen) — height
              comes from the resizable bottomState; collapsed mode shrinks
              to just the header row. */}
          <div
            className={`${isFullscreen ? 'hidden' : 'flex'} glass border border-border-dark rounded-xl flex-col shrink-0 overflow-hidden ${dragging ? '' : 'transition-[height] duration-200 ease-out'}`}
            style={{ height: bottomState.collapsed ? 44 : bottomState.height }}
          >
            <div className="flex items-center justify-between border-b border-border-subtle px-2 shrink-0">
              <div className="flex items-center">
                {[
                  { k: 'positions', label: 'Open',    count: positions.length },
                  { k: 'orders',    label: 'Pending', count: openOrders.length },
                  { k: 'closed',    label: 'Closed',  count: 0 },
                ].map((t) => (
                  <button
                    key={t.k}
                    onClick={() => {
                      setTab(t.k);
                      // If user clicks a tab while collapsed, expand back.
                      if (bottomState.collapsed) setBottomState((s) => ({ ...s, collapsed: false }));
                    }}
                    className={`relative px-4 py-3 text-sm font-semibold flex items-center gap-2 transition-colors ${
                      tab === t.k ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {t.label}
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        tab === t.k
                          ? 'bg-primary-500 text-white'
                          : 'bg-bg-hover text-text-secondary'
                      }`}
                    >
                      {t.count}
                    </span>
                    {tab === t.k && !bottomState.collapsed && (
                      <span className="absolute bottom-0 left-2 right-2 h-[3px] bg-primary-500 rounded-t-full" />
                    )}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 mr-1">
                {tab === 'positions' && positions.length > 0 && !bottomState.collapsed && (
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Close all ${positions.length} open position(s)?`)) return;
                      try {
                        const { data } = await api.post('/trading/positions/close-all', {
                          accountId: account?._id,
                        });
                        const r = data.data;
                        if (r.failed?.length) {
                          toast.error(`Closed ${r.closed}/${r.total}. ${r.failed.length} failed.`);
                        } else {
                          toast.success(`Closed ${r.closed} position(s)`);
                        }
                        refresh();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                    className="text-[11px] font-bold px-3 py-1.5 rounded-md bg-bear/15 text-bear border border-bear/30 hover:bg-bear/25 transition-colors"
                  >
                    Close All
                  </button>
                )}
                {/* Maximize — grow the bottom panel to take ~70% of the
                    chart group height; toggle back to ~240 when clicked
                    again from the max state. */}
                <button
                  type="button"
                  onClick={() => {
                    setBottomState((s) => {
                      const groupH = chartGroupRef.current?.clientHeight || 600;
                      const maxH = Math.round(groupH * 0.7);
                      const next = s.height >= maxH - 5 ? 240 : maxH;
                      return { height: next, collapsed: false };
                    });
                  }}
                  title="Maximize panel"
                  className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v2H5v5H3V3z" /><path d="M21 3h-7v2h5v5h2V3z" /><path d="M3 21h7v-2H5v-5H3v7z" /><path d="M21 21h-7v-2h5v-5h2v7z" /></svg>
                </button>
                {/* Minimize / collapse — toggle the panel to header-only. */}
                <button
                  type="button"
                  onClick={() => setBottomState((s) => ({ ...s, collapsed: !s.collapsed }))}
                  title={bottomState.collapsed ? 'Expand panel' : 'Minimize panel'}
                  className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  {bottomState.collapsed ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  )}
                </button>
              </div>
            </div>
            <div className="p-3 overflow-x-auto flex-1">
              {tab === 'positions' && (
                <PositionsTable
                  positions={positionsWithLivePnl}
                  onClose={closePosition}
                  onModify={modifyPositionSlTp}
                  fxRate={fxRate}
                  instrumentsBySymbol={instrumentsBySymbol}
                />
              )}
              {tab === 'orders' && (
                <OrdersTable
                  orders={openOrders}
                  onCancel={cancelOrder}
                  fxRate={fxRate}
                  instrumentsBySymbol={instrumentsBySymbol}
                />
              )}
              {tab === 'closed' && (
                <div className="py-10 text-center">
                  <div className="text-sm text-text-secondary">No closed trades to show</div>
                  <div className="text-xs text-text-muted mt-1">
                    Your trade history will appear here.{' '}
                    <a href="/reports" className="text-primary-500 hover:underline">View reports</a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right — order form panel (closes individually + via Expand).
            The × is now rendered inline inside the OrderForm header (same
            row as the asset name) via the `onClose` prop. */}
        <aside className={`${(!showOrderPanel || isFullscreen) ? 'hidden' : 'flex'} w-full lg:w-[340px] shrink-0 flex-col gap-1 min-h-0`}>
          {instrument && account && (
            <OrderForm
              instrument={instrument}
              account={account}
              onPlaced={refresh}
              onPendingPriceChange={setPendingPreview}
              side={orderSide}
              onSideChange={setOrderSide}
              onClose={() => setShowOrderPanel(false)}
            />
          )}
        </aside>

        {/* Right re-open tab — shown only when Order panel is collapsed */}
        {!showOrderPanel && !isFullscreen && (
          <button
            type="button"
            onClick={() => setShowOrderPanel(true)}
            title="Show order panel"
            className="hidden lg:flex w-7 shrink-0 self-start flex-col items-center justify-center gap-2 py-3 glass border border-border-dark rounded-xl text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            <span className="text-[9px] uppercase tracking-[0.2em] font-bold whitespace-nowrap" style={{ writingMode: 'vertical-rl' }}>
              Place Order
            </span>
          </button>
        )}
      </div>

      {/* ── Equity footer — live margin/balance/equity bar (hidden in fullscreen) ── */}
      {equityNums && !isFullscreen && (
        <div className="mt-2 glass border border-border-dark rounded-xl px-4 py-2.5 flex items-center justify-between flex-wrap gap-x-6 gap-y-1 text-xs shrink-0">
          <FooterStat label="Equity"       value={fmtMoney(equityNums.equity, equityNums.base)} />
          <FooterStat label="Free Margin"  value={fmtMoney(equityNums.free, equityNums.base)} />
          <FooterStat label="Balance"      value={fmtMoney(equityNums.balance, equityNums.base)} />
          <FooterStat label="Margin"       value={fmtMoney(equityNums.used, equityNums.base)} />
          <FooterStat
            label="Margin Level"
            value={equityNums.marginLevel != null ? `${equityNums.marginLevel.toFixed(2)}%` : '—'}
            color={equityNums.marginLevel != null && equityNums.marginLevel < 100 ? '#DC2626' : undefined}
          />
        </div>
      )}
    </div>
  );
}

function FooterStat({ label, value, color }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-secondary font-semibold">{label}:</span>
      <span className="font-mono font-bold text-text-primary" style={{ color: color || undefined }}>
        {value}
      </span>
    </div>
  );
}

function PositionsTable({ positions, onClose, onModify, fxRate, instrumentsBySymbol }) {
  if (!positions.length) {
    return (
      <div className="py-10 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3 border border-border-dark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 4 4 5-7" />
          </svg>
        </div>
        <div className="text-sm text-text-secondary">No open positions</div>
        <div className="text-xs text-text-muted mt-1">Place a market or limit order to open one.</div>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Symbol</th>
          <th className="text-left p-2">Side</th>
          <th className="text-right p-2">Qty</th>
          <th className="text-right p-2">Entry</th>
          <th className="text-right p-2">Mark</th>
          <th className="text-right p-2">P&L</th>
          <th className="text-right p-2">Lev</th>
          <th className="text-right p-2"></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const pnl = Number(p.unrealizedPnl || 0);
          const inst = instrumentsBySymbol?.[p.symbol];
          const quote = inst?.quoteCurrency || 'USD';
          const prec = inst?.pricePrecision || 4;
          const entry = fmtPriceDual(p.entryPrice, quote, fxRate, prec);
          const mark = fmtPriceDual(p.markPrice || p.entryPrice, quote, fxRate, prec);
          // PnL on the wire is already in the position's quote currency.
          // We display USD throughout, so for INR-quoted positions convert
          // to USD; otherwise show the native number as-is.
          const pnlUsd = quote === 'INR' ? pnl / Math.max(Number(fxRate || 0), 1) : pnl;
          return (
            <tr key={p._id} className="table-row">
              <td className="p-2 font-medium">
                <div className="flex items-center gap-2">
                  <AssetIcon row={inst || { symbol: p.symbol }} size={22} round />
                  <span>{p.symbol}</span>
                </div>
              </td>
              <td className={`p-2 font-semibold ${p.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>
                {p.side === 'BUY' ? 'LONG' : 'SHORT'}
              </td>
              <td className="p-2 text-right font-mono">{fmtNum(p.quantity, 4)}</td>
              <td className="p-2 text-right font-mono">
                <div>{entry.primary}</div>
                {entry.secondary && <div className="text-[10px] text-gray-500">{entry.secondary}</div>}
              </td>
              <td className="p-2 text-right font-mono">
                <div>{mark.primary}</div>
                {mark.secondary && <div className="text-[10px] text-gray-500">{mark.secondary}</div>}
              </td>
              <td className={`p-2 text-right font-mono ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                <div>{fmtPnlSimple(pnlUsd, 'USD')}</div>
              </td>
              <td className="p-2 text-right">1:{p.leverage}</td>
              <td className="p-2 text-right">
                <div className="flex justify-end gap-1">
                  <button onClick={() => onModify(p)} className="btn-ghost text-xs px-2 py-1">SL/TP</button>
                  <button onClick={() => onClose(p._id)} className="btn-ghost text-xs px-2 py-1">Close</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrdersTable({ orders, onCancel, fxRate, instrumentsBySymbol }) {
  if (!orders.length) {
    return (
      <div className="py-10 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3 border border-border-dark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
          </svg>
        </div>
        <div className="text-sm text-text-secondary">No open orders</div>
        <div className="text-xs text-text-muted mt-1">Pending limit/stop orders will appear here.</div>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Symbol</th>
          <th className="text-left p-2">Side</th>
          <th className="text-left p-2">Type</th>
          <th className="text-right p-2">Qty</th>
          <th className="text-right p-2">Filled</th>
          <th className="text-right p-2">Price / Trigger</th>
          <th className="text-right p-2">Status</th>
          <th className="text-right p-2"></th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const inst = instrumentsBySymbol?.[o.symbol];
          const quote = inst?.quoteCurrency || 'USD';
          const prec = inst?.pricePrecision || 4;
          const limitPx = o.price ? fmtPriceDual(o.price, quote, fxRate, prec) : null;
          const stopPx = o.stopPrice ? fmtPriceDual(o.stopPrice, quote, fxRate, prec) : null;
          return (
            <tr key={o._id} className="table-row">
              <td className="p-2 font-medium">
                <div className="flex items-center gap-2">
                  <AssetIcon row={inst || { symbol: o.symbol }} size={22} round />
                  <span>{o.symbol}</span>
                </div>
              </td>
              <td className={`p-2 font-semibold ${o.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>{o.side}</td>
              <td className="p-2">
                {o.type}
                {o.type === 'STOP' && o.triggeredAt && <span className="ml-1 text-[10px] text-blue-500">(fired)</span>}
              </td>
              <td className="p-2 text-right font-mono">{fmtNum(o.quantity, 4)}</td>
              <td className="p-2 text-right font-mono">{fmtNum(o.filledQuantity, 4)}</td>
              <td className="p-2 text-right font-mono">
                {o.type === 'STOP' ? (
                  <>
                    <div>{stopPx?.primary || '-'}{limitPx ? ` / ${limitPx.primary}` : ''}</div>
                    {(stopPx?.secondary || limitPx?.secondary) && (
                      <div className="text-[10px] text-gray-500">
                        {stopPx?.secondary || ''}{limitPx?.secondary ? ` / ${limitPx.secondary}` : ''}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>{limitPx?.primary || '-'}</div>
                    {limitPx?.secondary && (
                      <div className="text-[10px] text-gray-500">{limitPx.secondary}</div>
                    )}
                  </>
                )}
              </td>
              <td className="p-2 text-right text-gray-400">{o.status}</td>
              <td className="p-2 text-right">
                <button onClick={() => onCancel(o._id)} className="btn-ghost text-xs">
                  Cancel
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
