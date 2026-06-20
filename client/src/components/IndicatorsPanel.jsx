import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CATEGORIES, MA_TYPES, INDICATORS,
  parseMaKey, labelForActive, categoryForKey,
} from './indicatorCatalog';
import IndicatorSettingsModal from './IndicatorSettingsModal';

/**
 * IndicatorsPanel — TradingView / Groww-style indicator picker.
 *  • Search box.
 *  • "Active indicators" section (edit/remove what's on the chart).
 *  • Collapsible category groups (Trend / Momentum / Volatility / Volume /
 *    Oscillators) with one clickable row per indicator.
 *  • Clicking a row opens a settings modal (period/length, colour, width, style);
 *    Apply updates the model instantly → chart updates live.
 *
 * Model (backward compatible): indicators[key] = true | { color, lineWidth,
 * lineStyle, length }. MA period lives in the key (`ema21`).
 *
 * props: { indicators, onChange(next), theme, onClose, anchorEl }
 */
export default function IndicatorsPanel({ indicators, onChange, theme, onClose, anchorEl }) {
  const dark = theme === 'dark';
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [modal, setModal] = useState(null); // { target, cfg, isActive, key }

  // Anchor the popover to the trigger button via FIXED positioning + a body
  // portal, so it escapes the chart area's overflow-hidden (which was clipping
  // the bottom of the list). Height is capped to the space below the button.
  const PANEL_W = 340;
  const [pos, setPos] = useState({ top: 64, left: 16, maxH: '70vh' });
  useEffect(() => {
    if (!anchorEl) return undefined;
    const update = () => {
      const r = anchorEl.getBoundingClientRect();
      const gap = 12;
      const top = r.bottom + 4;
      const left = Math.max(gap, Math.min(r.left, window.innerWidth - PANEL_W - gap));
      const maxH = Math.max(220, window.innerHeight - top - gap);
      setPos({ top, left, maxH });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchorEl]);

  const c = dark
    ? { bg: '#0F172A', border: '#334155', text: '#F1F5F9', muted: '#94A3B8', input: '#1E293B', hover: '#1E293B', sub: '#0B1220' }
    : { bg: '#FFFFFF', border: '#E2E8F0', text: '#0F172A', muted: '#64748B', input: '#FFFFFF', hover: '#F1F5F9', sub: '#F8FAFC' };

  const cfgOf = (key) => (typeof indicators[key] === 'object' && indicators[key] ? indicators[key] : {});
  const activeKeys = useMemo(
    () => Object.keys(indicators).filter((k) => indicators[k]).sort((a, b) => labelForActive(a, cfgOf(a)).localeCompare(labelForActive(b, cfgOf(b)))),
    [indicators],
  );

  // Build category → rows (MA types live under Trend; others under their cat).
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return CATEGORIES.map((cat) => {
      const rows = [];
      if (cat === 'Trend') MA_TYPES.forEach((ma) => rows.push({ kind: 'ma', ma, name: ma.name, color: ma.color }));
      INDICATORS.filter((i) => i.cat === cat).forEach((ind) => rows.push({ kind: 'ind', ind, name: ind.name, color: ind.color }));
      const filtered = query ? rows.filter((r) => r.name.toLowerCase().includes(query)) : rows;
      return { cat, rows: filtered };
    }).filter((g) => g.rows.length);
  }, [q]);

  const activeCountForMa = (code) => activeKeys.filter((k) => parseMaKey(k)?.code === code).length;

  const openRow = (row) => {
    if (row.kind === 'ma') {
      setModal({ target: { type: 'ma', ma: row.ma }, cfg: {}, isActive: false, key: null });
    } else {
      const key = row.ind.key;
      const active = !!indicators[key];
      setModal({ target: { type: 'ind', ind: row.ind }, cfg: cfgOf(key), isActive: active, key: active ? key : null });
    }
  };

  const openActive = (key) => {
    const ma = parseMaKey(key);
    if (ma) setModal({ target: { type: 'ma', ma: ma.def }, cfg: { ...cfgOf(key), period: ma.period }, isActive: true, key });
    else {
      const ind = INDICATORS.find((i) => i.key === key);
      if (ind) setModal({ target: { type: 'ind', ind }, cfg: cfgOf(key), isActive: true, key });
    }
  };

  const applyModal = (params) => {
    const next = { ...indicators };
    if (modal.target.type === 'ma') {
      const key = `${modal.target.ma.code}${params.period}`;
      if (modal.key && modal.key !== key) delete next[modal.key];      // period changed → move
      next[key] = { color: params.color, lineWidth: params.lineWidth, lineStyle: params.lineStyle };
    } else {
      const key = modal.target.ind.key;
      next[key] = {
        color: params.color, lineWidth: params.lineWidth, lineStyle: params.lineStyle,
        ...(params.length != null ? { length: params.length } : {}),
      };
    }
    onChange(next);
    setModal(null);
  };

  const removeKey = (key) => {
    const next = { ...indicators };
    delete next[key];
    onChange(next);
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div
        className="fixed z-[56] max-w-[94vw] rounded-xl shadow-elevated overflow-hidden flex flex-col"
        style={{ top: pos.top, left: pos.left, width: PANEL_W, maxHeight: pos.maxH, background: c.bg, border: `1px solid ${c.border}`, color: c.text }}
      >
        {/* Search */}
        <div className="p-2.5" style={{ borderBottom: `1px solid ${c.border}` }}>
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.muted} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search indicators…"
              className="w-full pl-8 pr-2 py-2 text-sm rounded-lg focus:outline-none"
              style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Active indicators */}
          {activeKeys.length > 0 && (
            <div style={{ borderBottom: `1px solid ${c.border}` }}>
              <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: c.muted }}>
                Active · {activeKeys.length}
              </div>
              {activeKeys.map((key) => (
                <div key={key} className="group flex items-center gap-2 px-3 py-1.5 text-sm" style={{ background: 'transparent' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cfgOf(key).color || dotColor(key) }} />
                  <button type="button" onClick={() => openActive(key)} className="flex-1 text-left truncate hover:underline" style={{ color: c.text }}>
                    {labelForActive(key, cfgOf(key))}
                  </button>
                  <button type="button" onClick={() => openActive(key)} title="Settings" className="opacity-60 hover:opacity-100" style={{ color: c.muted }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  </button>
                  <button type="button" onClick={() => removeKey(key)} title="Remove" className="opacity-60 hover:opacity-100" style={{ color: '#ef4444' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Categories */}
          {groups.map(({ cat, rows }) => {
            const isCollapsed = !q && collapsed[cat];
            return (
              <div key={cat} style={{ borderBottom: `1px solid ${c.border}` }}>
                <button
                  type="button"
                  onClick={() => setCollapsed((s) => ({ ...s, [cat]: !s[cat] }))}
                  className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: c.muted, background: c.sub }}
                >
                  <span>{cat}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {!isCollapsed && rows.map((row) => {
                  const maCount = row.kind === 'ma' ? activeCountForMa(row.ma.code) : 0;
                  const indActive = row.kind === 'ind' && !!indicators[row.ind.key];
                  const on = maCount > 0 || indActive;
                  return (
                    <button
                      key={row.kind === 'ma' ? row.ma.code : row.ind.key}
                      type="button"
                      onClick={() => openRow(row)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors"
                      style={{ color: c.text }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = c.hover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: row.color }} />
                      <span className="flex-1 truncate">{row.name}</span>
                      {on && (
                        <span className="text-[10px] font-bold px-1.5 py-px rounded-full text-white" style={{ background: '#1D4ED8' }}>
                          {row.kind === 'ma' ? maCount : '✓'}
                        </span>
                      )}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.muted} strokeWidth="2" strokeLinecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {groups.length === 0 && (
            <div className="px-4 py-6 text-center text-sm" style={{ color: c.muted }}>No indicators match “{q}”.</div>
          )}
        </div>
      </div>

      {modal && (
        <IndicatorSettingsModal
          target={modal.target}
          cfg={modal.cfg}
          isActive={modal.isActive}
          theme={theme}
          onApply={applyModal}
          onRemove={modal.key ? () => { removeKey(modal.key); setModal(null); } : null}
          onClose={() => setModal(null)}
        />
      )}
    </>,
    document.body,
  );
}

function dotColor(key) {
  const ma = parseMaKey(key);
  if (ma) return ma.def.color;
  return INDICATORS.find((i) => i.key === key)?.color || '#1D4ED8';
}
