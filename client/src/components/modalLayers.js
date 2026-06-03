// App-wide z-index scale — single source of truth for layering.
// Kept in its own (non-component) module so components/Modal.jsx can stay
// Fast-Refresh-eligible (a module that exports a React component must NOT
// also export non-component values, or Vite HMR bails and the running tab
// can get stuck on stale code).
export const Z = {
  dropdown: 100,
  tooltip: 200,
  menu: 300,
  drawer: 500,
  modal: 1000,
  critical: 1100,
};
