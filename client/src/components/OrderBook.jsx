import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum, fmtPriceDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

export default function OrderBook({ symbol, pricePrecision = 2, quoteCurrency = 'USD' }) {
  const [book, setBook] = useState({ bids: [], asks: [] });
  const fxRate = useFxRate();

  useEffect(() => {
    let cancelled = false;
    let unsub = null;
    (async () => {
      try {
        const { data } = await api.get(`/instruments/${symbol}/orderbook`, { params: { depth: 15 } });
        if (!cancelled) setBook(data.data);
      } catch (e) {}
    })();

    unsub = wsClient.subscribe(`orderbook:${symbol}`, (snap) => {
      setBook({ bids: snap.bids || [], asks: snap.asks || [] });
    });

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [symbol]);

  const maxQty = Math.max(
    ...book.bids.map((b) => Number(b.quantity)),
    ...book.asks.map((a) => Number(a.quantity)),
    1
  );

  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 border-b border-border-dark">
        <div className="text-sm font-medium text-gray-300">Order Book</div>
      </div>
      <div className="p-2">
        <div className="grid grid-cols-3 text-xs text-gray-500 px-2 mb-1">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>
        {/* Asks (reversed: highest at top, best ask at bottom) */}
        <div className="space-y-px">
          {book.asks
            .slice(0, 10)
            .reverse()
            .map((lvl, i) => (
              <Row key={`a${i}`} level={lvl} side="ask" maxQty={maxQty} pricePrecision={pricePrecision} quoteCurrency={quoteCurrency} fxRate={fxRate} />
            ))}
        </div>
        <div className="my-2 px-2 text-center text-xs text-gray-500 border-y border-border-dark py-1">
          Spread: {book.asks[0] && book.bids[0]
            ? fmtNum(Number(book.asks[0].price) - Number(book.bids[0].price), pricePrecision)
            : '-'}
        </div>
        {/* Bids */}
        <div className="space-y-px">
          {book.bids.slice(0, 10).map((lvl, i) => (
            <Row key={`b${i}`} level={lvl} side="bid" maxQty={maxQty} pricePrecision={pricePrecision} quoteCurrency={quoteCurrency} fxRate={fxRate} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ level, side, maxQty, pricePrecision, quoteCurrency, fxRate }) {
  const pct = (Number(level.quantity) / maxQty) * 100;
  const colorClass = side === 'bid' ? 'text-bull' : 'text-bear';
  const bgClass = side === 'bid' ? 'bg-bull' : 'bg-bear';
  // INR primary line; USD as a small parenthetical suffix to keep the row
  // compact (the order book has limited horizontal real estate).
  const px = fmtPriceDual(level.price, quoteCurrency, fxRate, pricePrecision);
  return (
    <div className="relative grid grid-cols-3 px-2 py-0.5 text-xs font-mono">
      <div
        className={`absolute inset-y-0 ${side === 'bid' ? 'left-0' : 'right-0'} ${bgClass} opacity-10`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
      <span className={`relative ${colorClass}`}>
        {px.primary}
        {px.secondary && (
          <span className="text-gray-500 text-[10px] ml-1">{px.secondary}</span>
        )}
      </span>
      <span className="relative text-right text-gray-300">{fmtNum(level.quantity, 4)}</span>
      <span className="relative text-right text-gray-500">
        {fmtNum(Number(level.price) * Number(level.quantity), 2)}
      </span>
    </div>
  );
}
