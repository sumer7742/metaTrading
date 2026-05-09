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

  // Subscribe to ALL symbols where user has open positions
  // This ensures PnL updates in real-time for every position, not just the visible chart
  useEffect(() => {
    if (!positions.length) return;
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        setPriceMap((prev) => ({ ...prev, [sym]: data.lastPrice }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [positions]);

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

  // Compute live PnL for each position using latest price from priceMap
  const positionsWithLivePnl = positions.map((p) => {
    const livePrice = priceMap[p.symbol] || p.markPrice || p.entryPrice;
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    const mark = Number(livePrice);
    const livePnl = p.side === 'BUY'
      ? (mark - entry) * qty
      : (entry - mark) * qty;
    return {
      ...p,
      markPrice: livePrice,
      unrealizedPnl: String(livePnl),
    };
  });

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
      {/* Header */}
      <div className="card p-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center space-x-3">
          {/* Market-watch trigger — replaces the old <select>. Click to open
              a popover with bid/ask/H/L per instrument; selecting a row swaps
              the active chart symbol via the URL param (same contract). */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setWatchOpen((o) => !o)}
              className="input w-56 font-medium flex items-center justify-between"
            >
              <span className="truncate">
                {symbol}
                {instrument?.name ? ` - ${instrument.name}` : ''}
              </span>
              <span className="text-gray-500 text-xs ml-2">▾</span>
            </button>
            {watchOpen && (
              <>
                {/* Click-outside catcher */}
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setWatchOpen(false)}
                />
                <div className="absolute left-0 top-full mt-1 w-[26rem] z-30 card shadow-xl border border-border-dark">
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
          {instrument && (() => {
            const lastPx = fmtPriceDual(
              livePrice || instrument.lastPrice,
              instrument.quoteCurrency || 'USD',
              fxRate,
              instrument.pricePrecision
            );
            return (
              <div className="flex items-center space-x-4">
                <div>
                  <div className="text-xs text-gray-500">Last Price</div>
                  <div className="text-lg font-mono text-white">{lastPx.primary}</div>
                  {lastPx.secondary && (
                    <div className="text-[11px] font-mono text-gray-500">{lastPx.secondary}</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-gray-500">Mode</div>
                  <div className="text-sm text-gray-300">{instrument.mode}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Max Leverage</div>
                  <div className="text-sm text-gray-300">1:{instrument.maxLeverage}</div>
                </div>
              </div>
            );
          })()}
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={selectedAccountId || ''}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="input w-56 text-xs"
          >
            {accounts.map((a) => (
              <option key={a._id} value={a._id}>
                {a.nickname || a.accountNumber} ({a.accountType})
              </option>
            ))}
          </select>
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

          {/* Positions / Orders tabs */}
          <div className="card">
            <div className="flex border-b border-border-dark">
              {[
                { k: 'positions', label: `Positions (${positions.length})` },
                { k: 'orders', label: `Open Orders (${openOrders.length})` },
              ].map((t) => (
                <button
                  key={t.k}
                  onClick={() => setTab(t.k)}
                  className={`px-4 py-2 text-sm ${
                    tab === t.k ? 'text-white border-b-2 border-primary-500' : 'text-gray-500'
                  }`}
                >
                  {t.label}
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
  if (!positions.length) return <div className="text-gray-500 text-sm py-4 text-center">No open positions</div>;
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
  if (!orders.length) return <div className="text-gray-500 text-sm py-4 text-center">No open orders</div>;
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
