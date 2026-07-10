import { create } from 'zustand';

// Single source of truth for the user's ACTIVE trading account.
//
// Both the Trade terminal and the header profile menu read/write this store,
// so switching the account in either place updates the other instantly (and
// drives the account-scoped positions/orders/balances refetch on the Trade
// page). Persisted to the same localStorage key the Trade page has always
// used, so any existing saved selection survives this change.
const STORAGE_KEY = 'tradepro:selected-account';

const readSaved = () => {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(STORAGE_KEY) || null; } catch (_) { return null; }
};

export const useSelectedAccount = create((set) => ({
  accountId: readSaved(),
  setAccountId: (id) => {
    set({ accountId: id || null });
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* ignore quota / privacy-mode errors */ }
  },
}));
