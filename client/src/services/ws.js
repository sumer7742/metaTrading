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
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      // Re-subscribe to all channels
      for (const channel of this.subscriptions.keys()) {
        this._send({ action: 'subscribe', channel });
      }
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'event' && msg.channel) {
          // strip user id suffix on user channels
          const baseChannel = msg.channel.replace(/^(user:[^:]+):.*$/, '$1');
          const cbs = this.subscriptions.get(msg.channel) || this.subscriptions.get(baseChannel);
          if (cbs) cbs.forEach((cb) => cb(msg.data));
        }
      } catch (err) {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      // Reconnect with backoff
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
      this.reconnectAttempts++;
      setTimeout(() => this.connect(this.token), delay);
    };

    this.ws.onerror = () => {};
  }

  _send(obj) {
    if (this.ws && this.connected) this.ws.send(JSON.stringify(obj));
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
