import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Computes simple account metrics on the client by combining positions + balances.
 * Polls every `intervalMs` to stay roughly in sync as prices move.
 *
 * For an authoritative view, the backend `/api/admin/accounts/:id/metrics` endpoint
 * uses the same formulas. This client-side version is for the trader UI.
 *
 * Returns: { balance, equity, usedMargin, freeMargin, unrealizedPnl, marginLevel, positions }
 */
export default function useAccountMetrics(accountId, intervalMs = 5000) {
  const [metrics, setMetrics] = useState({
    balance: '0',
    equity: '0',
    usedMargin: '0',
    freeMargin: '0',
    unrealizedPnl: '0',
    marginLevel: '0',
    positions: [],
  });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;

    const compute = async () => {
      try {
        const [balRes, posRes] = await Promise.all([
          api.get('/wallet/balances', { params: { accountId } }),
          api.get('/trading/positions'),
        ]);
        if (cancelled) return;

        const balances = balRes.data.data || [];
        const positions = (posRes.data.data || []).filter((p) => p.accountId === accountId);

        // Pick the base currency wallet (USD by default; use first if missing)
        const baseWallet = balances.find((b) => b.currency === 'USD') || balances[0];
        const balance = baseWallet ? Number(baseWallet.balance) : 0;

        let usedMargin = 0;
        let unrealizedPnl = 0;
        for (const p of positions) {
          usedMargin += Number(p.margin || 0);
          unrealizedPnl += Number(p.unrealizedPnl || 0);
        }
        const equity = balance + unrealizedPnl;
        const freeMargin = equity - usedMargin;
        const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : 0;

        setMetrics({
          balance: balance.toFixed(2),
          equity: equity.toFixed(2),
          usedMargin: usedMargin.toFixed(2),
          freeMargin: freeMargin.toFixed(2),
          unrealizedPnl: unrealizedPnl.toFixed(2),
          marginLevel: marginLevel.toFixed(2),
          positions,
        });
      } catch (err) {
        // ignore - keep last known metrics
      }
    };

    compute();
    const id = setInterval(compute, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [accountId, intervalMs]);

  return metrics;
}
