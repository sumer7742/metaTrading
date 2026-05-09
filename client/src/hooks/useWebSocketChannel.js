import { useEffect, useRef } from 'react';
import { wsClient } from '../services/ws';

/**
 * Subscribe to a WebSocket channel and run a callback on every event.
 * Automatically subscribes on mount + dependency change, unsubscribes on cleanup.
 *
 * @param {string|null} channel - Channel name (e.g. 'orderbook:BTCUSD'). Pass null/falsy to skip.
 * @param {(data: any) => void} onMessage - Callback for each event.
 *
 * Example:
 *   useWebSocketChannel(`ticker:${symbol}`, (data) => setPrice(data.lastPrice));
 */
export default function useWebSocketChannel(channel, onMessage) {
  // Keep latest callback in a ref so we don't re-subscribe on every render
  const cbRef = useRef(onMessage);
  useEffect(() => {
    cbRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!channel) return;
    const unsub = wsClient.subscribe(channel, (data) => {
      if (cbRef.current) cbRef.current(data);
    });
    return () => unsub && unsub();
  }, [channel]);
}
