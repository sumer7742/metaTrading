import { getImpersonationToken } from './impersonation';

// WS URL derives from VITE_WS_URL if set, else from the HTTP API URL
// (swap https→wss, http→ws, append /ws). Means deploy only needs to
// set one env var — VITE_API_URL — and WebSocket follows automatically.
const _wsExplicit = import.meta.env.VITE_WS_URL;
const _httpBase = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE;
const _deriveFromHttp = (httpUrl) =>
  httpUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/api\/?$/, '') + '/ws';
const WS_URL = _wsExplicit
  || (_httpBase ? _deriveFromHttp(_httpBase) : 'ws://localhost:5000/ws');

class WSClient {
  constructor() {
    this.ws = null;
    this.subscriptions = new Map(); // channel -> Set<callback>
    this.reconnectAttempts = 0;
    this.connected = false;
    this.token = null;
  }

  connect(token) {
    this.token = token;
    const url = token ? `${WS_URL}?token=${token}` : WS_URL;
    // Close any prior socket before swapping the reference so a late
    // onclose from the old one doesn't trigger a second reconnect race.
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.close(); } catch (_) {}
    }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      // Only the CURRENT socket can flip `connected` and replay
      // subscriptions. If a stale socket's onopen fires after a
      // reconnect, ignore it (its sends would hit a CONNECTING new
      // socket and throw `InvalidStateError`).
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      for (const channel of this.subscriptions.keys()) {
        this._send({ action: 'subscribe', channel });
      }
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event' && msg.channel) {
          const baseChannel = msg.channel.replace(/^(user:[^:]+):.*$/, '$1');
          const cbs = this.subscriptions.get(msg.channel) || this.subscriptions.get(baseChannel);
          if (cbs) cbs.forEach((cb) => cb(msg.data));
        }
      } catch (err) { /* ignore */ }
    };

    ws.onclose = () => {
      // Stale onclose (from a socket we already replaced) shouldn't
      // schedule another reconnect — that snowballs into a thundering
      // herd of sockets.
      if (this.ws !== ws) return;
      this.connected = false;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      this.reconnectAttempts++;
      // Reconnect with the FRESHEST token, not the one we first connected
      // with. After an access-token refresh the original token is stale — a
      // reconnect (server restart, network blip, heartbeat timeout) that
      // reused it would come back anonymous, and every private channel
      // (user:notifications, chat, orders…) would be silently rejected until
      // a full page reload. Mirrors the admin ws client.
      setTimeout(() => this.connect(this._currentToken()), delay);
    };

    ws.onerror = () => {};
  }

  // The current live access token — impersonation (tab-scoped) wins over a
  // real login, matching how auth.init picks the token for the first connect.
  _currentToken() {
    try { return getImpersonationToken() || localStorage.getItem('accessToken') || null; }
    catch (_) { return this.token; }
  }

  // Defensive send: only attempts when the socket is OPEN. Browsers
  // throw `InvalidStateError` if the send is dispatched while the
  // socket is still CONNECTING (or CLOSING/CLOSED).
  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) { /* throw absorbed — network race */ }
  }

  subscribe(channel, callback) {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      this._send({ action: 'subscribe', channel });
    }
    this.subscriptions.get(channel).add(callback);
    return () => this.unsubscribe(channel, callback);
  }

  unsubscribe(channel, callback) {
    const set = this.subscriptions.get(channel);
    if (!set) return;
    set.delete(callback);
    if (!set.size) {
      this.subscriptions.delete(channel);
      this._send({ action: 'unsubscribe', channel });
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscriptions.clear();
  }
}

export const wsClient = new WSClient();
