import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export const api = axios.create({ baseURL: API_URL, headers: { 'Content-Type': 'application/json' } });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let isRefreshing = false;
let queue = [];
const processQueue = (err, token = null) => {
  queue.forEach((p) => (err ? p.reject(err) : p.resolve(token)));
  queue = [];
};

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      const code = error.response.data?.error?.code;
      if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN') {
        if (isRefreshing) {
          return new Promise((resolve, reject) => queue.push({ resolve, reject }))
            .then((token) => {
              original.headers.Authorization = `Bearer ${token}`;
              return api(original);
            });
        }
        original._retry = true;
        isRefreshing = true;
        try {
          const refreshToken = localStorage.getItem('admin_refreshToken');
          if (!refreshToken) throw new Error('no refresh');
          const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
          localStorage.setItem('admin_accessToken', data.data.accessToken);
          localStorage.setItem('admin_refreshToken', data.data.refreshToken);
          processQueue(null, data.data.accessToken);
          original.headers.Authorization = `Bearer ${data.data.accessToken}`;
          return api(original);
        } catch (e) {
          processQueue(e);
          localStorage.removeItem('admin_accessToken');
          localStorage.removeItem('admin_refreshToken');
          window.location.href = '/login';
          return Promise.reject(e);
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
