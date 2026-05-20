import { useState } from 'react';

/**
 * Premium Order Modal — UI ONLY.
 *
 * Pure presentational component. No API calls, no state-bound math,
 * no order submission. All interactivity is local UI state only so
 * users can preview hover / active / animated transitions.
 *
 * Usage:
 *   <OrderModalUI open={true} onClose={() => ...} />
 *
 * Design tokens — luxury fintech / Apple-Wallet-style:
 *   - rounded-3xl corners everywhere
 *   - soft drop-shadow + faint coloured glow on the active path
 *   - backdrop-blur glassmorphism on the modal container
 *   - subtle candlestick pattern under the hero block
 *   - tailwind transitions in place of framer-motion (not installed)
 */
export default function OrderModalUI({ open = true, onClose = () => {} }) {
  const [side, setSide] = useState('BUY');            // 'BUY' | 'SELL'
  const [orderType, setOrderType] = useState('MARKET'); // 'MARKET' | 'LIMIT'
  const [price, setPrice] = useState('82450.00');
  const [qty, setQty] = useState('0.0050');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [leverage, setLeverage] = useState(10);

  if (!open) return null;

  // Side-aware accents — all gradient/shadow tokens come from here so the
  // entire panel re-tints in one place when the user flips BUY ↔ SELL.
  const isBuy = side === 'BUY';
  const accent = isBuy
    ? {
        from: '#10B981', to: '#059669', soft: 'rgba(16,185,129,0.14)',
        glow: 'rgba(16,185,129,0.35)', ring: '#10B98133',
        label: 'BUY', verb: 'Buy', icon: '↑',
      }
    : {
        from: '#F43F5E', to: '#E11D48', soft: 'rgba(244,63,94,0.14)',
        glow: 'rgba(244,63,94,0.35)', ring: '#F43F5E33',
        label: 'SELL', verb: 'Sell', icon: '↓',
      };

  const percentChips = [25, 50, 75, 100];
  const leverageMarks = [1, 5, 10, 25, 50, 100];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-900/40 backdrop-blur-md animate-fadeIn">
      {/* Modal container — glass card */}
      <div
        className="relative w-full max-w-[480px] max-h-[95vh] overflow-hidden flex flex-col rounded-[28px] bg-white/95 backdrop-blur-2xl border border-white shadow-[0_30px_60px_-15px_rgba(15,23,42,0.25),0_0_0_1px_rgba(255,255,255,0.6)_inset]"
        style={{ animation: 'orderModalIn 280ms cubic-bezier(.16,1,.3,1) both' }}
      >
        {/* Soft side-coloured glow following the active intent */}
        <span
          className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full transition-all duration-500"
          style={{ background: `radial-gradient(circle, ${accent.glow}, transparent 70%)` }}
        />
        <span
          className="pointer-events-none absolute -bottom-32 -left-24 w-80 h-80 rounded-full transition-all duration-500"
          style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.18), transparent 70%)' }}
        />

        {/* Tiny candlestick pattern in the hero strip */}
        <CandlestickBackdrop />

        {/* ─── Header ─────────────────────────────────────────────── */}
        <div className="relative flex items-start justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-3.5 min-w-0">
            {/* Pair stack — BTC over USD */}
            <div className="relative shrink-0">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-black text-lg shadow-lg shadow-orange-500/30">
                ₿
              </div>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white border-2 border-slate-50 flex items-center justify-center text-[9px] font-extrabold text-slate-700 shadow-sm">
                $
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[17px] font-bold text-slate-900 tracking-tight">BTC / USD</span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[9px] font-bold uppercase tracking-wider">
                  <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                  Live
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                <span>Bitcoin · Spot</span>
                <span className="text-slate-300">·</span>
                <span className="font-mono font-semibold text-emerald-600">+1.24%</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-9 h-9 rounded-full bg-slate-100/70 hover:bg-slate-200/80 flex items-center justify-center text-slate-500 hover:text-slate-900 transition-all hover:rotate-90 duration-300"
          >
            <Icon><path d="M18 6L6 18" /><path d="M6 6l12 12" /></Icon>
          </button>
        </div>

        {/* ─── Body (scrollable) ──────────────────────────────────── */}
        <div className="relative px-5 pb-4 overflow-y-auto flex-1 space-y-4">

          {/* ── BUY / SELL segmented cards ──────────────────────── */}
          <div className="grid grid-cols-2 gap-2.5">
            {['BUY', 'SELL'].map((s) => {
              const active = side === s;
              const buy = s === 'BUY';
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`relative overflow-hidden rounded-2xl p-4 text-left transition-all duration-300 ${
                    active ? 'scale-[1.01] shadow-lg' : 'opacity-70 hover:opacity-95 hover:scale-[1.005]'
                  }`}
                  style={
                    active
                      ? {
                          background: buy
                            ? 'linear-gradient(135deg, #ECFDF5 0%, #FFFFFF 60%)'
                            : 'linear-gradient(135deg, #FFF1F2 0%, #FFFFFF 60%)',
                          border: `1.5px solid ${buy ? '#10B981' : '#F43F5E'}`,
                          boxShadow: `0 12px 32px -10px ${buy ? 'rgba(16,185,129,0.35)' : 'rgba(244,63,94,0.30)'}`,
                        }
                      : {
                          background: '#FFFFFF',
                          border: '1.5px solid #E2E8F0',
                        }
                  }
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black text-lg shadow-sm transition-transform group-hover:scale-110"
                      style={{ background: buy ? 'linear-gradient(135deg, #10B981, #059669)' : 'linear-gradient(135deg, #F43F5E, #E11D48)' }}
                    >
                      {buy ? '↑' : '↓'}
                    </span>
                    {active && (
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center shadow-sm"
                        style={{ background: buy ? '#10B981' : '#F43F5E' }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                      </span>
                    )}
                  </div>
                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">{buy ? 'Long' : 'Short'}</div>
                    <div className="text-[15px] font-bold text-slate-900 mt-0.5">{s}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Order type tabs ──────────────────────────────────── */}
          <div className="relative grid grid-cols-2 gap-1 p-1 rounded-2xl bg-slate-100/80 backdrop-blur">
            {/* Sliding active pill */}
            <span
              className="absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-xl bg-white shadow-md transition-all duration-300 ease-out"
              style={{ left: orderType === 'MARKET' ? '4px' : 'calc(50% + 0px)' }}
            />
            {['MARKET', 'LIMIT'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOrderType(t)}
                className={`relative py-2 rounded-xl text-[13px] font-bold transition-colors ${
                  orderType === t ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {t === 'MARKET' ? 'Market' : 'Limit'}
              </button>
            ))}
          </div>

          {/* ── Price input card ─────────────────────────────────── */}
          <div className="relative rounded-2xl bg-white border border-slate-200/80 px-4 pt-3 pb-4 shadow-sm">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">
                Price (USD)
              </label>
              {orderType === 'MARKET' && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Market</span>
              )}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-slate-400 font-bold text-lg">$</span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={orderType === 'MARKET'}
                inputMode="decimal"
                className="flex-1 min-w-0 text-2xl font-bold tabular-nums text-slate-900 bg-transparent focus:outline-none disabled:text-slate-400 placeholder:text-slate-300"
              />
            </div>
            {/* Ask / Bid mini-display */}
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">Bid</span>
                <span className="font-mono font-bold text-rose-600">82,448.50</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-slate-400">spread $1.50</span>
                <span className="w-1 h-1 rounded-full bg-slate-300" />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-bold text-emerald-600">82,450.00</span>
                <span className="text-slate-500">Ask</span>
              </div>
            </div>
          </div>

          {/* ── Quantity section ────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">Quantity</label>
              <span className="text-[10px] text-slate-400 font-mono">
                ≈ <span className="font-bold text-slate-700">${(Number(price) * Number(qty) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </span>
            </div>
            {/* Quick percent chips */}
            <div className="grid grid-cols-4 gap-1.5 mb-2.5">
              {percentChips.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setQty(((Number(price) * 0.005 * p) / 100).toFixed(4) || '0.0000')}
                  className="py-1.5 rounded-xl text-[12px] font-bold text-slate-600 bg-white/80 backdrop-blur border border-slate-200 hover:border-blue-500/50 hover:bg-blue-500/5 hover:text-blue-600 hover:scale-[1.03] active:scale-95 transition-all"
                >
                  {p === 100 ? 'MAX' : `${p}%`}
                </button>
              ))}
            </div>
            {/* Big numeric input */}
            <div className="relative rounded-2xl bg-white border border-slate-200/80 shadow-sm px-4 py-3 flex items-baseline gap-2">
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="decimal"
                className="flex-1 min-w-0 text-xl font-bold tabular-nums text-slate-900 bg-transparent focus:outline-none placeholder:text-slate-300"
              />
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold">
                <span className="w-4 h-4 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-[8px] font-black">₿</span>
                BTC
              </span>
            </div>
          </div>

          {/* ── Risk management — SL / TP ────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">Risk Management</label>
              <span className="text-[10px] text-slate-400 font-semibold">Optional</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {/* Stop Loss */}
              <div className="relative rounded-2xl bg-gradient-to-br from-rose-50/80 to-white border border-rose-100 px-3.5 py-3 hover:border-rose-200 transition-colors group">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-rose-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  Stop Loss
                </div>
                <div className="mt-1.5 flex items-baseline gap-1">
                  <span className="text-slate-400 text-xs font-bold">$</span>
                  <input
                    value={stopLoss}
                    onChange={(e) => setStopLoss(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="flex-1 min-w-0 text-base font-bold tabular-nums text-slate-900 bg-transparent focus:outline-none placeholder:text-slate-300"
                  />
                </div>
              </div>
              {/* Take Profit */}
              <div className="relative rounded-2xl bg-gradient-to-br from-emerald-50/80 to-white border border-emerald-100 px-3.5 py-3 hover:border-emerald-200 transition-colors group">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-emerald-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Take Profit
                </div>
                <div className="mt-1.5 flex items-baseline gap-1">
                  <span className="text-slate-400 text-xs font-bold">$</span>
                  <input
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="flex-1 min-w-0 text-base font-bold tabular-nums text-slate-900 bg-transparent focus:outline-none placeholder:text-slate-300"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── Leverage slider ─────────────────────────────────── */}
          <div className="rounded-2xl bg-gradient-to-br from-blue-50/60 via-white to-white border border-blue-100/80 px-4 py-4 shadow-sm">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">Leverage</label>
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold text-white shadow-md transition-all"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', boxShadow: '0 6px 16px -4px rgba(59,130,246,0.45)' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" /></svg>
                {leverage}×
              </span>
            </div>
            {/* Custom slider — gradient track + glowing thumb */}
            <div className="mt-4 relative">
              <input
                type="range"
                min="1"
                max="100"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="orderslider w-full"
                style={{ background: `linear-gradient(90deg, #3B82F6 0%, #6366F1 ${leverage}%, #E2E8F0 ${leverage}%, #E2E8F0 100%)` }}
              />
            </div>
            {/* Mark scale */}
            <div className="mt-2 flex justify-between text-[9px] font-bold text-slate-400 px-1">
              {leverageMarks.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLeverage(m)}
                  className={`transition-colors hover:text-blue-600 ${leverage === m ? 'text-blue-600' : ''}`}
                >
                  {m}×
                </button>
              ))}
            </div>
          </div>

          {/* ── Trade summary card ──────────────────────────────── */}
          <div className="rounded-2xl bg-slate-50/70 backdrop-blur border border-slate-200/60 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">Trade Summary</span>
              <span className="text-[9px] text-slate-400">Real-time estimate</span>
            </div>
            <SummaryRow
              icon={<Icon><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Icon>}
              label="Margin Required"
              value="$41.22"
              tint="blue"
            />
            <SummaryRow
              icon={<Icon><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" /></Icon>}
              label="Estimated Fees"
              value="$0.10"
              tint="slate"
            />
            <SummaryRow
              icon={<Icon><polyline points="22 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></Icon>}
              label="Pip Value"
              value="$0.50"
              tint="emerald"
            />
            <SummaryRow
              icon={<Icon><path d="M12 2L2 7v10l10 5 10-5V7L12 2z" /><path d="M2 7l10 5 10-5" /><path d="M12 22V12" /></Icon>}
              label="Liquidation Price"
              value="$74,205.30"
              tint="rose"
              danger
            />
          </div>
        </div>

        {/* ─── Bottom CTA ─────────────────────────────────────── */}
        <div className="relative p-4 pt-3 border-t border-slate-100/80 bg-white/70 backdrop-blur-xl">
          <button
            type="button"
            className="group relative w-full h-14 rounded-2xl text-white font-bold text-[15px] tracking-tight overflow-hidden transition-all duration-300 hover:scale-[1.01] active:scale-[0.99]"
            style={{
              background: `linear-gradient(135deg, ${accent.from} 0%, ${accent.to} 100%)`,
              boxShadow: `0 18px 36px -10px ${accent.glow}, 0 0 0 1px rgba(255,255,255,0.10) inset`,
            }}
          >
            {/* Shimmer */}
            <span className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)' }} />
            <span className="relative flex items-center justify-center gap-2.5">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/20 text-base font-black">{accent.icon}</span>
              <span>Place {accent.label} Order</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-hover:translate-x-1">
                <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
              </svg>
            </span>
          </button>
          {/* Sub-text */}
          <div className="mt-2.5 flex items-center justify-center gap-1.5 text-[10px] text-slate-400">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            Bank-grade encryption · Funds protected
          </div>
        </div>
      </div>

      {/* Local styles for the entry animation + custom slider thumb */}
      <style>{`
        @keyframes orderModalIn {
          0%   { opacity: 0; transform: translateY(20px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes fadeIn {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        .animate-fadeIn { animation: fadeIn 220ms ease-out both; }

        input.orderslider {
          -webkit-appearance: none;
          appearance: none;
          height: 8px;
          border-radius: 9999px;
          outline: none;
          cursor: pointer;
        }
        input.orderslider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: #ffffff;
          border: 2.5px solid #3B82F6;
          box-shadow: 0 6px 14px -3px rgba(59,130,246,0.55), 0 0 0 4px rgba(59,130,246,0.08);
          cursor: grab;
          transition: transform 0.15s ease;
        }
        input.orderslider::-webkit-slider-thumb:active {
          transform: scale(1.08);
          cursor: grabbing;
        }
        input.orderslider::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: #ffffff;
          border: 2.5px solid #3B82F6;
          box-shadow: 0 6px 14px -3px rgba(59,130,246,0.55), 0 0 0 4px rgba(59,130,246,0.08);
          cursor: grab;
        }
      `}</style>
    </div>
  );
}

// ─── Tiny presentational helpers ─────────────────────────────────────

function SummaryRow({ icon, label, value, tint = 'slate', danger = false }) {
  const palettes = {
    blue:    { bg: 'bg-blue-50',    fg: 'text-blue-600' },
    emerald: { bg: 'bg-emerald-50', fg: 'text-emerald-600' },
    rose:    { bg: 'bg-rose-50',    fg: 'text-rose-600' },
    slate:   { bg: 'bg-slate-100',  fg: 'text-slate-600' },
  };
  const p = palettes[tint] || palettes.slate;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${p.bg} ${p.fg}`}>
          {icon}
        </span>
        <span className="text-[12px] font-semibold text-slate-700">{label}</span>
      </div>
      <span className={`text-[13px] font-bold font-mono tabular-nums ${danger ? 'text-rose-600' : 'text-slate-900'}`}>
        {value}
      </span>
    </div>
  );
}

function Icon({ children, w = 14 }) {
  return (
    <svg width={w} height={w} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

// Subtle decorative candlestick pattern that sits behind the hero strip
function CandlestickBackdrop() {
  return (
    <svg
      className="absolute top-0 left-0 right-0 pointer-events-none opacity-[0.05] mix-blend-multiply"
      width="100%" height="120" viewBox="0 0 480 120" preserveAspectRatio="none"
    >
      <g stroke="#0F172A" strokeWidth="1.5" strokeLinecap="round">
        {/* Wicks */}
        <line x1="40"  y1="20" x2="40"  y2="100" />
        <line x1="80"  y1="35" x2="80"  y2="95" />
        <line x1="120" y1="15" x2="120" y2="90" />
        <line x1="160" y1="25" x2="160" y2="105" />
        <line x1="200" y1="10" x2="200" y2="85" />
        <line x1="240" y1="30" x2="240" y2="100" />
        <line x1="280" y1="20" x2="280" y2="80" />
        <line x1="320" y1="40" x2="320" y2="95" />
        <line x1="360" y1="15" x2="360" y2="70" />
        <line x1="400" y1="25" x2="400" y2="90" />
        <line x1="440" y1="10" x2="440" y2="65" />
      </g>
      <g fill="#10B981">
        <rect x="34"  y="45" width="12" height="40" rx="2" />
        <rect x="114" y="35" width="12" height="40" rx="2" />
        <rect x="194" y="30" width="12" height="35" rx="2" />
        <rect x="274" y="35" width="12" height="30" rx="2" />
        <rect x="354" y="25" width="12" height="35" rx="2" />
        <rect x="434" y="20" width="12" height="35" rx="2" />
      </g>
      <g fill="#F43F5E">
        <rect x="74"  y="50" width="12" height="35" rx="2" />
        <rect x="154" y="45" width="12" height="45" rx="2" />
        <rect x="234" y="50" width="12" height="40" rx="2" />
        <rect x="314" y="55" width="12" height="30" rx="2" />
        <rect x="394" y="45" width="12" height="35" rx="2" />
      </g>
    </svg>
  );
}
