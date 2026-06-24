import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

/**
 * Option chain — strikes × CE/PE for an underlying + expiry. Tapping a premium
 * opens that option in the trade view (/trade?symbol=…). Long-only for now
 * (buy CE/PE); writing is blocked server-side.
 */
export default function OptionChain() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [underlying, setUnderlying] = useState((params.get('underlying') || 'NIFTY').toUpperCase());
  const [input, setInput] = useState(underlying);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (u, exp) => {
    setLoading(true); setErr('');
    try {
      const q = new URLSearchParams({ underlying: u });
      if (exp) q.set('expiry', exp);
      const res = await api.get(`/instruments/option-chain?${q.toString()}`);
      setData(res.data?.data ?? res.data);
    } catch (e) {
      setErr(e?.response?.data?.message || 'Failed to load option chain');
      setData(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(underlying, ''); }, [underlying, load]);

  const spot = data?.spot != null ? Number(data.spot) : null;
  const rows = data?.rows || [];
  const atm = data?.atm != null ? String(data.atm) : null; // server-validated ATM (vs forward)

  const futures = data?.futures || [];
  const go = (sym) => sym && navigate(`/trade?symbol=${encodeURIComponent(sym)}`);

  // Greeks line: invalid IV → "N/A". Only for trustworthy legs.
  const gkLine = (leg) => {
    if (!leg || !leg.valid) return null;
    const iv = leg.iv != null ? `${(leg.iv * 100).toFixed(1)}%` : 'N/A';
    return (
      <div className="text-[9px] text-gray-400 mt-0.5 leading-tight">
        IV {iv} · δ {leg.delta != null ? leg.delta.toFixed(2) : '—'} · θ {leg.theta != null ? leg.theta.toFixed(1) : '—'}
      </div>
    );
  };

  // Premium cell: NEVER 0.00 — show "--" for missing/invalid; dim + "·" when stale.
  const premium = (leg, colorCls) => {
    if (!leg || !leg.valid || leg.ltp == null) {
      return <span className="text-gray-400" title={leg && leg.reason ? leg.reason : 'no data'}>--</span>;
    }
    return (
      <button
        onClick={() => go(leg.symbol)}
        className={`px-2 py-0.5 rounded ${colorCls} hover:underline font-medium ${leg.stale ? 'opacity-50' : ''}`}
        title={leg.stale ? `stale (${leg.ageSec}s ago)` : `time value ${leg.timeValue ?? '—'}`}
      >
        {fmtNum(leg.ltp, 2)}{leg.stale ? ' ·' : ''}
      </button>
    );
  };
  const fmtExp = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '');

  return (
    <div className="max-w-3xl mx-auto px-3 py-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-lg font-semibold mr-auto">F&amp;O — Futures &amp; Options</h1>
        <form
          onSubmit={(e) => { e.preventDefault(); setUnderlying(input.trim().toUpperCase()); }}
          className="flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Underlying (e.g. NIFTY)"
            className="px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-transparent text-sm w-44"
          />
          <button type="submit" className="px-3 py-1.5 rounded bg-primary-600 text-white text-sm font-medium">Load</button>
        </form>
      </div>

      {/* Data-integrity notices (forward/expiry mismatch). */}
      {data?.expiryBasisWarning && (
        <div className="mb-2 text-[11px] text-amber-600 bg-amber-50 dark:bg-amber-900/10 rounded px-2 py-1">
          ⚠ No same-expiry future — pricing uses a different-expiry forward (basis may be off).
        </div>
      )}

      {/* Meta: spot + expiry tabs + last updated */}
      <div className="flex flex-wrap items-center gap-3 mb-2 text-sm">
        {spot != null && (
          <span className="font-medium">{underlying} fwd: <span className="text-primary-600">₹{fmtNum(spot, 2)}</span></span>
        )}
        {data?.lastUpdated && (
          <span className="text-[11px] text-gray-400">updated {new Date(data.lastUpdated).toLocaleTimeString('en-IN')}</span>
        )}
        {data?.expiries?.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {data.expiries.map((e) => (
              <button
                key={e}
                onClick={() => load(underlying, e)}
                className={`px-2 py-1 rounded text-xs border ${e === data.expiry
                  ? 'bg-primary-600 text-white border-primary-600'
                  : 'border-gray-300 dark:border-gray-700'}`}
              >
                {fmtExp(e)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Futures on this underlying — F&O in one place. */}
      {!loading && !err && futures.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-semibold text-gray-500 mb-1">Futures</div>
          <div className="flex flex-wrap gap-2">
            {futures.map((f) => (
              <button
                key={f.symbol}
                onClick={() => go(f.symbol)}
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:border-primary-500 hover:shadow text-left transition-colors"
                title={`Trade ${f.symbol}`}
              >
                <div className="text-[11px] text-gray-500">{fmtExp(f.expiryDate)}{f.lotSize ? ` · lot ${f.lotSize}` : ''}</div>
                <div className="text-sm font-semibold">₹{fmtNum(f.lastPrice, 2)}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="py-10 text-center text-sm text-gray-500">Loading…</div>}
      {err && <div className="py-6 text-center text-sm text-red-500">{err}</div>}

      {!loading && !err && rows.length > 0 && (
        <div className="text-xs font-semibold text-gray-500 mb-1">Option chain</div>
      )}

      {!loading && !err && rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-800">
                <th className="py-2 px-3 text-right">CALL (CE) ₹</th>
                <th className="py-2 px-3 text-center">Strike</th>
                <th className="py-2 px-3 text-left">PUT (PE) ₹</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isAtm = String(r.strike) === String(atm);
                return (
                  <tr key={r.strike} className={`border-b border-gray-100 dark:border-gray-900 ${isAtm ? 'bg-amber-50 dark:bg-amber-900/10' : ''}`}>
                    {/* CALL — ITM when strike < spot (subtle tint) */}
                    <td className={`py-1.5 px-3 text-right ${spot != null && Number(r.strike) < spot ? 'bg-emerald-50/40 dark:bg-emerald-900/10' : ''}`}>
                      {premium(r.ce, 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400')}
                      {gkLine(r.ce)}
                    </td>
                    <td className={`py-1.5 px-3 text-center font-semibold ${isAtm ? 'text-amber-600' : ''}`}>{fmtNum(r.strike, 0)}</td>
                    {/* PUT — ITM when strike > spot */}
                    <td className={`py-1.5 px-3 text-left ${spot != null && Number(r.strike) > spot ? 'bg-rose-50/40 dark:bg-rose-900/10' : ''}`}>
                      {premium(r.pe, 'bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-400')}
                      {gkLine(r.pe)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !err && rows.length === 0 && (
        <div className="py-10 text-center text-sm text-gray-500">
          No option contracts for {underlying}. Seed some: <code>node scripts/seed-nfo-options.js</code>
        </div>
      )}

      <p className="mt-3 text-[11px] text-gray-500">
        Tap a CE/PE premium to buy that option. Long-only (buying calls/puts); option writing needs SPAN margin and is disabled.
      </p>
    </div>
  );
}
