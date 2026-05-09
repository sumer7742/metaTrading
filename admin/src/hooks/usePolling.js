import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../services/api';

/**
 * Poll an API endpoint at a regular interval. Useful for the admin dashboard
 * (live exposure, withdrawal queue, etc) where WebSocket isn't strictly needed.
 *
 * @param {string|null} path - API path. null to skip.
 * @param {number} intervalMs - Poll interval (default 10s).
 * @param {object} [options]
 * @param {object} [options.params] - Axios query params
 * @param {boolean} [options.enabled=true] - Stop polling when false
 *
 * @returns {{ data, loading, error, refresh }}
 *
 * Example:
 *   const { data: stats } = usePolling('/admin/dashboard', 10000);
 */
export default function usePolling(path, intervalMs = 10000, { params, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const fetchOnce = useCallback(async () => {
    if (!path || !enabled) return;
    try {
      const res = await api.get(path, { params: paramsRef.current });
      setData(res.data.data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => {
    if (!path || !enabled) return;
    fetchOnce();
    const id = setInterval(fetchOnce, intervalMs);
    return () => clearInterval(id);
  }, [path, enabled, intervalMs, fetchOnce]);

  return { data, loading, error, refresh: fetchOnce };
}
