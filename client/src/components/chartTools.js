/**
 * Drawing-tool registry — the single source of truth for the TradingView-style
 * drawing palette. Both the engine (useChartDrawings) and the toolbar
 * (ChartDrawingToolbar) read from here.
 *
 * Every tool maps to a generic geometric "family" the engine knows how to
 * render / hit-test / resize, plus the number of points it collects:
 *   number → fixed N-click tool · 'free' → click-to-add, double-click to finish.
 *
 * Some distinct TradingView tools share a family with a `variant` flag (e.g.
 * the pitchfork variants, the fib fans). Where geometry is highly specialised
 * (Gann square, fib spiral, volume profile, auto-labelled patterns) the engine
 * draws a faithful, fully-interactive approximation.
 */

// group -> ordered items. Each item: { tool, label, family, pts, variant?, glyph?, hotkey?, fav? }
export const GROUPS = [
  {
    name: 'Lines',
    items: [
      { tool: 'trendline', label: 'Trend Line', family: 'trend', pts: 2, hotkey: 'Alt+T' },
      { tool: 'ray', label: 'Ray', family: 'trend', pts: 2, variant: 'rayR' },
      { tool: 'infoline', label: 'Info Line', family: 'trend', pts: 2, variant: 'info' },
      { tool: 'extended', label: 'Extended Line', family: 'trend', pts: 2, variant: 'extend' },
      { tool: 'trendangle', label: 'Trend Angle', family: 'trend', pts: 2, variant: 'angle' },
      { tool: 'hline', label: 'Horizontal Line', family: 'hline', pts: 1, hotkey: 'Alt+H' },
      { tool: 'hray', label: 'Horizontal Ray', family: 'hray', pts: 1, hotkey: 'Alt+J' },
      { tool: 'vline', label: 'Vertical Line', family: 'vline', pts: 1, hotkey: 'Alt+V' },
      { tool: 'crossline', label: 'Cross Line', family: 'cross', pts: 1, hotkey: 'Alt+C' },
    ],
  },
  {
    name: 'Channels',
    items: [
      { tool: 'parallel', label: 'Parallel Channel', family: 'channel', pts: 3 },
      { tool: 'regression', label: 'Regression Trend', family: 'regression', pts: 2 },
      { tool: 'flatchannel', label: 'Flat Top/Bottom', family: 'channel', pts: 3, variant: 'flat' },
      { tool: 'disjoint', label: 'Disjoint Channel', family: 'channel', pts: 3, variant: 'disjoint' },
    ],
  },
  {
    name: 'Pitchforks',
    items: [
      { tool: 'pitchfork', label: 'Pitchfork', family: 'pitchfork', pts: 3 },
      { tool: 'schiff', label: 'Schiff Pitchfork', family: 'pitchfork', pts: 3, variant: 'schiff' },
      { tool: 'modschiff', label: 'Modified Schiff', family: 'pitchfork', pts: 3, variant: 'modschiff' },
      { tool: 'insidepitchfork', label: 'Inside Pitchfork', family: 'pitchfork', pts: 3, variant: 'inside' },
    ],
  },
  {
    name: 'Fibonacci',
    items: [
      { tool: 'fibretr', label: 'Fib Retracement', family: 'fib', pts: 2, hotkey: 'Alt+F' },
      { tool: 'fibext', label: 'Trend-Based Fib Extension', family: 'fib', pts: 3, variant: 'ext' },
      { tool: 'fibchannel', label: 'Fib Channel', family: 'fibchannel', pts: 3 },
      { tool: 'fibtimezone', label: 'Fib Time Zone', family: 'fibtime', pts: 2 },
      { tool: 'fibfan', label: 'Fib Speed Resistance Fan', family: 'fan', pts: 2, variant: 'fib' },
      { tool: 'fibtimetrend', label: 'Trend-Based Fib Time', family: 'fibtime', pts: 2, variant: 'trend' },
      { tool: 'fibcircles', label: 'Fib Circles', family: 'circles', pts: 2, variant: 'fib' },
      { tool: 'fibspiral', label: 'Fib Spiral', family: 'spiral', pts: 2 },
      { tool: 'fibarcs', label: 'Fib Speed Resistance Arcs', family: 'arcs', pts: 2 },
      { tool: 'fibwedge', label: 'Fib Wedge', family: 'arcs', pts: 2, variant: 'wedge' },
      { tool: 'pitchfan', label: 'Pitchfan', family: 'fan', pts: 2, variant: 'gann' },
    ],
  },
  {
    name: 'Gann',
    items: [
      { tool: 'gannbox', label: 'Gann Box', family: 'rectgrid', pts: 2 },
      { tool: 'gannsquarefixed', label: 'Gann Square Fixed', family: 'gannsquare', pts: 2 },
      { tool: 'gannsquare', label: 'Gann Square', family: 'gannsquare', pts: 2 },
      { tool: 'gannfan', label: 'Gann Fan', family: 'fan', pts: 2, variant: 'gann' },
    ],
  },
  {
    name: 'Patterns',
    items: [
      { tool: 'xabcd', label: 'XABCD Pattern', family: 'poly', pts: 5, variant: 'XABCD' },
      { tool: 'cypher', label: 'Cypher Pattern', family: 'poly', pts: 5, variant: 'XABCD' },
      { tool: 'headshoulders', label: 'Head and Shoulders', family: 'poly', pts: 7, variant: 'HS' },
      { tool: 'abcd', label: 'ABCD Pattern', family: 'poly', pts: 4, variant: 'ABCD' },
      { tool: 'trianglepattern', label: 'Triangle Pattern', family: 'poly', pts: 4, variant: 'closed' },
      { tool: 'threedrives', label: 'Three Drives Pattern', family: 'poly', pts: 7, variant: '3D' },
    ],
  },
  {
    name: 'Elliott Waves',
    items: [
      { tool: 'elliott12345', label: 'Elliott Impulse Wave (12345)', family: 'poly', pts: 6, variant: '12345' },
      { tool: 'elliottabc', label: 'Elliott Correction Wave (ABC)', family: 'poly', pts: 4, variant: 'ABC' },
      { tool: 'elliottabcde', label: 'Elliott Triangle Wave (ABCDE)', family: 'poly', pts: 6, variant: 'ABCDE' },
      { tool: 'elliottwxy', label: 'Elliott Double Combo (WXY)', family: 'poly', pts: 4, variant: 'WXY' },
      { tool: 'elliottwxyxz', label: 'Elliott Triple Combo (WXYXZ)', family: 'poly', pts: 6, variant: 'WXYXZ' },
    ],
  },
  {
    name: 'Cycles',
    items: [
      { tool: 'cyclic', label: 'Cyclic Lines', family: 'fibtime', pts: 2, variant: 'cycle' },
      { tool: 'timecycles', label: 'Time Cycles', family: 'arcs', pts: 2, variant: 'time' },
      { tool: 'sine', label: 'Sine Line', family: 'sine', pts: 2 },
    ],
  },
  {
    name: 'Projection',
    items: [
      { tool: 'longpos', label: 'Long Position', family: 'position', pts: 2, variant: 'long' },
      { tool: 'shortpos', label: 'Short Position', family: 'position', pts: 2, variant: 'short' },
      { tool: 'forecast', label: 'Forecast', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'barspattern', label: 'Bars Pattern', family: 'rect', pts: 2 },
      { tool: 'ghostfeed', label: 'Ghost Feed', family: 'rect', pts: 2 },
      { tool: 'projection', label: 'Projection', family: 'poly', pts: 3, variant: 'closed' },
    ],
  },
  {
    name: 'Volume-based',
    items: [
      { tool: 'anchoredvwap', label: 'Anchored VWAP', family: 'vwap', pts: 1 },
      { tool: 'fixedrangevp', label: 'Fixed Range Volume Profile', family: 'volprofile', pts: 2 },
    ],
  },
  {
    name: 'Measurer',
    items: [
      { tool: 'pricerange', label: 'Price Range', family: 'measure', pts: 2, variant: 'price' },
      { tool: 'daterange', label: 'Date Range', family: 'measure', pts: 2, variant: 'date' },
      { tool: 'datepricerange', label: 'Date and Price Range', family: 'measure', pts: 2, variant: 'both' },
    ],
  },
  {
    name: 'Brushes',
    items: [
      { tool: 'brush', label: 'Brush', family: 'brush', pts: 'free' },
      { tool: 'highlighter', label: 'Highlighter', family: 'brush', pts: 'free', variant: 'hl' },
    ],
  },
  {
    name: 'Arrows',
    items: [
      { tool: 'arrowmarker', label: 'Arrow Marker', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'arrow', label: 'Arrow', family: 'trend', pts: 2, variant: 'arrowR' },
      { tool: 'arrowup', label: 'Arrow Mark Up', family: 'marker', pts: 1, glyph: '⬆' },
      { tool: 'arrowdown', label: 'Arrow Mark Down', family: 'marker', pts: 1, glyph: '⬇' },
      { tool: 'arrowleft', label: 'Arrow Mark Left', family: 'marker', pts: 1, glyph: '⬅' },
      { tool: 'arrowright', label: 'Arrow Mark Right', family: 'marker', pts: 1, glyph: '➡' },
    ],
  },
  {
    name: 'Shapes',
    items: [
      { tool: 'rect', label: 'Rectangle', family: 'rect', pts: 2, hotkey: 'Alt+Shift+R' },
      { tool: 'rotrect', label: 'Rotated Rectangle', family: 'rotrect', pts: 3 },
      { tool: 'path', label: 'Path', family: 'poly', pts: 'free', variant: 'arrow' },
      { tool: 'circle', label: 'Circle', family: 'ellipse', pts: 2, variant: 'circle' },
      { tool: 'ellipse', label: 'Ellipse', family: 'ellipse', pts: 2 },
      { tool: 'polyline', label: 'Polyline', family: 'poly', pts: 'free' },
      { tool: 'triangle', label: 'Triangle', family: 'poly', pts: 3, variant: 'closed' },
    ],
  },
  {
    name: 'Text & Notes',
    items: [
      { tool: 'text', label: 'Text', family: 'text', pts: 1 },
      { tool: 'anchoredtext', label: 'Anchored Text', family: 'text', pts: 1 },
      { tool: 'note', label: 'Note', family: 'marker', pts: 1, variant: 'note', glyph: '🗒' },
      { tool: 'pricenote', label: 'Price Note', family: 'marker', pts: 1, variant: 'note', glyph: '💲' },
      { tool: 'pin', label: 'Pin', family: 'marker', pts: 1, glyph: '📍' },
      { tool: 'table', label: 'Table', family: 'marker', pts: 1, variant: 'note', glyph: '▦' },
      { tool: 'callout', label: 'Callout', family: 'marker', pts: 1, variant: 'callout', glyph: '💬' },
      { tool: 'comment', label: 'Comment', family: 'marker', pts: 1, variant: 'callout', glyph: '💭' },
      { tool: 'pricelabel', label: 'Price Label', family: 'marker', pts: 1, variant: 'note', glyph: '🏷' },
      { tool: 'signpost', label: 'Signpost', family: 'marker', pts: 1, glyph: '⛳' },
      { tool: 'flagmark', label: 'Flag Mark', family: 'marker', pts: 1, glyph: '🚩' },
    ],
  },
];

// Cursor variants + eraser (first rail button flyout).
export const CURSORS = [
  { tool: 'crosshair', label: 'Cross', cursor: 'crosshair' },
  { tool: 'dot', label: 'Dot', cursor: 'default' },
  { tool: 'arrowcur', label: 'Arrow', cursor: 'default' },
  { tool: 'eraser', label: 'Eraser', cursor: 'pointer' },
];

// Left-rail buttons → which groups their flyout shows. `repIcon` is the family
// used to pick the rail glyph (and the rail remembers the last tool per button).
export const RAIL = [
  { id: 'cursor', repIcon: 'cursor', cursors: true },
  { id: 'lines', repIcon: 'trend', groups: ['Lines', 'Channels', 'Pitchforks'] },
  { id: 'fib', repIcon: 'fib', groups: ['Fibonacci', 'Gann'] },
  { id: 'patterns', repIcon: 'pattern', groups: ['Patterns', 'Elliott Waves', 'Cycles'] },
  { id: 'projection', repIcon: 'position', groups: ['Projection', 'Volume-based', 'Measurer'] },
  { id: 'brush', repIcon: 'brush', groups: ['Brushes', 'Arrows', 'Shapes'] },
  { id: 'text', repIcon: 'text', groups: ['Text & Notes'] },
  { id: 'emoji', repIcon: 'emoji', emoji: true },
];

// Flat tool → metadata map (built from GROUPS).
export const TOOL_META = (() => {
  const m = {};
  for (const g of GROUPS) for (const it of g.items) m[it.tool] = { ...it, group: g.name };
  // emoji is special-cased (own picker)
  m.emoji = { tool: 'emoji', label: 'Emoji', family: 'emoji', pts: 1, group: 'Emoji' };
  return m;
})();

export const toolMeta = (tool) => TOOL_META[tool] || null;
export const pointsFor = (tool) => (TOOL_META[tool] ? TOOL_META[tool].pts : 0);
export const familyOf = (tool) => (TOOL_META[tool] ? TOOL_META[tool].family : null);
export const toolLabel = (tool) => (TOOL_META[tool] ? TOOL_META[tool].label : tool);
export const TEXT_TOOLS = new Set(['text', 'anchoredtext', 'note', 'pricenote', 'callout', 'comment', 'pricelabel', 'signpost', 'flagmark', 'table']);

// Families that support each style field (used by the property panel).
export const HAS_WIDTH = new Set(['trend', 'hline', 'hray', 'vline', 'cross', 'rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'regression', 'fib', 'fibchannel', 'fibtime', 'fan', 'circles', 'spiral', 'arcs', 'pitchfork', 'poly', 'sine', 'vwap', 'measure', 'position', 'brush', 'volprofile']);
export const HAS_STYLE = new Set(['trend', 'hline', 'hray', 'vline', 'cross', 'rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'regression', 'poly', 'sine', 'brush']);
export const HAS_FILL = new Set(['rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'poly', 'position', 'fib', 'fibchannel', 'volprofile']);
