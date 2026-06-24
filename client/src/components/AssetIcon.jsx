import { useState } from 'react';
import CountryFlag from './CountryFlag';

/**
 * <AssetIcon /> — render an instrument's icon depending on its category:
 *   • CRYPTO      → real coin logo SVG from the cryptocurrency-icons CDN
 *                   (atomic-labs/cryptocurrency-icons via jsDelivr).
 *   • FOREX       → two stacked country-flag PNGs (base + quote).
 *   • COMMODITY   → tile with the periodic-table symbol (Au, Ag, Oil) in
 *                   the commodity's own colour.
 *   • INDEX       → tile with an exchange/index abbreviation in a brand tint.
 *   • Fallback    → grey tile with the first two characters.
 *
 * Pass either explicit props (symbol/baseCurrency/quoteCurrency/category)
 * or `row={instrument}` and we'll read from there.
 */

const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@0.18.1/svg/color/';

// Bases that have an icon in atomic-labs/cryptocurrency-icons. Keep this in
// sync with the CDN — if a coin isn't here, we fall back to a coloured tile.
const CRYPTO_LIST = new Set([
  'btc','eth','sol','xrp','doge','ada','bnb','avax','matic','link',
  'ltc','uni','aave','atom','dot','trx','shib','near','algo','fil',
  'apt','op','arb','sui','mkr','comp','snx','crv','sand','mana',
  'icp','etc','bch','xlm','xmr','xtz','vet','fet','hbar','rune',
  'inj','imx','grt','egld','ftm','axs','sushi','enj','knc','yfi',
]);

// Commodity SVG icons — proper visual representations (gold coin, silver
// coin, oil drum, flame) instead of plain text tiles. Each gradient uses a
// unique ID so multiple icons can co-exist on the same page without
// fill-conflict (browsers scope gradient IDs globally per document).

function GoldIcon({ size }) {
  // Triple-brick stack — two bricks side-by-side at the base, one centered
  // on top. Each brick has a front face + brighter top face for an
  // isometric "looking down" feel. Side-face shading on the rightmost
  // brick + a soft ground shadow under the stack make it read 3D.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <linearGradient id="ai-gold-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FFE17F" />
          <stop offset="45%"  stopColor="#E8B923" />
          <stop offset="100%" stopColor="#8B6914" />
        </linearGradient>
        <linearGradient id="ai-gold-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FFF4C2" />
          <stop offset="100%" stopColor="#F4C430" />
        </linearGradient>
        <linearGradient id="ai-gold-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="#A67C00" />
          <stop offset="100%" stopColor="#6B5410" />
        </linearGradient>
      </defs>

      {/* Ground shadow */}
      <ellipse cx="20" cy="34.5" rx="17" ry="1.6" fill="rgba(0,0,0,0.18)" />

      {/* ── Bottom-left brick ─────────────────────────────────── */}
      <path d="M2.5 23 L18.5 23 L17 33 L5 33 Z"
            fill="url(#ai-gold-face)" stroke="#5C4500" strokeWidth="0.5" />
      <path d="M5 19 L17 19 L18.5 23 L2.5 23 Z"
            fill="url(#ai-gold-top)" stroke="#5C4500" strokeWidth="0.5" />
      {/* highlight strip on the top face */}
      <line x1="7" y1="20.5" x2="15" y2="20.5" stroke="#FFF8D6" strokeWidth="0.5" opacity="0.7" />

      {/* ── Bottom-right brick ────────────────────────────────── */}
      <path d="M21.5 23 L37.5 23 L35 33 L23 33 Z"
            fill="url(#ai-gold-face)" stroke="#5C4500" strokeWidth="0.5" />
      <path d="M23 19 L35 19 L37.5 23 L21.5 23 Z"
            fill="url(#ai-gold-top)" stroke="#5C4500" strokeWidth="0.5" />
      {/* right-side face for depth */}
      <path d="M37.5 23 L35 33 L33.5 32.6 L36 22.8 Z"
            fill="url(#ai-gold-side)" opacity="0.7" />
      <line x1="25" y1="20.5" x2="33" y2="20.5" stroke="#FFF8D6" strokeWidth="0.5" opacity="0.7" />

      {/* ── Top brick (centered, sitting on the two bricks) ───── */}
      <path d="M11 9 L29 9 L27 19 L13 19 Z"
            fill="url(#ai-gold-face)" stroke="#5C4500" strokeWidth="0.5" />
      <path d="M13 4 L27 4 L29 9 L11 9 Z"
            fill="url(#ai-gold-top)" stroke="#5C4500" strokeWidth="0.5" />
      {/* purity stamp on the top brick's top face */}
      <text x="20" y="7.5" textAnchor="middle" fontSize="3" fontWeight="800" fill="#5C4500" fontFamily="Arial">999.9</text>
      {/* subtle horizontal line groove */}
      <line x1="15" y1="14" x2="25" y2="14" stroke="#FFF8D6" strokeWidth="0.4" opacity="0.5" />
    </svg>
  );
}

function SilverIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <radialGradient id="ai-silver" cx="35%" cy="35%" r="75%">
          <stop offset="0%"   stopColor="#F5F7FA" />
          <stop offset="45%"  stopColor="#B7BFC9" />
          <stop offset="100%" stopColor="#5B6470" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill="url(#ai-silver)" stroke="#4B5563" strokeWidth="1" />
      <circle cx="20" cy="20" r="14" fill="none" stroke="#4B5563" strokeWidth="0.6" opacity="0.45" />
      <text x="20" y="25" textAnchor="middle" fontSize="13" fontWeight="900" fill="#374151" fontFamily="Georgia, serif">Ag</text>
    </svg>
  );
}

function CopperIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <radialGradient id="ai-copper" cx="35%" cy="35%" r="75%">
          <stop offset="0%"   stopColor="#FFC089" />
          <stop offset="45%"  stopColor="#C2733A" />
          <stop offset="100%" stopColor="#7A3F12" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill="url(#ai-copper)" stroke="#5C2F0E" strokeWidth="1" />
      <circle cx="20" cy="20" r="14" fill="none" stroke="#5C2F0E" strokeWidth="0.6" opacity="0.45" />
      <text x="20" y="25" textAnchor="middle" fontSize="13" fontWeight="900" fill="#3D1F09" fontFamily="Georgia, serif">Cu</text>
    </svg>
  );
}

function OilIcon({ size }) {
  // Black oil drop — dark gradient + small white highlight.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <radialGradient id="ai-oil" cx="40%" cy="35%" r="70%">
          <stop offset="0%"   stopColor="#475569" />
          <stop offset="60%"  stopColor="#1F2937" />
          <stop offset="100%" stopColor="#0B0F17" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill="url(#ai-oil)" />
      <path d="M20 8c-4 5-6 9-6 13a6 6 0 0 0 12 0c0-4-2-8-6-13z" fill="#0B0F17" stroke="#1F2937" strokeWidth="0.6" />
      <circle cx="17.5" cy="19" r="1.5" fill="#94A3B8" opacity="0.7" />
    </svg>
  );
}

function GasIcon({ size }) {
  // Blue flame — natural gas actually burns blue, so this is both
  // on-brand (no yellow) AND scientifically accurate.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <defs>
        <linearGradient id="ai-gas" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#60A5FA" />
          <stop offset="55%"  stopColor="#2563EB" />
          <stop offset="100%" stopColor="#1E3A8A" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="19" fill="#EFF6FF" stroke="#93C5FD" strokeWidth="1" />
      <path
        d="M20 7c-1 4-5 5-5 11a5 5 0 0 0 10 0c0-3-2-4-2-7 2 2 4 3 4 7a7 7 0 0 1-14 0c0-5 4-7 7-11z"
        fill="url(#ai-gas)"
      />
    </svg>
  );
}

// Map of commodity codes → custom SVG component. Falls back to a tile glyph
// for anything not listed below.
const COMMODITY_ICONS = {
  XAU: GoldIcon, GOLD: GoldIcon, GOLDM: GoldIcon,
  XAG: SilverIcon, SILVER: SilverIcon, SILVERM: SilverIcon,
  WTI: OilIcon, BRENT: OilIcon, USOIL: OilIcon, OIL: OilIcon, CRUDEOIL: OilIcon,
  NGAS: GasIcon, GAS: GasIcon, NATURALGAS: GasIcon,
  COPPER: CopperIcon, COP: CopperIcon,
};

// Fallback text tiles for commodities not in COMMODITY_ICONS above.
const COMMODITY = {
  WHEAT: { glyph: 'WHE', bg: '#A16207' },
  CORN:  { glyph: 'COR', bg: '#CA8A04' },
  ZINC:      { glyph: 'Zn', bg: '#64748B' },
  ALUMINIUM: { glyph: 'Al', bg: '#94A3B8' },
  LEAD:      { glyph: 'Pb', bg: '#475569' },
  NICKEL:    { glyph: 'Ni', bg: '#6B7280' },
};

const INDEX = {
  NAS100: { glyph: 'NQ',  bg: '#0EA5E9' },
  US30:   { glyph: 'DJ',  bg: '#475569' },
  SPX500: { glyph: 'SP',  bg: '#22C55E' },
  GER40:  { glyph: 'DAX', bg: '#1F2937' },
  UK100:  { glyph: 'FT',  bg: '#7C3AED' },
  JPN225: { glyph: 'N',   bg: '#DC2626' },
  HK50:   { glyph: 'HK',  bg: '#EA580C' },
  AUS200: { glyph: 'AU',  bg: '#0EA5E9' },
};

// ── Index / Stock tile glyphs ─────────────────────────────────────────────
// Indian indices and equities have no logo CDN, so instead of plain text
// initials we render a clean white chart glyph on a coloured gradient tile —
// a bar-chart for indices, an up-trend line for stocks. The tile colour is
// derived deterministically from the underlying so every NIFTY tile is the
// same blue, every SBIN tile the same teal, etc. (recognisable at a glance
// without relying on the letters).

// Curated, high-contrast palette (no muddy/low-contrast hues against white).
const TILE_PALETTE = [
  ['#2563EB', '#1E40AF'], ['#7C3AED', '#5B21B6'], ['#0891B2', '#155E75'],
  ['#16A34A', '#15803D'], ['#EA580C', '#C2410C'], ['#DB2777', '#9D174D'],
  ['#0D9488', '#115E59'], ['#CA8A04', '#92600A'], ['#DC2626', '#991B1B'],
  ['#4F46E5', '#3730A3'], ['#0EA5E9', '#0369A1'], ['#9333EA', '#6B21A8'],
];
// Brand-ish tints for the four big indices so they read as "themselves".
const INDEX_TINT = {
  NIFTY: ['#2563EB', '#1E40AF'], BANKNIFTY: ['#7C3AED', '#5B21B6'],
  FINNIFTY: ['#0D9488', '#115E59'], MIDCPNIFTY: ['#EA580C', '#C2410C'],
  SENSEX: ['#DC2626', '#991B1B'],
};
function _tileColor(keyStr) {
  let h = 0;
  for (let i = 0; i < keyStr.length; i++) h = (h * 31 + keyStr.charCodeAt(i)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length];
}

function GlyphTile({ size, round, colors, children }) {
  const g = Math.round(size * 0.58);
  return (
    <span
      className={`keep-white flex items-center justify-center shrink-0 ${round ? 'rounded-full' : 'rounded-xl'}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, ${colors[0]}, ${colors[1]})`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(0,0,0,0.18)',
      }}
    >
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none"
           stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

// Ascending bar-chart → indices.
const IndexGlyph = () => (
  <>
    <rect x="3.5" y="13" width="4" height="7.5" rx="1" fill="#FFFFFF" stroke="none" />
    <rect x="10" y="8.5" width="4" height="12" rx="1" fill="#FFFFFF" stroke="none" opacity="0.85" />
    <rect x="16.5" y="4" width="4" height="16.5" rx="1" fill="#FFFFFF" stroke="none" />
  </>
);
// Up-trend line with arrow head → stocks.
const StockGlyph = () => (
  <>
    <path d="M4 16.5 L9.5 11 L13 14 L20 6.5" />
    <path d="M15.5 6.5 H20 V11" />
  </>
);

function CryptoImage({ symbol, size }) {
  // Some coin logos aren't in the CDN — gracefully fall back to a coloured
  // tile with the ticker if the request 404s.
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="keep-white rounded-full flex items-center justify-center font-bold shrink-0"
        style={{
          width: size,
          height: size,
          background: '#475569',
          color: '#FFFFFF',
          fontSize: Math.round(size * 0.4),
          lineHeight: 1,
          textShadow: '0 1px 1px rgba(0,0,0,0.25)',
        }}
      >
        {symbol.slice(0, 3).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`${CRYPTO_CDN}${symbol}.svg`}
      width={size}
      height={size}
      alt={symbol.toUpperCase()}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0"
      style={{ borderRadius: '50%' }}
    />
  );
}

// Common quote suffixes used by exchanges. We strip these from the
// symbol to infer the base currency when the row doesn't carry one
// (e.g. legacy instruments seeded without baseCurrency/category).
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'BUSD', 'INR', 'EUR', 'GBP', 'JPY', 'AUD', 'BTC', 'ETH'];

function _inferBaseFromSymbol(sym) {
  if (!sym) return '';
  const upper = sym.toUpperCase().replace(/[\/\-_.]/g, '');
  // Longest suffix wins — USDT before USD before USD before T to avoid
  // mis-matching BTCUSD as BTCUSD/T.
  for (const suf of [...QUOTE_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (upper.endsWith(suf) && upper.length > suf.length) {
      return upper.slice(0, upper.length - suf.length);
    }
  }
  return upper;
}

export default function AssetIcon({
  row,
  symbol,
  baseCurrency,
  quoteCurrency,
  category,
  size = 32,
  round = false,
}) {
  const sym   = (symbol        ?? row?.symbol        ?? '').toUpperCase();
  const cat   = (category      ?? row?.category      ?? '').toUpperCase();
  const quote = (quoteCurrency ?? row?.quoteCurrency ?? '').toUpperCase();
  // Resolve a usable base currency. If the row didn't carry one (legacy
  // / partially-seeded data) we infer it by stripping a known quote
  // suffix off the symbol. That makes BTCUSD render the BTC logo even
  // when category/baseCurrency are blank.
  let base = (baseCurrency ?? row?.baseCurrency ?? '').toUpperCase();
  if (!base) base = _inferBaseFromSymbol(sym);
  // Underlying (F&O rows carry it) — used as the colour key so every NIFTY /
  // SBIN contract shares one tile colour regardless of expiry/strike suffix.
  const under = String(row?.underlying || '').toUpperCase();

  // CRYPTO → real coin logo when available. We accept either:
  //   1. an explicit category=CRYPTO row
  //   2. ANY symbol whose inferred base is in our crypto list — covers
  //      seed gaps where category wasn't set on the instrument.
  if (base) {
    const baseLower = base.toLowerCase();
    if (CRYPTO_LIST.has(baseLower) && (cat === 'CRYPTO' || cat === '' || cat === 'OTHER')) {
      return <CryptoImage symbol={baseLower} size={size} />;
    }
  }

  // COMMODITY → custom SVG icon (gold coin, silver coin, oil drop, flame…).
  // F&O commodity futures carry the metal/energy in `underlying` (e.g. GOLD)
  // while symbol is the contract code (GOLD26JULFUT) — check it first.
  if (cat === 'COMMODITY' || COMMODITY_ICONS[under] || COMMODITY_ICONS[base] || COMMODITY_ICONS[sym]) {
    const Icon = COMMODITY_ICONS[under] || COMMODITY_ICONS[base] || COMMODITY_ICONS[sym];
    if (Icon) return <Icon size={size} />;
  }

  // FOREX → two stacked country flags
  if (cat === 'FOREX' && base && quote) {
    const inner = Math.round(size * 0.72);
    const flagW = Math.round(inner * 0.78);
    return (
      <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
        <span
          className="absolute left-0 top-0 rounded-full bg-white border border-border-dark flex items-center justify-center overflow-hidden"
          style={{ width: inner, height: inner }}
        >
          <CountryFlag currency={base} width={flagW} />
        </span>
        <span
          className="absolute right-0 bottom-0 rounded-full bg-white border border-border-dark flex items-center justify-center overflow-hidden"
          style={{ width: inner, height: inner }}
        >
          <CountryFlag currency={quote} width={flagW} />
        </span>
      </span>
    );
  }

  // INDEX → bar-chart glyph tile (Indian indices: NIFTY/BANKNIFTY/… have no
  // logo). US/global indices kept in the INDEX map below still use their short
  // recognisable text glyph (NQ/DJ/SP) so they don't lose identity.
  if (cat === 'INDEX' && !INDEX[sym]) {
    const colorKey = under || base || sym;
    const colors = INDEX_TINT[colorKey] || INDEX_TINT[under] || _tileColor(colorKey);
    return <GlyphTile size={size} round={round} colors={colors}><IndexGlyph /></GlyphTile>;
  }

  // STOCK → up-trend glyph tile (Indian + global equities; no logo CDN). The
  // accompanying symbol label identifies the name; the tile gives a premium,
  // consistent look in place of two-letter initials.
  if (cat === 'STOCK') {
    const colors = _tileColor(under || base || sym);
    return <GlyphTile size={size} round={round} colors={colors}><StockGlyph /></GlyphTile>;
  }

  // COMMODITY / INDEX / fallback → coloured tile with text glyph.
  // Use the resolved BASE for the fallback so BTCUSD shows "BTC" instead
  // of the symbol-prefix "BT" (which scans as a country code, not a coin).
  const fallbackGlyph = (
    under && under.length >= 3 ? under.slice(0, 3)
      : base.length >= 3 ? base.slice(0, 3)
        : base || sym.slice(0, 2) || '?'
  );
  const meta =
    COMMODITY[under] ||
    COMMODITY[base]  ||
    COMMODITY[sym]   ||
    INDEX[sym]       ||
    { glyph: fallbackGlyph, bg: '#475569' };

  // Inline `color: #FFFFFF` + `keep-white` class — Tailwind's text-white
  // gets overridden by global table/typography styles in some surfaces
  // (Orders activity rail, dashboards), which is why the glyph used to
  // render dark-on-dark. Forcing it via inline style guarantees the
  // text is always visible against the coloured tile.
  return (
    <span
      className={`keep-white flex items-center justify-center font-bold shrink-0 ${round ? 'rounded-full' : 'rounded-xl'}`}
      style={{
        width: size,
        height: size,
        background: meta.bg,
        color: '#FFFFFF',
        fontSize: Math.round(size * (meta.glyph.length > 2 ? 0.32 : 0.4)),
        letterSpacing: meta.glyph.length > 2 ? '-0.02em' : '0',
        lineHeight: 1,
        textShadow: '0 1px 1px rgba(0,0,0,0.25)',
      }}
    >
      {meta.glyph}
    </span>
  );
}
