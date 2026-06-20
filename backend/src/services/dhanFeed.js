/**
 * Dhan (DhanHQ) feed adapter — live LTP for instruments imported with
 * externalProvider:'DHAN' (NSE cash + NFO F&O). Polls Dhan's Market Quote LTP
 * REST endpoint and publishes ticks like the Angel/OANDA feeds (lastPrice +
 * candle + ticker broadcast). Session-gated via marketHours.
 *
 * Dhan uses a long-lived access token (no TOTP login). Get it from the Dhan
 * web/app → DhanHQ Trading APIs.
 *
 * Setup (.env):
 *   DHAN_CLIENT_ID=your_dhan_client_id
 *   DHAN_ACCESS_TOKEN=your_access_token
 *   DHAN_POLL_MS=2000           (optional)
 *
 * Instruments must carry externalProvider:'DHAN' + instrumentToken (Dhan
 * SECURITY_ID) + exchange (NSE/NFO/...) — set by import-dhan-instruments.js.
 */
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const BASE = 'https://api.dhan.co';
const POLL_MS = Number(process.env.DHAN_POLL_MS) || 2000;
const TIMEOUT_MS = Number(process.env.DHAN_TIMEOUT_MS) || 7000;

// Our exchange → Dhan exchange-segment key for the marketfeed body.
const SEG = { NSE: 'NSE_EQ', BSE: 'BSE_EQ', NFO: 'NSE_FNO', BFO: 'BSE_FNO', MCX: 'MCX_COMM' };

let broadcaster = null;
let active = false;
let _timer = null;

const setBroadcaster = (b) => { broadcaster = b; };
const _credsPresent = () => !!(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN);

async function _post(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'access-token': process.env.DHAN_ACCESS_TOKEN,
        'client-id': process.env.DHAN_CLIENT_ID,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(timer); }
}

async function _publishTick(inst, ltp) {
  const price = Number(ltp).toFixed(inst.pricePrecision || 2);
  await Instrument.updateOne({ _id: inst._id }, { $set: { lastPrice: price, lastPriceUpdatedAt: new Date() } });
  try { await updateCandlesForTrade({ symbol: inst.symbol, price, quantity: '0', ts: Date.now() }); } catch (_) { /* */ }
  if (broadcaster) broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: price, ts: Date.now(), source: 'DHAN' });
}

async function _pollOnce() {
  const insts = await Instrument.find({
    externalProvider: 'DHAN', instrumentToken: { $ne: null }, isActive: true,
  }).select('_id symbol instrumentToken exchange pricePrecision').lean();
  if (!insts.length) return;

  const bySeg = {}; const idMap = new Map();
  for (const i of insts) {
    const seg = SEG[i.exchange] || 'NSE_EQ';
    (bySeg[seg] = bySeg[seg] || []).push(Number(i.instrumentToken));
    idMap.set(`${seg}:${i.instrumentToken}`, i);
  }

  for (const seg of Object.keys(bySeg)) {
    const ids = bySeg[seg];
    for (let k = 0; k < ids.length; k += 1000) { // Dhan LTP cap ~1000/req
      const chunk = ids.slice(k, k + 1000);
      const resp = await _post('/v2/marketfeed/ltp', { [seg]: chunk });
      const data = (resp && resp.data && resp.data[seg]) || {};
      for (const [sid, q] of Object.entries(data)) {
        const inst = idMap.get(`${seg}:${sid}`);
        const px = q && (q.last_price != null ? q.last_price : q.ltp);
        if (inst && px != null) await _publishTick(inst, px);
      }
    }
  }
  try { require('./feedOrchestrator').recordTick('DHAN'); } catch (_) {}
}

async function _loop() {
  if (!active) return;
  let open = true;
  try { open = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { /* default open */ }
  if (open) {
    try {
      await _pollOnce();
      try { require('./feedOrchestrator').recordConnection('DHAN', true); } catch (_) {}
    } catch (e) {
      console.error('[Dhan] poll error:', e.message);
      try { require('./feedOrchestrator').recordError('DHAN', e); } catch (_) {}
    }
  }
  _timer = setTimeout(_loop, open ? POLL_MS : 60000);
}

const start = () => {
  if (!_credsPresent()) {
    console.log('[Dhan] No DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN — Indian live feed disabled (instruments still show, prices static).');
    return;
  }
  if (active) return;
  active = true;
  console.log(`[Dhan] starting market feed (poll ${POLL_MS}ms, NSE session-gated)`);
  _loop().catch((e) => console.error('[Dhan] start error:', e.message));
};

const stop = () => { active = false; if (_timer) { clearTimeout(_timer); _timer = null; } };

module.exports = { start, stop, setBroadcaster, isActive: () => active };
