/**
 * Basic AML / sanctions screener.
 *
 * In production, integrate with a real provider:
 *   - Refinitiv World-Check
 *   - ComplyAdvantage
 *   - Sanctions.io
 *   - OFAC SDN List API
 *
 * This MVP uses a simple in-memory blocklist for demonstrating the integration
 * point. Replace `_loadBlocklist` with an API call in production.
 *
 * Doc §12.4: Required for KYC and high-value withdrawal monitoring.
 */

let nameBlocklist = new Set(); // normalized full names
let countryBlocklist = new Set(); // ISO codes
let pepList = new Set(); // Politically Exposed Persons (high-risk, not blocked)

const _loadBlocklist = () => {
  // Static seed list - replace with real provider integration
  const sampleBlocklist = [
    // OFAC examples (truncated; real list has thousands)
    { name: 'OSAMA BIN LADEN', country: 'AF' },
    { name: 'SADDAM HUSSEIN', country: 'IQ' },
    { name: 'TEST BLOCKED USER', country: 'XX' }, // for testing
  ];
  const sampleCountries = ['IR', 'KP', 'SY', 'CU']; // sanctioned countries
  const samplePep = ['VLADIMIR PUTIN', 'TEST PEP USER'];

  nameBlocklist = new Set(sampleBlocklist.map((e) => _normalize(e.name)));
  countryBlocklist = new Set(sampleCountries);
  pepList = new Set(samplePep.map(_normalize));

  console.log(`[AML] Loaded ${nameBlocklist.size} blocked names, ${countryBlocklist.size} blocked countries, ${pepList.size} PEPs`);
};

const _normalize = (s = '') => s.toString().trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Screen a person against the lists. Returns:
 *   { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH', hits: [...], allowed: boolean }
 *
 * - HIGH risk + name match -> blocked
 * - MEDIUM (PEP or sanctioned country) -> requires manual review
 * - LOW -> auto-approve eligible
 */
const screenPerson = ({ firstName, lastName, country }) => {
  const fullName = _normalize(`${firstName || ''} ${lastName || ''}`);
  const hits = [];

  if (fullName && nameBlocklist.has(fullName)) {
    hits.push({ type: 'NAME_BLOCKLIST', match: fullName });
  }
  if (country && countryBlocklist.has(country.toUpperCase())) {
    hits.push({ type: 'SANCTIONED_COUNTRY', match: country });
  }
  if (fullName && pepList.has(fullName)) {
    hits.push({ type: 'PEP', match: fullName });
  }

  let riskLevel = 'LOW';
  let allowed = true;

  if (hits.find((h) => h.type === 'NAME_BLOCKLIST' || h.type === 'SANCTIONED_COUNTRY')) {
    riskLevel = 'HIGH';
    allowed = false;
  } else if (hits.length > 0) {
    riskLevel = 'MEDIUM';
    // Allowed but flagged for manual review
  }

  return { riskLevel, hits, allowed };
};

/**
 * Screen a transaction (deposit/withdrawal) for AML red flags.
 * Returns suspicious activity score 0-100.
 */
const screenTransaction = ({ userId, amount, currency, type, recentTransactions = [] }) => {
  let score = 0;
  const flags = [];

  // Structuring detection: multiple txs just under reporting threshold
  const reportingThreshold = 10000; // USD
  const amt = Number(amount);
  if (amt > reportingThreshold * 0.9 && amt < reportingThreshold) {
    score += 30;
    flags.push('JUST_BELOW_REPORTING_THRESHOLD');
  }

  // Rapid succession of similar amounts
  const sameDayCount = recentTransactions.filter(
    (t) => new Date(t.createdAt) > new Date(Date.now() - 24 * 60 * 60 * 1000)
  ).length;
  if (sameDayCount > 5) {
    score += 25;
    flags.push('HIGH_FREQUENCY_24H');
  }

  // Round-trip detection: deposit followed quickly by withdrawal of similar amount
  if (type === 'WITHDRAWAL' && recentTransactions.find((t) => t.type === 'DEPOSIT' && Math.abs(Number(t.amount) - amt) < amt * 0.05)) {
    score += 40;
    flags.push('ROUND_TRIP_PATTERN');
  }

  // Very large amount
  if (amt > 50000) {
    score += 15;
    flags.push('LARGE_AMOUNT');
  }

  return {
    score,
    flags,
    requiresReview: score >= 50,
    riskLevel: score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
  };
};

// Initialize on module load
_loadBlocklist();

module.exports = { screenPerson, screenTransaction };
