import { create } from 'zustand';

const STORAGE_KEY = 'tradepro:theme';

/**
 * Read the saved theme. Falls back to the user's system preference if nothing
 * has been saved yet, with a final fallback to dark (the app's original default).
 */
const readInitial = () => {
  if (typeof window === 'undefined') return 'dark';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
};

const apply = (theme) => {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // color-scheme tells the browser to render native form controls + scrollbars
  // in the matching tone. Without it, dropdowns and date pickers in light
  // mode still render with the dark UA stylesheet.
  document.documentElement.style.colorScheme = theme;
};

/**
 * Apply the saved/system theme synchronously. Call this from main.jsx BEFORE
 * React renders so the user never sees a flash of the wrong theme on load.
 */
export const applyInitialTheme = () => {
  apply(readInitial());
};

export const useThemeStore = create((set, get) => ({
  theme: readInitial(),

  /** Switch to the given theme and persist. */
  setTheme: (next) => {
    if (next !== 'light' && next !== 'dark') return;
    apply(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* private mode */ }
    set({ theme: next });
  },

  /** Convenience flip — light → dark or dark → light. */
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));
