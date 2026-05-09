import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../services/api';

/**
 * Fetch data from an API endpoint with loading/error/refresh.
 * Re-runs when `path` or any item in `deps` changes.
 *
 * @param {string|null} path - API path (e.g. '/admin/users'). Pass null to skip.
 * @param {object} [options]
 * @param {object} [options.params] - Axios query params
 * @param {any[]} [options.deps] - Extra deps that should trigger refetch
 * @param {any} [options.initialData] - Initial value before first fetch
 */
export default function useApi(path, { params, deps = [], initialData = null } = {}) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const fetchData = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(path, { params: paramsRef.current });
      setData(res.data.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData, setData };
}
