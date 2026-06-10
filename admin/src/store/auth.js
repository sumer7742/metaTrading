import { create } from 'zustand';
import { api, errorMessage } from '../services/api';

// Roles allowed into the admin console. MANAGER is part of the management
// hierarchy (scoped, read-mostly views); add future mgmt roles here.
const ADMIN_APP_ROLES = ['ADMIN', 'SUPER_ADMIN', 'MANAGER',
  'FINANCIAL_ADMIN', 'DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'];

export const useAuthStore = create((set) => ({
  user: null,
  loading: true,

  init: async () => {
    const token = localStorage.getItem('admin_accessToken');
    if (!token) return set({ loading: false });
    try {
      const { data } = await api.get('/auth/me');
      if (!ADMIN_APP_ROLES.includes(data.data.role)) {
        localStorage.removeItem('admin_accessToken');
        localStorage.removeItem('admin_refreshToken');
        set({ user: null, loading: false });
        return;
      }
      set({ user: data.data, loading: false });
    } catch {
      localStorage.removeItem('admin_accessToken');
      localStorage.removeItem('admin_refreshToken');
      set({ user: null, loading: false });
    }
  },

  login: async (email, password, twoFactorCode) => {
    const { data } = await api.post('/auth/login', { email, password, twoFactorCode });
    if (!ADMIN_APP_ROLES.includes(data.data.user.role)) {
      throw new Error('Not an admin account');
    }
    localStorage.setItem('admin_accessToken', data.data.accessToken);
    localStorage.setItem('admin_refreshToken', data.data.refreshToken);
    set({ user: data.data.user });
    return data.data.user;
  },

  logout: async () => {
    try { await api.post('/auth/logout', { refreshToken: localStorage.getItem('admin_refreshToken') }); } catch {}
    localStorage.removeItem('admin_accessToken');
    localStorage.removeItem('admin_refreshToken');
    set({ user: null });
  },

  // Re-pull /auth/me so Manager Access Control changes (permissions / master
  // switch) apply WITHOUT a logout. Called on window focus + periodically.
  refresh: async () => {
    if (!localStorage.getItem('admin_accessToken')) return;
    try { const { data } = await api.get('/auth/me'); set({ user: data.data }); } catch { /* ignore */ }
  },
}));

export { errorMessage };
