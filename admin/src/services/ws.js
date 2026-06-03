// Minimal WebSocket client for the admin app (the admin app had none —
// it polled). Mirrors the client app's ws.js: subscribe(channel, cb)
// returns an unsubscribe fn; auto-connects with the admin access token and
// reconnects with backoff. Used by the manager Support Chats page.
const _wsExplicit = import.meta.env.VITE_WS_URL;
const _httpBase = import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE;
const _deriveFromHttp = (httpUrl) =>
  httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/api\/?$/, '') + '/ws';
const WS_URL = _wsExplicit || (_httpBase ? _deriveFromHttp(_httpBase) : 'ws://localhost:5000/ws');

class WSClient {
  constructor() {
    this.ws = null;
    this.subscriptions = new Map();
    this.reconnectAttempts = 0;
    this.connected = false;
    this.token = null;
  }

  // Connect (or reconnect) using the current admin access token. Safe to
  // call repeatedly — re-connects only if the token changed or socket is down.
  ensureConnected() {
    const token = localStorage.getItem('admin_accessToken');
    if (!token) return;
    if (this.ws && this.token === token && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.connect(token);
  }

  connect(token) {
    this.token = token;
    const url = token ? `${WS_URL}?token=${token}` : WS_URL;
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (_) {} }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      for (const channel of this.subscriptions.keys()) this._send({ action: 'subscribe', channel });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event' && msg.channel) {
          const base = msg.channel.replace(/^(user:[^:]+):.*$/, '$1');
          const cbs = this.subscriptions.get(msg.channel) || this.subscriptions.get(base);
          if (cbs) cbs.forEach((cb) => cb(msg.data));
        }
      } catch (_) { /* ignore */ }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      this.reconnectAttempts++;
      setTimeout(() => this.connect(localStorage.getItem('admin_accessToken')), delay);
    };
    ws.onerror = () => {};
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  subscribe(channel, callback) {
    this.ensureConnected();
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
    if (!set.size) { this.subscriptions.delete(channel); this._send({ action: 'unsubscribe', channel }); }
  }
}

export const wsClient = new WSClient();
