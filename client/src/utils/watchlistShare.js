// Watchlist import / export / share helpers.
//
// Share is intentionally STATELESS: a watchlist is encoded into a compact
// URL-safe code that the recipient imports as their OWN copy. No server
// record, no public read endpoint, so one user's lists can never leak to
// another — it just carries name + emoji + color + symbols.

const VERSION = 1;

// Unicode-safe base64 (btoa only handles latin1; emoji/names need this).
const b64encode = (str) => btoa(unescape(encodeURIComponent(str)));
const b64decode = (str) => decodeURIComponent(escape(atob(str)));

const symbolsOf = (wl) => (wl.items || []).map((it) => it.symbol);

const normalize = (obj = {}) => ({
  name: String(obj.name ?? obj.n ?? 'Imported watchlist').slice(0, 40),
  emoji: String(obj.emoji ?? obj.e ?? ''),
  color: String(obj.color ?? obj.c ?? ''),
  symbols: (obj.symbols ?? obj.s ?? [])
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean),
});

// ─── Share code (for links / clipboard) ──────────────────────────────
export function encodeWatchlist(wl) {
  const payload = { v: VERSION, n: wl.name, e: wl.emoji || '', c: wl.color || '', s: symbolsOf(wl) };
  return b64encode(JSON.stringify(payload));
}

export function decodeWatchlist(code) {
  return normalize(JSON.parse(b64decode(code)));
}

// Full shareable URL pointing back at the watchlist page with a ?share=code.
export function buildShareLink(wl) {
  const code = encodeWatchlist(wl);
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?share=${code}`;
}

// ─── Export to a downloadable file ───────────────────────────────────
export function exportWatchlistFile(wl) {
  const json = JSON.stringify(
    { type: 'tradepro-watchlist', version: VERSION, name: wl.name, emoji: wl.emoji || '', color: wl.color || '', symbols: symbolsOf(wl) },
    null,
    2,
  );
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(wl.name || 'watchlist').replace(/[^\w-]+/g, '_')}.watchlist.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Parse pasted text / uploaded file into a watchlist payload ──────
// Accepts: our JSON file shape, a raw share code, a JSON array of symbols,
// or a plain comma/space/newline-separated symbol list.
export function parseImport(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Nothing to import');

  // 1) JSON (file export, share payload, or array of symbols)
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return normalize({ symbols: obj });
    return normalize(obj);
  } catch (_) { /* not JSON — fall through */ }

  // 2) Bare share code (base64 of JSON)
  try {
    const decoded = JSON.parse(b64decode(text));
    return normalize(decoded);
  } catch (_) { /* not a code — fall through */ }

  // 3) Delimited symbol list ("BTCUSDT, ETHUSDT\nSOLUSDT")
  const symbols = text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) throw new Error('Could not read any symbols');
  return normalize({ symbols });
}
