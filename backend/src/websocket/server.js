const WebSocket = require('ws');
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Lightweight WebSocket server.
 *
 * Public channels (no auth required):
 *   - ticker:<symbol>
 *   - orderbook:<symbol>
 *   - trades:<symbol>
 *   - candles:<symbol>:<timeframe>
 *
 * Private channels (require token in connection query: ?token=...):
 *   - user:orders
 *   - user:positions
 *   - user:wallet
 *   - user:notifications
 *   - admin:exposure  (admins only)
 *
 * Client message format:
 *   { action: 'subscribe' | 'unsubscribe', channel: 'orderbook:BTCUSD' }
 */
class WSBroadcaster {
  constructor() {
    this.wss = null;
    // channel -> Set<ws>
    this.subscriptions = new Map();
    this.heartbeatInterval = null;
  }

  attach(server) {
    this.wss = new WebSocket.Server({
      server,
      path: '/ws',
      // Enable per-message deflate compression — saves ~70% bandwidth
      // for repetitive JSON messages (price ticks, order updates).
      // CPU overhead is negligible compared to network savings.
      perMessageDeflate: {
        threshold: 1024, // only compress messages >= 1KB
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        concurrencyLimit: 10,
      },
      // Memory protection — drop messages too large to broadcast
      maxPayload: 1 * 1024 * 1024, // 1MB
    });

    this.wss.on('connection', (ws, req) => {
      ws.subscriptions = new Set();
      ws.userId = null;
      ws.role = null;
      ws.isAlive = true;

      // Try to read token from URL query for private channels.
      // Differentiate auth_error (token expired/invalid) from anonymous so
      // the client can refresh its access token and reconnect cleanly,
      // rather than guessing why a `user:` subscribe later got rejected.
      let authError = null;
      try {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');
        if (token) {
          try {
            const payload = verifyAccessToken(token);
            ws.userId = payload.sub;
            ws.role = payload.role;
          } catch (verr) {
            authError = /expired/i.test(verr.message || '') ? 'expired' : 'invalid';
          }
        }
      } catch (e) {
        // malformed URL — anonymous
      }

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleClientMessage(ws, msg);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        for (const ch of ws.subscriptions) {
          const set = this.subscriptions.get(ch);
          if (set) {
            set.delete(ws);
            if (!set.size) this.subscriptions.delete(ch);
          }
        }
      });

      if (authError) {
        ws.send(JSON.stringify({ type: 'auth_error', reason: authError }));
      }
      ws.send(JSON.stringify({ type: 'connected', authenticated: !!ws.userId }));
    });

    // Heartbeat: ping every 30s; if a client misses two consecutive pongs we
    // terminate it. Without this, idle/NAT-dropped sockets pile up in the
    // subscriptions Map indefinitely (memory leak).
    this.heartbeatInterval = setInterval(() => {
      if (!this.wss) return;
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) { /* ignore */ }
          return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { /* ignore */ }
      });
    }, 30000);

    this.wss.on('close', () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    });

    console.log('[WS] WebSocket server attached at /ws');
  }

  _handleClientMessage(ws, msg) {
    const { action, channel } = msg;
    if (!channel || typeof channel !== 'string') {
      return ws.send(JSON.stringify({ type: 'error', message: 'channel required' }));
    }

    // Auth check for private channels
    if (channel.startsWith('user:') && !ws.userId) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Authentication required for private channel' }));
    }
    if (channel.startsWith('admin:') && !['ADMIN', 'SUPER_ADMIN'].includes(ws.role)) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Admin only' }));
    }

    const userScopedChannel = channel.startsWith('user:') ? `${channel}:${ws.userId}` : channel;

    if (action === 'subscribe') {
      if (!this.subscriptions.has(userScopedChannel)) this.subscriptions.set(userScopedChannel, new Set());
      this.subscriptions.get(userScopedChannel).add(ws);
      ws.subscriptions.add(userScopedChannel);
      ws.send(JSON.stringify({ type: 'subscribed', channel }));
    } else if (action === 'unsubscribe') {
      const set = this.subscriptions.get(userScopedChannel);
      if (set) {
        set.delete(ws);
        if (!set.size) this.subscriptions.delete(userScopedChannel);
      }
      ws.subscriptions.delete(userScopedChannel);
      ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown action' }));
    }
  }

  publish(channel, data) {
    const set = this.subscriptions.get(channel);
    if (!set) return;
    const msg = JSON.stringify({ type: 'event', channel, data });
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // Convenience methods used by matching engine
  broadcastTrade(trade) {
    this.publish(`trades:${trade.symbol}`, trade);
    this.publish(`ticker:${trade.symbol}`, { lastPrice: trade.price, ts: trade.ts });
  }

  broadcastOrderBook(symbol, snapshot) {
    this.publish(`orderbook:${symbol}`, snapshot);
  }

  broadcastCandle(symbol, timeframe, candle) {
    this.publish(`candles:${symbol}:${timeframe}`, candle);
  }

  notifyUser(userId, channel, data) {
    this.publish(`user:${channel}:${userId}`, data);
  }

  // Called by server.js during graceful shutdown — politely close every
  // client socket so the frontend reconnect logic kicks in cleanly
  // instead of seeing TCP resets.
  close() {
    if (!this.wss) return;
    try {
      this.wss.clients.forEach((ws) => {
        try { ws.close(1001, 'Server shutting down'); } catch (_) {}
      });
      this.wss.close();
    } catch (_) { /* nothing to do — we're going down */ }
  }
}

module.exports = new WSBroadcaster();
