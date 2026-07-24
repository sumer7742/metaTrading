import { api } from './api';

/**
 * Broker terminal API wrapper.
 *
 * Broker-agnostic on purpose — every call takes an optional `broker` code and
 * the backend's BrokerRouter picks the adapter. The UI renders the same
 * screens for Dhan, Upstox or FYERS; the broker catalogue (`listBrokers`) tells
 * it which credential fields to collect and which actions to show. Adding a
 * broker needs no change here.
 *
 * All responses use the platform envelope `{ success, data }`; we return
 * `res.data.data` so callers work with the payload directly.
 */
// Envelope unwrapper. The backend replies `{ success, data }`; most broker
// endpoints then wrap the payload again under a named key (`{ connections }`,
// `{ positions }`, …). Each method below peels to the BARE useful value so
// components never have to know the wrapper shape — that mismatch is exactly
// what caused `connections.filter is not a function`.
const body = (res) => res?.data?.data;
const pick = (key) => (res) => {
  const d = body(res);
  return (d && d[key] !== undefined) ? d[key] : d;
};

export const brokerApi = {
  // ── Catalogue ──  → brokers[]
  listBrokers: () => api.get('/broker/brokers').then(pick('brokers')).then((v) => v || []),

  // ── Connections ──
  listConnections: () => api.get('/broker/connections').then(pick('connections')).then((v) => v || []),
  connect: (payload) => api.post('/broker/connections', payload).then(pick('connection')),
  disconnect: (broker) => api.delete(`/broker/connections/${broker}`).then(body),
  verify: (broker) => api.post(`/broker/connections/${broker}/verify`).then(body),
  setDefault: (broker) => api.patch(`/broker/connections/${broker}/default`).then(pick('connection')),
  startStream: (broker) => api.post(`/broker/connections/${broker}/stream`).then(body),

  // ── Portfolio (query side) ──
  summary: (params) => api.get('/broker/portfolio/summary', { params }).then(body), // { funds, positions, holdings, totals, errors }
  positions: (params) => api.get('/broker/portfolio/positions', { params }).then(pick('positions')).then((v) => v || []),
  holdings: (params) => api.get('/broker/portfolio/holdings', { params }).then(pick('holdings')).then((v) => v || []),
  funds: (params) => api.get('/broker/portfolio/funds', { params }).then(pick('funds')),
  sync: (broker) => api.post('/broker/portfolio/sync', broker ? { broker } : {}).then(body),

  // ── Orders ──
  // The single order endpoint the UI calls for ANY broker.
  place: (payload) => api.post('/orders', payload).then(body),
  modify: (clientOrderId, payload) => api.put(`/orders/${clientOrderId}`, payload).then(body),
  cancel: (clientOrderId) => api.delete(`/orders/${clientOrderId}`).then(body),
  orders: (params) => api.get('/orders', { params }).then(pick('orders')).then((v) => v || []),
  history: (params) => api.get('/orders/history', { params }).then(pick('trades')).then((v) => v || []),
  orderAudit: (clientOrderId) => api.get(`/orders/${clientOrderId}/audit`).then(body),

  // ── Market data ──
  quotes: (params) => api.get('/broker/market/quotes', { params }).then(pick('quotes')).then((v) => v || []),
  marketStatus: (params) => api.get('/broker/market/status', { params }).then(pick('markets')).then((v) => v || []),
};

// Connection statuses that mean "ready to trade".
export const USABLE_STATUSES = ['ACTIVE', 'PENDING'];
export const isUsable = (conn) => conn && USABLE_STATUSES.includes(conn.status);

// Order statuses that are final (no modify/cancel possible).
export const TERMINAL_STATUSES = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'FAILED'];
export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

// Colour intent for a status chip — maps onto the app's bull/bear/muted tokens.
export const statusTone = (status) => {
  if (['FILLED', 'ACTIVE'].includes(status)) return 'bull';
  if (['REJECTED', 'FAILED', 'INVALID', 'EXPIRED', 'ERROR'].includes(status)) return 'bear';
  if (['CANCELLED', 'DISCONNECTED', 'REVOKED'].includes(status)) return 'muted';
  return 'info'; // CREATED/VALIDATED/QUEUED/BROKER_ACCEPTED/EXCHANGE_ACCEPTED/PARTIALLY_FILLED/PENDING/EXPIRED
};
