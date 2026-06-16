/**
 * Multi-chart layout templates — TradingView-style.
 *
 * Each template describes a CSS-grid (cols × rows) plus the placement of every
 * pane as `[colStart, colSpan, rowStart, rowSpan]` (1-indexed). The same `cells`
 * array drives both the live grid and the little preview icon in the picker, so
 * adding a template needs no extra artwork.
 */

// Build a uniform cols×rows grid (row-major).
const grid = (cols, rows) => {
  const cells = [];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) cells.push([c, 1, r, 1]);
  return cells;
};

export const LAYOUTS = [
  // 1
  { id: '1', n: 1, cols: 1, rows: 1, cells: [[1, 1, 1, 1]] },

  // 2
  { id: '2c', n: 2, cols: 2, rows: 1, cells: grid(2, 1) },
  { id: '2r', n: 2, cols: 1, rows: 2, cells: grid(1, 2) },

  // 3
  { id: '3c', n: 3, cols: 3, rows: 1, cells: grid(3, 1) },
  { id: '3r', n: 3, cols: 1, rows: 3, cells: grid(1, 3) },
  { id: '3lr', n: 3, cols: 2, rows: 2, cells: [[1, 1, 1, 2], [2, 1, 1, 1], [2, 1, 2, 1]] }, // 1 left + 2 right
  { id: '3tb', n: 3, cols: 2, rows: 2, cells: [[1, 2, 1, 1], [1, 1, 2, 1], [2, 1, 2, 1]] }, // 1 top + 2 bottom

  // 4
  { id: '4g', n: 4, cols: 2, rows: 2, cells: grid(2, 2) },
  { id: '4c', n: 4, cols: 4, rows: 1, cells: grid(4, 1) },
  { id: '4r', n: 4, cols: 1, rows: 4, cells: grid(1, 4) },
  { id: '4lr', n: 4, cols: 2, rows: 3, cells: [[1, 1, 1, 3], [2, 1, 1, 1], [2, 1, 2, 1], [2, 1, 3, 1]] }, // 1 left + 3 right
  { id: '4tb', n: 4, cols: 3, rows: 2, cells: [[1, 3, 1, 1], [1, 1, 2, 1], [2, 1, 2, 1], [3, 1, 2, 1]] }, // 1 top + 3 bottom

  // 5
  { id: '5tb', n: 5, cols: 6, rows: 2, cells: [[1, 2, 1, 1], [3, 2, 1, 1], [5, 2, 1, 1], [1, 3, 2, 1], [4, 3, 2, 1]] }, // 3 top + 2 bottom
  { id: '5c', n: 5, cols: 5, rows: 1, cells: grid(5, 1) },
  { id: '5lr', n: 5, cols: 2, rows: 4, cells: [[1, 1, 1, 4], [2, 1, 1, 1], [2, 1, 2, 1], [2, 1, 3, 1], [2, 1, 4, 1]] }, // 1 left + 4 right

  // 6
  { id: '6g', n: 6, cols: 3, rows: 2, cells: grid(3, 2) },
  { id: '6c', n: 6, cols: 6, rows: 1, cells: grid(6, 1) },
  { id: '6r', n: 6, cols: 1, rows: 6, cells: grid(1, 6) },
  { id: '6v', n: 6, cols: 2, rows: 3, cells: grid(2, 3) },

  // 7
  { id: '7lr', n: 7, cols: 3, rows: 3, cells: [[1, 1, 1, 3], [2, 1, 1, 1], [3, 1, 1, 1], [2, 1, 2, 1], [3, 1, 2, 1], [2, 1, 3, 1], [3, 1, 3, 1]] }, // 1 left + 6 right
  { id: '7c', n: 7, cols: 7, rows: 1, cells: grid(7, 1) },

  // 8
  { id: '8g', n: 8, cols: 4, rows: 2, cells: grid(4, 2) },
  { id: '8c', n: 8, cols: 8, rows: 1, cells: grid(8, 1) },
  { id: '8v', n: 8, cols: 2, rows: 4, cells: grid(2, 4) },
];

export const LAYOUT_BY_ID = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));
export const getLayout = (id) => LAYOUT_BY_ID[id] || LAYOUTS[0];

// Picker groups: count → templates.
export const LAYOUT_GROUPS = (() => {
  const m = new Map();
  for (const l of LAYOUTS) { if (!m.has(l.n)) m.set(l.n, []); m.get(l.n).push(l); }
  return [...m.entries()].map(([n, items]) => ({ n, items }));
})();

// The in-layout properties that can be synchronised across panes.
export const SYNC_FIELDS = [
  { key: 'symbol', label: 'Symbol', info: 'Show the same instrument in every chart' },
  { key: 'interval', label: 'Interval', info: 'Use the same timeframe in every chart' },
  { key: 'crosshair', label: 'Crosshair', info: 'Move the crosshair together across charts' },
  { key: 'time', label: 'Time', info: 'Scroll / zoom the time axis together' },
  { key: 'dateRange', label: 'Date range', info: 'Keep the same visible date range' },
];

export const DEFAULT_SYNC = { symbol: false, interval: false, crosshair: true, time: false, dateRange: false };
