import axios from 'axios';

// Build the API base URL from env. Accepts either VITE_API_URL (legacy)
// or VITE_API_BASE (newer naming used in deploy docs). If the value
// doesn't already end with `/api`, append it — that way both
// `https://api.yourdomain.com` and `https://api.yourdomain.com/api`
// produce a correct base. Fallback to local dev backend.
const _envBase = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE || 'http://localhost:5000/api';
const API_URL = _envBase.replace(/\/$/, '').endsWith('/api')
  ? _envBase.replace(/\/$/, '')
  : _envBase.replace(/\/$/, '') + '/api';

export const api = axios.create({
  baseURL: API_URL,
  // baseURL: 'http://localhost:5000/api',
  headers: { 'Content-Type': 'application/json' },
  // 20s ceiling so a stuck backend doesn't leave the UI on a "Loading…"
  // screen forever. Most requests should complete in under 1s; anything
  // approaching this ceiling is a bug worth surfacing as an error.
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
  failedQueue = [];
};

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      const code = error.response.data?.error?.code;
      if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN') {
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          })
            .then((token) => {
              original.headers.Authorization = `Bearer ${token}`;
              return api(original);
            })
            .catch((err) => Promise.reject(err));
        }
        original._retry = true;
        isRefreshing = true;
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) {
          isRefreshing = false;
          window.location.href = '/login';
          return Promise.reject(error);
        }
        try {
          const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
          const newAccess = data.data.accessToken;
          const newRefresh = data.data.refreshToken;
          localStorage.setItem('accessToken', newAccess);
          localStorage.setItem('refreshToken', newRefresh);
          processQueue(null, newAccess);
          original.headers.Authorization = `Bearer ${newAccess}`;
          return api(original);
        } catch (err) {
          processQueue(err, null);
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
          window.location.href = '/login';
          return Promise.reject(err);
        } finally {
          isRefreshing = false;
        }
      }
    }
    return Promise.reject(error);
  }
);

export const errorMessage = (err) =>
  err?.response?.data?.error?.message || err?.message || 'Request failed';
