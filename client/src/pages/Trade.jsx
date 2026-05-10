import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import PriceChart from '../components/PriceChart';
import OrderBook from '../components/OrderBook';
import OrderForm from '../components/OrderForm';
import MarketWatch from '../components/MarketWatch';
import { fmtNum, fmtPnlSimple, fmtMoney, fmtPriceDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

export default function Trade() {
  const [params, setParams] = useSearchParams();
  const symbol = params.get('symbol') || 'BTCUSD';
  const [timeframe, setTimeframe] = useState('1m');
  const [instruments, setInstruments] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [openOrders, setOpenOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [tab, setTab] = useState('positions');
  // Map of symbol -> latest live price (for ALL positions, not just selected chart)
  const [priceMap, setPriceMap] = useState({});
  const [livePrice, setLivePrice] = useState(null);
  // Live preview from OrderForm: { side, type, price } while user is typing.
  // Shown as a dotted price line on the chart so the user can see exactly
  // where their LIMIT/STOP would sit before they click Place.
  const [pendingPreview, setPendingPreview] = useState(null);
  // Market watch popover state.
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchSearch, setWatchSearch] = useState('');

  const instrument = useMemo(() => instruments.find((i) => i.symbol === symbol), [instruments, symbol]);
  // Lookup map so PositionsTable / OrdersTable can resolve quoteCurrency
  // and pricePrecision per row without prop-drilling individual fields.
  const instrumentsBySymbol = useMemo(() => {
    const out = {};
    for (const i of instruments) out[i.symbol] = i;
    return out;
  }, [instruments]);
  const account = useMemo(() => accounts.find((a) => a._id === selectedAccountId) || accounts[0], [
    accounts,
    selectedAccountId,
  ]);
  const fxRate = useFxRate();

  // Initial load
  useEffect(() => {
    (async () => {
      const [i, a] = await Promise.all([api.get('/instruments'), api.get('/user/accounts')]);
      setInstruments(i.data.data);
      setAccounts(a.data.data);
      if (a.data.data.length) setSelectedAccountId(a.data.data[0]._id);
    })();
  }, []);

  const refresh = async () => {
    const [o, p] = await Promise.all([api.get('/trading/orders/open'), api.get('/trading/positions')]);
    setOpenOrders(o.data.data);
    setPositions(p.data.data);
  };

  useEffect(() => {
    refresh();
  }, []);

  // Subscribe to live ticker for the selected chart symbol.
  // Resetting livePrice on symbol switch is critical — otherwise the chart's
  // `live:last` price line keeps showing the previous symbol's price (e.g.
  // a $80k BTC line on a $1.17 EURUSD chart) until the next tick arrives,
  // which stretches the y-axis and looks broken. Same for the order-form
  // preview line — a $80k preview shouldn't linger on a $1.17 EURUSD chart.
  useEffect(() => {
    if (!symbol) return;
    setLivePrice(null);
    setPendingPreview(null);
    const unsub = wsClient.subscribe(`ticker:${symbol}`, (data) => {
      setLivePrice(data.lastPrice);
      // Also update priceMap for PnL calculation
      setPriceMap((prev) => ({ ...prev, [symbol]: data.lastPrice }));
    });
    return () => {
      unsub();
    };
  }, [symbol]);

  // Subscribe to ALL symbols where the user has open positions so PnL ticks
  // for every row, not just the chart's symbol. Depend on the stable
  // joined-symbol key (not the `positions` array) so a refresh that returns
  // an identical symbol set doesn't tear down + rebuild every WS subscription.
  const positionSymbolsKey = useMemo(
    () => [...new Set(positions.map((p) => p.symbol))].sort().join('|'),
    [positions]
  );
  useEffect(() => {
    if (!positionSymbolsKey) return;
    const symbols = positionSymbolsKey.split('|');
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        setPriceMap((prev) => ({ ...prev, [sym]: data.lastPrice }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [positionSymbolsKey]);

  // Subscribe to private 'positions', 'orders' and 'wallet' channels so the
  // table + chart refresh on FILLED/STOP_TRIGGERED/OCO_CANCELLED etc. Without
  // the 'orders' subscription, a triggered STOP would leave a stale price-line
  // on the chart until the next manual interaction.
  useEffect(() => {
    const unsub = wsClient.subscribe('positions', () => refresh());
    const orders = wsClient.subscribe('orders', () => refresh());
    const wallet = wsClient.subscribe('wallet', () => refresh());
    return () => {
      unsub && unsub();
      orders && orders();
      wallet && wallet();
    };
  }, []);

  // Compute live PnL for each position using latest price from priceMap.
  // `markPx` (not `livePrice`) is named explicitly to avoid shadowing the
  // chart's livePrice state — the two represent different things.
  const positionsWithLivePnl = useMemo(() =>
    positions.map((p) => {
      const markPx = priceMap[p.symbol] || p.markPrice || p.entryPrice;
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const mark = Number(markPx);
      if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(mark)) {
        return { ...p, markPrice: markPx, unrealizedPnl: '0' };
      }
      const livePnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      return { ...p, markPrice: markPx, unrealizedPnl: String(livePnl) };
    }),
    [positions, priceMap]
  );

  const cancelOrder = async (id) => {
    try {
      await api.delete(`/trading/orders/${id}`);
      toast.success('Order cancelled');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const closePosition = async (id) => {
    try {
      await api.post(`/trading/positions/${id}/close`);
      toast.success('Position closing');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const modifyPositionSlTp = async (position) => {
    const sl = window.prompt(`Stop Loss for ${position.symbol} (blank to remove)`, position.stopLoss || '');
    if (sl === null) return; // user cancelled
    const tp = window.prompt(`Take Profit for ${position.symbol} (blank to remove)`, position.takeProfit || '');
    if (tp === null) return;
    try {
      await api.put(`/trading/positions/${position._id}`, {
        stopLoss: sl === '' ? null : sl,
        takeProfit: tp === '' ? null : tp,
      });
      toast.success('SL/TP updated');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      {/* Trade header — premium row.
          IMPORTANT: outer card is NOT overflow-hidden so the symbol-picker
          dropdown can extend below the card and overlay the chart. The
          gradient backdrop lives inside its own clipped layer instead. */}
      <div className="relative rounded-xl border border-border-dark bg-bg-card p-4 z-30">
        {/* Decorative gradient — clipped to the card's rounded corners by
            its own overflow-hidden wrapper, isolated from the content layer. */}
        <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
          <div
            className="absolute inset-0 opacity-50"
            style={{ background: 'radial-gradient(circle at 0% 0%, rgba(252, 213, 53, 0.08), transparent 50%)' }}
          />
        </div>
        <div className="relative flex items-center justify-between flex-wrap gap-3">
          {/* Left cluster — symbol picker + price + meta */}
          <div className="flex items-center gap-5 flex-wrap">
            {/* Symbol selector pill */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setWatchOpen((o) => !o)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border-dark bg-bg-panel hover:border-border-accent hover:bg-bg-hover transition-colors group"
                title="Change symbol"
              >
                <span
                  className="w-9 h-9 rounded-md flex items-center justify-center text-xs font-extrabold text-bg-dark shrink-0"
                  style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
                >
                  {symbol?.slice(0, 3) || '—'}
                </span>
                <div className="text-left">
                  <div className="text-sm font-bold text-white leading-none">{symbol || '—'}</div>
                  <div className="text-[10px] text-text-muted mt-1 leading-none truncate max-w-[160px]">
                    {instrument?.name || 'Pick instrument'}
                  </div>
                </div>
                <span className="text-text-muted text-xs ml-1 group-hover:text-primary-500 transition-colors">▾</span>
              </button>
              {watchOpen && (
                <>
                  {/* Click-outside catcher sits BELOW the dropdown but ABOVE
                      everything else on the page so a click anywhere outside
                      closes the popover. */}
                  <div className="fixed inset-0 z-40" onClick={() => setWatchOpen(false)} />
                  {/* Dropdown — z-50 wins against the chart card and any
                      sibling overflow contexts. */}
                  <div className="absolute left-0 top-full mt-2 w-[28rem] z-50 card shadow-2xl border-border-accent/20">
                    <div className="p-2 border-b border-border-dark">
                      <input
                        type="text"
                        autoFocus
                        value={watchSearch}
                        onChange={(e) => setWatchSearch(e.target.value)}
                        placeholder="Search symbol or name…"
                        className="input w-full text-xs"
                      />
                    </div>
                    <MarketWatch
                      activeSymbol={symbol}
                      search={watchSearch}
                      onSelect={(s) => {
                        setParams({ symbol: s });
                        setWatchOpen(false);
                        setWatchSearch('');
                      }}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Live price */}
            {instrument && (() => {
              const lastPx = fmtPriceDual(
                livePrice || instrument.lastPrice,
                instrument.quoteCurrency || 'USD',
                fxRate,
                instrument.pricePrecision
              );
              return (
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse shrink-0" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold leading-none">
                      Last Price
                    </div>
                    <div className="text-2xl font-bold text-white font-mono leading-none mt-1">
                      {lastPx.primary}
                    </div>
                    {lastPx.secondary && (
                      <div className="text-[11px] font-mono text-text-muted mt-1 leading-none">
                        {lastPx.secondary}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Mode + leverage badges */}
            {instrument && (
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-md text-[10px] uppercase font-bold bg-bg-hover border border-border-dark text-text-secondary tracking-wider">
                  {instrument.mode}
                </span>
                <span className="px-2.5 py-1 rounded-md text-[10px] uppercase font-bold bg-primary-500/10 border border-primary-500/30 text-primary-500 tracking-wider">
                  1:{instrument.maxLeverage}
                </span>
              </div>
            )}
          </div>

          {/* Right — account selector pill */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">
              Account
            </span>
            <select
              value={selectedAccountId || ''}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="input w-56 text-xs font-medium"
            >
              {accounts.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.nickname || a.accountNumber} · {a.accountType}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 space-y-4">
          {instrument && (
            <PriceChart
              symbol={symbol}
              timeframe={timeframe}
              onTimeframeChange={setTimeframe}
              livePrice={livePrice || instrument.lastPrice}
              openOrders={openOrders}
              positions={positionsWithLivePnl}
              pendingPreview={pendingPreview}
              pricePrecision={instrument.pricePrecision}
            />
          )}

          {/* Positions / Orders tabs — with count pills + premium tab styling */}
          <div className="card">
            <div className="flex items-center border-b border-border-dark px-2">
              {[
                { k: 'positions', label: 'Positions', count: positions.length },
                { k: 'orders', label: 'Open Orders', count: openOrders.length },
              ].map((t) => (
                <button
                  key={t.k}
                  onClick={() => setTab(t.k)}
                  className={`relative px-4 py-3 text-sm font-medium flex items-center gap-2 transition-colors ${
                    tab === t.k
                      ? 'text-white'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {t.label}
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      tab === t.k
                        ? 'bg-primary-500/20 text-primary-500'
                        : 'bg-bg-hover text-text-muted'
                    }`}
                  >
                    {t.count}
                  </span>
                  {tab === t.k && (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-500 rounded-t-full" />
                  )}
                </button>
              ))}
            </div>
            <div className="p-3 overflow-x-auto">
              {tab === 'positions' && (
                <PositionsTable
                  positions={positionsWithLivePnl}
                  onClose={closePosition}
                  onModify={modifyPositionSlTp}
                  fxRate={fxRate}
                  instrumentsBySymbol={instrumentsBySymbol}
                />
              )}
              {tab === 'orders' && (
                <OrdersTable
                  orders={openOrders}
                  onCancel={cancelOrder}
                  fxRate={fxRate}
                  instrumentsBySymbol={instrumentsBySymbol}
                />
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 space-y-4">
          {instrument && (
            <OrderBook symbol={symbol} pricePrecision={instrument.pricePrecision} quoteCurrency={instrument.quoteCurrency} />
          )}
          {instrument && account && (
            <OrderForm
              instrument={instrument}
              account={account}
              onPlaced={refresh}
              onPendingPriceChange={setPendingPreview}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PositionsTable({ positions, onClose, onModify, fxRate, instrumentsBySymbol }) {
  if (!positions.length) {
    return (
      <div className="py-10 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3 border border-border-dark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3v18h18" />
            <path d="M7 14l4-4 4 4 5-7" />
          </svg>
        </div>
        <div className="text-sm text-text-secondary">No open positions</div>
        <div className="text-xs text-text-muted mt-1">Place a market or limit order to open one.</div>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Symbol</th>
          <th className="text-left p-2">Side</th>
          <th className="text-right p-2">Qty</th>
          <th className="text-right p-2">Entry</th>
          <th className="text-right p-2">Mark</th>
          <th className="text-right p-2">P&L</th>
          <th className="text-right p-2">Lev</th>
          <th className="text-right p-2"></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const pnl = Number(p.unrealizedPnl || 0);
          const inst = instrumentsBySymbol?.[p.symbol];
          const quote = inst?.quoteCurrency || 'USD';
          const prec = inst?.pricePrecision || 4;
          const entry = fmtPriceDual(p.entryPrice, quote, fxRate, prec);
          const mark = fmtPriceDual(p.markPrice || p.entryPrice, quote, fxRate, prec);
          // PnL is in the position's quote currency on the wire — convert to
          // INR for display so the headline number stays consistent.
          const pnlInr = quote === 'USD' ? pnl * Number(fxRate || 0) : pnl;
          return (
            <tr key={p._id} className="table-row">
              <td className="p-2 font-medium">{p.symbol}</td>
              <td className={`p-2 font-semibold ${p.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>
                {p.side === 'BUY' ? 'LONG' : 'SHORT'}
              </td>
              <td className="p-2 text-right font-mono">{fmtNum(p.quantity, 4)}</td>
              <td className="p-2 text-right font-mono">
                <div>{entry.primary}</div>
                {entry.secondary && <div className="text-[10px] text-gray-500">{entry.secondary}</div>}
              </td>
              <td className="p-2 text-right font-mono">
                <div>{mark.primary}</div>
                {mark.secondary && <div className="text-[10px] text-gray-500">{mark.secondary}</div>}
              </td>
              <td className={`p-2 text-right font-mono ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                <div>{fmtPnlSimple(pnlInr, 'INR')}</div>
                {quote === 'USD' && (
                  <div className="text-[10px] text-gray-500">{fmtPnlSimple(pnl, 'USD')}</div>
                )}
              </td>
              <td className="p-2 text-right">1:{p.leverage}</td>
              <td className="p-2 text-right">
                <div className="flex justify-end gap-1">
                  <button onClick={() => onModify(p)} className="btn-ghost text-xs px-2 py-1">SL/TP</button>
                  <button onClick={() => onClose(p._id)} className="btn-ghost text-xs px-2 py-1">Close</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrdersTable({ orders, onCancel, fxRate, instrumentsBySymbol }) {
  if (!orders.length) {
    return (
      <div className="py-10 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3 border border-border-dark">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
          </svg>
        </div>
        <div className="text-sm text-text-secondary">No open orders</div>
        <div className="text-xs text-text-muted mt-1">Pending limit/stop orders will appear here.</div>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Symbol</th>
          <th className="text-left p-2">Side</th>
          <th className="text-left p-2">Type</th>
          <th className="text-right p-2">Qty</th>
          <th className="text-right p-2">Filled</th>
          <th className="text-right p-2">Price / Trigger</th>
          <th className="text-right p-2">Status</th>
          <th className="text-right p-2"></th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const inst = instrumentsBySymbol?.[o.symbol];
          const quote = inst?.quoteCurrency || 'USD';
          const prec = inst?.pricePrecision || 4;
          const limitPx = o.price ? fmtPriceDual(o.price, quote, fxRate, prec) : null;
          const stopPx = o.stopPrice ? fmtPriceDual(o.stopPrice, quote, fxRate, prec) : null;
          return (
            <tr key={o._id} className="table-row">
              <td className="p-2 font-medium">{o.symbol}</td>
              <td className={`p-2 font-semibold ${o.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>{o.side}</td>
              <td className="p-2">
                {o.type}
                {o.type === 'STOP' && o.triggeredAt && <span className="ml-1 text-[10px] text-amber-400">(fired)</span>}
              </td>
              <td className="p-2 text-right font-mono">{fmtNum(o.quantity, 4)}</td>
              <td className="p-2 text-right font-mono">{fmtNum(o.filledQuantity, 4)}</td>
              <td className="p-2 text-right font-mono">
                {o.type === 'STOP' ? (
                  <>
                    <div>{stopPx?.primary || '-'}{limitPx ? ` / ${limitPx.primary}` : ''}</div>
                    {(stopPx?.secondary || limitPx?.secondary) && (
                      <div className="text-[10px] text-gray-500">
                        {stopPx?.secondary || ''}{limitPx?.secondary ? ` / ${limitPx.secondary}` : ''}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>{limitPx?.primary || '-'}</div>
                    {limitPx?.secondary && (
                      <div className="text-[10px] text-gray-500">{limitPx.secondary}</div>
                    )}
                  </>
                )}
              </td>
              <td className="p-2 text-right text-gray-400">{o.status}</td>
              <td className="p-2 text-right">
                <button onClick={() => onCancel(o._id)} className="btn-ghost text-xs">
                  Cancel
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
