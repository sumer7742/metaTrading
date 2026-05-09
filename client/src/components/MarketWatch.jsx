import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum, fmtPriceDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

/**
 * Market-watch table — shows every active instrument with derived bid/ask,
 * absolute spread (under symbol), session high/low, and a 24h % change badge.
 * Click a row to switch the active chart symbol.
 *
 * Live updates: subscribes to `ticker:<symbol>` for every visible row and
 * recomputes bid/ask client-side from the same spread rule the backend uses,
 * so the numbers tick without re-hitting the API.
 */
export default function MarketWatch({ activeSymbol, onSelect, search = '' }) {
  const [rows, setRows] = useState([]);
  const [spreadRules, setSpreadRules] = useState({}); // symbol → { value, type }
  // USD→INR rate, shared across all rows. Re-renders this component when
  // the rate refreshes (every ~5 min) so prices stay roughly current.
  const fxRate = useFxRate();

  // Initial fetch — one shot, then we keep the rows live via ticker subs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, all] = await Promise.all([
          api.get('/instruments/watchlist'),
          api.get('/instruments'),
        ]);
        if (cancelled) return;
        setRows(w.data.data);
        const rules = {};
        for (const i of all.data.data) {
          rules[i.symbol] = { value: i.spreadValue || '0', type: i.spreadType || 'FIXED' };
        }
        setSpreadRules(rules);
      } catch (e) { /* ignore */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to ticker for every symbol so bid/ask/last updates live.
  // Re-derives bid/ask from the cached spread rule to avoid a round-trip per tick.
  useEffect(() => {
    if (!rows.length) return;
    const unsubs = rows.map((r) =>
      wsClient.subscribe(`ticker:${r.symbol}`, (data) => {
        const last = Number(data.lastPrice);
        if (!Number.isFinite(last) || last <= 0) return;
        const rule = spreadRules[r.symbol] || { value: '0', type: 'FIXED' };
        const half = Number(rule.value || 0) / 2;
        const bid = rule.type === 'PERCENTAGE' ? last * (1 - half) : last - half;
        const ask = rule.type === 'PERCENTAGE' ? last * (1 + half) : last + half;
        setRows((prev) =>
          prev.map((row) =>
            row.symbol === r.symbol
              ? { ...row, lastPrice: String(last), bid: String(bid), ask: String(ask), spread: String(ask - bid) }
              : row
          )
        );
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [rows.length, spreadRules]);

  const filtered = useMemo(() => {
    const q = (search || '').trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((r) => r.symbol.includes(q) || (r.name || '').toUpperCase().includes(q));
  }, [rows, search]);

  if (!rows.length) {
    return <div className="p-4 text-sm text-gray-500">Loading watchlist…</div>;
  }

  return (
    <div className="overflow-y-auto max-h-[60vh]">
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 uppercase sticky top-0 bg-bg-card z-10">
          <tr>
            <th className="text-left px-3 py-2 font-normal">Symbol</th>
            <th className="text-right px-3 py-2 font-normal">Bid</th>
            <th className="text-right px-3 py-2 font-normal">Ask</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const isActive = r.symbol === activeSymbol;
            const change = Number(r.change24h);
            const changeColor =
              !Number.isFinite(change) ? 'text-gray-500' : change >= 0 ? 'text-bull' : 'text-bear';
            // Quote currency drives the primary/secondary split. INR-quoted
            // instruments only show INR; USD-quoted show INR primary + USD
            // small below.
            const quote = r.quoteCurrency || 'USD';
            const bidPx = fmtPriceDual(r.bid, quote, fxRate, r.pricePrecision || 2);
            const askPx = fmtPriceDual(r.ask, quote, fxRate, r.pricePrecision || 2);
            return (
              <tr
                key={r.symbol}
                onClick={() => onSelect?.(r.symbol)}
                className={`border-t border-border-dark cursor-pointer transition-colors ${
                  isActive ? 'bg-bg-hover' : 'hover:bg-bg-hover'
                }`}
              >
                {/* Symbol + small spread number under it */}
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-white">{r.symbol}</div>
                  <div className="text-[11px] text-gray-500 font-mono">
                    {fmtNum(r.spread, Math.min(r.pricePrecision || 2, 5))}
                  </div>
                </td>

                {/* Bid + USD secondary + low */}
                <td className="px-3 py-2 text-right align-top">
                  <div className="font-mono text-blue-400">{bidPx.primary}</div>
                  {bidPx.secondary && (
                    <div className="text-[10px] text-gray-500 font-mono">{bidPx.secondary}</div>
                  )}
                  {r.dayLow && (
                    <div className="text-[11px] text-gray-500 font-mono">
                      L {fmtNum(r.dayLow, r.pricePrecision)}
                    </div>
                  )}
                </td>

                {/* Ask + USD secondary + high + change% */}
                <td className="px-3 py-2 text-right align-top">
                  <div className="font-mono text-red-400">{askPx.primary}</div>
                  {askPx.secondary && (
                    <div className="text-[10px] text-gray-500 font-mono">{askPx.secondary}</div>
                  )}
                  {r.dayHigh && (
                    <div className="text-[11px] text-gray-500 font-mono">
                      H {fmtNum(r.dayHigh, r.pricePrecision)}
                    </div>
                  )}
                  {Number.isFinite(change) && (
                    <div className={`text-[10px] font-mono ${changeColor}`}>
                      {change >= 0 ? '+' : ''}
                      {change.toFixed(2)}%
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {!filtered.length && (
            <tr>
              <td colSpan={3} className="px-3 py-6 text-center text-gray-500">
                No symbols match "{search}"
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
