import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wsClient } from '../services/ws';
import { api } from '../services/api';

const STORAGE_KEY = 'tradepro:notifications:v1';
const PREFS_KEY = 'tradepro:notifications:prefs:v1';
const MAX_NOTIFICATIONS = 50;

const DEFAULT_PREFS = {
  muteSounds: true,  // sounds disabled entirely — kept in prefs only for backward compat
  enableTrading: true,
  enableMarkets: true,
  enableAccount: true,
};

// Notification categories → tab group. Used by the UI to filter and by
// the prefs to gate which channels create notifications at all.
export const NOTIFICATION_META = {
  ORDER:       { tab: 'Trading', icon: 'order',  tint: '#1D4ED8', label: 'Order update' },
  TRADING:     { tab: 'Trading', icon: 'signal', tint: '#0EA5E9', label: 'Trade alert' },
  PORTFOLIO:   { tab: 'Trading', icon: 'pie',    tint: '#10B981', label: 'Portfolio update' },
  PRICE_ALERT: { tab: 'Markets', icon: 'bell',   tint: '#3B82F6', label: 'Price alert' },
  VOLATILITY:  { tab: 'Markets', icon: 'bolt',   tint: '#8B5CF6', label: 'Volatility alert' },
  SCREENER:    { tab: 'Markets', icon: 'filter', tint: '#EC4899', label: 'Screener alert' },
  ACCOUNT:     { tab: 'Account', icon: 'user',   tint: '#475569', label: 'Account' },
};

const readState = () => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
};
const writeState = (list) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_NOTIFICATIONS))); }
  catch (_) {}
};
const readPrefs = () => {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) };
  } catch (_) { return DEFAULT_PREFS; }
};
const writePrefs = (p) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {}
};

// Notification sounds removed per product decision — silent UX only.
// Bell badge + visual highlight are the only cues.

/**
 * Notification store hook. Backed by localStorage so notifications
 * persist across reloads. Subscribes to relevant WS channels to
 * generate new notifications in real time.
 *
 * Returns:
 *  - notifications: full array
 *  - unreadCount: number of unread items
 *  - prefs: user preferences (mute, per-tab toggles)
 *  - markAllRead, markRead, clear: actions
 *  - updatePrefs: setter for preferences
 *  - add: imperative API to push a notification (for non-WS sources)
 */
export function useNotifications() {
  const [notifications, setNotifications] = useState(readState);
  const [prefs, setPrefs] = useState(readPrefs);

  // Persist any change to notifications.
  useEffect(() => { writeState(notifications); }, [notifications]);
  useEffect(() => { writePrefs(prefs); }, [prefs]);

  // Cross-tab sync — if the user clears notifications in another tab,
  // reflect it here.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) {
        try { setNotifications(e.newValue ? JSON.parse(e.newValue) : []); } catch (_) {}
      }
      if (e.key === PREFS_KEY) {
        try { setPrefs({ ...DEFAULT_PREFS, ...(e.newValue ? JSON.parse(e.newValue) : {}) }); }
        catch (_) {}
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Dedupe window — if a notification with the same type+title has
  // already fired in the last 30 s, drop the new one. Keeps the bell
  // from spamming when the server emits repeated state-tick events.
  const dedupeRef = useRef(new Map());
  const add = useCallback((n) => {
    const meta = NOTIFICATION_META[n.type] || NOTIFICATION_META.TRADING;
    if (meta.tab === 'Trading' && !prefs.enableTrading) return;
    if (meta.tab === 'Markets' && !prefs.enableMarkets) return;
    if (meta.tab === 'Account' && !prefs.enableAccount) return;

    const key = `${n.type}|${n.title}`;
    const now = Date.now();
    const lastTs = dedupeRef.current.get(key) || 0;
    if (now - lastTs < 30 * 1000) return; // same body within 30 s → drop
    dedupeRef.current.set(key, now);

    const entry = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      type: n.type,
      title: n.title,
      message: n.message || '',
      timestamp: now,
      status: n.status || 'info',
      link: n.link || null,
      symbol: n.symbol || null,
      read: false,
    };
    setNotifications((prev) => [entry, ...prev].slice(0, MAX_NOTIFICATIONS));
  }, [prefs]);

  const markRead = useCallback((id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clear = useCallback(() => setNotifications([]), []);

  const updatePrefs = useCallback((patch) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  // ── WS-driven notification generators ─────────────────────────────
  // Each subscription receives the event payload and pushes a natural-
  // language notification. Diff-against-previous logic is intentionally
  // kept simple: every event becomes a notification. The MAX cap + the
  // mute prefs keep noise in check.
  useEffect(() => {
    // Only fire on meaningful state changes. Generic 'updated' events
    // (which the server emits on every tick to refresh PnL) are
    // ignored — those would spam the bell on every price update.
    const MEANINGFUL_ORDER = new Set(['filled', 'placed', 'created', 'cancelled', 'rejected']);
    const MEANINGFUL_POSITION = new Set(['opened', 'closed', 'created']);

    const unsubO = wsClient.subscribe('orders', (data) => {
      const action = String(data?.action || '').toLowerCase();
      if (!MEANINGFUL_ORDER.has(action)) return;
      const o = data?.order || data || {};
      const sym = o.symbol || data?.symbol;
      add({
        type: 'ORDER',
        title: `Order ${action}${sym ? ' · ' + sym : ''}`,
        message: o.side && o.quantity ? `${o.side} ${o.quantity} ${sym || ''}` : 'Your order status changed',
        status: action === 'filled' ? 'success' : action === 'cancelled' || action === 'rejected' ? 'warning' : 'info',
        link: '/reports',
        symbol: sym,
      });
    });
    const unsubP = wsClient.subscribe('positions', (data) => {
      const action = String(data?.action || '').toLowerCase();
      if (!MEANINGFUL_POSITION.has(action)) return;
      const p = data?.position || data || {};
      const sym = p.symbol || data?.symbol;
      const pnl = Number(p.realizedPnl ?? p.unrealizedPnl ?? 0);
      add({
        type: 'TRADING',
        title: `Position ${action}${sym ? ' · ' + sym : ''}`,
        message: action === 'closed' && Number.isFinite(pnl) && pnl !== 0
          ? `PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`
          : (p.side ? `${p.side} ${p.quantity || ''} ${sym || ''}` : 'Your position changed'),
        status: action === 'closed' ? (pnl >= 0 ? 'success' : 'error') : 'info',
        link: '/trade' + (sym ? `?symbol=${encodeURIComponent(sym)}` : ''),
        symbol: sym,
      });
    });
    const unsubW = wsClient.subscribe('wallet', (data) => {
      // Only fire when the server reports an actual transaction amount —
      // skip silent rebalance / tick events that have no amount field.
      const amount = Number(data?.amount ?? 0);
      if (!Number.isFinite(amount) || amount === 0) return;
      const action = String(data?.action || 'updated').toLowerCase();
      add({
        type: 'ACCOUNT',
        title: `Wallet ${action}`,
        message: `${amount > 0 ? '+' : ''}${amount.toFixed(2)} ${data?.currency || ''}`,
        status: amount >= 0 ? 'success' : 'info',
        link: '/wallet',
      });
    });
    return () => {
      unsubO && unsubO();
      unsubP && unsubP();
      unsubW && unsubW();
    };
  }, [add]);

  // ── Price-alerts engine ───────────────────────────────────────────
  // Pulls the user's configured alerts (symbol + direction + target)
  // from /reports/alerts, subscribes to `ticker:<symbol>` for each
  // unique symbol, and fires a PRICE_ALERT notification the instant
  // the target is crossed. `firedRef` blocks re-fire within the
  // session for non-repeatable alerts so a flapping price doesn't
  // spam the user.
  const alertsRef = useRef([]);
  const firedRef = useRef(new Set());
  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      try {
        const { data } = await api.get('/reports/alerts');
        if (cancelled) return;
        alertsRef.current = (data?.data || []).filter((a) => a.isActive && !a.triggeredAt);
      } catch (_) { /* keep prior */ }
    };
    refetch();
    const unsubA = wsClient.subscribe('alerts', refetch);
    return () => { cancelled = true; unsubA && unsubA(); };
  }, []);

  // ── Volatility + screener (24h-mover) + ticker-based alerts ──────
  // One shared `ticker:*` subscription per symbol referenced by ANY
  // alert / position. Each tick:
  //  1. Checks all matching price-alert thresholds.
  //  2. Updates a sliding 5-minute price-sample buffer per symbol;
  //     fires a VOLATILITY notification if |Δ%| ≥ 2 % across the
  //     window (debounced 10 min per symbol).
  //  3. Fires a SCREENER notification when the day's % change
  //     crosses ±5 % (debounced 30 min per symbol).
  const priceHistoryRef = useRef({}); // symbol → [{ ts, price }]
  const volCooldownRef = useRef({});  // symbol → ts of last vol notif
  const screenerCooldownRef = useRef({}); // symbol → ts of last screener notif
  const lastDayChangeSignRef = useRef({}); // symbol → 1 | -1 | 0
  const symbolsToWatchRef = useRef(new Set());
  const [watchedSymbols, setWatchedSymbols] = useState([]);

  // Re-derive the watch-set whenever alerts or positions change.
  useEffect(() => {
    const sample = () => {
      const next = new Set();
      for (const a of alertsRef.current) if (a.symbol) next.add(a.symbol);
      // Also watch every symbol the user holds a position in for
      // volatility + portfolio PnL tracking.
      for (const p of positionsCacheRef.current) if (p.symbol) next.add(p.symbol);
      // Cheap shallow-equal vs prior set.
      const arr = Array.from(next).sort();
      const prev = Array.from(symbolsToWatchRef.current).sort();
      if (arr.length !== prev.length || arr.some((s, i) => s !== prev[i])) {
        symbolsToWatchRef.current = next;
        setWatchedSymbols(arr);
      }
    };
    sample();
    const id = setInterval(sample, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!watchedSymbols.length) return;
    const unsubs = watchedSymbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (tick) => {
        const price = Number(tick?.lastPrice);
        if (!Number.isFinite(price) || price <= 0) return;
        const now = Date.now();

        // (1) Price-alert thresholds
        for (const a of alertsRef.current) {
          if (a.symbol !== sym) continue;
          if (firedRef.current.has(a._id)) continue;
          const target = Number(a.targetPrice);
          if (!Number.isFinite(target)) continue;
          const crossed =
            (a.direction === 'ABOVE' && price >= target) ||
            (a.direction === 'BELOW' && price <= target);
          if (!crossed) continue;
          firedRef.current.add(a._id);
          add({
            type: 'PRICE_ALERT',
            title: `${sym} crossed ${a.direction === 'ABOVE' ? 'above' : 'below'} ${target}`,
            message: `Now at ${price.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}${a.note ? ' · ' + a.note : ''}`,
            status: 'success',
            link: `/trade?symbol=${encodeURIComponent(sym)}`,
            symbol: sym,
          });
        }

        // (2) Volatility: 5-min sliding window
        const hist = priceHistoryRef.current[sym] || [];
        hist.push({ ts: now, price });
        // Trim to last 5 min
        const cutoff = now - 5 * 60 * 1000;
        while (hist.length && hist[0].ts < cutoff) hist.shift();
        priceHistoryRef.current[sym] = hist;
        if (hist.length >= 5) {
          const oldest = hist[0].price;
          const pct = ((price - oldest) / oldest) * 100;
          if (Math.abs(pct) >= 2) {
            const lastFired = volCooldownRef.current[sym] || 0;
            if (now - lastFired > 10 * 60 * 1000) {
              volCooldownRef.current[sym] = now;
              add({
                type: 'VOLATILITY',
                title: `${sym} ${pct >= 0 ? 'surged' : 'dropped'} ${Math.abs(pct).toFixed(2)}% in 5 min`,
                message: `Live: ${price}`,
                status: pct >= 0 ? 'success' : 'error',
                link: `/trade?symbol=${encodeURIComponent(sym)}`,
                symbol: sym,
              });
            }
          }
        }

        // (3) Screener — 24h % change band crossing
        const change24h = Number(tick?.change24h ?? tick?.priceChangePercent);
        if (Number.isFinite(change24h)) {
          const sign = change24h >= 5 ? 1 : change24h <= -5 ? -1 : 0;
          const prevSign = lastDayChangeSignRef.current[sym] ?? 0;
          if (sign !== 0 && sign !== prevSign) {
            const lastFired = screenerCooldownRef.current[sym] || 0;
            if (now - lastFired > 30 * 60 * 1000) {
              screenerCooldownRef.current[sym] = now;
              add({
                type: 'SCREENER',
                title: `${sym} on the ${sign > 0 ? 'top gainers' : 'top losers'} list`,
                message: `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}% today`,
                status: sign > 0 ? 'success' : 'error',
                link: `/trade?symbol=${encodeURIComponent(sym)}`,
                symbol: sym,
              });
            }
          }
          lastDayChangeSignRef.current[sym] = sign;
        }
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [watchedSymbols, add]);

  // ── Portfolio PnL — threshold crossings ──────────────────────────
  // Caches positions for the watch-symbols effect above, and emits a
  // PORTFOLIO notification when total unrealised PnL crosses ±$100,
  // ±$500, or ±$1 000. `lastPnlBandRef` tracks the last band emitted
  // to avoid re-firing while the value hovers around the same line.
  const positionsCacheRef = useRef([]);
  const lastPnlBandRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get('/trading/positions');
        if (!cancelled) positionsCacheRef.current = Array.isArray(data?.data) ? data.data : [];
      } catch (_) { /* keep prior */ }
    };
    load();
    const u1 = wsClient.subscribe('positions', load);
    const u2 = wsClient.subscribe('orders', load);
    // PnL re-checker — runs every 5 s using the latest cached
    // positions + price history we already maintain.
    const tickId = setInterval(() => {
      // Skip entirely when the user has no positions — without this
      // an idle account would still trip the PnL band logic (totalPnl
      // = 0 is mathematically inside the −$100 band) and spam a
      // "Portfolio PnL crossed −$100" on every page load.
      if (!positionsCacheRef.current.length) return;
      let totalPnl = 0;
      for (const p of positionsCacheRef.current) {
        const hist = priceHistoryRef.current[p.symbol] || [];
        const last = hist[hist.length - 1]?.price ?? Number(p.markPrice) ?? Number(p.entryPrice);
        const entry = Number(p.entryPrice);
        const qty = Number(p.quantity);
        if (![entry, qty, last].every(Number.isFinite)) continue;
        totalPnl += p.side === 'BUY' ? (last - entry) * qty : (entry - last) * qty;
      }
      // Discrete band: only when PnL actually exceeds a threshold in
      // either direction. Returns 0 if |PnL| < $100 (no fire).
      let band = 0;
      const POS = [100, 500, 1000];
      const NEG = [-100, -500, -1000];
      for (const b of POS) if (totalPnl >= b) band = b;
      for (const b of NEG) if (totalPnl <= b) band = b;
      if (band !== 0 && band !== lastPnlBandRef.current) {
        lastPnlBandRef.current = band;
        add({
          type: 'PORTFOLIO',
          title: `Portfolio PnL crossed ${band > 0 ? '+' : '-'}$${Math.abs(band)}`,
          message: `Live total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
          status: band > 0 ? 'success' : 'error',
          link: '/dashboard',
        });
      }
    }, 5000);
    return () => { cancelled = true; u1 && u1(); u2 && u2(); clearInterval(tickId); };
  }, [add]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  return {
    notifications,
    unreadCount,
    prefs,
    add,
    markRead,
    markAllRead,
    clear,
    updatePrefs,
  };
}
