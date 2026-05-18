import { create } from 'zustand';

const STORAGE_KEY = 'tradepro:theme';

// Light is the default Groww palette. Dark uses dark surfaces with the same
// green primary, intended for the trading terminal experience.
const readInitial = () => {
  if (typeof window === 'undefined') return 'light';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'light';
};

const apply = (theme) => {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
};

export const applyInitialTheme = () => apply(readInitial());

export const useThemeStore = create((set, get) => ({
  theme: readInitial(),
  setTheme: (next) => {
    if (next !== 'light' && next !== 'dark') return;
    apply(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* private mode */ }
    set({ theme: next });
  },
  toggle: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
}));
