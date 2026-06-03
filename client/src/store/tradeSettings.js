import { create } from 'zustand';
import { useThemeStore } from './theme';

const STORAGE_KEY = 'tradepro:tradeSettings';

// ─── Defaults ────────────────────────────────────────────────────────
// Every section lives under its own key so settings stay self-documenting
// and partial reads (e.g. just chart toggles) don't need deep traversal.
const DEFAULTS = {
  showOnChart: {
    signals:        false,
    hmr:            false,
    alerts:         true,   // price alerts are most-used → default on
    positions:      true,
    tpsl:           true,   // TP / SL lines on open positions
    stopLimit:      true,   // pending STOP / LIMIT order lines
    calendar:       false,
    orderPreview:   true,   // live Entry/TP/SL preview lines while filling the order form
  },
  calendarFilters: {
    high:    true,
    medium:  true,
    low:     false,
    lowest:  false,
  },
  sounds: {
    alerts:  true,
    tpsl:    false,
  },
  trading: {
    openOrderMode: 'regular',     // 'regular' | 'oneClick' | 'riskCalc'
    priceSource:   'mid',         // 'bid' | 'ask' | 'mid'
    appearance:    'system',      // 'light' | 'dark' | 'system'
    timeZone:      'local',       // 'utc' | 'gmt' | 'local'
  },
  autoTrading: {
    autoTpSl:        false,
    confirmOrder:    true,    // confirm before placing — safer default
    oneClick:        false,
    autoSaveLayout:  true,
  },
};

// Deep-merge defaults onto whatever localStorage holds, so schema additions
// (new toggles, new sections) don't break older persisted blobs.
const merge = (base, override) => {
  if (!override || typeof override !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], override[k]);
    } else if (override[k] !== undefined) {
      out[k] = override[k];
    }
  }
  return out;
};

const readInitial = () => {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return merge(DEFAULTS, JSON.parse(raw));
  } catch (_) {
    return DEFAULTS;
  }
};

const write = (state) => {
  try {
    // Strip transient drawerOpen flag before persisting — UI state, not a setting.
    const { drawerOpen, ...persistable } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch (_) { /* private mode */ }
};

// ─── Appearance sync ────────────────────────────────────────────────
// The settings store owns the user's intent ('light' | 'dark' | 'system');
// the existing theme store owns what's currently applied to the document.
// We translate intent → effective theme + push it to the theme store
// whenever it changes. 'system' tracks the prefers-color-scheme media query.
const systemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

const applyAppearance = (intent) => {
  const themeStore = useThemeStore.getState();
  const next = intent === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : intent;
  if (themeStore.theme !== next) themeStore.setTheme(next);
};

// Subscribe to OS theme changes when intent is 'system'.
let _mqListener = null;
const wireSystemListener = (intent) => {
  if (typeof window === 'undefined') return;
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return;
  if (_mqListener) {
    try { mq.removeEventListener('change', _mqListener); } catch (_) {}
    _mqListener = null;
  }
  if (intent === 'system') {
    _mqListener = () => applyAppearance('system');
    try { mq.addEventListener('change', _mqListener); } catch (_) {}
  }
};

// ─── Store ──────────────────────────────────────────────────────────
export const useTradeSettings = create((set, get) => {
  const initial = readInitial();
  return {
    ...initial,
    drawerOpen: false,

    // Generic setter — `path` is dot notation: 'showOnChart.signals' etc.
    set: (path, value) => {
      const segs = path.split('.');
      const state = get();
      // Deep clone touched branch only — leave untouched sections referentially stable.
      const next = { ...state };
      let cursor = next;
      for (let i = 0; i < segs.length - 1; i++) {
        cursor[segs[i]] = { ...cursor[segs[i]] };
        cursor = cursor[segs[i]];
      }
      cursor[segs[segs.length - 1]] = value;
      // Side effect: appearance change applies the theme immediately.
      if (path === 'trading.appearance') {
        applyAppearance(value);
        wireSystemListener(value);
      }
      set(next);
      write(next);
    },

    // Bulk override (used by reset).
    replace: (next) => {
      set(next);
      write(next);
      applyAppearance(next.trading?.appearance || 'system');
      wireSystemListener(next.trading?.appearance || 'system');
    },

    reset: () => {
      const fresh = { ...DEFAULTS, drawerOpen: get().drawerOpen };
      set(fresh);
      write(fresh);
      applyAppearance(DEFAULTS.trading.appearance);
      wireSystemListener(DEFAULTS.trading.appearance);
    },

    openDrawer:  () => set({ drawerOpen: true }),
    closeDrawer: () => set({ drawerOpen: false }),
    toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),
  };
});

// Apply the persisted appearance on app boot. Called once from main.jsx /
// App init — safe to call multiple times.
export const applyInitialTradeSettings = () => {
  const intent = useTradeSettings.getState().trading.appearance;
  applyAppearance(intent);
  wireSystemListener(intent);
};
