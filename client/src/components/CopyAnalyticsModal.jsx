import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';

/**
 * CopyAnalyticsModal — full performance analytics for one copy relation:
 * fee-aware P&L breakdown, equity + daily-PnL charts, 25+ metrics, master
 * comparison, trade history, CSV/print export and date filters. Updates in
 * real time on copy-trading WS events. Charts are custom inline SVG (the app's
 * pattern — no extra chart dependency).
 */

const sym = (c) => (c === 'USD' ? '$' : c === 'INR' ? '₹' : `${c} `);
const money = (n, c) => `${Number(n) < 0 ? '-' : ''}${sym(c)}${Math.abs(Number(n || 0)).toFixed(2)}`;
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

const PRESETS = [
  { id: 'all', label: 'All' }, { id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: '90d', label: '90D' },
];

export default function CopyAnalyticsModal({ rel, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');

  const load = async () => {
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get(`/copy-trading/copy/${rel._id}/analytics`, { params });
      setData(r.data.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(true); load(); }, [from, to]);
  useEffect(() => {
    const un = wsClient.subscribe('copytrading', () => load());
    return () => un && un();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (p) => {
    setPreset(p);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    const ago = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
    if (p === 'all') { setFrom(''); setTo(''); }
    else if (p === '7d') { setFrom(fmt(ago(6))); setTo(fmt(now)); }
    else if (p === '30d') { setFrom(fmt(ago(29))); setTo(fmt(now)); }
    else if (p === '90d') { setFrom(fmt(ago(89))); setTo(fmt(now)); }
  };

  const c = data?.currency || 'USD';

  const exportCsv = () => {
    if (!data?.trades?.length) return toast.error('No trades to export');
    const cols = ['Closed', 'Symbol', 'Side', 'Qty', 'Entry', 'Close', 'PnL', 'Commission', 'Swap'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(esc).join(',')];
    for (const t of data.trades) {
      lines.push([new Date(t.closedAt).toISOString(), t.symbol, t.side, t.qty, t.entryPrice, t.closePrice, t.pnl, t.commission, t.swap].map(esc).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `copy-analytics-${rel._id}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[94vh] overflow-y-auto no-scrollbar" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center gap-3 flex-wrap sticky top-0 bg-bg-card z-10">
          <div className="min-w-0 flex-1">
            <h3 className="font-extrabold text-text-primary truncate">Copy analytics · {rel.master?.displayName || 'Trader'}</h3>
            <p className="text-[11px] text-text-muted">{data?.account ? `${data.account.nickname || data.account.number}` : ''} · {data?.status}</p>
          </div>
          <div className="flex items-center gap-1">
            {PRESETS.map((p) => (
              <button key={p.id} onClick={() => applyPreset(p.id)}
                className={`text-xs px-2.5 py-1 rounded ${preset === p.id ? 'btn-primary' : 'bg-bg-hover text-text-secondary hover:text-text-primary'}`}>{p.label}</button>
            ))}
            <input type="date" value={from} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} className="text-xs px-2 py-1 rounded border border-border-dark bg-white" />
            <span className="text-text-muted text-xs">→</span>
            <input type="date" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} className="text-xs px-2 py-1 rounded border border-border-dark bg-white" />
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {loading || !data ? (
          <div className="py-20 text-center text-text-muted">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Fee-aware P&L breakdown */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="card p-4 bg-bg-hover/40">
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-2">P&L breakdown</div>
                <Line label="Gross profit" value={money(data.grossProfit, c)} tone="bull" />
                <Line label="Performance fee" value={`-${money(data.performanceFeePaid, c)}`} tone="bear" />
                <Line label="Commission" value={`-${money(data.commission, c)}`} tone="bear" />
                <Line label="Swap" value={`-${money(data.swap, c)}`} tone="bear" />
                <div className="border-t border-border-dark mt-2 pt-2">
                  <Line label="Net profit" value={money(data.netProfit, c)} tone={data.netProfit >= 0 ? 'bull' : 'bear'} bold />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 content-start">
                <Kpi label="Net profit" value={money(data.netProfit, c)} tone={data.netProfit >= 0 ? 'bull' : 'bear'} big />
                <Kpi label="ROI" value={pct(data.roi)} tone={data.roi >= 0 ? 'bull' : 'bear'} big />
                <Kpi label="Win rate" value={pct(data.winRate)} />
                <Kpi label="Profit factor" value={data.profitFactor == null ? '∞' : data.profitFactor} />
              </div>
            </div>

            {/* Equity curve */}
            <Panel title="Equity curve (cumulative net)">
              <EquityChart data={data.curve} />
            </Panel>

            {/* Daily PnL */}
            <Panel title="Daily P&L">
              <PnlBars data={data.daily} />
            </Panel>

            {/* Master comparison */}
            {data.master && (
              <Panel title={`Comparison with master · ${data.master.displayName}`}>
                <div className="grid grid-cols-2 gap-4 text-center py-1">
                  <div>
                    <div className="text-[10px] uppercase text-text-muted font-bold">You</div>
                    <div className="text-sm font-bold text-text-primary">ROI {pct(data.roi)} · Win {pct(data.winRate)} · {data.closedTrades} trades</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase text-text-muted font-bold">Master</div>
                    <div className="text-sm font-bold text-text-primary">ROI {pct(data.master.roiPct)} · Win {pct(data.master.winRate)} · {data.master.totalTrades} trades</div>
                  </div>
                </div>
              </Panel>
            )}

            {/* Full metric grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Kpi label="Total trades" value={data.totalTrades} />
              <Kpi label="Closed" value={data.closedTrades} />
              <Kpi label="Open" value={data.openTrades} />
              <Kpi label="Success rate" value={pct(data.successRate)} />
              <Kpi label="Avg win" value={money(data.avgWin, c)} tone="bull" />
              <Kpi label="Avg loss" value={money(data.avgLoss, c)} tone="bear" />
              <Kpi label="Largest win" value={money(data.largestWin, c)} tone="bull" />
              <Kpi label="Largest loss" value={money(data.largestLoss, c)} tone="bear" />
              <Kpi label="Risk / reward" value={data.riskReward} />
              <Kpi label="Recovery factor" value={data.recoveryFactor} />
              <Kpi label="Sharpe" value={data.sharpe == null ? '—' : data.sharpe} />
              <Kpi label="Max drawdown" value={money(data.maxDrawdown, c)} tone="bear" />
              <Kpi label="Current equity" value={money(data.currentEquity, c)} />
              <Kpi label="Max equity" value={money(data.maxEquity, c)} />
              <Kpi label="Total lots" value={data.totalLots} />
              <Kpi label="Avg holding" value={`${data.avgHoldingMinutes} min`} />
            </div>

            {/* Trade history */}
            <Panel title={`Trade history (${data.trades.length})`} action={
              <div className="flex gap-1">
                <button onClick={exportCsv} className="text-xs btn-ghost">Export CSV</button>
                <button onClick={() => window.print()} className="text-xs btn-ghost">Print / PDF</button>
              </div>
            }>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card text-[10px] uppercase text-text-muted">
                    <tr><Th>Closed</Th><Th>Symbol</Th><Th>Side</Th><Th right>Qty</Th><Th right>PnL</Th><Th right>Comm.</Th></tr>
                  </thead>
                  <tbody>
                    {data.trades.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-text-muted">No closed trades</td></tr>}
                    {data.trades.map((t) => (
                      <tr key={t.id} className="border-b border-border-dark/50">
                        <td className="py-1.5 px-2 text-text-secondary whitespace-nowrap">{new Date(t.closedAt).toLocaleDateString()}</td>
                        <td className="py-1.5 px-2 font-semibold text-text-primary">{t.symbol}</td>
                        <td className="py-1.5 px-2"><span className={t.side === 'BUY' ? 'text-bull' : 'text-bear'}>{t.side}</span></td>
                        <td className="py-1.5 px-2 text-right font-mono">{t.qty}</td>
                        <td className={`py-1.5 px-2 text-right font-mono font-semibold ${t.pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{money(t.pnl, c)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-text-muted">{money(t.commission, c)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── small building blocks ─────────────────────────────────────────── */
function Kpi({ label, value, tone, big }) {
  const col = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div className="card p-2.5">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted truncate">{label}</div>
      <div className={`${big ? 'text-lg' : 'text-sm'} font-extrabold font-mono tabular-nums ${col}`}>{value}</div>
    </div>
  );
}
function Line({ label, value, tone, bold }) {
  const col = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div className="flex items-center justify-between py-0.5 text-sm">
      <span className={`${bold ? 'font-bold text-text-primary' : 'text-text-secondary'}`}>{label}</span>
      <span className={`font-mono tabular-nums ${bold ? 'font-extrabold' : 'font-semibold'} ${col}`}>{value}</span>
    </div>
  );
}
function Panel({ title, action, children }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
function Th({ children, right }) {
  return <th className={`py-1.5 px-2 font-bold ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Empty({ label }) {
  return <div className="py-8 text-center text-xs text-text-muted">{label}</div>;
}

function EquityChart({ data }) {
  if (!data?.length) return <Empty label="No closed trades yet" />;
  const W = 600, H = 160, P = 10;
  const ys = data.map((d) => d.equity);
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const range = (max - min) || 1;
  const x = (i) => P + (i / Math.max(1, data.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - min) / range) * (H - 2 * P);
  const pts = data.map((d, i) => `${x(i)},${y(d.equity)}`).join(' ');
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`;
  const up = ys[ys.length - 1] >= 0;
  const stroke = up ? '#10b981' : '#ef4444';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 160 }}>
      <polygon points={area} fill={up ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'} />
      <line x1={P} y1={y(0)} x2={W - P} y2={y(0)} className="text-border-dark" stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function PnlBars({ data }) {
  if (!data?.length) return <Empty label="No P&L data" />;
  const W = 600, H = 140, P = 10;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.pnl)));
  const bw = (W - 2 * P) / data.length;
  const zeroY = H / 2;
  const scale = (H / 2 - P) / max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 140 }}>
      <line x1={P} y1={zeroY} x2={W - P} y2={zeroY} className="text-border-dark" stroke="currentColor" strokeWidth="0.5" />
      {data.map((d, i) => {
        const h = Math.max(1, Math.abs(d.pnl) * scale);
        const xx = P + i * bw + bw * 0.15;
        const yy = d.pnl >= 0 ? zeroY - h : zeroY;
        return <rect key={i} x={xx} y={yy} width={bw * 0.7} height={h} rx="1" fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />;
      })}
    </svg>
  );
}
