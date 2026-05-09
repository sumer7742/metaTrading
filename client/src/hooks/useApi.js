import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../services/api';

/**
 * Fetch data from an API endpoint with loading and error state.
 * Re-runs when `path` or any item in `deps` changes.
 *
 * @param {string|null} path - API path (e.g. '/instruments'). Pass null to skip the call.
 * @param {object} [options]
 * @param {object} [options.params] - Query params for axios
 * @param {any[]} [options.deps] - Extra dependencies that should trigger re-fetch
 * @param {any} [options.initialData] - Initial value before first fetch resolves
 * @returns {{ data, loading, error, refresh }}
 *
 * Example:
 *   const { data: instruments, loading, refresh } = useApi('/instruments');
 */
export default function useApi(path, { params, deps = [], initialData = null } = {}) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState(null);

  // Stable reference for params so changing object identity doesn't refetch
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
