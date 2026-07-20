import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ─── Position SL/TP / partial-close modal ──────────────────────────────
//
// Shared by the Trade page (open positions + pending-order pills) and the
// Explore dashboard (pending-order edit). Tabs:
//   • Modify        — edit Take Profit / Stop Loss with numeric ± steppers
//   • Partial close — close a fraction of the position by lots (positions only)
//   • Close by      — full close at market (positions only)
// For a pending order (kind='order') only the Modify tab shows and it edits
// SL/TP, submitting { takeProfit, stopLoss }.
//
// Pip math: pipSize = 10^-precision. So for BTC with precision=2 the pip
// is 0.01. The pip / USD / % readout below each price field shows the
// delta between the entered price and the reference (position entry, or the
// order's own trigger price), how MT5 / cTrader render this control.
export default function PositionSlTpModal({ position, kind = 'position', instrument, free = 0, onClose, onSubmit, onPartialClose }) {
  const isOrder = kind === 'order';
  const [tab, setTab] = useState('modify');
  const [tp, setTp] = useState(position.takeProfit ? String(position.takeProfit) : '');
  const [sl, setSl] = useState(position.stopLoss ? String(position.stopLoss) : '');
  const [partialQty, setPartialQty] = useState(String((Number(position.quantity) || 0) / 2));
  const [saving, setSaving] = useState(false);

  const precision = Math.max(0, Math.min(8, Number(instrument?.pricePrecision) || 2));
  const pipSize = Math.pow(10, -precision);
  // Positions carry entryPrice; a pending order anchors to its trigger price.
  const entry = Number(position.entryPrice) || Number(position.price) || Number(position.stopPrice) || 0;
  const lastPx = Number(instrument?.lastPrice) || 0;
  const qty = Number(position.quantity) || 0;
  const isBuy = position.side === 'BUY';

  const livePnl = (isBuy ? (lastPx - entry) : (entry - lastPx)) * qty;
  const livePnlClass = livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400';

  const delta = (priceStr) => {
    const p = Number(priceStr);
    if (!Number.isFinite(p) || !entry) return { pips: 0, usd: 0, pct: 0 };
    const raw = isBuy ? (p - entry) : (entry - p);
    return {
      pips: raw / pipSize,
      usd:  raw * qty,
      pct:  (raw / entry) * 100,
    };
  };
  const tpDelta = delta(tp);
  const slDelta = delta(sl);

  const fmt = (n, d = 2) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const stepFmt = (n) => Number(n).toFixed(precision);
  const stepPrice = (curr, dir) => {
    const base = Number(curr) || entry || lastPx || 0;
    return stepFmt(base + dir * pipSize);
  };

  const submitModify = async () => {
    setSaving(true);
    try {
      await onSubmit({
        takeProfit: tp.trim() === '' ? null : Number(tp),
        stopLoss:   sl.trim() === '' ? null : Number(sl),
      });
    } finally { setSaving(false); }
  };
  const submitPartialClose = async () => {
    setSaving(true);
    try { await onPartialClose(Number(partialQty)); }
    finally { setSaving(false); }
  };
  const submitFullClose = async () => {
    setSaving(true);
    try { await onPartialClose(qty); }
    finally { setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — symbol, side, qty, P&L, close × */}
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {instrument?.icon && <span className="text-lg">{instrument.icon}</span>}
                <span className="font-bold text-base text-text-primary">{position.symbol}</span>
                <span className="text-sm text-text-muted tabular-nums">{fmt(qty, 2)} lots</span>
              </div>
              <div className="mt-1 text-[13px] tabular-nums">
                <span className={isBuy ? 'text-primary-600 font-semibold' : 'text-bear font-semibold'}>
                  {isBuy ? 'Buy' : 'Sell'}
                </span>{' '}
                <span className="text-text-muted">at</span>{' '}
                <span className="text-text-primary font-mono">{stepFmt(entry)}</span>
              </div>
            </div>
            <div className="text-right">
              <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
              <div className={`mt-1 text-[13px] font-mono font-bold tabular-nums ${livePnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {livePnl >= 0 ? '+' : ''}{fmt(livePnl)} USD
              </div>
              <div className="text-[11px] text-text-muted font-mono">{stepFmt(lastPx)}</div>
            </div>
          </div>

          {/* Tab strip — for pending orders we only show "Modify" since
              partial-close / close-by are position-only operations. */}
          <div className={`mt-4 grid bg-bg-hover rounded-lg p-1 ${isOrder ? 'grid-cols-1' : 'grid-cols-3'}`}>
            {(isOrder
              ? [{ id: 'modify', label: 'Modify order' }]
              : [
                  { id: 'modify',  label: 'Modify' },
                  { id: 'partial', label: 'Partial close' },
                  { id: 'closeby', label: 'Close by' },
                ]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`text-[13px] font-semibold py-2 rounded-md transition-all ${
                  tab === t.id
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {tab === 'modify' && (
            <>
              <PriceField
                label="Take Profit"
                value={tp}
                placeholder="Not set"
                onChange={setTp}
                onClear={() => setTp('')}
                onStep={(dir) => setTp(stepPrice(tp || entry || lastPx, dir))}
                delta={tpDelta}
                deltaTone="bull"
                refPrice={entry || lastPx}
                qty={qty}
                pipSize={pipSize}
                free={free}
                side={position.side}
                isTp
              />
              <PriceField
                label="Stop Loss"
                value={sl}
                placeholder="Not set"
                onChange={setSl}
                onClear={() => setSl('')}
                onStep={(dir) => setSl(stepPrice(sl || entry || lastPx, dir))}
                delta={slDelta}
                deltaTone="bear"
                refPrice={entry || lastPx}
                qty={qty}
                pipSize={pipSize}
                free={free}
                side={position.side}
                isTp={false}
                menuUp
              />
              <button
                onClick={submitModify}
                disabled={saving}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : (isOrder ? 'Modify order' : 'Modify position')}
              </button>
            </>
          )}

          {tab === 'partial' && (
            <>
              <div>
                <label className="block text-[12px] font-semibold text-text-secondary mb-1.5">Quantity to close</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max={qty}
                    value={partialQty}
                    onChange={(e) => setPartialQty(e.target.value)}
                    className="flex-1 px-3 py-2.5 rounded-lg border border-border-dark bg-white text-base font-mono text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
                  />
                  <span className="text-xs text-text-muted whitespace-nowrap">/ {fmt(qty, 2)} lots</span>
                </div>
                <div className="flex gap-1.5 mt-2">
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPartialQty(String((qty * f).toFixed(2)))}
                      className="text-[11px] font-bold px-2.5 py-1 rounded border border-border-dark text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors"
                    >
                      {(f * 100).toFixed(0)}%
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={submitPartialClose}
                disabled={saving || !Number(partialQty)}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Closing…' : `Close ${fmt(Number(partialQty) || 0, 2)} lots`}
              </button>
            </>
          )}

          {tab === 'closeby' && (
            <>
              <div className="rounded-lg bg-bg-hover/50 border border-border-subtle px-3 py-2.5 text-[12px] text-text-secondary leading-snug">
                Close the entire <span className="font-bold text-text-primary">{fmt(qty, 2)} lot</span> {isBuy ? 'long' : 'short'} position at market. Realized P&L will settle to your trading wallet.
              </div>
              <button
                onClick={submitFullClose}
                disabled={saving}
                className="btn-primary w-full py-3 text-sm disabled:opacity-50"
              >
                {saving ? 'Closing…' : `Close ${fmt(qty, 2)} lots at market`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const PF_MODES = [
  { id: 'price',   label: 'By asset price', short: 'Price' },
  { id: 'pips',    label: 'In pips',        short: 'Pips' },
  { id: 'money',   label: 'In money',       short: 'USD' },
  { id: 'percent', label: 'In % of equity', short: '%' },
];
function PriceField({
  label, value, placeholder, onChange, onClear, onStep, delta, deltaTone,
  refPrice = 0, qty = 0, pipSize = 0.01, free = 0, isTp = false, side = 'BUY', menuUp = false,
}) {
  const has = value && String(value).trim() !== '';
  const [mode, setMode] = useState('price');
  const [menuOpen, setMenuOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [input, setInput] = useState(() => (value != null && value !== '' ? String(value) : ''));
  const btnRef = useRef(null);

  // TP profit moves price up for BUY / down for SELL; SL is the inverse.
  const dir = (side === 'BUY' ? 1 : -1) * (isTp ? 1 : -1);
  const trim = (n, dp) => { const r = Number(Number(n).toFixed(dp)); return Number.isFinite(r) ? String(r) : ''; };
  // A user-entered value in the current unit → an asset price (what we store).
  const toPrice = (raw) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) return '';
    if (mode === 'price') return v;
    if (!refPrice) return '';
    if (mode === 'pips')  return refPrice + dir * v * pipSize;
    if (mode === 'money') return qty > 0 ? refPrice + dir * (v / qty) : '';
    if (mode === 'percent') { if (!qty || !free) return ''; return refPrice + dir * ((v / 100) * free / qty); }
    return v;
  };
  // The stored price → the display value in the current unit.
  const fromPrice = (priceStr) => {
    const p = Number(priceStr);
    if (!Number.isFinite(p) || p === 0) return '';
    if (mode === 'price') return String(priceStr);
    if (!refPrice) return '';
    const diff = (p - refPrice) * dir;
    if (mode === 'pips')  return trim(diff / pipSize, 1);
    if (mode === 'money') return qty > 0 ? trim(diff * qty, 2) : '';
    if (mode === 'percent') { if (!qty || !free) return ''; return trim((diff * qty / free) * 100, 2); }
    return String(priceStr);
  };
  // Reflect the underlying price in the chosen unit whenever either changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setInput(fromPrice(value)); }, [value, mode, refPrice, qty, free]);

  const handleInput = (raw) => {
    setInput(raw);
    // Price mode: pass the raw string straight through so decimals type
    // naturally ("82450." mid-entry). Other units convert back to a price.
    if (mode === 'price') { onChange(raw); return; }
    const price = toPrice(raw);
    onChange(price === '' ? '' : String(price));
  };
  const openMenu = () => {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setMenuOpen((o) => !o);
  };
  const cur = PF_MODES.find((m) => m.id === mode) || PF_MODES[0];
  const MENU_W = 176;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[13px] font-semibold text-text-secondary">{label}</label>
        <span
          className="w-4 h-4 rounded-full border border-border-dark text-text-muted text-[10px] flex items-center justify-center"
          title="Enter this level by asset price, pips, money, or % of equity"
        >?</span>
      </div>
      <div className="flex items-center bg-white border border-border-dark rounded-lg overflow-hidden focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/15 transition-all">
        <input
          type="number"
          step="any"
          value={input}
          placeholder={placeholder}
          onChange={(e) => handleInput(e.target.value)}
          className="flex-1 min-w-0 bg-transparent px-3 py-2.5 text-base font-mono text-text-primary placeholder-text-muted focus:outline-none"
        />
        {has && (
          <button
            type="button"
            onClick={onClear}
            className="text-text-muted hover:text-text-primary px-2 transition-colors shrink-0"
            title="Clear"
          >×</button>
        )}
        <button
          ref={btnRef}
          type="button"
          onClick={openMenu}
          className="text-[11px] text-text-secondary hover:text-text-primary px-2 h-10 select-none flex items-center gap-0.5 border-l border-border-subtle whitespace-nowrap shrink-0"
        >
          {cur.short} <span className={`text-[10px] transition-transform ${menuOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>
        <button
          type="button"
          onClick={() => onStep(-1)}
          className="w-9 h-10 border-l border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-base font-bold shrink-0"
          title="−1 pip"
        >−</button>
        <button
          type="button"
          onClick={() => onStep(1)}
          className="w-9 h-10 border-l border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-base font-bold shrink-0"
          title="+1 pip"
        >+</button>
      </div>
      {menuOpen && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onMouseDown={() => setMenuOpen(false)} />
          <div
            className="fixed z-[91] bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden py-1"
            style={{
              width: MENU_W,
              left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
              ...(menuUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
            }}
          >
            {PF_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setMode(m.id); setMenuOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors ${m.id === mode ? 'bg-primary-500/10 text-primary-600 font-semibold' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
      {has && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] tabular-nums">
          <span className={deltaTone === 'bull' ? 'text-bull font-semibold' : 'text-bear font-semibold'}>
            {delta.pips >= 0 ? '+' : ''}{delta.pips.toFixed(1)} pips
          </span>
          <span className="text-text-muted">·</span>
          <span className="text-text-secondary">{delta.usd.toFixed(2)} USD</span>
          <span className="text-text-muted">·</span>
          <span className="text-text-secondary">{delta.pct.toFixed(2)} %</span>
        </div>
      )}
    </div>
  );
}
