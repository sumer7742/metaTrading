import { useEffect, useState } from 'react';

/**
 * Debounce a value. Returns the value after `delay` ms have passed without changes.
 * Useful for search inputs to avoid hammering the API on every keystroke.
 *
 * Example:
 *   const [search, setSearch] = useState('');
 *   const debouncedSearch = useDebounce(search, 300);
 *   useEffect(() => { fetchUsers(debouncedSearch); }, [debouncedSearch]);
 */
export default function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
