/**
 * Angel One SmartAPI feed adapter — Indian NSE/BSE cash market data.
 *
 * FREE with an Angel One demat account. This adapter polls the SmartAPI REST
 * quote endpoint (LTP mode) for all instruments tagged externalProvider:'ANGEL'
 * and publishes ticks the same way the OANDA/Binance feeds do (lastPrice +
 * candle aggregation + ticker broadcast). Session-gated via marketHours so it
 * only polls while NSE is open.
 *
 * Why REST polling (not the binary WebSocket) for Phase 1:
 *   - Robust + simple; sub-second binary SmartStream can be added later.
 *   - REST LTP is fine for a B-book MVP (poll every ~2s).
 *
 * Setup (FREE, ~10 min):
 *   1. Open an Angel One account → enable SmartAPI at https://smartapi.angelone.in/
 *   2. Create an app → note the API Key.
 *   3. Enable TOTP (2FA) → save the TOTP secret (base32).
 *   4. Set in .env:
 *        ANGEL_API_KEY=your_smartapi_key
 *        ANGEL_CLIENT_CODE=your_login_id
 *        ANGEL_PIN=your_login_pin
 *        ANGEL_TOTP_SECRET=base32_totp_secret
 *        ANGEL_POLL_MS=2000            (optional)
 *
 * Per instrument (admin), set:
 *   exchange: 'NSE' (or 'BSE'),  segment: 'EQ',
 *   externalProvider: 'ANGEL',   instrumentToken: '<angel symbolToken>'
 *   (token comes from Angel's OpenAPIScripMaster.json — e.g. RELIANCE-EQ = 2885)
 */
const crypto = require('crypto');
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const BASE = 'https://apiconnect.angelone.in';
const POLL_MS = Number(process.env.ANGEL_POLL_MS) || 2000;
const TIMEOUT_MS = Number(process.env.ANGEL_TIMEOUT_MS) || 7000;

let broadcaster = null;
let active = false;
let _timer = null;
let _session = { jwt: null, feedToken: null, exp: 0 };

const setBroadcaster = (b) => { broadcaster = b; };

// ── TOTP (RFC 6238) so we don't need an external dependency ──────────────
function _base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s || '').replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of s) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function _totp(secretBase32) {
  const key = _base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

const _credsPresent = () =>
  !!(process.env.ANGEL_API_KEY && process.env.ANGEL_CLIENT_CODE && process.env.ANGEL_PIN && process.env.ANGEL_TOTP_SECRET);

const _baseHeaders = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-UserType': 'USER',
  'X-SourceID': 'WEB',
  'X-ClientLocalIP': '127.0.0.1',
  'X-ClientPublicIP': '127.0.0.1',
  'X-MACAddress': '00:00:00:00:00:00',
  'X-PrivateKey': process.env.ANGEL_API_KEY,
});

async function _fetchJson(path, { method = 'POST', body, auth = false } = {}) {
  const headers = _baseHeaders();
  if (auth) headers.Authorization = `Bearer ${_session.jwt}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
    });
    if (res.status === 401 || res.status === 403) { _session.jwt = null; _session.exp = 0; }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

// Login (TOTP) → jwt + feed token. Cached for the session day; re-login on expiry/401.
async function _ensureLogin() {
  if (_session.jwt && Date.now() < _session.exp) return _session;
  const totp = _totp(process.env.ANGEL_TOTP_SECRET);
  const j = await _fetchJson('/rest/auth/angelbroking/user/v1/loginByPassword', {
    body: { clientcode: process.env.ANGEL_CLIENT_CODE, password: process.env.ANGEL_PIN, totp },
  });
  if (!j || !j.status || !j.data || !j.data.jwtToken) {
    throw new Error(`Angel login failed: ${j && j.message ? j.message : JSON.stringify(j).slice(0, 200)}`);
  }
  _session = { jwt: j.data.jwtToken, feedToken: j.data.feedToken, exp: Date.now() + 6 * 3600 * 1000 };
  console.log('[Angel] ✓ logged in (SmartAPI)');
  return _session;
}

// One quote sweep across all ANGEL instruments, grouped by exchange, chunked ≤50.
async function _pollOnce() {
  const insts = await Instrument.find({
    externalProvider: 'ANGEL', instrumentToken: { $ne: null }, isActive: true,
  }).select('_id symbol instrumentToken exchange pricePrecision').lean();
  if (!insts.length) return;

  const byExch = {}; const tokenMap = new Map();
  for (const i of insts) {
    const ex = i.exchange || 'NSE';
    (byExch[ex] = byExch[ex] || []).push(String(i.instrumentToken));
    tokenMap.set(`${ex}:${i.instrumentToken}`, i);
  }

  for (const ex of Object.keys(byExch)) {
    const tokens = byExch[ex];
    for (let k = 0; k < tokens.length; k += 50) {
      const chunk = tokens.slice(k, k + 50);
      const resp = await _fetchJson('/rest/secure/angelbroking/market/v1/quote', {
        auth: true, body: { mode: 'LTP', exchangeTokens: { [ex]: chunk } },
      });
      const fetched = (resp && resp.data && resp.data.fetched) || [];
      for (const q of fetched) {
        const inst = tokenMap.get(`${q.exchange}:${q.symbolToken}`);
        if (!inst || q.ltp == null) continue;
        await _publishTick(inst, q.ltp);
      }
    }
  }
  try { require('./feedOrchestrator').recordTick('ANGEL'); } catch (_) {}
}

async function _publishTick(inst, ltp) {
  const price = Number(ltp).toFixed(inst.pricePrecision || 2);
  await Instrument.updateOne({ _id: inst._id }, { $set: { lastPrice: price, lastPriceUpdatedAt: new Date() } });
  try {
    await updateCandlesForTrade({ symbol: inst.symbol, price, quantity: '0', ts: Date.now() });
  } catch (_) { /* ignore */ }
  if (broadcaster) {
    broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: price, ts: Date.now(), source: 'ANGEL' });
  }
}

async function _loop() {
  if (!active) return;
  let open = true;
  try { open = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { /* default open */ }
  if (open) {
    try {
      await _ensureLogin();
      await _pollOnce();
      try { require('./feedOrchestrator').recordConnection('ANGEL', true); } catch (_) {}
    } catch (e) {
      console.error('[Angel] poll error:', e.message);
      try { require('./feedOrchestrator').recordError('ANGEL', e); } catch (_) {}
    }
  }
  // Poll fast while open; idle-check once a minute when closed.
  _timer = setTimeout(_loop, open ? POLL_MS : 60000);
}

/**
 * On-demand historical backfill (1-min/etc candles) via getCandleData.
 * interval e.g. 'ONE_MINUTE','FIVE_MINUTE','ONE_DAY'; dates 'YYYY-MM-DD HH:mm'.
 * Returns [[ts,o,h,l,c,v], ...].
 */
async function backfillCandles({ exchange, symboltoken, interval, fromdate, todate }) {
  await _ensureLogin();
  const resp = await _fetchJson('/rest/secure/angelbroking/historical/v1/getCandleData', {
    auth: true, body: { exchange, symboltoken, interval, fromdate, todate },
  });
  return (resp && resp.data) || [];
}

const start = () => {
  if (!_credsPresent()) {
    console.log('[Angel] No SmartAPI creds — Indian NSE/BSE feed disabled. See services/angelFeed.js header to enable.');
    return;
  }
  if (active) return;
  active = true;
  console.log(`[Angel] starting SmartAPI feed (poll ${POLL_MS}ms, NSE session-gated)`);
  _loop().catch((e) => console.error('[Angel] start error:', e.message));
};

const stop = () => {
  active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
};

module.exports = { start, stop, setBroadcaster, backfillCandles, isActive: () => active, _totp };
