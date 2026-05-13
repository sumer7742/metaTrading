const express = require('express');
const router = express.Router();

const FALLBACK = Number(process.env.USDINR_FALLBACK) || 83;
const TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 7000;

let cachedRate = FALLBACK;
let cachedAt = 0;
let inflight = null;

const fetchUpstream = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', {
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    const json = await res.json();
    const rate = Number(json && json.rates && json.rates.INR);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('upstream payload invalid');
    return rate;
  } finally {
    clearTimeout(timer);
  }
};

router.get('/usdinr', async (req, res) => {
  const now = Date.now();
  if (now - cachedAt < TTL_MS && cachedAt > 0) {
    return res.json({ rate: cachedRate, source: 'cache', ts: cachedAt });
  }

  if (!inflight) {
    inflight = fetchUpstream()
      .then((rate) => {
        cachedRate = rate;
        cachedAt = Date.now();
        return { rate, source: 'frankfurter', ts: cachedAt };
      })
      .catch((err) => {
        cachedAt = Date.now();
        return { rate: cachedRate, source: 'fallback', ts: cachedAt, error: err.message };
      })
      .finally(() => { inflight = null; });
  }

  const result = await inflight;
  res.json(result);
});

module.exports = router;
