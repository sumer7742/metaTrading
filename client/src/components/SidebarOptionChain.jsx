import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

/**
 * SidebarOptionChain — compact, Groww-style option chain for the Trade panel.
 * Call LTP · Strike · Put LTP, ATM row highlighted, ITM cells tinted, a spot-
 * price divider through the middle, and tap-a-premium → open that contract.
 * Fetches from /instruments/option-chain (same data the /options page uses).
 */
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

export default function SidebarOptionChain({ defaultUnderlying = 'NIFTY', onPick }) {
  const initial = UNDERLYINGS.includes(String(defaultUnderlying || '').toUpperCase())
    ? String(defaultUnderlying).toUpperCase()
    : 'NIFTY';
  const [underlying, setUnderlying] = useState(initial);
  const [expiry, setExpiry] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const atmRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    const q = new URLSearchParams({ underlying });
    if (expiry) q.set('expiry', expiry);
    api.get(`/instruments/option-chain?${q.toString()}`)
      .then((res) => { if (!cancelled) setData(res.data?.data ?? res.data); })
      .catch((e) => { if (!cancelled) { setErr(e?.response?.data?.message || 'No option chain available'); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [underlying, expiry]);

  // Reset the expiry choice whenever the underlying changes.
  useEffect(() => { setExpiry(''); }, [underlying]);

  const spot = data?.spot != null ? Number(data.spot) : null;
  const rows = data?.rows || [];
  const atm = data?.atm != null ? String(data.atm) : null;
  const expiries = data?.expiries || [];

  // Centre the ATM strike once the rows render.
  useEffect(() => {
    if (atmRef.current) { try { atmRef.current.scrollIntoView({ block: 'center' }); } catch (_) {} }
  }, [rows, atm]);

  const fmtExp = (iso) => { try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch (_) { return iso; } };

  const cell = (leg, side) => {
    if (!leg || !leg.valid || leg.ltp == null) return <span className="text-text-muted">--</span>;
    return (
      <button
        type="button"
        onClick={() => onPick?.(leg.symbol)}
        title={leg.stale ? `stale (${leg.ageSec}s ago)` : 'Tap to trade'}
        className={`font-mono font-semibold text-[13px] text-text-primary hover:text-primary-600 ${leg.stale ? 'opacity-50' : ''}`}
      >
        ₹{fmtNum(leg.ltp, 2)}
      </button>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Underlying + expiry selectors */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0">
        <select
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value)}
          className="text-sm font-extrabold bg-transparent text-text-primary focus:outline-none cursor-pointer"
        >
          {UNDERLYINGS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        {expiries.length > 0 && (
          <select
            value={expiry || data?.expiry || ''}
            onChange={(e) => setExpiry(e.target.value)}
            className="ml-auto text-xs bg-bg-hover rounded-md px-2 py-1 text-text-primary border border-border-dark focus:outline-none cursor-pointer"
          >
            {expiries.map((e) => <option key={e} value={e}>{fmtExp(e)}</option>)}
          </select>
        )}
      </div>

      {/* Column header */}
      <div className="grid grid-cols-3 px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-text-muted border-b border-border-subtle shrink-0">
        <div className="text-left">Call LTP</div>
        <div className="text-center">Strike</div>
        <div className="text-right">Put LTP</div>
      </div>

      {/* Rows */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && <div className="py-8 text-center text-xs text-text-muted">Loading…</div>}
        {err && !loading && <div className="py-8 text-center text-xs text-text-muted px-3">{err}</div>}
        {!loading && !err && rows.length === 0 && (
          <div className="py-8 text-center text-xs text-text-muted px-3">No option chain for {underlying}.</div>
        )}
        {!loading && !err && rows.map((r, i) => {
          const isAtm = String(r.strike) === atm;
          const ceItm = spot != null && Number(r.strike) < spot;
          const peItm = spot != null && Number(r.strike) > spot;
          // Spot-price divider: drawn where the strikes cross the live spot.
          const showSpotLine = spot != null && i > 0 && Number(rows[i - 1].strike) < spot && Number(r.strike) >= spot;
          return (
            <div key={r.strike} ref={isAtm ? atmRef : null}>
              {showSpotLine && (
                <div className="relative flex items-center justify-center py-1">
                  <div className="absolute inset-x-2 h-px bg-primary-500/40" />
                  <span className="relative text-[10px] font-bold font-mono bg-bg-card px-2 text-primary-600 rounded">
                    {fmtNum(spot, 2)}
                  </span>
                </div>
              )}
              <div className={`grid grid-cols-3 items-center px-3 py-1.5 border-b border-border-subtle/50 ${isAtm ? 'bg-primary-500/[0.07]' : 'hover:bg-bg-hover'}`}>
                <div className={`text-left rounded px-1 ${ceItm ? 'bg-bull/[0.08]' : ''}`}>{cell(r.ce, 'ce')}</div>
                <div className={`text-center font-mono font-bold text-[13px] ${isAtm ? 'text-primary-600' : 'text-text-secondary'}`}>{fmtNum(r.strike, 0)}</div>
                <div className={`text-right rounded px-1 ${peItm ? 'bg-bear/[0.08]' : ''}`}>{cell(r.pe, 'pe')}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
