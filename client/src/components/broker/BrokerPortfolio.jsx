import { useCallback, useEffect, useState } from 'react';
import { brokerApi } from '../../services/broker';
import { errorMessage } from '../../services/api';
import { Card, Placeholder, Stat, Pnl, inr } from './brokerUi';

/**
 * Portfolio snapshot for the connected broker — funds, positions and holdings.
 *
 * Uses the backend's `/portfolio/summary`, which fetches all three in parallel
 * and degrades gracefully: if one section errors the others still render, and
 * the failure is surfaced instead of blanking the screen.
 */
export default function BrokerPortfolio({ broker, refreshSignal }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      setData(await brokerApi.summary({ broker: broker || undefined, force }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [broker]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => { if (refreshSignal) load(true); }, [refreshSignal, load]);

  const funds = data?.funds;
  const positions = data?.positions || [];
  const holdings = data?.holdings || [];
  const totals = data?.totals || {};

  return (
    <div className="space-y-4">
      <Card
        title="Funds & margin"
        actions={
          <button type="button" onClick={() => load(true)}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
            Refresh
          </button>
        }
      >
        <Placeholder loading={loading} error={error}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4">
            <Stat label="Available cash" value={inr(funds?.availableCash)} />
            <Stat label="Used margin" value={inr(funds?.utilizedMargin)} />
            <Stat label="Total balance" value={inr(funds?.totalBalance)} />
            <Stat
              label="Total P&L"
              value={<Pnl value={totals.totalPnl} />}
              tone={Number(totals.totalPnl) > 0 ? 'bull' : Number(totals.totalPnl) < 0 ? 'bear' : undefined}
              sub={`${totals.openPositions ?? positions.length} open · ${holdings.length} holdings`}
            />
          </div>
          {data?.errors?.length > 0 && (
            <div className="px-4 pb-3 text-[11px] text-bear">
              Some sections couldn't load: {data.errors.map((e) => e.message).join('; ')}
            </div>
          )}
        </Placeholder>
      </Card>

      <Card title="Positions" subtitle={positions.length ? `${positions.length} open` : undefined}>
        <Placeholder loading={loading} empty={!positions.length ? 'No open positions.' : undefined}>
          <PositionTable rows={positions} />
        </Placeholder>
      </Card>

      <Card title="Holdings" subtitle={holdings.length ? `${holdings.length} stocks` : undefined}>
        <Placeholder loading={loading} empty={!holdings.length ? 'No holdings.' : undefined}>
          <HoldingTable rows={holdings} />
        </Placeholder>
      </Card>
    </div>
  );
}

function PositionTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">
            <th className="text-left font-semibold px-4 py-2">Instrument</th>
            <th className="text-right font-semibold px-3 py-2">Qty</th>
            <th className="text-right font-semibold px-3 py-2">Avg</th>
            <th className="text-right font-semibold px-3 py-2">LTP</th>
            <th className="text-right font-semibold px-4 py-2">P&L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((p, i) => (
            <tr key={`${p.symbol}-${i}`} className="hover:bg-bg-hover/50">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${p.side === 'BUY' ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                    {p.side === 'BUY' ? 'LONG' : p.side === 'SELL' ? 'SHORT' : p.side}
                  </span>
                  <span className="font-semibold text-text-primary">{p.symbol}</span>
                  <span className="text-[11px] text-text-muted">{p.exchange} · {p.product}</span>
                </div>
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{p.qty}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{inr(p.averagePrice)}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{inr(p.lastPrice)}</td>
              <td className="px-4 py-2.5 text-right"><Pnl value={p.pnl} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">
            <th className="text-left font-semibold px-4 py-2">Stock</th>
            <th className="text-right font-semibold px-3 py-2">Qty</th>
            <th className="text-right font-semibold px-3 py-2">Avg</th>
            <th className="text-right font-semibold px-3 py-2">LTP</th>
            <th className="text-right font-semibold px-4 py-2">P&L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((h, i) => (
            <tr key={`${h.symbol}-${i}`} className="hover:bg-bg-hover/50">
              <td className="px-4 py-2.5 font-semibold text-text-primary">{h.symbol}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{h.quantity}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{inr(h.averagePrice)}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">{inr(h.currentPrice)}</td>
              <td className="px-4 py-2.5 text-right">
                <Pnl value={h.pnl} />
                {h.pnlPercent != null && (
                  <div className={`text-[10px] font-mono ${Number(h.pnlPercent) >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {Number(h.pnlPercent) >= 0 ? '+' : ''}{Number(h.pnlPercent).toFixed(2)}%
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
