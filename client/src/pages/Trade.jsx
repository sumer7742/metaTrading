import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import PriceChart from '../components/PriceChart';
import OrderForm from '../components/OrderForm';
import NotificationCenter from '../components/NotificationCenter';
import MarketWatch from '../components/MarketWatch';
import { fmtNum, fmtPnlSimple, fmtMoney, fmtPriceDual, fmtMoneyDual, currencySymbol } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import { useThemeStore } from '../store/theme';
import { Link } from 'react-router-dom';
import { recordRecentlyViewed } from '../hooks/useRecentlyViewed';
import AssetIcon from '../components/AssetIcon';
import TradeSettingsPanel from '../components/settings/TradeSettingsPanel';
import { useTradeSettings } from '../store/tradeSettings';
import { getMarketSession } from '../utils/marketSession';

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
  // Fine-grained Zustand selectors — each slice gets its own subscription
  // so the chart re-renders the instant a toggle flips, without depending
  // on top-level state reference equality.
  const showOnChart      = useTradeSettings((s) => s.showOnChart);
  const calendarFilters  = useTradeSettings((s) => s.calendarFilters);
  const tradingPrefs     = useTradeSettings((s) => s.trading);
  const setTradeSetting  = useTradeSettings((s) => s.set);
  // Legacy alias — kept so existing references downstream still compile.
  // (Re-built every render from the slices above, so reactivity is preserved.)
  const tradeSettings = { showOnChart, calendarFilters, trading: tradingPrefs };
  // Captures the rich 24h fields from `ticker:<symbol>` WS frames (Binance
  // 24hrTicker) so panels like Performance + the OrderForm price strip
  // see fresh change24h / dayHigh / dayLow / volume / bid / ask even when
  // the cached `useInstruments` row is stale.
  const [liveEnrichment, setLiveEnrichment] = useState({});
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
  // Whether the entire right sidebar (icon strip + content panel) is on
  // screen. When `false`, we render a thin reopen tab on the right edge
  // instead — drawer-style hide/show.
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  // Order panel defaults open on desktop, closed on mobile (chart fills
  // the viewport; user taps the floating "+ Order" FAB or BUY/SELL chip
  // to open the bottom sheet). The matchMedia check has to happen at
  // initial render — toggling later would clobber the user's choice.
  const [showOrderPanel, setShowOrderPanel] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  // Active panel tab in the left mini-sidebar — TradingView-style icon
  // strip on the far edge that switches what content the 280px panel
  // shows. 'watchlist' is the default (= the existing instruments list).
  const [leftPanelTab, setLeftPanelTab] = useState('watchlist');
  // Live order-book snapshot for the active symbol — populated only when
  // the Market Depth tab is open (avoid wasted polling/subscriptions for
  // tabs the user never visits).
  const [orderBook, setOrderBook] = useState(null);
  const [orderBookLoading, setOrderBookLoading] = useState(false);
  // Movers panel — live overlay of change24h from WS ticker enrichment.
  // Keyed by symbol; sparsely populated as Binance ticker frames arrive.
  // We merge this into `instrumentRows` so the panel re-sorts in real
  // time without waiting for /watchlist polling.
  const [moverOverlay, setMoverOverlay] = useState({});

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
  // Order side (BUY/SELL) is owned by the chart-top quick-trade chip so
  // the chip and the order form stay in sync.
  const [orderSide, setOrderSide] = useState('BUY');
  // In fullscreen the side OrderForm aside is hidden — instead the
  // BUY/SELL chip pops the order form as a glass overlay floating on
  // top of the chart, TradingView-style. This flag controls that
  // overlay; auto-resets when the user exits fullscreen so a stale
  // overlay doesn't reappear next time they re-enter.
  const [showFloatingOrder, setShowFloatingOrder] = useState(false);
  // Floating order overlay drag state — offsets from its default
  // centred position. Reset to (0,0) every time the panel re-opens so
  // it doesn't reappear at a stale location.
  const [floatPos, setFloatPos] = useState({ x: 0, y: 0 });
  const floatDragRef = useRef({ dragging: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 });
  // Resizable height for the fullscreen floating order modal. Persisted
  // so the user's preferred size survives reloads. Clamped between 320
  // (enough for the core form) and 820 (fits comfortably on most screens).
  const FLOAT_H_KEY = 'tradepro:float-order-height';
  const [floatHeight, setFloatHeight] = useState(() => {
    if (typeof window === 'undefined') return 460;
    try {
      const raw = localStorage.getItem(FLOAT_H_KEY);
      const n = raw ? Number(raw) : 460;
      return Number.isFinite(n) ? Math.max(320, Math.min(820, n)) : 460;
    } catch (_) { return 460; }
  });
  useEffect(() => {
    try { localStorage.setItem(FLOAT_H_KEY, String(floatHeight)); } catch (_) {}
  }, [floatHeight]);
  const floatResizeRef = useRef({ resizing: false, startY: 0, startH: 0 });
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

  const instrumentBase = useMemo(() => instruments.find((i) => i.symbol === symbol), [instruments, symbol]);
  // Merge the live ticker enrichment (24h fields from Binance) onto the
  // base instrument record so all downstream consumers (OrderForm price
  // strip, Performance panel, Market Depth fallback) see fresh values
  // even when the cached watchlist row is stale or empty.
  const instrument = useMemo(() => {
    if (!instrumentBase) return null;
    const enrich = liveEnrichment[symbol];
    if (!enrich) return instrumentBase;
    const valid = (v) => Number.isFinite(v) && v > 0;
    return {
      ...instrumentBase,
      change24h: Number.isFinite(enrich.change24h) ? enrich.change24h : instrumentBase.change24h,
      dayHigh:   valid(enrich.dayHigh)   ? enrich.dayHigh   : instrumentBase.dayHigh,
      dayLow:    valid(enrich.dayLow)    ? enrich.dayLow    : instrumentBase.dayLow,
      volume24h: valid(enrich.volume24h) ? enrich.volume24h : instrumentBase.volume24h,
      bid:       valid(enrich.bid)       ? enrich.bid       : instrumentBase.bid,
      ask:       valid(enrich.ask)       ? enrich.ask       : instrumentBase.ask,
    };
  }, [instrumentBase, liveEnrichment, symbol]);
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

  // Effective leverage from /user/leverage — same source OrderForm uses
  // (admin override → plan default → fallback 100). Without this the
  // account dropdown was showing a stale `account.leverage` value (e.g.
  // 101) that didn't match the leverage actually applied to new orders.
  // WS subscription keeps it in sync if admin changes the cap mid-session.
  const [leverageState, setLeverageState] = useState(null);
  useEffect(() => {
    let cancelled = false;
    // Refetch whenever the active account changes so demo accounts get
    // their unlimited cap instead of inheriting admin overrides that
    // only apply to real accounts.
    const fetchLev = () => {
      const params = account?._id ? { accountId: account._id } : {};
      api.get('/user/leverage', { params })
        .then((r) => { if (!cancelled) setLeverageState(r.data?.data || null); })
        .catch(() => {});
    };
    fetchLev();
    const unsub = wsClient.subscribe('user:leverage', (data) => {
      // WS push is user-wide (admin override change). Re-fetch with the
      // current account context so demo accounts stay at unlimited.
      if (!cancelled) fetchLev();
    });
    window.addEventListener('focus', fetchLev);
    return () => {
      cancelled = true;
      if (unsub) unsub();
      window.removeEventListener('focus', fetchLev);
    };
  }, [account?._id]);

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
    // Use allSettled so a single endpoint failure doesn't blank both
    // tables. Each side keeps its prior data on transient errors.
    const [o, p] = await Promise.allSettled([
      api.get('/trading/orders/open'),
      api.get('/trading/positions'),
    ]);
    if (o.status === 'fulfilled') setOpenOrders(o.value.data.data);
    if (p.status === 'fulfilled') setPositions(p.value.data.data);
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
      // Capture the 24h enrichment fields from Binance 24hrTicker so
      // Performance / OrderForm panels can render real numbers even
      // when the cached watchlist row is empty.
      if (Number.isFinite(Number(data.change24h)) || Number.isFinite(Number(data.bid))) {
        setLiveEnrichment((prev) => ({
          ...prev,
          [symbol]: {
            change24h: Number(data.change24h),
            dayHigh:   Number(data.dayHigh),
            dayLow:    Number(data.dayLow),
            volume24h: Number(data.volume24h),
            bid:       Number(data.bid),
            ask:       Number(data.ask),
          },
        }));
      }
    });
    return () => {
      unsub();
    };
  }, [symbol]);

  // ── Market Depth — real order-book data for the active symbol.
  // Only fetches + subscribes when the Depth tab is actually open so we
  // don't pay for the WS channel + REST snapshot on every page load.
  useEffect(() => {
    if (leftPanelTab !== 'depth' || !symbol) {
      setOrderBook(null);
      setOrderBookLoading(false);
      return;
    }
    let cancelled = false;
    setOrderBookLoading(true);
    setOrderBook(null);
    const load = async () => {
      try {
        const { data } = await api.get(`/instruments/${encodeURIComponent(symbol)}/orderbook`, { params: { depth: 20 } });
        if (!cancelled) {
          setOrderBook(data?.data || null);
          setOrderBookLoading(false);
        }
      } catch (_) {
        if (!cancelled) { setOrderBook(null); setOrderBookLoading(false); }
      }
    };
    load();
    const unsub = wsClient.subscribe(`orderbook:${symbol}`, (snap) => {
      if (snap) {
        setOrderBook(snap);
        setOrderBookLoading(false);
      }
    });
    return () => { cancelled = true; unsub && unsub(); };
  }, [leftPanelTab, symbol]);

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
  // Resolve the per-position "mark" price using the user's chosen
  // Settings > Trading > Price Source. For positions on the active
  // symbol we have full bid/ask context (via instrument); for other
  // symbols we fall back to last-price (priceMap) since we don't track
  // per-symbol bid/ask client-side.
  const priceSource = tradeSettings.trading.priceSource;
  const positionsWithLivePnl = useMemo(() =>
    positions.map((p) => {
      const last = priceMap[p.symbol];
      let markPx = last || p.markPrice || p.entryPrice;
      // Apply price-source override only when we have explicit bid/ask
      // for this symbol (i.e. it's the active symbol on the chart).
      if (p.symbol === symbol && instrument) {
        const b = Number(instrument.bid);
        const a = Number(instrument.ask);
        if (priceSource === 'bid' && Number.isFinite(b) && b > 0) markPx = b;
        else if (priceSource === 'ask' && Number.isFinite(a) && a > 0) markPx = a;
        else if (priceSource === 'mid' && Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) markPx = (a + b) / 2;
      }
      // Hedge mode — derive positionSide for legacy positions that don't
      // carry the field yet (BUY → LONG, SELL → SHORT). The UI keys cards
      // off this so a BUY and a SELL on the same symbol render as two
      // independent rows instead of being treated as one.
      const positionSide = p.positionSide || (p.side === 'BUY' ? 'LONG' : 'SHORT');
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const mark = Number(markPx);
      if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(mark)) {
        return { ...p, positionSide, markPrice: markPx, unrealizedPnl: '0' };
      }
      // LONG profits when mark > entry; SHORT profits when mark < entry.
      const livePnl = positionSide === 'LONG' ? (mark - entry) * qty : (entry - mark) * qty;
      return { ...p, positionSide, markPrice: markPx, unrealizedPnl: String(livePnl) };
    }),
    [positions, priceMap, priceSource, symbol, instrument]
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

  // Position-modify modal. Replaces the old window.prompt pair with a
  // proper popup (TP/SL fields + tabs for partial close / close-by).
  const [slTpModalPosition, setSlTpModalPosition] = useState(null);
  const modifyPositionSlTp = (position) => setSlTpModalPosition(position);

  const submitSlTpModify = async (positionId, payload) => {
    try {
      await api.put(`/trading/positions/${positionId}`, payload);
      toast.success('Position updated');
      setSlTpModalPosition(null);
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

  // Stable join-key for the movers effect — depending on `instrumentRows`
  // directly would retrigger on every WS tick because the array gets a
  // new reference each priceMap update, which would refetch watchlist +
  // resubscribe to all tickers every tick (real perf leak).
  const moverSymbolsKey = useMemo(
    () => instrumentRows.map((r) => r.symbol).sort().join('|'),
    [instrumentRows]
  );

  // ── Movers — when the panel is open, subscribe to ticker frames for
  // every active instrument and capture change24h / dayHigh / dayLow
  // into a sparse overlay map. This drives the panel's live sort.
  // Also force-refreshes the watchlist endpoint on open so older
  // cached `_cache` blobs from useInstruments get the fresh numbers.
  useEffect(() => {
    if (leftPanelTab !== 'hotlist') return;
    if (!moverSymbolsKey) return;
    const symbols = moverSymbolsKey.split('|');
    // Best-effort refresh of the watchlist endpoint — patch the
    // module-level cache so all consumers (this row + nav etc.) see fresh numbers.
    api.get('/instruments/watchlist').then(({ data }) => {
      const rows = data?.data || [];
      const next = {};
      for (const r of rows) {
        if (Number.isFinite(Number(r.change24h))) {
          next[r.symbol] = {
            change24h: Number(r.change24h),
            dayHigh:   Number(r.dayHigh),
            dayLow:    Number(r.dayLow),
            volume24h: Number(r.volume24h),
            lastPrice: Number(r.lastPrice),
          };
        }
      }
      setMoverOverlay((prev) => ({ ...prev, ...next }));
    }).catch(() => {});
    // Subscribe to live ticker updates for every symbol — Binance's
    // 24hrTicker now broadcasts change24h on the same ticker:<symbol>
    // channel, so even if the watchlist endpoint is stale the overlay
    // gets refreshed on every tick.
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (tick) => {
        if (!tick) return;
        if (!Number.isFinite(Number(tick.change24h))) return;
        setMoverOverlay((prev) => ({
          ...prev,
          [sym]: {
            change24h: Number(tick.change24h),
            dayHigh:   Number(tick.dayHigh),
            dayLow:    Number(tick.dayLow),
            volume24h: Number(tick.volume24h),
            lastPrice: Number(tick.lastPrice),
          },
        }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [leftPanelTab, moverSymbolsKey]);

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
    const walletAvail = Number(walletFree || 0); // wallet free = balance − locked
    const upnl = positionsWithLivePnl.reduce((acc, p) => acc + Number(p.unrealizedPnl || 0), 0);
    const usedMargin = positions.reduce((acc, p) => {
      const px = Number(p.entryPrice || 0) * Number(p.quantity || 0);
      const lev = Math.max(Number(p.leverage || 1), 1);
      return acc + px / lev;
    }, 0);
    const balance = walletAvail + usedMargin;          // realized cash in wallet
    const equity = balance + upnl;                     // balance + uPnL
    const freeMargin = equity - usedMargin;            // broker free-margin formula
    const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : null;
    return {
      equity,
      free: freeMargin,
      balance,
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
        // If the API rejects (no user gesture, permissions, denied) we
        // must NOT leave chartView stuck in 'fullscreen' — the UI would
        // think it's in fullscreen forever. Revert state on failure.
        try {
          Promise.resolve(req.call(root)).catch(() => {
            setChartView((v) => (v === 'fullscreen' ? 'normal' : v));
          });
        } catch (_) {
          setChartView((v) => (v === 'fullscreen' ? 'normal' : v));
        }
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

  // ── Floating order overlay — drag-to-move support ─────────────────
  // Global mouse listeners track pointer movement once the user
  // grabs the drag handle on the overlay header. The position is
  // expressed as a delta from the centred baseline so the existing
  // CSS positioning (`top: 50%; right: 30%`) keeps working.
  useEffect(() => {
    const onMove = (e) => {
      const st = floatDragRef.current;
      if (!st.dragging) return;
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      setFloatPos({ x: st.startPosX + dx, y: st.startPosY + dy });
    };
    const onUp = () => { floatDragRef.current.dragging = false; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  // Reset position whenever the overlay closes — re-opening lands it
  // at the default centred location, not at the last drag spot.
  useEffect(() => {
    if (!showFloatingOrder) setFloatPos({ x: 0, y: 0 });
  }, [showFloatingOrder]);

  // ── Floating order overlay — drag-to-RESIZE support ──────────────
  // Bottom edge of the modal has a resize grip; dragging it adjusts the
  // modal height. Clamped between 360 and 900 px so it stays usable.
  useEffect(() => {
    const onMove = (e) => {
      const st = floatResizeRef.current;
      if (!st.resizing) return;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      if (clientY == null) return;
      const dy = clientY - st.startY;
      const next = Math.max(320, Math.min(820, st.startH + dy));
      setFloatHeight(next);
    };
    const onUp = () => { floatResizeRef.current.resizing = false; document.body.style.userSelect = ''; document.body.style.cursor = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, []);
  const startFloatResize = (e) => {
    const clientY = e.touches?.[0]?.clientY ?? e.clientY;
    floatResizeRef.current = { resizing: true, startY: clientY, startH: floatHeight };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  };

  const startFloatDrag = (e) => {
    floatDragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startPosX: floatPos.x,
      startPosY: floatPos.y,
    };
    // Prevent the chart underneath from registering text-selection
    // while the user drags across it.
    document.body.style.userSelect = 'none';
  };
  // Wrap the side-change handler so clicking BUY/SELL on the chip
  // always reveals an order form the user can act on:
  //  • Fullscreen → pop the floating overlay (side panel is hidden)
  //  • Normal     → expand the side OrderForm aside if collapsed
  // Without this, clicking BUY/SELL on a collapsed-panel layout would
  // silently change `orderSide` with no visible UI.
  const handleOrderSideChange = useCallback((side) => {
    setOrderSide(side);
    if (isFullscreen) {
      setShowFloatingOrder(true);
    } else if (!showOrderPanel) {
      setShowOrderPanel(true);
    }
  }, [isFullscreen, showOrderPanel]);
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
      <div className={`${isFullscreen ? 'hidden' : 'flex'} items-center justify-between gap-2 bg-white border-b border-border-dark px-3 sm:px-4 h-[52px] shrink-0 -mx-1 -mt-1`}>
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
            className="hidden sm:inline-flex shrink-0 items-center justify-center w-7 h-7 rounded-lg border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Quick-access Show-on-Chart toggles — same flags as the
              Settings panel (mirrored), pinned here so the user can flip
              positions / TP-SL / Stop-Limit overlays with one click. */}
          <div className="hidden md:inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-border-dark bg-bg-hover/30">
            <HeaderToggle
              active={showOnChart.positions}
              onClick={() => setTradeSetting('showOnChart.positions', !showOnChart.positions)}
              label="Positions"
              title="Show open positions on chart"
              accent="emerald"
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" /><rect x="6" y="13" width="3" height="5" /><rect x="11" y="9" width="3" height="9" /><rect x="16" y="6" width="3" height="12" />
                </svg>
              }
            />
            <HeaderToggle
              active={showOnChart.tpsl}
              onClick={() => setTradeSetting('showOnChart.tpsl', !showOnChart.tpsl)}
              label="TP/SL"
              title="Show TP / SL lines on open positions"
              accent="indigo"
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="8"  x2="21" y2="8"  strokeDasharray="3 3" />
                  <line x1="3" y1="16" x2="21" y2="16" strokeDasharray="3 3" />
                  <circle cx="8"  cy="8"  r="1.5" fill="currentColor" />
                  <circle cx="16" cy="16" r="1.5" fill="currentColor" />
                </svg>
              }
            />
            <HeaderToggle
              active={showOnChart.stopLimit}
              onClick={() => setTradeSetting('showOnChart.stopLimit', !showOnChart.stopLimit)}
              label="Pending"
              title="Show pending Stop / Limit order lines"
              accent="amber"
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6"  x2="21" y2="6" />
                  <line x1="3" y1="18" x2="21" y2="18" strokeDasharray="3 3" />
                  <polyline points="7 10 12 14 17 10" />
                </svg>
              }
            />
          </div>

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
                  className="h-11 flex items-center gap-2.5 pl-1.5 pr-2.5 rounded-lg border border-border-dark bg-white hover:bg-bg-hover transition-all shadow-sm text-left"
                >
                  {/* Wallet icon in tinted rounded square */}
                  <div className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center bg-primary-500/10 text-primary-600">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                      <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
                    </svg>
                  </div>
                  <div className="flex flex-col leading-[1.15] min-w-0">
                    {/* Top row — name + DEMO/LIVE pill */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-text-primary truncate max-w-[110px] sm:max-w-[140px]">
                        {name}
                      </span>
                      {acc?.accountType && (
                        <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-600 tracking-wider">
                          {acc.accountType}
                        </span>
                      )}
                    </div>
                    {/* Bottom row — balance + currency */}
                    <div className="text-[13px] font-bold text-text-primary tabular-nums truncate">
                      {hideBalance ? '••••' : fmtBal} <span className="text-[10px] text-text-muted font-medium ml-0.5">{ccy}</span>
                    </div>
                  </div>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="text-text-muted shrink-0 ml-0.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
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
              // Prefer the global effective leverage (admin override → plan
              // default → fallback) so this matches what OrderForm enforces
              // when placing orders. Falls back to the per-account field
              // only if the endpoint hasn't responded yet.
              const accLeverage = leverageState?.effectiveLeverage
                || account?.leverage
                || account?.maxLeverage
                || 100;
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
            className="h-9 inline-flex items-center gap-1.5 px-2.5 sm:px-4 font-bold text-[13px] shadow-card hover:shadow-elevated transition-all shrink-0"
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
        {/* Mini icon strip — TradingView-style panel switcher.
            Drawer-style: a × at the top hides the WHOLE sidebar (strip
            + content panel). When hidden a thin reopen tab appears on
            the far right edge so the user can bring it back. */}
        {showRightSidebar && (
          <aside className={`hidden lg:flex lg:order-3 w-16 shrink-0 flex-col gap-1 p-1 -mt-1 -mr-1 glass border-l border-border-dark overflow-y-auto ${isFullscreen ? 'z-20' : ''}`}>
            {/* Close-drawer button — hides the whole right sidebar. */}
            <button
              type="button"
              onClick={() => setShowRightSidebar(false)}
              title="Close sidebar"
              aria-label="Close sidebar"
              className="w-full py-1.5 mb-0.5 rounded-md flex flex-col items-center justify-center gap-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
              </svg>
              <span className="text-[9px] font-semibold leading-none tracking-tight">Close</span>
            </button>

            {[
              { id: 'watchlist',    label: 'Instruments',  icon: <SbWatchI /> },
              { id: 'details',      label: 'Details',      icon: <SbDetailsI /> },
              { id: 'about',        label: 'About',        icon: <SbAboutI /> },
              { id: 'performance',  label: 'Performance',  icon: <SbPerfI /> },
              { id: 'depth',        label: 'Depth',        icon: <SbDepthI /> },
              { id: 'positions',    label: 'Positions',    icon: <SbPositionsI /> },
              { id: 'pending',      label: 'Pending',      icon: <SbPendingI /> },
              { id: 'hotlist',      label: 'Movers',       icon: <SbHotI /> },
            ].map((t) => {
              const active = leftPanelTab === t.id && showInstruments;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setLeftPanelTab(t.id); if (!showInstruments) setShowInstruments(true); }}
                  title={t.label}
                  aria-label={t.label}
                  className={`w-full py-1.5 rounded-md flex flex-col items-center justify-center gap-0.5 transition-all ${
                    active
                      ? 'bg-primary-500/15 text-primary-600 ring-1 ring-primary-500/30'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  {t.icon}
                  <span className="text-[9px] font-semibold leading-none tracking-tight">{t.label}</span>
                </button>
              );
            })}

            {/* Settings — same tab behaviour as the others (no drawer). */}
            <SettingsTabBtn
              active={leftPanelTab === 'settings' && showInstruments}
              onClick={() => { setLeftPanelTab('settings'); if (!showInstruments) setShowInstruments(true); }}
            />
          </aside>
        )}

        {/* Reopen tab — shown only when the right sidebar is fully closed.
            Mirrors the "Place Order" reopen tab pattern used on the order
            form: a slim vertical strip the user can grab to bring back
            the sidebar. */}
        {!showRightSidebar && !isFullscreen && (
          <button
            type="button"
            onClick={() => setShowRightSidebar(true)}
            title="Show sidebar"
            className="hidden lg:flex lg:order-3 w-7 shrink-0 self-start flex-col items-center justify-center gap-2 py-3 glass border border-border-dark rounded-xl text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 7l-5 5 5 5" /><path d="M18 7l-5 5 5 5" />
            </svg>
            <span className="text-[9px] uppercase tracking-[0.2em] font-bold whitespace-nowrap" style={{ writingMode: 'vertical-rl' }}>
              Panels
            </span>
          </button>
        )}

        {/* Right — INSTRUMENTS panel (closes individually + via drawer ×).
            In fullscreen the panel still renders but floats above the chart
            (absolute + z-20) so it doesn't push the chart's bounds.
            The whole-sidebar drawer (showRightSidebar=false) hides this
            too — only the reopen tab stays. */}
        <aside className={`${!showInstruments || !showRightSidebar ? 'hidden' : 'hidden lg:flex'} lg:order-2 w-[280px] shrink-0 glass border border-border-dark rounded-xl flex-col overflow-hidden ${isFullscreen ? 'z-20' : ''}`}>
          <div className="px-3 py-2.5 border-b border-border-dark flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.15em] font-extrabold text-text-primary">
                {leftPanelTab === 'watchlist' ? 'Instruments'
                 : leftPanelTab === 'details' ? 'Symbol Details'
                 : leftPanelTab === 'about' ? 'About'
                 : leftPanelTab === 'performance' ? 'Performance'
                 : leftPanelTab === 'depth' ? 'Market Depth'
                 : leftPanelTab === 'positions' ? 'Open Positions'
                 : leftPanelTab === 'pending' ? 'Pending Orders'
                 : leftPanelTab === 'settings' ? 'Settings'
                 : 'Top Movers'}
              </span>
              {leftPanelTab === 'watchlist' && (
                <span className="text-text-secondary text-xs font-semibold">{instrumentRows.length}</span>
              )}
              {leftPanelTab === 'positions' && positions.length > 0 && (
                <span className="text-text-secondary text-xs font-semibold">{positions.length}</span>
              )}
              {leftPanelTab === 'pending' && openOrders.length > 0 && (
                <span className="text-text-secondary text-xs font-semibold">{openOrders.length}</span>
              )}
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

          {/* ── Panel content switches by leftPanelTab ─────────────── */}
          {leftPanelTab === 'watchlist' && (<>
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
          </>)}

          {/* ── Symbol Details pane ─────────────────────────────────── */}
          {leftPanelTab === 'details' && instrument && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
              <div className="flex items-center gap-2.5 pb-3 border-b border-border-subtle">
                <AssetIcon row={instrument} size={36} round />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-text-primary truncate">{instrument.symbol}</div>
                  <div className="text-[11px] text-text-muted truncate">{instrument.name || `${instrument.baseCurrency}/${instrument.quoteCurrency}`}</div>
                </div>
              </div>
              {[
                { label: 'Category', value: instrument.category },
                { label: 'Base / Quote', value: `${instrument.baseCurrency || '—'} / ${instrument.quoteCurrency || '—'}` },
                { label: 'Last Price', value: fmtNum(instrument.lastPrice, Math.min(instrument.pricePrecision || 2, 5)), mono: true },
                { label: 'Bid / Ask', value: `${fmtNum(instrument.bid, Math.min(instrument.pricePrecision || 2, 5))} / ${fmtNum(instrument.ask, Math.min(instrument.pricePrecision || 2, 5))}`, mono: true },
                { label: 'Spread', value: instrument.spreadValue ? `${instrument.spreadValue} (${instrument.spreadType || 'FIXED'})` : '—' },
                { label: 'Max Leverage', value: instrument.maxLeverage ? `1:${instrument.maxLeverage}` : '—' },
                { label: 'Min Order', value: instrument.minOrderSize || '—' },
                { label: 'Precision', value: `${instrument.pricePrecision || 2} digits` },
                { label: 'Feed', value: instrument.externalProvider || 'Internal' },
                { label: 'Status', value: instrument.isActive ? 'Active' : 'Inactive', tone: instrument.isActive ? 'bull' : 'muted' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{row.label}</span>
                  <span className={`${row.mono ? 'font-mono' : ''} text-text-primary text-right truncate`}
                        style={row.tone === 'bull' ? { color: '#16A34A' } : undefined}>
                    {row.value}
                  </span>
                </div>
              ))}
              {Number.isFinite(Number(instrument.change24h)) && (
                <div className="pt-3 border-t border-border-subtle">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1">24h Change</div>
                  <div className="text-lg font-bold font-mono"
                       style={{ color: Number(instrument.change24h) >= 0 ? '#16A34A' : '#DC2626' }}>
                    {Number(instrument.change24h) >= 0 ? '+' : ''}{Number(instrument.change24h).toFixed(2)}%
                  </div>
                </div>
              )}
            </div>
          )}
          {leftPanelTab === 'details' && !instrument && (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted px-4 text-center">
              Pick an instrument from Watchlist to see its details here.
            </div>
          )}

          {/* ── Top Movers pane — top 5 gainers + 5 losers ─────────── */}
          {leftPanelTab === 'hotlist' && (
            <div className="flex-1 overflow-y-auto">
              {(() => {
                // Merge the static instrumentRows snapshot with the
                // live `moverOverlay` map (populated from WS ticker
                // frames + fresh watchlist on tab open).
                const merged = instrumentRows.map((r) => {
                  const o = moverOverlay[r.symbol];
                  return o
                    ? {
                        ...r,
                        change24h: o.change24h,
                        dayHigh:   o.dayHigh,
                        dayLow:    o.dayLow,
                        volume24h: o.volume24h,
                        lastPrice: Number.isFinite(o.lastPrice) ? o.lastPrice : r.lastPrice,
                      }
                    : r;
                });
                const ranked = merged
                  .filter((r) => Number.isFinite(Number(r.change24h)))
                  .sort((a, b) => Number(b.change24h) - Number(a.change24h));
                const gainers = ranked.slice(0, 8);
                const losers = ranked.slice(-8).reverse();
                const Row = ({ r }) => {
                  const change = Number(r.change24h);
                  const pos = change >= 0;
                  const prec = Math.min(r.pricePrecision || 2, 5);
                  return (
                    <button
                      type="button"
                      onClick={() => openTab(r.symbol)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-hover transition-colors text-left"
                    >
                      <AssetIcon row={r} size={22} round />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-text-primary truncate">{r.symbol}</div>
                        <div className="text-[10px] font-mono text-text-muted">{fmtNum(r.lastPrice, prec)}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[11px] font-bold font-mono tabular-nums" style={{ color: pos ? '#16A34A' : '#DC2626' }}>
                          {pos ? '+' : ''}{change.toFixed(2)}%
                        </div>
                        {Number.isFinite(Number(r.volume24h)) && Number(r.volume24h) > 0 && (
                          <div className="text-[9px] font-mono text-text-muted mt-0.5">
                            Vol {Number(r.volume24h) >= 1e6
                              ? (Number(r.volume24h) / 1e6).toFixed(1) + 'M'
                              : Number(r.volume24h) >= 1e3
                                ? (Number(r.volume24h) / 1e3).toFixed(1) + 'K'
                                : Number(r.volume24h).toFixed(0)}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                };
                return (
                  <>
                    {/* Live status header */}
                    <div className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-text-muted bg-bg-hover/40 border-b border-border-subtle flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="relative flex w-1.5 h-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-70 animate-ping" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-bull" />
                        </span>
                        Live · {ranked.length} symbols
                      </span>
                    </div>
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-bull bg-bull/5 border-b border-border-subtle">▲ Top Gainers</div>
                    {gainers.length === 0
                      ? <div className="px-3 py-4 text-[11px] text-text-muted text-center">Waiting for 24h data…</div>
                      : gainers.map((r) => <Row key={`g-${r.symbol}`} r={r} />)}
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-bear bg-bear/5 border-y border-border-subtle">▼ Top Losers</div>
                    {losers.length === 0
                      ? <div className="px-3 py-4 text-[11px] text-text-muted text-center">Waiting for 24h data…</div>
                      : losers.map((r) => <Row key={`l-${r.symbol}`} r={r} />)}
                  </>
                );
              })()}
            </div>
          )}

          {/* ── About pane — descriptive asset-class info + key facts ── */}
          {leftPanelTab === 'about' && instrument && (() => {
            const cat = String(instrument.category || '').toUpperCase();
            const desc = cat === 'CRYPTO'
              ? 'Cryptocurrency pair trading 24/7 against the US Dollar. High volatility — risk management essential.'
              : cat === 'FOREX'
              ? 'Currency pair traded on the spot FX market. Liquidity peaks during overlapping London + New York sessions.'
              : cat === 'STOCK'
              ? 'Listed equity — price reflects company shares traded on its primary exchange during market hours.'
              : cat === 'COMMODITY'
              ? 'Physical-asset derivative — gold, silver, oil and similar contracts settled against spot reference prices.'
              : cat === 'INDEX'
              ? 'Stock-index CFD — exposure to a basket of listed equities tracked by the underlying benchmark.'
              : 'Tradable instrument quoted in real time.';
            const hours = cat === 'CRYPTO' ? '24 / 7' : cat === 'FOREX' ? 'Mon 00:00 → Fri 22:00 UTC' : 'Exchange hours';
            return (
              <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                <div className="flex items-center gap-2.5 pb-3 border-b border-border-subtle">
                  <AssetIcon row={instrument} size={36} round />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-text-primary truncate">{instrument.symbol}</div>
                    <div className="text-[11px] text-text-muted truncate">{instrument.name || `${instrument.baseCurrency}/${instrument.quoteCurrency}`}</div>
                  </div>
                </div>
                <p className="text-[12px] leading-relaxed text-text-secondary">{desc}</p>
                <div className="space-y-2">
                  {[
                    { l: 'Asset Class',  v: cat ? cat.charAt(0) + cat.slice(1).toLowerCase() : '—' },
                    { l: 'Quote Curr.',  v: instrument.quoteCurrency || '—' },
                    { l: 'Trading Hours', v: hours },
                  ].map((r) => (
                    <div key={r.l} className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{r.l}</span>
                      <span className="text-text-primary text-right truncate">{r.v}</span>
                    </div>
                  ))}
                </div>
                <div className="pt-3 border-t border-border-subtle">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-2">Risk Notice</div>
                  <p className="text-[11px] text-text-muted leading-relaxed">
                    Leveraged trading carries significant risk and may not be suitable for all investors. Past performance is not indicative of future results.
                  </p>
                </div>
              </div>
            );
          })()}
          {leftPanelTab === 'about' && !instrument && (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted px-4 text-center">
              Pick an instrument to see its description here.
            </div>
          )}

          {/* ── Performance pane — 24h stats, sparkline, range viz ───── */}
          {leftPanelTab === 'performance' && instrument && (
            <SidebarPerformance instrument={instrument} livePrice={livePrice} />
          )}
          {leftPanelTab === 'performance' && !instrument && (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted px-4 text-center">
              Pick an instrument to see performance stats here.
            </div>
          )}

          {/* ── Market Depth pane — real order-book data ───────────── */}
          {leftPanelTab === 'depth' && instrument && (() => {
            const session = getMarketSession(instrument.category);
            // Market closed (forex weekend, stocks after-hours, etc.) →
            // show a clear status card instead of streaming stale data.
            if (!session.isOpen) {
              return (
                <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center">
                  <span className="w-12 h-12 rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                  </span>
                  <div className="text-sm font-bold text-text-primary">{session.label}</div>
                  {session.detail && <p className="mt-1 text-[11px] text-text-muted max-w-[220px]">{session.detail}</p>}
                  <div className="mt-3 text-[10px] uppercase tracking-wider font-bold text-text-muted">{instrument.symbol} · {instrument.category}</div>
                </div>
              );
            }
            // Render immediately with whatever we have (real book or
            // top-of-book fallback). No loading spinner — even the
            // first frame shows useful data via the derived bid/ask.
            const prec = Math.min(instrument.pricePrecision || 2, 5);
            const realBids = Array.isArray(orderBook?.bids) ? orderBook.bids : [];
            const realAsks = Array.isArray(orderBook?.asks) ? orderBook.asks : [];
            const hasRealBook = realBids.length > 0 || realAsks.length > 0;

            // Normalise to the same shape used by the simulated fallback.
            // Backend returns { price, quantity (string), count }; convert
            // to numbers and clip to the top 8 each side.
            const realAsksRows = realAsks.slice(0, 8).map((l) => ({
              price: Number(l.price), size: Number(l.quantity), count: l.count,
            })).filter((r) => Number.isFinite(r.price));
            const realBidsRows = realBids.slice(0, 8).map((l) => ({
              price: Number(l.price), size: Number(l.quantity), count: l.count,
            })).filter((r) => Number.isFinite(r.price));

            // Resolve top-of-book bid/ask through three fallbacks:
            //   1. instrument.bid / instrument.ask (from /watchlist)
            //   2. livePrice ± spread/2 (live WS tick × instrument's spread)
            //   3. instrument.lastPrice ± spread/2 (last known price)
            const _deriveBA = () => {
              const fromWl = (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : null;
              };
              let b = fromWl(instrument.bid);
              let a = fromWl(instrument.ask);
              if (b && a) return { bid: b, ask: a };
              const lp = fromWl(livePrice) || fromWl(instrument.lastPrice);
              if (!lp) return { bid: null, ask: null };
              const sv = Number(instrument.spreadValue) || 0;
              const half = sv > 0 ? sv / 2 : 0;
              if (instrument.spreadType === 'PERCENTAGE') {
                return { bid: lp * (1 - half), ask: lp * (1 + half) };
              }
              return { bid: lp - half, ask: lp + half };
            };
            const { bid: fbBid, ask: fbAsk } = _deriveBA();

            let asks = [...realAsksRows].sort((a, b) => b.price - a.price);
            let bids = [...realBidsRows].sort((a, b) => b.price - a.price);

            // Synthesize a 10-level depth ladder around top-of-book when
            // the venue's L2 isn't available (forex, stocks, commodities
            // on free-tier providers). Top-of-book is real; deeper levels
            // are realistic estimates so the panel looks complete.
            // Sizes use a deterministic per-symbol seed → no UI flicker.
            const isSynthetic = !hasRealBook && Number.isFinite(fbAsk) && Number.isFinite(fbBid);
            if (isSynthetic) {
              const sv = Number(instrument.spreadValue) || (fbAsk - fbBid);
              const step = sv > 0 ? sv : (fbAsk - fbBid);
              // Stable PRNG keyed by symbol so the ladder doesn't reshuffle
              // every tick. Pseudo-volume distribution centred at top-of-book.
              const seed = (instrument.symbol || 'X').split('').reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
              const noise = (i) => {
                // Deterministic 0..1 based on seed + i, no Math.random.
                const x = Math.sin((seed + i * 137) * 9301 + 49297) * 233280;
                return Math.abs(x - Math.floor(x));
              };
              asks = [];
              bids = [];
              for (let i = 0; i < 10; i++) {
                const drop = 1 - (i * 0.085); // taper from top of book
                const askSize = +(drop * (3 + noise(i * 2) * 4)).toFixed(4);
                const bidSize = +(drop * (3 + noise(i * 2 + 1) * 4)).toFixed(4);
                asks.push({ price: fbAsk + step * i, size: Math.max(askSize, 0.1), count: 1, _synthetic: i > 0 });
                bids.push({ price: fbBid - step * i, size: Math.max(bidSize, 0.1), count: 1, _synthetic: i > 0 });
              }
              asks.reverse(); // render high → low
            } else {
              // Real book has data but maybe missing one side — pad with
              // the live top-of-book quote so neither side is empty.
              if (asks.length === 0 && Number.isFinite(fbAsk)) {
                asks = [{ price: fbAsk, size: NaN, count: null, _topOnly: true }];
              }
              if (bids.length === 0 && Number.isFinite(fbBid)) {
                bids = [{ price: fbBid, size: NaN, count: null, _topOnly: true }];
              }
            }

            const bestBid = bids[0]?.price;
            const bestAsk = asks[asks.length - 1]?.price;
            const spread = (Number.isFinite(bestAsk) && Number.isFinite(bestBid)) ? bestAsk - bestBid : null;
            const midPrice = (Number.isFinite(bestAsk) && Number.isFinite(bestBid)) ? (bestAsk + bestBid) / 2 : null;
            const spreadBps = midPrice && spread != null ? (spread / midPrice) * 10000 : null;
            const maxSize = Math.max(
              ...asks.map((a) => a.size).filter(Number.isFinite),
              ...bids.map((b) => b.size).filter(Number.isFinite),
              0.0001,
            );
            // Aggregate stats — sums + counts + imbalance + cumulative depth
            const sumSize = (arr) => arr.reduce((s, r) => s + (Number.isFinite(r.size) ? r.size : 0), 0);
            const sumNotional = (arr) => arr.reduce((s, r) => s + (Number.isFinite(r.size) && Number.isFinite(r.price) ? r.size * r.price : 0), 0);
            const totalBidSize = sumSize(bids);
            const totalAskSize = sumSize(asks);
            const totalBidNotional = sumNotional(bids);
            const totalAskNotional = sumNotional(asks);
            const totalSize = totalBidSize + totalAskSize;
            const bidPct = totalSize > 0 ? (totalBidSize / totalSize) * 100 : 50;
            const askPct = 100 - bidPct;
            // Cumulative running totals — asks counted from the spread
            // outward (bottom row of the asks block = lowest ask = first
            // to fill if you buy aggressively). Bids same logic from
            // their best (top of bids block).
            //   asks are sorted high→low for render, so we walk in REVERSE
            //   to accumulate from the lowest ask up.
            const askCumul = new Array(asks.length).fill(0);
            let runA = 0;
            for (let i = asks.length - 1; i >= 0; i--) {
              runA += (Number.isFinite(asks[i].size) ? asks[i].size : 0);
              askCumul[i] = runA;
            }
            //   bids are sorted high→low — cumul walks forward from best bid.
            const bidCumul = new Array(bids.length).fill(0);
            let runB = 0;
            for (let i = 0; i < bids.length; i++) {
              runB += (Number.isFinite(bids[i].size) ? bids[i].size : 0);
              bidCumul[i] = runB;
            }
            return (
              <div className="flex-1 overflow-y-auto text-[11px]">
                {/* Live indicator */}
                <div className="px-3 pt-2 pb-1 flex items-center justify-between text-[9px] uppercase tracking-wider font-bold text-text-muted">
                  <span className="flex items-center gap-1.5">
                    {hasRealBook ? (
                      <>
                        <span className="relative flex w-1.5 h-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-70 animate-ping" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-bull" />
                        </span>
                        Live · {realBids.length + realAsks.length} levels
                      </>
                    ) : (
                      <>
                        <span className="relative flex w-1.5 h-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-70 animate-ping" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-bull" />
                        </span>
                        Live top-of-book · est. depth
                      </>
                    )}
                  </span>
                  {orderBook?.ts && (
                    <span className="font-mono text-[9px] text-text-muted">
                      {new Date(orderBook.ts).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Summary strip — Bid / Ask totals + counts + mid */}
                <div className="px-3 pt-1 pb-2 grid grid-cols-3 gap-2 text-[10px] border-b border-border-subtle">
                  <div>
                    <div className="text-text-muted uppercase tracking-wider text-[8px] font-bold">Bids · {bids.length}</div>
                    <div className="font-mono font-bold text-bull tabular-nums mt-0.5">{totalBidSize.toFixed(2)}</div>
                    <div className="font-mono text-[9px] text-text-muted tabular-nums">{totalBidNotional > 0 ? totalBidNotional.toFixed(0) : '—'}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-text-muted uppercase tracking-wider text-[8px] font-bold">Mid</div>
                    <div className="font-mono font-bold text-text-primary tabular-nums mt-0.5">{midPrice != null ? fmtNum(midPrice, prec) : '—'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-text-muted uppercase tracking-wider text-[8px] font-bold">Asks · {asks.length}</div>
                    <div className="font-mono font-bold text-bear tabular-nums mt-0.5">{totalAskSize.toFixed(2)}</div>
                    <div className="font-mono text-[9px] text-text-muted tabular-nums">{totalAskNotional > 0 ? totalAskNotional.toFixed(0) : '—'}</div>
                  </div>
                </div>

                {/* Imbalance bar — % lean of bids vs asks */}
                <div className="px-3 py-2 border-b border-border-subtle">
                  <div className="flex items-center justify-between text-[9px] uppercase tracking-wider font-bold text-text-muted mb-1">
                    <span>Buy {bidPct.toFixed(0)}%</span>
                    <span>Sell {askPct.toFixed(0)}%</span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-bg-hover overflow-hidden flex">
                    <span className="bg-bull transition-all duration-300" style={{ width: `${bidPct}%` }} />
                    <span className="bg-bear transition-all duration-300" style={{ width: `${askPct}%` }} />
                  </div>
                </div>

                {/* Column headers */}
                <div className="px-2 pt-2 text-[9px] uppercase tracking-wider font-bold text-text-muted grid grid-cols-4 gap-2 mb-1">
                  <span>Price</span>
                  <span className="text-right">Size</span>
                  <span className="text-right">Total</span>
                  <span className="text-right">Cumul</span>
                </div>

                {/* Asks (red, top half) */}
                <div>
                  {asks.length === 0 ? (
                    <div className="px-3 py-3 text-center text-[10px] text-text-muted">No asks</div>
                  ) : asks.map((row, i) => {
                    const pct = (row.size / maxSize) * 100;
                    const cum = askCumul[i];
                    return (
                      <div key={`a-${i}`} className="relative grid grid-cols-4 gap-2 px-2 py-1 font-mono tabular-nums">
                        <span className="absolute inset-y-0 right-0 bg-bear/10" style={{ width: `${pct}%` }} />
                        <span className="relative text-bear">{fmtNum(row.price, prec)}</span>
                        <span className="relative text-right text-text-secondary">{Number.isFinite(row.size) ? row.size.toFixed(4) : '—'}</span>
                        <span className="relative text-right text-text-muted">{Number.isFinite(row.size) && Number.isFinite(row.price) ? (row.size * row.price).toFixed(0) : '—'}</span>
                        <span className="relative text-right text-text-muted">{Number.isFinite(cum) && cum > 0 ? cum.toFixed(2) : '—'}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Bids (green, bottom half) */}
                <div>
                  {bids.length === 0 ? (
                    <div className="px-3 py-3 text-center text-[10px] text-text-muted">No bids</div>
                  ) : bids.map((row, i) => {
                    const pct = (row.size / maxSize) * 100;
                    const cum = bidCumul[i];
                    return (
                      <div key={`b-${i}`} className="relative grid grid-cols-4 gap-2 px-2 py-1 font-mono tabular-nums">
                        <span className="absolute inset-y-0 right-0 bg-bull/10" style={{ width: `${pct}%` }} />
                        <span className="relative text-bull">{fmtNum(row.price, prec)}</span>
                        <span className="relative text-right text-text-secondary">{Number.isFinite(row.size) ? row.size.toFixed(4) : '—'}</span>
                        <span className="relative text-right text-text-muted">{Number.isFinite(row.size) && Number.isFinite(row.price) ? (row.size * row.price).toFixed(0) : '—'}</span>
                        <span className="relative text-right text-text-muted">{Number.isFinite(cum) && cum > 0 ? cum.toFixed(2) : '—'}</span>
                      </div>
                    );
                  })}
                </div>

                {asks.length === 0 && bids.length === 0 && (
                  <div className="px-3 py-6 text-[10px] text-text-muted text-center">
                    Waiting for price feed for {instrument.symbol}…<br />
                    <span className="text-text-muted/70">Check that the external feed is running.</span>
                  </div>
                )}
              </div>
            );
          })()}
          {leftPanelTab === 'depth' && !instrument && (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted px-4 text-center">
              Pick an instrument to see market depth here.
            </div>
          )}

          {/* ── Positions pane — compact list of open positions ────── */}
          {leftPanelTab === 'positions' && (
            <SidebarPositions
              positions={positionsWithLivePnl}
              activeSymbol={symbol}
              onSelect={(sym) => setParams({ symbol: sym })}
              onClose={closePosition}
              instrumentsBySymbol={instrumentsBySymbol}
            />
          )}

          {/* ── Pending orders pane — open LIMIT/STOP orders awaiting fill ── */}
          {leftPanelTab === 'pending' && (
            <SidebarPendingOrders
              orders={openOrders}
              activeSymbol={symbol}
              onSelect={(sym) => setParams({ symbol: sym })}
              onCancel={cancelOrder}
              instrumentsBySymbol={instrumentsBySymbol}
            />
          )}

          {/* ── Settings pane — same slot as the other tabs ─────── */}
          {leftPanelTab === 'settings' && <TradeSettingsPanel />}

        </aside>

        {/* Wrapper — vertical stack: [chart + order form row] then [equity bar].
            Lets the equity bar span the full width of chart + order form.
            order-1 places this BEFORE the (now right-side) instruments sidebar. */}
        <div className="flex-1 lg:order-1 flex flex-col gap-1 min-w-0 min-h-0">
          <div className="flex-1 flex gap-1 min-h-0 min-w-0">

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
                  /* Apply user's Show-on-Chart toggles + Time Zone from Settings.
                     - "Open positions" toggle:      entry line for each position
                     - "TP / SL on positions":       SL/TP lines anchored to positions
                     - "Stop / Limit orders":        pending LIMIT/STOP order lines + pendingPreview */
                  openOrders={tradeSettings.showOnChart.stopLimit ? openOrders : []}
                  positions={
                    // Two independent toggles share the same position array:
                    //   positions toggle → entry-price line
                    //   tpsl toggle      → SL/TP lines
                    // Strip the corresponding fields per-toggle so each works
                    // on its own (previously, positions off killed both).
                    (tradeSettings.showOnChart.positions || tradeSettings.showOnChart.tpsl)
                      ? positionsWithLivePnl.map((p) => ({
                          ...p,
                          entryPrice: tradeSettings.showOnChart.positions ? p.entryPrice : null,
                          stopLoss:   tradeSettings.showOnChart.tpsl      ? p.stopLoss   : null,
                          takeProfit: tradeSettings.showOnChart.tpsl      ? p.takeProfit : null,
                        }))
                      : []
                  }
                  pendingPreview={tradeSettings.showOnChart.stopLimit ? pendingPreview : null}
                  showPositions={tradeSettings.showOnChart.positions}
                  showTpSl={tradeSettings.showOnChart.tpsl}
                  showStopLimit={tradeSettings.showOnChart.stopLimit}
                  positionsCount={positionsWithLivePnl.filter((p) => p.symbol === symbol).length}
                  ordersCount={openOrders.filter((o) => o.symbol === symbol).length}
                  openPositionsCount={positions.length}
                  onCloseAll={async () => {
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
                  showAlerts={tradeSettings.showOnChart.alerts}
                  showSignals={tradeSettings.showOnChart.signals}
                  showHmr={tradeSettings.showOnChart.hmr}
                  showCalendar={tradeSettings.showOnChart.calendar}
                  calendarFilters={tradeSettings.calendarFilters}
                  timeZone={tradeSettings.trading.timeZone}
                  pricePrecision={instrument.pricePrecision}
                  infoStrip={chartInfoStrip}
                  instrument={instrument}
                  /* Position pill actions on the chart — × closes / modifies */
                  /* Click anywhere on the pill body (not the × button) opens
                     the rich Edit TP/SL modal. */
                  onPositionEdit={(p) => setSlTpModalPosition(p)}
                  onPositionClose={(p) => closePosition(p._id)}
                  onPositionRemoveSl={(p) => api.put(`/trading/positions/${p._id}`, { stopLoss: null }).then(() => { toast.success('SL removed'); refresh(); }).catch((e) => toast.error(errorMessage(e)))}
                  onPositionRemoveTp={(p) => api.put(`/trading/positions/${p._id}`, { takeProfit: null }).then(() => { toast.success('TP removed'); refresh(); }).catch((e) => toast.error(errorMessage(e)))}
                  /* Drag-to-update — fires on drop with the snapped price. */
                  onPositionUpdateSl={(p, price) => api.put(`/trading/positions/${p._id}`, { stopLoss: price }).then(() => { toast.success(`SL updated to ${price}`); refresh(); }).catch((e) => toast.error(errorMessage(e)))}
                  onPositionUpdateTp={(p, price) => api.put(`/trading/positions/${p._id}`, { takeProfit: price }).then(() => { toast.success(`TP updated to ${price}`); refresh(); }).catch((e) => toast.error(errorMessage(e)))}
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
                  className={`absolute w-[280px] max-w-[calc(100vw-1.5rem)] z-30 transition-opacity duration-200 ease-out ${
                    showFloatingOrder
                      ? 'opacity-100 pointer-events-auto'
                      : 'opacity-0 pointer-events-none'
                  }`}
                  style={{
                    top: `calc(50% + ${floatPos.y}px)`,
                    right: `calc(30% - ${floatPos.x}px)`,
                    transform: 'translateY(-50%)',
                    height: Math.min(floatHeight, Math.max(320, (typeof window !== 'undefined' ? window.innerHeight : 800) - 40)),
                    maxHeight: 'calc(100% - 1.5rem)',
                  }}
                  aria-hidden={!showFloatingOrder}
                  role="dialog"
                  aria-label="Place order"
                >
                  {/* Glass card wraps OrderForm. Drag handle at top moves
                      the panel; resize grip at bottom changes height. */}
                  <div className="glass border border-border-dark rounded-xl shadow-2xl flex flex-col backdrop-blur-xl h-full overflow-hidden">
                    {/* Drag handle bar */}
                    <div
                      onMouseDown={startFloatDrag}
                      className="cursor-move select-none flex items-center justify-center py-1.5 bg-bg-hover/40 hover:bg-bg-hover/60 border-b border-border-subtle transition-colors group shrink-0"
                      title="Drag to move"
                      role="separator"
                      aria-label="Drag to reposition"
                    >
                      <span className="w-10 h-1 rounded-full bg-text-muted/50 group-hover:bg-text-muted transition-colors" />
                    </div>
                    {/* OrderForm gets the remaining space and scrolls if
                        the user shrinks the panel below the form's
                        natural height. */}
                    <div className="flex-1 min-h-0 overflow-y-auto">
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
                    {/* Bottom resize grip — drag vertically to change
                        panel height. Double-click resets to default. */}
                    <div
                      onMouseDown={startFloatResize}
                      onTouchStart={(e) => { e.preventDefault(); startFloatResize(e); }}
                      onDoubleClick={() => setFloatHeight(560)}
                      className="cursor-ns-resize select-none flex items-center justify-center py-1 bg-bg-hover/40 hover:bg-primary-500/15 border-t border-border-subtle transition-colors group shrink-0"
                      title="Drag to resize · double-click to reset"
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize panel height"
                    >
                      <svg width="22" height="6" viewBox="0 0 22 6" className="text-text-muted/60 group-hover:text-primary-500 transition-colors">
                        <circle cx="3"  cy="3" r="1.2" fill="currentColor" />
                        <circle cx="8"  cy="3" r="1.2" fill="currentColor" />
                        <circle cx="13" cy="3" r="1.2" fill="currentColor" />
                        <circle cx="18" cy="3" r="1.2" fill="currentColor" />
                      </svg>
                    </div>
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
                    className={`relative px-3 sm:px-4 py-2.5 sm:py-3 text-xs sm:text-sm font-semibold flex items-center gap-1.5 sm:gap-2 transition-colors ${
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
                    <Link to="/reports" className="text-primary-500 hover:underline">View reports</Link>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Mobile-only backdrop — dims the chart when the order sheet is
            open, so a tap outside closes the sheet. Hidden on lg+ where
            the order form sits inline. */}
        {showOrderPanel && !isFullscreen && (
          <div
            className="lg:hidden fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity"
            onClick={() => setShowOrderPanel(false)}
            aria-hidden="true"
          />
        )}

        {/* Right — order form panel.
            • lg+: inline aside taking 340px of the row width
            • mobile: fixed bottom-sheet overlay with rounded top corners,
              swipe-grip, and a 90vh max-height so the chart underneath
              is still partially visible (broker-app pattern). */}
        <aside
          className={`${(!showOrderPanel || isFullscreen) ? 'hidden' : 'flex'}
            fixed lg:relative inset-x-0 bottom-0 lg:inset-auto
            z-40 lg:z-auto
            max-h-[90vh] lg:max-h-none
            w-full lg:w-[280px] shrink-0
            flex-col gap-1 min-h-0
            rounded-t-2xl lg:rounded-none
            shadow-[0_-8px_30px_rgba(0,0,0,0.18)] lg:shadow-none
            bg-white lg:bg-transparent
            overflow-y-auto lg:overflow-visible`}
        >
          {/* Mobile drag-handle bar — tap or swipe-down to close. */}
          <div className="lg:hidden shrink-0 flex items-center justify-center pt-2 pb-1">
            <button
              type="button"
              onClick={() => setShowOrderPanel(false)}
              aria-label="Close order panel"
              className="w-10 h-1 rounded-full bg-text-muted/40 hover:bg-text-muted/60 transition-colors"
            />
          </div>
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

        {/* Right re-open tab (desktop) — vertical pill on the right edge.
            Mobile uses a separate floating FAB rendered below. */}
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

        {/* Mobile-only FAB — anchored above the equity bar so it never
            overlaps content. Positioned right edge with safe-area-inset
            for devices with home indicator. Hidden on lg+ (inline aside
            always visible) and in fullscreen (floating overlay takes over). */}
        {!showOrderPanel && !isFullscreen && (
          <button
            type="button"
            onClick={() => setShowOrderPanel(true)}
            className="lg:hidden fixed right-3 z-30 inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-full font-extrabold text-[13px] text-white shadow-elevated active:scale-95 transition-transform"
            style={{
              bottom: 'calc(env(safe-area-inset-bottom, 0px) + 88px)',
              background: orderSide === 'SELL'
                ? 'linear-gradient(180deg, #EF4444 0%, #DC2626 100%)'
                : 'linear-gradient(180deg, #10B981 0%, #059669 100%)',
              boxShadow: orderSide === 'SELL'
                ? '0 6px 20px rgba(239,68,68,0.45)'
                : '0 6px 20px rgba(16,185,129,0.45)',
            }}
            aria-label="Open order panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            <span>Place Order</span>
          </button>
        )}

          </div>{/* end flex-row: chart + order form */}

          {/* ── Equity bar — desktop shows all 5 stats in one row;
              mobile uses an even 2-column grid (Equity / Balance,
              Free Margin / Margin Used, Margin Level spans both
              columns). Reads cleanly without orphan rows. */}
          {equityNums && !isFullscreen && (
            <div className="glass border border-border-dark rounded-xl px-3 sm:px-4 py-2 sm:py-2.5 grid grid-cols-2 sm:flex sm:items-center sm:justify-between gap-x-3 sm:gap-x-6 gap-y-2 text-[11px] sm:text-xs shrink-0">
              <FooterStat label="Equity"       value={fmtMoney(equityNums.equity, equityNums.base)} />
              <FooterStat label="Balance"      value={fmtMoney(equityNums.balance, equityNums.base)} />
              <FooterStat label="Free Margin"  value={fmtMoney(equityNums.free, equityNums.base)} />
              <FooterStat label="Margin"       value={fmtMoney(equityNums.used, equityNums.base)} />
              <div className="col-span-2 sm:col-auto">
                <FooterStat
                  label="Margin Level"
                  value={equityNums.marginLevel != null ? `${equityNums.marginLevel.toFixed(2)}%` : '—'}
                  color={equityNums.marginLevel != null && equityNums.marginLevel < 100 ? '#DC2626' : undefined}
                />
              </div>
            </div>
          )}
        </div>{/* end wrapper flex-col */}
      </div>

      {/* Position SL/TP modify modal */}
      {slTpModalPosition && (
        <PositionSlTpModal
          position={slTpModalPosition}
          instrument={instrumentsBySymbol?.[slTpModalPosition.symbol]}
          onClose={() => setSlTpModalPosition(null)}
          onSubmit={(payload) => submitSlTpModify(slTpModalPosition._id, payload)}
          onPartialClose={async (closeQty) => {
            // Partial close uses the dedicated endpoint. Full close
            // (closeQty >= position.quantity) falls back to /close.
            const fullQty = Number(slTpModalPosition.quantity);
            const qty = Math.min(fullQty, Math.max(0, Number(closeQty)));
            if (!qty) return;
            try {
              if (qty >= fullQty) {
                await api.post(`/trading/positions/${slTpModalPosition._id}/close`);
              } else {
                await api.post(`/trading/positions/${slTpModalPosition._id}/partial-close`, { quantity: qty });
              }
              toast.success(qty >= fullQty ? 'Position closing' : `Closing ${qty} lots`);
              setSlTpModalPosition(null);
              refresh();
            } catch (e) { toast.error(errorMessage(e)); }
          }}
        />
      )}

    </div>
  );
}

// ─── Mini-sidebar icons (sidebar lives on the right of the chart) ────
const SbS = ({ children }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const SbWatchI   = () => <SbS><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></SbS>;
const SbDetailsI = () => <SbS><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></SbS>;
const SbHotI     = () => <SbS><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></SbS>;
const SbAboutI   = () => <SbS><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></SbS>;
const SbPerfI    = () => <SbS><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /><circle cx="11" cy="10" r="0.7" fill="currentColor" /></SbS>;
const SbDepthI   = () => <SbS><line x1="3" y1="6"  x2="21" y2="6" /><line x1="6" y1="10" x2="18" y2="10" /><line x1="3" y1="14" x2="21" y2="14" /><line x1="6" y1="18" x2="18" y2="18" /></SbS>;
const SbPositionsI = () => <SbS><path d="M3 3v18h18" /><rect x="6" y="13" width="3" height="5" /><rect x="11" y="9"  width="3" height="9" /><rect x="16" y="6"  width="3" height="12" /></SbS>;
const SbPendingI   = () => <SbS><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></SbS>;
const SbGearI    = () => <SbS><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></SbS>;

// Settings trigger button — opens the right-side drawer. Lives in the
// mini-sidebar bottom slot so it's always one click away.
// Settings is now a panel tab — no longer needs its own component
// (kept the wrapper exported only because the sidebar map still uses it).
// Receives the same active/onClick wiring as other tabs.
function SettingsTabBtn({ active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Trading Settings"
      aria-label="Trading Settings"
      className={`w-full py-1.5 rounded-md flex flex-col items-center justify-center gap-0.5 transition-all ${
        active
          ? 'bg-primary-500/15 text-primary-600 ring-1 ring-primary-500/30'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <SbGearI />
      <span className="text-[9px] font-semibold leading-none tracking-tight">Settings</span>
    </button>
  );
}

function FooterStat({ label, value, color }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-2 min-w-0">
      <span className="text-text-secondary font-semibold text-[10px] sm:text-xs uppercase sm:normal-case tracking-wider sm:tracking-normal leading-none sm:leading-normal">
        <span className="hidden sm:inline">{label}:</span>
        <span className="sm:hidden">{label}</span>
      </span>
      <span className="font-mono font-bold text-text-primary truncate" style={{ color: color || undefined }}>
        {value}
      </span>
    </div>
  );
}

// Premium open-positions panel — gradient summary header, glassy position
// cards with a side-accent stripe, live P&L %, SL/TP chips, and inline
// close button. Click a card to switch the chart to that position.
function SidebarPositions({ positions, activeSymbol, onSelect, onClose, instrumentsBySymbol }) {
  if (!positions || positions.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center mb-3">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18" /><rect x="7" y="13" width="3" height="5" /><rect x="12" y="9"  width="3" height="9" /><rect x="17" y="6"  width="3" height="12" />
          </svg>
        </div>
        <div className="text-[13px] text-text-primary font-bold">No open positions</div>
        <div className="text-[11px] text-text-muted mt-1.5 px-2 leading-relaxed">
          Place a market or limit order — your live positions will appear here with realtime P&amp;L.
        </div>
      </div>
    );
  }

  const totalPnl     = positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
  const totalNotional= positions.reduce((s, p) => s + Number(p.quantity || 0) * Number(p.entryPrice || 0), 0);
  const winners      = positions.filter((p) => Number(p.unrealizedPnl || 0) >= 0).length;
  const losers       = positions.length - winners;
  const pnlPctTotal  = totalNotional > 0 ? (totalPnl / totalNotional) * 100 : 0;

  return (
    <div className="flex flex-col">
      {/* ── Premium summary card ─────────────────────────────────── */}
      <div className={`mx-2 mt-2 mb-1 rounded-xl border shadow-sm p-3 ${
        totalPnl >= 0
          ? 'bg-gradient-to-br from-emerald-50 via-white to-emerald-50/40 border-emerald-200/70'
          : 'bg-gradient-to-br from-rose-50 via-white to-rose-50/40 border-rose-200/70'
      }`}>
        <div className="flex items-center justify-between">
          <span className="text-[9.5px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Net P&amp;L</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${totalPnl >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
            {totalPnl >= 0 ? 'Profit' : 'Loss'}
          </span>
        </div>
        <div className={`mt-1 text-[22px] font-mono font-extrabold leading-tight tracking-tight ${totalPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
          {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[10.5px] font-mono font-bold ${pnlPctTotal >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {pnlPctTotal >= 0 ? '+' : ''}{pnlPctTotal.toFixed(2)}%
          </span>
          <span className="text-[10px] text-text-muted">of notional</span>
        </div>
        <div className="mt-2 pt-2 border-t border-border-subtle/60 grid grid-cols-3 gap-1">
          <Stat lbl="Open"     val={positions.length} accent="text-text-primary" />
          <Stat lbl="Winners"  val={winners}          accent="text-emerald-600"  />
          <Stat lbl="Losers"   val={losers}           accent="text-rose-600"     />
        </div>
      </div>

      {/* ── Position cards ────────────────────────────────────────── */}
      <div className="px-2 py-1 space-y-1.5">
        {positions.map((p) => {
          const inst   = instrumentsBySymbol?.[p.symbol];
          const isBuy  = p.side === 'BUY';
          const pnl    = Number(p.unrealizedPnl || 0);
          const isActive = p.symbol === activeSymbol;
          const prec   = inst?.pricePrecision ?? 4;
          const notional = Number(p.quantity || 0) * Number(p.entryPrice || 0);
          const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
          const sideStripe = isBuy ? 'bg-emerald-500' : 'bg-rose-500';
          return (
            <div
              key={p._id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect && onSelect(p.symbol)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect && onSelect(p.symbol); }}
              className={`group relative overflow-hidden rounded-lg border transition-all cursor-pointer ${
                isActive
                  ? 'border-primary-500/40 bg-primary-500/[0.04] shadow-[0_0_0_1px_rgba(99,102,241,0.15)]'
                  : 'border-border-subtle bg-white hover:border-border-dark hover:shadow-sm'
              }`}
            >
              {/* Side accent stripe */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${sideStripe}`} />

              <div className="pl-2.5 pr-2 py-2">
                {/* Top row: side chip + symbol + close button */}
                <div className="flex items-center justify-between gap-1.5 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded tracking-wide ${
                      isBuy
                        ? 'bg-emerald-500 text-white shadow-[0_1px_2px_rgba(16,185,129,0.4)]'
                        : 'bg-rose-500 text-white shadow-[0_1px_2px_rgba(239,68,68,0.4)]'
                    }`}>
                      {isBuy ? '↑ BUY' : '↓ SELL'}
                    </span>
                    <span className="text-[12px] font-extrabold text-text-primary truncate tracking-tight">{p.symbol}</span>
                    {isActive && (
                      <span className="text-[8.5px] px-1 py-0.5 rounded bg-primary-500/15 text-primary-600 font-bold uppercase tracking-wider">Active</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClose && onClose(p._id); }}
                    className="opacity-60 group-hover:opacity-100 text-text-muted hover:text-rose-600 transition-all p-1 rounded hover:bg-rose-50"
                    title="Close position"
                    aria-label="Close position"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                  </button>
                </div>

                {/* P&L hero */}
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <div className={`text-[15.5px] font-mono font-extrabold leading-none tracking-tight ${pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                  </div>
                  <div className={`text-[10.5px] font-mono font-bold px-1.5 py-0.5 rounded ${
                    pnl >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                  }`}>
                    {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                  </div>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-2 gap-1 text-[10px] font-mono">
                  <div className="flex items-baseline gap-1">
                    <span className="text-text-muted text-[9px] uppercase tracking-wide">Qty</span>
                    <span className="text-text-primary font-semibold">{Number(p.quantity).toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
                  </div>
                  <div className="flex items-baseline gap-1 justify-end">
                    <span className="text-text-muted text-[9px] uppercase tracking-wide">Entry</span>
                    <span className="text-text-primary font-semibold">{Number(p.entryPrice || 0).toFixed(prec)}</span>
                  </div>
                </div>

                {/* SL / TP chips (only if set) */}
                {(p.stopLoss || p.takeProfit) && (
                  <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border-subtle/60">
                    {p.stopLoss && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] font-mono px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200/70">
                        <span className="text-rose-600 font-bold">SL</span>
                        <span className="text-rose-700 font-semibold">{Number(p.stopLoss).toFixed(prec)}</span>
                      </span>
                    )}
                    {p.takeProfit && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] font-mono px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200/70">
                        <span className="text-emerald-600 font-bold">TP</span>
                        <span className="text-emerald-700 font-semibold">{Number(p.takeProfit).toFixed(prec)}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact header pill-toggle — used in the top bar for the quick-access
// Show-on-Chart switches. Each button shows a small ON/OFF status dot
// so the user can read state at a glance, plus a strong color when ON
// and a clearly faded look when OFF.
function HeaderToggle({ active, onClick, label, title, icon, accent = 'emerald' }) {
  const accentMap = {
    emerald: {
      on:  'bg-emerald-500 text-white border-emerald-600 shadow-[0_1px_3px_rgba(16,185,129,0.5)]',
      dot: 'bg-emerald-400 ring-emerald-200',
    },
    indigo: {
      on:  'bg-indigo-500 text-white border-indigo-600 shadow-[0_1px_3px_rgba(99,102,241,0.5)]',
      dot: 'bg-indigo-400 ring-indigo-200',
    },
    amber: {
      on:  'bg-amber-500 text-white border-amber-600 shadow-[0_1px_3px_rgba(245,158,11,0.5)]',
      dot: 'bg-amber-400 ring-amber-200',
    },
  };
  const cfg = accentMap[accent] || accentMap.emerald;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${title} — ${active ? 'ON' : 'OFF'}`}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-bold transition-all border ${
        active
          ? cfg.on
          : 'bg-white text-text-secondary border-border-dark hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {/* Status dot — solid when ON, hollow ring when OFF. */}
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full transition-all ${
          active
            ? `${cfg.dot} ring-2`
            : 'bg-transparent ring-1 ring-text-muted/60'
        }`}
        aria-hidden="true"
      />
      {icon}
      <span className="leading-none">{label}</span>
    </button>
  );
}

// SidebarPendingOrders — compact list of open LIMIT/STOP orders awaiting
// fill. Mirrors SidebarPositions visually but trades the live-PnL summary
// for a "distance from market" hint and a cancel button instead of close.
function SidebarPendingOrders({ orders, activeSymbol, onSelect, onCancel, instrumentsBySymbol }) {
  if (!orders || orders.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center mb-3">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
          </svg>
        </div>
        <div className="text-[13px] text-text-primary font-bold">No pending orders</div>
        <div className="text-[11px] text-text-muted mt-1.5 px-2 leading-relaxed">
          Place a limit or stop order — it&apos;ll wait here until the market hits your price.
        </div>
      </div>
    );
  }

  const buyCnt  = orders.filter((o) => o.side === 'BUY').length;
  const sellCnt = orders.length - buyCnt;
  const limitCnt = orders.filter((o) => o.type === 'LIMIT').length;
  const stopCnt  = orders.length - limitCnt;

  return (
    <div className="flex flex-col">
      {/* ── Summary card ───────────────────────────────────────────── */}
      <div className="mx-2 mt-2 mb-1 rounded-xl border border-border-subtle bg-gradient-to-br from-slate-50 via-white to-slate-50/40 shadow-sm p-3">
        <div className="flex items-center justify-between">
          <span className="text-[9.5px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Pending</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider bg-slate-100 text-slate-700">Awaiting fill</span>
        </div>
        <div className="mt-1 text-[22px] font-mono font-extrabold leading-tight tracking-tight text-text-primary">{orders.length}</div>
        <div className="text-[10px] text-text-muted">order{orders.length === 1 ? '' : 's'} in queue</div>
        <div className="mt-2 pt-2 border-t border-border-subtle/60 grid grid-cols-4 gap-1">
          <Stat lbl="Buy"   val={buyCnt}   accent="text-emerald-600" />
          <Stat lbl="Sell"  val={sellCnt}  accent="text-rose-600" />
          <Stat lbl="Limit" val={limitCnt} accent="text-text-primary" />
          <Stat lbl="Stop"  val={stopCnt}  accent="text-text-primary" />
        </div>
      </div>

      {/* ── Order cards ────────────────────────────────────────────── */}
      <div className="px-2 py-1 space-y-1.5">
        {orders.map((o) => {
          const inst       = instrumentsBySymbol?.[o.symbol];
          const isBuy      = o.side === 'BUY';
          const isStop     = o.type === 'STOP';
          const isActive   = o.symbol === activeSymbol;
          const prec       = inst?.pricePrecision ?? 4;
          const triggerPx  = Number(isStop ? o.stopPrice : o.price) || 0;
          const lastPx     = Number(inst?.lastPrice || 0);
          const distPct    = (triggerPx > 0 && lastPx > 0)
            ? ((triggerPx - lastPx) / lastPx) * 100
            : null;
          const sideStripe = isBuy ? 'bg-emerald-500' : 'bg-rose-500';
          const created    = o.createdAt ? new Date(o.createdAt) : null;
          const ageMin     = created ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 60000)) : null;
          const ageLabel   = ageMin === null ? null
                           : ageMin < 1     ? 'just now'
                           : ageMin < 60    ? `${ageMin}m ago`
                           : ageMin < 1440  ? `${Math.floor(ageMin / 60)}h ago`
                           : `${Math.floor(ageMin / 1440)}d ago`;

          return (
            <div
              key={o._id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect && onSelect(o.symbol)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect && onSelect(o.symbol); }}
              className={`group relative overflow-hidden rounded-lg border transition-all cursor-pointer ${
                isActive
                  ? 'border-primary-500/40 bg-primary-500/[0.04] shadow-[0_0_0_1px_rgba(99,102,241,0.15)]'
                  : 'border-border-subtle bg-white hover:border-border-dark hover:shadow-sm'
              }`}
            >
              {/* Side accent stripe */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${sideStripe}`} />

              <div className="pl-2.5 pr-2 py-2">
                {/* Top row: side chip + type pill + symbol + cancel */}
                <div className="flex items-center justify-between gap-1.5 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded tracking-wide ${
                      isBuy
                        ? 'bg-emerald-500 text-white shadow-[0_1px_2px_rgba(16,185,129,0.4)]'
                        : 'bg-rose-500 text-white shadow-[0_1px_2px_rgba(239,68,68,0.4)]'
                    }`}>
                      {isBuy ? '↑ BUY' : '↓ SELL'}
                    </span>
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 tracking-wide">
                      {isStop ? 'STOP' : 'LIMIT'}
                    </span>
                    <span className="text-[12px] font-extrabold text-text-primary truncate tracking-tight">
                      {o.symbol}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onCancel && onCancel(o._id); }}
                    title="Cancel order"
                    aria-label="Cancel order"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded text-text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors opacity-60 group-hover:opacity-100"
                  >
                    Cancel
                  </button>
                </div>

                {/* Body — trigger price + distance hint */}
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[9.5px] uppercase tracking-wider font-bold text-text-muted">
                      {isStop ? 'Trigger' : 'Limit'} @
                    </div>
                    <div className="font-mono text-[13px] font-extrabold text-text-primary tabular-nums leading-tight">
                      {triggerPx ? triggerPx.toFixed(prec) : '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[9.5px] uppercase tracking-wider font-bold text-text-muted">Qty</div>
                    <div className="font-mono text-[12px] font-bold text-text-secondary tabular-nums">
                      {Number(o.quantity || 0).toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    </div>
                  </div>
                </div>

                {/* Footer — distance from market + age */}
                {(distPct !== null || ageLabel) && (
                  <div className="mt-1.5 pt-1.5 border-t border-border-subtle/60 flex items-center justify-between text-[10px]">
                    {distPct !== null ? (
                      <span className={`font-mono font-bold tabular-nums ${
                        Math.abs(distPct) < 0.1 ? 'text-amber-600' : 'text-text-muted'
                      }`}>
                        {distPct >= 0 ? '+' : ''}{distPct.toFixed(2)}% from market
                      </span>
                    ) : <span />}
                    {ageLabel && <span className="text-text-muted font-medium">{ageLabel}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// SidebarPerformance — pulls 48 × 1h candles for the active instrument so
// the panel renders real numbers (change %, high, low, sparkline) even when
// the instrument document's snapshot fields (change24h, dayHigh, dayLow)
// are stale or unset — which happens on freshly seeded forex pairs over the
// weekend. Instrument fields are preferred; candles fill the gaps.
function SidebarPerformance({ instrument, livePrice }) {
  const [candles, setCandles] = useState([]);
  const [loadingCandles, setLoadingCandles] = useState(false);

  useEffect(() => {
    if (!instrument?.symbol) { setCandles([]); return; }
    let cancelled = false;
    setLoadingCandles(true);
    api.get(`/instruments/${instrument.symbol}/candles`, {
      params: { timeframe: '1h', limit: 48 },
    })
      .then((r) => {
        if (cancelled) return;
        const raw = Array.isArray(r.data?.data) ? r.data.data : [];
        setCandles(raw);
      })
      .catch(() => { if (!cancelled) setCandles([]); })
      .finally(() => { if (!cancelled) setLoadingCandles(false); });
    return () => { cancelled = true; };
  }, [instrument?.symbol]);

  const session = getMarketSession(instrument.category);
  const prec = Math.min(instrument.pricePrecision || 2, 5);

  // ── Live last price (prefer WS tick) ────────────────────────────
  const last = Number(livePrice ?? instrument.lastPrice);

  // ── 24h change (instrument field → candle-derived fallback) ────
  let change = Number(instrument.change24h);
  if (!Number.isFinite(change) && candles.length >= 2) {
    const firstClose = Number(candles[0]?.close);
    const lastClose  = Number(candles[candles.length - 1]?.close);
    if (Number.isFinite(firstClose) && firstClose > 0 && Number.isFinite(lastClose)) {
      change = ((lastClose - firstClose) / firstClose) * 100;
    }
  }
  const pos = Number.isFinite(change) ? change >= 0 : null;
  const tone = pos == null ? '#9CA3AF' : pos ? '#16A34A' : '#DC2626';

  // ── 24h high / low (instrument field → candle-derived fallback) ─
  let hi = Number(instrument.dayHigh);
  let lo = Number(instrument.dayLow);
  if ((!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) && candles.length > 0) {
    const highs = candles.map((c) => Number(c.high)).filter(Number.isFinite);
    const lows  = candles.map((c) => Number(c.low)).filter(Number.isFinite);
    if (highs.length && lows.length) {
      hi = Math.max(...highs);
      lo = Math.min(...lows);
    }
  }
  const hasRange = Number.isFinite(hi) && Number.isFinite(lo) && hi > lo;
  const pctOfRange = hasRange ? ((last - lo) / (hi - lo)) * 100 : null;

  // ── Derived: open / mid / spread / range% / volume / turnover ──
  const open24h = Number.isFinite(last) && Number.isFinite(change) && change !== -100
    ? last / (1 + change / 100)
    : null;
  const bid = Number(instrument.bid);
  const ask = Number(instrument.ask);
  const haveBA = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0;
  const mid = haveBA ? (bid + ask) / 2 : null;
  const spreadAbs = haveBA ? ask - bid : null;
  const spreadBps = mid && spreadAbs != null ? (spreadAbs / mid) * 10000 : null;
  const rangePct = hasRange ? ((hi - lo) / lo) * 100 : null;
  const volNum = Number(instrument.volume24h);
  const turnover = Number.isFinite(volNum) && Number.isFinite(last) ? volNum * last : null;
  const fmtCompact = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(0);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
      {/* Market session banner (closed only) */}
      {!session.isOpen && (
        <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-warn shrink-0"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold text-text-primary">{session.label}</div>
            {session.detail && <div className="text-[10px] text-text-muted truncate">{session.detail}</div>}
          </div>
        </div>
      )}

      {/* Headline 24h change + sparkline */}
      <div className="rounded-xl border border-border-subtle bg-bg-hover/40 p-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">24h Change</div>
          {session.isOpen ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-bull">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-70 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-bull" />
              </span>
              Live
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
              Closed
            </span>
          )}
        </div>
        <div className="mt-1 text-2xl font-bold font-mono tabular-nums" style={{ color: tone }}>
          {pos == null ? '—' : `${pos ? '+' : ''}${change.toFixed(2)}%`}
        </div>

        {/* Sparkline — 48 × 1h candles, color matches change direction */}
        <div className="mt-2 -mx-1">
          <Sparkline
            candles={candles}
            color={tone}
            height={48}
            loading={loadingCandles}
          />
        </div>

        <div className="mt-2 text-[10px] font-mono text-text-muted">
          Last · <span className="text-text-primary font-bold">{fmtNum(last, prec)}</span> {instrument.quoteCurrency}
          {open24h != null && (
            <span className="ml-2">Open · <span className="text-text-secondary">{fmtNum(open24h, prec)}</span></span>
          )}
        </div>
      </div>

      {/* 24h range visualisation */}
      {hasRange && (
        <div>
          <div className="flex items-center justify-between mb-1.5 text-[10px] uppercase tracking-wider font-bold text-text-muted">
            <span>24h Low</span>
            <span>24h High</span>
          </div>
          <div className="relative h-1.5 rounded-full bg-bg-hover overflow-hidden">
            <div className="absolute inset-y-0 left-0 right-0 bg-gradient-to-r from-bear/30 via-text-muted/20 to-bull/30 rounded-full" />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full ring-2 ring-white"
              style={{ left: `calc(${Math.max(0, Math.min(100, pctOfRange))}% - 4px)`, background: tone }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums">
            <span className="text-bear">{fmtNum(lo, prec)}</span>
            <span className="text-bull">{fmtNum(hi, prec)}</span>
          </div>
        </div>
      )}

      {/* Section: Price & Quote */}
      {(() => {
        const rows = [
          { l: 'Last',     v: Number.isFinite(last) ? fmtNum(last, prec) : null,   tone: 'normal' },
          { l: 'Open',     v: open24h != null ? fmtNum(open24h, prec) : null,      tone: 'normal' },
          { l: 'Mid',      v: mid != null    ? fmtNum(mid, prec)    : null,        tone: 'normal' },
          { l: 'Bid',      v: Number.isFinite(bid) && bid > 0 ? fmtNum(bid, prec) : null, tone: 'bull' },
          { l: 'Ask',      v: Number.isFinite(ask) && ask > 0 ? fmtNum(ask, prec) : null, tone: 'bear' },
          { l: 'Spread',   v: spreadAbs != null && spreadAbs > 0 ? fmtNum(spreadAbs, prec) : null },
          { l: 'Spread (bps)', v: spreadBps != null && spreadBps > 0 ? spreadBps.toFixed(2) : null },
        ].filter((r) => r.v != null);
        if (!rows.length) return null;
        return (
          <div className="space-y-2 pt-2 border-t border-border-subtle">
            <div className="text-[9px] uppercase tracking-[0.18em] font-bold text-text-muted">Price · Quote</div>
            {rows.map((r) => (
              <div key={r.l} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-text-muted">{r.l}</span>
                <span
                  className="font-mono tabular-nums font-semibold"
                  style={r.tone === 'bull' ? { color: '#16A34A' } : r.tone === 'bear' ? { color: '#DC2626' } : { color: 'inherit' }}
                >
                  {r.v}
                </span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Section: Range & Volume */}
      {(() => {
        const rows = [
          { l: '24h High',  v: hasRange ? fmtNum(hi, prec) : null, tone: 'bull' },
          { l: '24h Low',   v: hasRange ? fmtNum(lo, prec) : null, tone: 'bear' },
          { l: 'Range',     v: hasRange ? fmtNum(hi - lo, prec) : null },
          { l: 'Range (%)', v: rangePct != null ? rangePct.toFixed(2) + '%' : null },
          { l: 'Volume',    v: Number.isFinite(volNum) && volNum > 0 ? fmtCompact(volNum) : null },
          { l: 'Turnover',  v: turnover != null && turnover > 0 ? `${currencySymbol(instrument.quoteCurrency || 'USD')}${fmtCompact(turnover)}` : null },
        ].filter((r) => r.v != null);
        if (!rows.length) return null;
        return (
          <div className="space-y-2 pt-2 border-t border-border-subtle">
            <div className="text-[9px] uppercase tracking-[0.18em] font-bold text-text-muted">Range · Volume</div>
            {rows.map((r) => (
              <div key={r.l} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-text-muted">{r.l}</span>
                <span
                  className="font-mono tabular-nums font-semibold"
                  style={r.tone === 'bull' ? { color: '#16A34A' } : r.tone === 'bear' ? { color: '#DC2626' } : { color: 'inherit' }}
                >
                  {r.v}
                </span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Section: Symbol & Trading */}
      {(() => {
        const rows = [
          { l: 'Symbol',       v: instrument.symbol || null },
          { l: 'Category',     v: instrument.category ? instrument.category.charAt(0) + instrument.category.slice(1).toLowerCase() : null },
          { l: 'Base / Quote', v: instrument.baseCurrency && instrument.quoteCurrency ? `${instrument.baseCurrency} / ${instrument.quoteCurrency}` : null },
          { l: 'Precision',    v: instrument.pricePrecision ? `${instrument.pricePrecision} digits` : null },
          { l: 'Min Order',    v: instrument.minOrderSize || null },
          { l: 'Max Leverage', v: instrument.maxLeverage ? `1:${instrument.maxLeverage}` : null },
          { l: 'Commission',   v: instrument.commissionPercent && Number(instrument.commissionPercent) > 0 ? `${(Number(instrument.commissionPercent) * 100).toFixed(3)}%` : null },
        ].filter((r) => r.v != null);
        if (!rows.length) return null;
        return (
          <div className="space-y-2 pt-2 border-t border-border-subtle">
            <div className="text-[9px] uppercase tracking-[0.18em] font-bold text-text-muted">Symbol · Trading</div>
            {rows.map((r) => (
              <div key={r.l} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-text-muted">{r.l}</span>
                <span className="font-mono tabular-nums font-semibold text-right truncate">{r.v}</span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// Tiny SVG sparkline used inside the Performance panel's 24h-change card.
// Renders an area-filled polyline from candle closes; auto-scales to its
// container width via viewBox + preserveAspectRatio.
function Sparkline({ candles, color, height = 48, loading }) {
  const closes = (candles || [])
    .map((c) => Number(c?.close))
    .filter((n) => Number.isFinite(n));

  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <div className="h-px w-12 bg-text-muted/30 animate-pulse" />
      </div>
    );
  }
  if (closes.length < 2) {
    return (
      <div className="flex items-center justify-center text-[10px] text-text-muted" style={{ height }}>
        No chart data
      </div>
    );
  }

  const W = 240;
  const H = height;
  const padY = 2;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const stepX = W / (closes.length - 1);
  const y = (v) => H - padY - ((v - min) / range) * (H - padY * 2);
  const pts = closes.map((v, i) => `${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`);
  const line = pts.join(' ');
  const area = `0,${H} ${line} ${W},${H}`;

  const gradId = `spark-grad-${color.replace('#', '')}`;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="overflow-visible">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Tiny labeled stat used inside the positions summary card.
function Stat({ lbl, val, accent }) {
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-[0.1em] font-bold text-text-muted">{lbl}</div>
      <div className={`text-[13px] font-mono font-extrabold leading-tight ${accent}`}>{val}</div>
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

// ─── Position SL/TP / partial-close modal ──────────────────────────────
//
// Triggered by the "SL/TP" button on each open position. Three tabs:
//   • Modify       — edit Take Profit / Stop Loss with numeric ± steppers
//   • Partial close — close a fraction of the position by lots
//   • Close by     — full close at market
//
// Pip math: pipSize = 10^-precision. So for BTC with precision=2 the pip
// is 0.01. The pip / USD / % readout below each price field shows the
// delta between the entered price and the position's entry, which is
// how MT5 / cTrader render this control.
function PositionSlTpModal({ position, instrument, onClose, onSubmit, onPartialClose }) {
  const [tab, setTab] = useState('modify');
  const [tp, setTp] = useState(position.takeProfit ? String(position.takeProfit) : '');
  const [sl, setSl] = useState(position.stopLoss ? String(position.stopLoss) : '');
  const [partialQty, setPartialQty] = useState(String((Number(position.quantity) || 0) / 2));
  const [saving, setSaving] = useState(false);

  const precision = Math.max(0, Math.min(8, Number(instrument?.pricePrecision) || 2));
  const pipSize = Math.pow(10, -precision);
  const entry = Number(position.entryPrice) || 0;
  const lastPx = Number(instrument?.lastPrice) || 0;
  const qty = Number(position.quantity) || 0;
  const isBuy = position.side === 'BUY';

  const livePnl = (isBuy ? (lastPx - entry) : (entry - lastPx)) * qty;
  const livePnlClass = livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const delta = (priceStr) => {
    const p = Number(priceStr);
    if (!Number.isFinite(p) || !entry) return { pips: 0, usd: 0, pct: 0 };
    const raw = isBuy ? (p - entry) : (entry - p);
    return {
      pips: raw / pipSize,
      usd:  raw * qty,
      pct:  (raw / entry) * 100,
    };
  };
  const tpDelta = delta(tp);
  const slDelta = delta(sl);

  const fmt = (n, d = 2) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const stepFmt = (n) => Number(n).toFixed(precision);
  const stepPrice = (curr, dir) => {
    const base = Number(curr) || entry || lastPx || 0;
    return stepFmt(base + dir * pipSize);
  };

  const submitModify = async () => {
    setSaving(true);
    try {
      await onSubmit({
        takeProfit: tp.trim() === '' ? null : Number(tp),
        stopLoss:   sl.trim() === '' ? null : Number(sl),
      });
    } finally { setSaving(false); }
  };
  const submitPartialClose = async () => {
    setSaving(true);
    try { await onPartialClose(Number(partialQty)); }
    finally { setSaving(false); }
  };
  const submitFullClose = async () => {
    setSaving(true);
    try { await onPartialClose(qty); }
    finally { setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — symbol, side, qty, P&L, close × */}
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {instrument?.icon && <span className="text-lg">{instrument.icon}</span>}
                <span className="font-bold text-base text-text-primary">{position.symbol}</span>
                <span className="text-sm text-text-muted tabular-nums">{fmt(qty, 2)} lots</span>
              </div>
              <div className="mt-1 text-[13px] tabular-nums">
                <span className={isBuy ? 'text-primary-600 font-semibold' : 'text-bear font-semibold'}>
                  {isBuy ? 'Buy' : 'Sell'}
                </span>{' '}
                <span className="text-text-muted">at</span>{' '}
                <span className="text-text-primary font-mono">{stepFmt(entry)}</span>
              </div>
            </div>
            <div className="text-right">
              <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
              <div className={`mt-1 text-[13px] font-mono font-bold tabular-nums ${livePnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {livePnl >= 0 ? '+' : ''}{fmt(livePnl)} USD
              </div>
              <div className="text-[11px] text-text-muted font-mono">{stepFmt(lastPx)}</div>
            </div>
          </div>

          {/* Tab strip */}
          <div className="mt-4 grid grid-cols-3 bg-bg-hover rounded-lg p-1">
            {[
              { id: 'modify',  label: 'Modify' },
              { id: 'partial', label: 'Partial close' },
              { id: 'closeby', label: 'Close by' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`text-[13px] font-semibold py-2 rounded-md transition-all ${
                  tab === t.id
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {tab === 'modify' && (
            <>
              <PriceField
                label="Take Profit"
                value={tp}
                placeholder="Not set"
                onChange={setTp}
                onClear={() => setTp('')}
                onStep={(dir) => setTp(stepPrice(tp || entry || lastPx, dir))}
                delta={tpDelta}
                deltaTone="bull"
              />
              <PriceField
                label="Stop Loss"
                value={sl}
                placeholder="Not set"
                onChange={setSl}
                onClear={() => setSl('')}
                onStep={(dir) => setSl(stepPrice(sl || entry || lastPx, dir))}
                delta={slDelta}
                deltaTone="bear"
              />
              <button
                onClick={submitModify}
                disabled={saving}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Modify position'}
              </button>
            </>
          )}

          {tab === 'partial' && (
            <>
              <div>
                <label className="block text-[12px] font-semibold text-text-secondary mb-1.5">Quantity to close</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={qty}
                    value={partialQty}
                    onChange={(e) => setPartialQty(e.target.value)}
                    className="flex-1 px-3 py-2.5 rounded-lg border border-border-dark bg-white text-base font-mono text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                  />
                  <span className="text-xs text-text-muted whitespace-nowrap">/ {fmt(qty, 2)} lots</span>
                </div>
                <div className="flex gap-1.5 mt-2">
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPartialQty(String((qty * f).toFixed(2)))}
                      className="text-[11px] font-bold px-2.5 py-1 rounded border border-border-dark text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors"
                    >
                      {(f * 100).toFixed(0)}%
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={submitPartialClose}
                disabled={saving || !Number(partialQty)}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Closing…' : `Close ${fmt(Number(partialQty) || 0, 2)} lots`}
              </button>
            </>
          )}

          {tab === 'closeby' && (
            <>
              <div className="rounded-lg bg-bg-hover/50 border border-border-subtle px-3 py-2.5 text-[12px] text-text-secondary leading-snug">
                Close the entire <span className="font-bold text-text-primary">{fmt(qty, 2)} lot</span> {isBuy ? 'long' : 'short'} position at market. Realized P&L will settle to your trading wallet.
              </div>
              <button
                onClick={submitFullClose}
                disabled={saving}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Closing…' : `Close ${fmt(qty, 2)} lots at market`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PriceField({ label, value, placeholder, onChange, onClear, onStep, delta, deltaTone }) {
  const has = value && String(value).trim() !== '';
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[13px] font-semibold text-text-secondary">{label}</label>
        <span
          className="w-4 h-4 rounded-full border border-border-dark text-text-muted text-[10px] flex items-center justify-center"
          title="Price triggers a market close at this level"
        >?</span>
      </div>
      <div className="flex items-center bg-white border border-border-dark rounded-lg overflow-hidden focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/15 transition-all">
        <input
          type="number"
          step="any"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-transparent px-3 py-2.5 text-base font-mono text-text-primary placeholder-text-muted focus:outline-none"
        />
        {has && (
          <button
            type="button"
            onClick={onClear}
            className="text-text-muted hover:text-text-primary px-2 transition-colors"
            title="Clear"
          >×</button>
        )}
        <span className="text-[11px] text-text-muted px-2 select-none flex items-center gap-0.5 border-l border-border-subtle">
          Price <span className="text-[10px]">▾</span>
        </span>
        <button
          type="button"
          onClick={() => onStep(-1)}
          className="w-9 h-10 border-l border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-base font-bold"
          title="−1 pip"
        >−</button>
        <button
          type="button"
          onClick={() => onStep(1)}
          className="w-9 h-10 border-l border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-base font-bold"
          title="+1 pip"
        >+</button>
      </div>
      {has && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums">
          <span className={deltaTone === 'bull' ? 'text-bull font-semibold' : 'text-bear font-semibold'}>
            {delta.pips >= 0 ? '+' : ''}{delta.pips.toFixed(1)} pips
          </span>
          <span className="text-text-muted">·</span>
          <span className="text-text-secondary">{delta.usd.toFixed(2)} USD</span>
          <span className="text-text-muted">·</span>
          <span className="text-text-secondary">{delta.pct.toFixed(2)} %</span>
        </div>
      )}
    </div>
  );
}
