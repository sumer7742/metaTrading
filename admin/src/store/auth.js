import { create } from 'zustand';
import { api, errorMessage } from '../services/api';

export const useAuthStore = create((set) => ({
  user: null,
  loading: true,

  init: async () => {
    const token = localStorage.getItem('admin_accessToken');
    if (!token) return set({ loading: false });
    try {
      const { data } = await api.get('/auth/me');
      if (!['ADMIN', 'SUPER_ADMIN'].includes(data.data.role)) {
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
    if (!['ADMIN', 'SUPER_ADMIN'].includes(data.data.user.role)) {
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
}));

export { errorMessage };
