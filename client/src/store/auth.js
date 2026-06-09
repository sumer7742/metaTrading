import { create } from 'zustand';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { getImpersonationToken, isImpersonating } from '../services/impersonation';

export const useAuthStore = create((set, get) => ({
  user: null,
  loading: true,

  init: async () => {
    // Read-only "View As User": an impersonation token (tab-scoped) takes
    // priority over any real login, so /auth/me resolves to the target user
    // and the app renders exactly as they see it.
    const impToken = getImpersonationToken();
    const token = impToken || localStorage.getItem('accessToken');
    if (!token) {
      set({ loading: false });
      return;
    }
    try {
      const { data } = await api.get('/auth/me');
      set({ user: data.data, loading: false });
      wsClient.connect(token);
    } catch (err) {
      if (!isImpersonating()) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
      }
      set({ user: null, loading: false });
    }
  },

  login: async (email, password, twoFactorCode) => {
    const { data } = await api.post('/auth/login', { email, password, twoFactorCode });
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    set({ user: data.data.user });
    wsClient.connect(data.data.accessToken);
    return data.data.user;
  },

  register: async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    set({ user: data.data.user });
    wsClient.connect(data.data.accessToken);
    return data.data.user;
  },

  logout: async () => {
    try {
      await api.post('/auth/logout', { refreshToken: localStorage.getItem('refreshToken') });
    } catch {}
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    wsClient.disconnect();
    set({ user: null });
  },

  refreshUser: async () => {
    try {
      const { data } = await api.get('/auth/me');
      set({ user: data.data });
    } catch {}
  },
}));

export { errorMessage };
