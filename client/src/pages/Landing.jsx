import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CmsFooter from '../components/CmsFooter';
import LandingHeader from '../components/LandingHeader';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

/**
 * Pre-login marketing landing page. Fully public — the only network call is the
 * public /instruments/watchlist feed that powers the live price ticker, and it
 * falls back to a static showcase list if that's unreachable, so the page always
 * renders. Built on the app's light design system (#1D4ED8 primary, bull/bear
 * accents). Reuses the CMS footer.
 *
 * Section order mirrors the reference marketing layout: Hero → Ticker →
 * Trust badges → Why Choose → Everything you need → Built for Every Trader
 * → Markets → Platform → Protected banner → How It Works →
 * Why Traders Love TradePro (testimonials + merged benefit badges) →
 * App download → Final CTA.
 */

const TICKER = [
  { s: 'BTC/USD', p: '67,420.50', c: +1.84 },
  { s: 'ETH/USD', p: '3,512.20', c: +2.31 },
  { s: 'EUR/USD', p: '1.16060', c: -0.12 },
  { s: 'XAU/USD', p: '2,348.10', c: +0.64 },
  { s: 'AAPL', p: '227.85', c: +0.92 },
  { s: 'TSLA', p: '248.40', c: -1.27 },
  { s: 'GBP/USD', p: '1.27310', c: +0.08 },
  { s: 'NAS100', p: '20,114.0', c: +1.05 },
  { s: 'USOIL', p: '78.92', c: -0.45 },
  { s: 'SOL/USD', p: '174.30', c: +4.12 },
];

const FEATURES = [
  { icon: 'bolt', title: 'Lightning execution', body: 'Ultra-low-latency matching engine fills your orders in milliseconds, even at peak volume.' },
  { icon: 'chart', title: 'Pro charting', body: '100+ indicators, full TradingView-style drawing tools and multi-chart layouts.' },
  { icon: 'copy', title: 'Copy trading', body: 'Mirror top traders automatically — set your allocation and let it run.' },
  { icon: 'shield', title: 'Bank-grade security', body: '2FA, encrypted sessions and segregated funds keep your capital protected.' },
  { icon: 'coins', title: 'Tight spreads', body: 'Institutional pricing with transparent, low commissions across every market.' },
  { icon: 'support', title: '24/7 support', body: 'Real humans, round the clock, in chat and helpdesk whenever you need them.' },
  { icon: 'risk', title: 'Risk management', body: 'Built-in stop-loss, take-profit and margin alerts to protect your capital.' },
  { icon: 'phone', title: 'Mobile trading', body: 'Full-featured apps on iOS and Android — trade and monitor on the go.' },
];

// Per-feature colorful logo gradients (badge bg) + matching soft shadows.
const FEAT_GRAD = {
  bolt:    'linear-gradient(135deg,#FBBF24 0%,#F97316 100%)',
  chart:   'linear-gradient(135deg,#38BDF8 0%,#3B82F6 100%)',
  copy:    'linear-gradient(135deg,#A78BFA 0%,#6366F1 100%)',
  shield:  'linear-gradient(135deg,#34D399 0%,#059669 100%)',
  coins:   'linear-gradient(135deg,#FB7185 0%,#EC4899 100%)',
  support: 'linear-gradient(135deg,#22D3EE 0%,#0EA5E9 100%)',
  globe:   'linear-gradient(135deg,#60A5FA 0%,#2563EB 100%)',
  lock:    'linear-gradient(135deg,#34D399 0%,#10B981 100%)',
  rupee:   'linear-gradient(135deg,#FBBF24 0%,#F59E0B 100%)',
  clock:   'linear-gradient(135deg,#22D3EE 0%,#3B82F6 100%)',
  grid:    'linear-gradient(135deg,#A78BFA 0%,#8B5CF6 100%)',
  deposit: 'linear-gradient(135deg,#34D399 0%,#059669 100%)',
  risk:    'linear-gradient(135deg,#FB7185 0%,#F43F5E 100%)',
  phone:   'linear-gradient(135deg,#818CF8 0%,#6366F1 100%)',
  _default:'linear-gradient(135deg,#60A5FA 0%,#3B82F6 100%)',
};
const FEAT_SH = {
  bolt: 'rgba(249,115,22,0.40)', chart: 'rgba(59,130,246,0.40)', copy: 'rgba(99,102,241,0.40)',
  shield: 'rgba(16,185,129,0.40)', coins: 'rgba(236,72,153,0.40)', support: 'rgba(14,165,233,0.40)',
  risk: 'rgba(244,63,94,0.40)', phone: 'rgba(99,102,241,0.40)',
};

const BADGES = [
  { icon: 'shield', color: '#3B82F6', title: 'Bank-level Security', body: 'Your funds and data are always protected with top-tier security.', tag: 'Across all markets' },
  { icon: 'bolt', color: '#22C55E', title: '24/7 Market Access', body: 'Trade anytime, anywhere with round-the-clock market access.', tag: 'Global presence' },
  { icon: 'percent', color: '#F59E0B', title: 'Low Trading Fees', body: 'Enjoy ultra-low fees and keep more of what you earn.', tag: 'Always open' },
  { icon: 'support', color: '#8B5CF6', title: '24/7 Live Support', body: 'Our support team is always here to help you succeed.', tag: 'Reliable & secure' },
];

// Dummy person photos for the "Trusted by 1M+" social-proof row. Uses the
// pravatar placeholder service; falls back to a tinted circle if it fails.
const AVATARS = [
  { src: 'https://i.pravatar.cc/80?img=12', bg: '#60A5FA' },
  { src: 'https://i.pravatar.cc/80?img=45', bg: '#F472B6' },
  { src: 'https://i.pravatar.cc/80?img=32', bg: '#34D399' },
  { src: 'https://i.pravatar.cc/80?img=5', bg: '#FBBF24' },
];

const WHY = [
  { icon: 'globe', title: 'Global Market Access', body: 'Trade thousands of assets across crypto, forex, stocks, commodities and indices — all from one account.' },
  { icon: 'bolt', title: 'Lightning-Fast Execution', body: 'Orders filled in milliseconds by a low-latency engine, even during peak volume.' },
  { icon: 'coins', title: 'Zero Hidden Fees', body: 'Transparent pricing with no surprise charges. What you see is what you pay.' },
  { icon: 'lock', title: '256-bit Encryption', body: 'Bank-grade encryption and 2FA keep your account and funds fully protected.' },
  { icon: 'rupee', title: '₹0 Free to Start', body: 'No signup fees and a free demo balance to practice risk-free before going live.' },
  { icon: 'clock', title: '24/7 Access', body: 'Markets, charts and support available round the clock, any day of the year.' },
  { icon: 'grid', title: '500+ Options', body: 'A huge catalogue of instruments and order types to build any strategy.' },
  { icon: 'deposit', title: 'Instant Deposits & Withdrawals', body: 'Fund and cash out quickly with multiple secure payment methods.' },
];

const BUILT = [
  { icon: 'coins', title: 'Spot Trading', body: 'Buy and sell your favourite assets instantly.' },
  { icon: 'chart', title: 'Advanced Charts', body: 'Pro tools with real-time data and market depth.' },
  { icon: 'shield', title: 'Safe & Reliable', body: 'Industry-leading security you can depend on.' },
  { icon: 'bolt', title: 'Quick Execution', body: 'Fast order execution with zero delays.' },
];

const MARKETS = [
  { name: 'Crypto', desc: '500+ Assets', c: +0.42, icon: 'crypto' },
  { name: 'Forex', desc: 'Major Pairs', c: -0.32, icon: 'fx' },
  { name: 'Stocks', desc: 'Global Stocks', c: +0.62, icon: 'stock' },
  { name: 'Commodities', desc: 'Gold, Oil & more', c: +0.42, icon: 'oil' },
  { name: 'Indices', desc: 'Global Indices', c: +0.42, icon: 'index' },
];

// Landing card name → Instrument.category enum. Drives the LIVE per-category
// average % change pulled from the public watchlist feed (the `c` above is only
// a static fallback used while loading / if the feed is unreachable).
const MARKET_CATEGORY = {
  Crypto: 'CRYPTO',
  Forex: 'FOREX',
  Stocks: 'STOCK',
  Commodities: 'COMMODITY',
  Indices: 'INDEX',
};

const STATS = [
  { v: '₹0', l: 'Free to start' },
  { v: '24/7', l: 'Platform access' },
  { v: '99.98%', l: 'Uptime' },
  { v: '256-bit', l: 'Encryption' },
];

const STEPS = [
  { n: '1', title: 'Create Account', body: 'Sign up in under two minutes — instant demo balance, no paperwork.' },
  { n: '2', title: 'Verify Identity', body: 'Quick KYC unlocks real-money trading and fast withdrawals.' },
  { n: '3', title: 'Deposit Funds', body: 'Top up securely with your preferred payment method.' },
  { n: '4', title: 'Start Trading', body: 'Trade 500+ markets with pro tools, copy trading and live analytics.' },
];

const TESTIMONIALS = [
  { name: 'Rahul Sharma', role: 'Professional Trader', init: 'RS', img: 'https://i.pravatar.cc/96?img=13', quote: 'TradePro is by far the best platform I have used. The execution speed and low fees are unmatched — I have moved all my trading here.' },
  { name: 'Sarah Williams', role: 'Crypto Investor', init: 'SW', img: 'https://i.pravatar.cc/96?img=47', quote: 'I have been trading crypto for years and this is the fastest, most reliable terminal I have come across. Highly recommended.' },
  { name: 'Michael Chen', role: 'Day Trader', init: 'MC', img: 'https://i.pravatar.cc/96?img=33', quote: 'The platform is super fast and reliable. I can trade anywhere, anytime, on any device, without any interruptions.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col bg-white text-text-primary overflow-x-hidden">
      <LandingStyles />
      <LandingHeader />
      <main className="flex-1">
        <Ticker />
        <Hero />
        <TrustBadges />
        <WhyChoose />
        <Features />
        <BuiltForEveryTrader />
        <Markets />
        <Platform />
        <ProtectedBanner />
        <Steps />
        <Testimonials />
        <AppDownload />
        <FinalCTA />
      </main>
      <CmsFooter />
    </div>
  );
}

/* ───────────────────────────── Hero ───────────────────────────── */
function Hero() {
  const grad = { background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  return (
    <section id="top" className="relative">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-[480px] h-[480px] rounded-full opacity-[0.18] blur-3xl" style={{ background: 'radial-gradient(circle,#1D4ED8,transparent 70%)' }} />
        <div className="absolute top-40 -left-32 w-[420px] h-[420px] rounded-full opacity-[0.12] blur-3xl" style={{ background: 'radial-gradient(circle,#00C853,transparent 70%)' }} />
      </div>
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-6 pt-8 pb-6 lg:pt-10 lg:pb-6 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <span className="badge-primary mb-5">● Secure &amp; safe · Always open market · Low fees on trades</span>
          <h1 className="text-[40px] leading-[1.08] sm:text-[56px] font-extrabold tracking-tight">
            Trade <span style={grad}>Free</span> Forever
          </h1>
          <div className="mt-2 flex items-center gap-2.5 text-2xl sm:text-4xl font-extrabold tracking-tight">
            <span style={grad}>Always Open</span>
            <span className="keep-white inline-flex w-8 h-8 sm:w-10 sm:h-10 rounded-xl items-center justify-center shrink-0" style={{ background: '#1D4ED8', color: '#FFFFFF' }}><FeatureIcon name="shield" /></span>
            <span style={{ background: 'linear-gradient(90deg,#10B981,#14B8A6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Always Free</span>
          </div>
          <p className="mt-5 text-lg text-text-secondary max-w-xl">
            Your gateway to unlimited, ultra-low-commission trading. With 24/7 market access and round-the-clock support, you can learn, practice and trade without limits — simple, secure and built for traders of all levels.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/register" className="keep-white inline-flex items-center gap-2 text-base font-bold px-7 py-3.5 rounded-lg shadow-elevated hover:shadow-xl transition-shadow" style={{ background: 'linear-gradient(90deg,#2563EB 0%,#10B981 100%)', color: '#FFFFFF' }}>Start trading free →</Link>
            <Link to="/login" className="btn-ghost text-base px-7 py-3.5">Sign in</Link>
          </div>
          <div className="mt-7 flex items-center gap-3">
            <div className="flex -space-x-2.5">
              {AVATARS.map((a, i) => (
                <img
                  key={i}
                  src={a.src}
                  alt="Trader"
                  loading="lazy"
                  className="w-8 h-8 rounded-full border-2 border-white shrink-0 object-cover"
                  style={{ background: a.bg }}
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                />
              ))}
            </div>
            <div>
              <div className="flex gap-0.5">
                {[0, 1, 2, 3, 4].map((i) => (
                  <svg key={i} width="14" height="14" viewBox="0 0 24 24" fill="#F59E0B" stroke="none"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 21.2l1.5-6.8L2.2 9.7l6.9-.7z" /></svg>
                ))}
              </div>
              <div className="text-sm text-text-muted font-medium">Trusted by over 1M+ traders worldwide</div>
            </div>
          </div>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

function HeroVisual() {
  return (
    <div className="relative">
      <div className="card p-5 shadow-elevated relative z-10">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-md bg-primary-500/10 text-primary-600 flex items-center justify-center font-bold text-xs">₿</span>
            <div>
              <div className="text-sm font-bold leading-tight">BTC / USD</div>
              <div className="text-[11px] text-text-muted leading-tight">Bitcoin</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-bold font-mono">67,420.50</div>
            <div className="text-[11px] font-bold text-bull">+1.84%</div>
          </div>
        </div>
        <ChartSVG />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="keep-white rounded-lg py-2.5 text-center font-bold text-sm" style={{ background: '#00C853', color: '#fff' }}>Buy</div>
          <div className="keep-white rounded-lg py-2.5 text-center font-bold text-sm" style={{ background: '#FF3B57', color: '#fff' }}>Sell</div>
        </div>
      </div>
      <div className="hidden sm:block absolute -left-6 bottom-10 z-20 card px-4 py-3 shadow-elevated float-a">
        <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider">Today's P&amp;L</div>
        <div className="text-lg font-extrabold text-bull">+$2,847.20</div>
      </div>
      <div className="hidden sm:block absolute -right-4 top-6 z-20 card px-4 py-3 shadow-elevated float-b">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-full bg-bull/15 text-bull flex items-center justify-center"><Check /></span>
          <div>
            <div className="text-xs font-bold">Order filled</div>
            <div className="text-[10px] text-text-muted">0.5 BTC · market</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartSVG() {
  const candles = [
    [40, 70, 35, 75], [60, 85, 55, 90], [50, 78, 45, 80], [72, 96, 66, 100], [60, 80, 58, 84],
    [78, 104, 70, 110], [92, 120, 86, 124], [80, 108, 74, 112], [100, 132, 94, 138], [120, 150, 112, 156],
    [108, 138, 102, 144], [128, 160, 120, 168],
  ];
  return (
    <svg viewBox="0 0 360 180" className="w-full h-[160px]" preserveAspectRatio="none">
      <defs>
        <linearGradient id="lndFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1D4ED8" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#1D4ED8" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0,150 L30,140 L60,148 L90,120 L120,128 L150,96 L180,104 L210,72 L240,80 L270,52 L300,60 L330,34 L360,40 L360,180 L0,180 Z" fill="url(#lndFill)" />
      <path className="lnd-line" d="M0,150 L30,140 L60,148 L90,120 L120,128 L150,96 L180,104 L210,72 L240,80 L270,52 L300,60 L330,34 L360,40"
        fill="none" stroke="#1D4ED8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {candles.map((c, i) => {
        const x = 14 + i * 29;
        const up = i % 3 !== 1;
        const col = up ? '#00C853' : '#FF3B57';
        const [a, b] = [180 - c[1], 180 - c[0]];
        const [wTop, wBot] = [180 - c[3], 180 - c[2]];
        return (
          <g key={i} opacity="0.85">
            <line x1={x} y1={wTop} x2={x} y2={wBot} stroke={col} strokeWidth="1.4" />
            <rect x={x - 4} y={Math.min(a, b)} width="8" height={Math.max(4, Math.abs(b - a))} rx="1.5" fill={col} />
          </g>
        );
      })}
      <circle className="lnd-dot" cx="330" cy="34" r="4" fill="#1D4ED8" />
    </svg>
  );
}

/* ───────────────────────────── Ticker ───────────────────────────── */
function Ticker() {
  // Live public price feed — pulls the same public `/instruments/watchlist`
  // endpoint the in-app market rail uses (no auth required), refreshed every
  // 10s. While it loads, or if the backend is unreachable, we fall back to the
  // static TICKER showcase so the marquee is never empty for a first visitor.
  const [live, setLive] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => api.get('/instruments/watchlist')
      .then((r) => {
        if (!on) return;
        const rows = (r.data?.data || [])
          .filter((x) => Number(x.lastPrice) > 0)
          .slice(0, 14)
          .map((x) => ({
            s: x.symbol,
            p: fmtNum(Number(x.lastPrice), Math.min(x.pricePrecision || 2, 5)),
            c: Number.isFinite(Number(x.change24h)) ? Number(x.change24h) : 0,
          }));
        if (rows.length) setLive(rows);
      })
      .catch(() => { /* keep the static fallback */ });
    load();
    const id = setInterval(load, 10000);
    return () => { on = false; clearInterval(id); };
  }, []);

  const data = live && live.length ? live : TICKER;
  const row = [...data, ...data];
  return (
    <div className="border-y border-border-subtle bg-bg-card/60 py-3 overflow-hidden">
      <div className="lnd-marquee flex gap-8 w-max">
        {row.map((t, i) => (
          <div key={i} className="flex items-center gap-2 text-sm whitespace-nowrap">
            <span className="font-bold">{t.s}</span>
            <span className="font-mono text-text-secondary">{t.p}</span>
            <span className={`font-bold ${t.c >= 0 ? 'text-bull' : 'text-bear'}`}>{t.c >= 0 ? '▲' : '▼'} {Math.abs(t.c).toFixed(2)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Trust badges row ───────────────────────── */
function TrustBadges() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-2 pb-6">
      <div className="card p-5 sm:p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-5 divide-y sm:divide-y-0 lg:divide-x divide-border-subtle">
          {BADGES.map((b) => (
            <div key={b.title} className="flex flex-col pt-5 sm:pt-0 lg:px-5 first:pt-0 first:lg:pl-0 last:lg:pr-0">
              <div className="flex items-start gap-3">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${b.color}15`, color: b.color }}><FeatureIcon name={b.icon} /></span>
                <div className="min-w-0">
                  <div className="text-sm font-bold">{b.title}</div>
                  <p className="text-[11px] text-text-muted mt-0.5 leading-snug">{b.body}</p>
                </div>
              </div>
              <div className="text-[11px] font-semibold text-text-secondary mt-2.5 pt-2 border-t border-border-subtle">{b.tag}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Why choose (8) ───────────────────────── */
function WhyChoose() {
  return (
    <section id="why" className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
      <SectionHead eyebrow="Why Choose Us" title="Why Choose TradePro?" sub="Everything you need to trade with confidence — speed, security and total transparency." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
        {WHY.map((w) => (
          <div key={w.title} className="card p-5 hover:border-primary-500/40 hover:shadow-elevated transition-all">
            <span className="keep-white w-12 h-12 rounded-xl flex items-center justify-center mb-3" style={{ background: FEAT_GRAD[w.icon] || FEAT_GRAD._default, color: '#fff', boxShadow: `0 8px 18px ${FEAT_SH[w.icon] || 'rgba(59,130,246,0.35)'}` }}><FeatureIcon name={w.icon} /></span>
            <h3 className="text-base font-bold">{w.title}</h3>
            <p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{w.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────── Everything you need (8) ───────────────── */
function Features() {
  return (
    <section id="features" className="bg-bg-card/50 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
        <SectionHead eyebrow="Features" title="Everything a Trader Needs" sub="A complete terminal built for speed, depth and control." />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="card p-6 hover:border-primary-500/40 hover:shadow-elevated transition-all group bg-white"
            >
              <div
                className="keep-white relative overflow-hidden w-12 h-12 rounded-xl flex items-center justify-center mb-4 group-hover:scale-105 transition-transform"
                style={{ background: FEAT_GRAD[f.icon] || FEAT_GRAD._default, color: '#FFFFFF', boxShadow: `0 8px 18px ${FEAT_SH[f.icon] || 'rgba(59,130,246,0.4)'}` }}
              >
                <span className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 30% 12%, rgba(255,255,255,0.45), transparent 60%)' }} />
                <span className="relative"><FeatureIcon name={f.icon} /></span>
              </div>
              <h3 className="text-base font-bold">{f.title}</h3>
              <p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────── Built for every trader (4) ─────────────────── */
function BuiltForEveryTrader() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
      <SectionHead eyebrow="For Everyone" title="Built for Every Trader" sub="Whether you're just starting or a pro, TradePro gives you the tools, flexibility and freedom to trade your way." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
        {BUILT.map((b) => (
          <div key={b.title} className="card p-6 text-center hover:border-primary-500/40 hover:shadow-elevated transition-all">
            <span className="keep-white w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: FEAT_GRAD[b.icon] || FEAT_GRAD._default, color: '#fff', boxShadow: `0 10px 22px ${FEAT_SH[b.icon] || 'rgba(59,130,246,0.35)'}` }}><FeatureIcon name={b.icon} /></span>
            <h3 className="text-base font-bold">{b.title}</h3>
            <p className="mt-1.5 text-sm text-text-secondary">{b.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────── Trade every market ─────────────────────── */
// Coin-style token (crypto / forex) — gradient disc with a white rim + top
// shine so it reads as a minted coin rather than a flat chip.
function Coin({ from, to, ring = 'rgba(255,255,255,0.55)', children }) {
  return (
    <span
      className="keep-white relative w-12 h-12 rounded-full flex items-center justify-center text-[18px] font-black border-2 border-white"
      style={{ background: `radial-gradient(120% 120% at 32% 22%, ${from} 0%, ${to} 82%)`, color: '#fff', boxShadow: '0 7px 16px rgba(15,23,42,0.30), inset 0 -3px 6px rgba(0,0,0,0.28), inset 0 2px 4px rgba(255,255,255,0.5)' }}
    >
      <span className="pointer-events-none absolute inset-[3px] rounded-full" style={{ border: `1.5px solid ${ring}` }} />
      <span className="pointer-events-none absolute inset-0 rounded-full" style={{ background: 'radial-gradient(58% 42% at 32% 22%, rgba(255,255,255,0.55), transparent 72%)' }} />
      <span className="relative leading-none">{children}</span>
    </span>
  );
}
// White disc holding a brand logo (stocks) — subtle border + shadow so the
// mark floats like a real app icon in both light and dark themes.
function LogoDisc({ tint = '#111827', children }) {
  return (
    <span className="keep-white w-11 h-11 rounded-full bg-white flex items-center justify-center border border-border-subtle shadow-md" style={{ color: tint }}>
      {children}
    </span>
  );
}
const AppleGlyph = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 1.6c0 1.2-.5 2.3-1.3 3.1-.9.9-2 1.5-3.1 1.4-.1-1.2.5-2.4 1.2-3.1.9-.9 2.2-1.5 3.2-1.4zM20 17.1c-.5 1.2-.8 1.7-1.4 2.7-.9 1.4-2.2 3.1-3.8 3.1-1.4 0-1.8-.9-3.7-.9s-2.3.9-3.7.9c-1.6 0-2.8-1.6-3.7-2.9C1.3 17.1.9 12.4 2.5 9.9c1-1.6 2.7-2.6 4.2-2.6 1.6 0 2.6.9 3.9.9 1.3 0 2.1-.9 3.9-.9 1.4 0 2.8.7 3.8 2-3.3 1.8-2.8 6.6.7 7.8z" /></svg>;
const TeslaGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3.2 5.6C6 4.5 9 4 12 4s6 .5 8.8 1.6l-.9 1.9c-1.2-.4-2.5-.7-3.8-.9l-1.2 1.9c-.9-.13-1.9-.2-2.9-.2s-2 .07-2.9.2L7.9 6.6c-1.3.2-2.6.5-3.8.9L3.2 5.6z" />
    <rect x="11" y="7.9" width="2" height="11.1" rx="0.5" />
  </svg>
);
const AmazonGlyph = () => (
  <span className="relative flex items-center justify-center font-black text-[19px] leading-none" style={{ color: '#111827' }}>
    a
    <svg className="absolute left-1/2 -translate-x-1/2 -bottom-1" width="24" height="9" viewBox="0 0 24 9" fill="none">
      <path d="M2 2.4c5.2 3.4 14.8 3.4 20 0" stroke="#FF9900" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M20.4 1l2.4 1.3-2.6 1z" fill="#FF9900" />
    </svg>
  </span>
);
const GoldBars = () => (
  <svg width="40" height="32" viewBox="0 0 40 32" aria-hidden="true">
    <defs>
      <linearGradient id="ldgoldF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FCD34D" /><stop offset="1" stopColor="#C2740A" /></linearGradient>
    </defs>
    <g stroke="#92400E" strokeWidth="0.6" strokeLinejoin="round">
      {/* bottom-left bar — front face + lighter 3D top face */}
      <path d="M3 30h13l-1.4-6H4.4z" fill="url(#ldgoldF)" />
      <path d="M4.4 24h11.2l2.2-2.6H6.6z" fill="#FDE68A" />
      {/* bottom-right bar */}
      <path d="M21 30h13l-1.4-6H22.4z" fill="url(#ldgoldF)" />
      <path d="M22.4 24h11.2l2.2-2.6H24.6z" fill="#FDE68A" />
      {/* top bar */}
      <path d="M12 22h13l-1.4-6H13.4z" fill="url(#ldgoldF)" />
      <path d="M13.4 16h11.2l2.2-2.6H15.6z" fill="#FEF3C7" />
    </g>
  </svg>
);
const OilBarrel = () => (
  <svg width="26" height="32" viewBox="0 0 26 32" aria-hidden="true">
    <defs>
      <linearGradient id="ldbarrel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#1E293B" /><stop offset="0.5" stopColor="#0B1220" /><stop offset="1" stopColor="#020617" /></linearGradient>
    </defs>
    <rect x="4" y="4" width="18" height="24" rx="3.4" fill="url(#ldbarrel)" />
    <ellipse cx="13" cy="4.6" rx="9" ry="2.6" fill="#334155" />
    <path d="M8.5 4.6v23" stroke="rgba(255,255,255,0.16)" strokeWidth="2" strokeLinecap="round" />
    <rect x="4" y="10.4" width="18" height="1.9" rx="0.6" fill="#F59E0B" opacity="0.9" />
    <rect x="4" y="19.4" width="18" height="1.9" rx="0.6" fill="#F59E0B" opacity="0.9" />
    <path d="M13 13.4c1.8 2 2.9 3.5 2.9 4.9a2.9 2.9 0 0 1-5.8 0c0-1.4 1.1-2.9 2.9-4.9z" fill="#FBBF24" />
  </svg>
);
const IndexChart = () => (
  <svg width="46" height="32" viewBox="0 0 46 32" aria-hidden="true">
    <defs>
      <linearGradient id="ldbarG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4ADE80" /><stop offset="1" stopColor="#15803D" /></linearGradient>
      <linearGradient id="ldbarB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#60A5FA" /><stop offset="1" stopColor="#1D4ED8" /></linearGradient>
      <linearGradient id="ldbarV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#C084FC" /><stop offset="1" stopColor="#7C3AED" /></linearGradient>
    </defs>
    <rect x="3"    y="18" width="5.5" height="11" rx="1.4" fill="url(#ldbarG)" />
    <rect x="11.5" y="12" width="5.5" height="17" rx="1.4" fill="url(#ldbarB)" />
    <rect x="20"   y="15" width="5.5" height="14" rx="1.4" fill="url(#ldbarV)" />
    <rect x="28.5" y="8"  width="5.5" height="21" rx="1.4" fill="url(#ldbarB)" />
    <rect x="37"   y="13" width="5.5" height="16" rx="1.4" fill="url(#ldbarG)" />
    <path d="M5.7 16 L14.2 10 L22.7 13.5 L31.2 6.5 L39.7 11" fill="none" stroke="#64748B" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M37.6 9.2 L40.3 10.3 L38.7 12.6 Z" fill="#64748B" />
  </svg>
);

function MarketCluster({ name }) {
  switch (name) {
    case 'Crypto':
      return (
        <div className="flex -space-x-3 justify-center">
          <Coin from="#FDB931" to="#F7931A">₿</Coin>
          <Coin from="#8A92B2" to="#627EEA">Ξ</Coin>
        </div>
      );
    case 'Forex':
      return (
        <div className="flex -space-x-3 justify-center">
          <Coin from="#34D399" to="#059669">$</Coin>
          <Coin from="#60A5FA" to="#2563EB">€</Coin>
        </div>
      );
    case 'Stocks':
      return (
        <div className="flex -space-x-2.5 justify-center">
          <LogoDisc tint="#111827"><AppleGlyph /></LogoDisc>
          <LogoDisc tint="#E82127"><TeslaGlyph /></LogoDisc>
          <LogoDisc><AmazonGlyph /></LogoDisc>
        </div>
      );
    case 'Commodities':
      return (
        <div className="flex items-end justify-center gap-1.5">
          <GoldBars />
          <OilBarrel />
        </div>
      );
    case 'Indices':
    default:
      return <IndexChart />;
  }
}

function Markets() {
  const grad = { background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  // Live per-category average 24h change from the same public /instruments/watchlist
  // feed the ticker uses. Each card's % becomes the mean change24h across that
  // category's instruments, refreshed every 10s. A category with no live data
  // (feed down, or no seeded change for that category) keeps its static fallback.
  const [chg, setChg] = useState({}); // { CRYPTO: 0.83, FOREX: -0.12, … }
  useEffect(() => {
    let on = true;
    const load = () => api.get('/instruments/watchlist')
      .then((r) => {
        if (!on) return;
        const acc = {}; // category → { sum, n }
        for (const x of (r.data?.data || [])) {
          const cat = String(x.category || '').toUpperCase();
          // change24h is null when the backend has no 24h baseline for that
          // instrument — guard explicitly (Number(null) === 0 would otherwise
          // pollute the average with fake zeros and block the static fallback).
          if (!cat || x.change24h == null) continue;
          const v = Number(x.change24h);
          if (!Number.isFinite(v)) continue;
          if (!acc[cat]) acc[cat] = { sum: 0, n: 0 };
          acc[cat].sum += v; acc[cat].n += 1;
        }
        const out = {};
        for (const [cat, a] of Object.entries(acc)) if (a.n) out[cat] = a.sum / a.n;
        setChg(out);
      })
      .catch(() => { /* keep the static fallback */ });
    load();
    const id = setInterval(load, 10000);
    return () => { on = false; clearInterval(id); };
  }, []);

  // ── Horizontal scroll rail with prev/next buttons ───────────────────
  // The cards live in an overflow-x scroller; the arrows call scrollBy and
  // fade out at each end (updated on scroll + resize).
  const scrollerRef = useRef(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(false);
  const updateArrows = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanL(el.scrollLeft > 4);
    setCanR(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);
  useEffect(() => {
    updateArrows();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    return () => { el.removeEventListener('scroll', updateArrows); window.removeEventListener('resize', updateArrows); };
  }, [updateArrows]);
  const scrollByDir = (dir) => {
    const el = scrollerRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };
  const arrowBtn = 'keep-white absolute top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-white border border-border-dark shadow-elevated flex items-center justify-center text-text-secondary transition-all duration-200';

  return (
    <section id="markets" className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-16 pb-4">
      <h2 className="text-3xl sm:text-[34px] font-extrabold tracking-tight text-center">Trade <span style={grad}>Every Market</span></h2>
      <div className="relative mt-8">
        {/* Prev */}
        <button
          type="button" onClick={() => scrollByDir(-1)} aria-label="Scroll left"
          className={`${arrowBtn} left-0 sm:-left-3 ${canL ? 'opacity-100 hover:text-primary-600 hover:border-primary-500/50 hover:scale-105' : 'opacity-40 pointer-events-none'}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        {/* Scroll rail */}
        <div ref={scrollerRef} className="flex gap-3 overflow-x-auto no-scrollbar scroll-smooth pb-1">
          {MARKETS.map((m) => {
            const live = chg[MARKET_CATEGORY[m.name]];
            const c = Number.isFinite(live) ? live : m.c;
            return (
              <div key={m.name} className="shrink-0 basis-[72%] sm:basis-[43%] md:basis-[30%] lg:basis-[21%] card p-4 text-center hover:border-primary-500/40 hover:shadow-elevated transition-all">
                <div className="h-12 flex items-center justify-center mb-3"><MarketCluster name={m.name} /></div>
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  <span className="font-bold text-sm">{m.name}</span>
                  <span className={`text-xs font-bold ${c >= 0 ? 'text-bull' : 'text-bear'}`}>{c >= 0 ? '+' : ''}{c.toFixed(2)}%</span>
                </div>
                <div className="text-[11px] text-text-muted truncate mt-0.5">{m.desc}</div>
              </div>
            );
          })}
        </div>
        {/* Next */}
        <button
          type="button" onClick={() => scrollByDir(1)} aria-label="Scroll right"
          className={`${arrowBtn} right-0 sm:-right-3 ${canR ? 'opacity-100 hover:text-primary-600 hover:border-primary-500/50 hover:scale-105' : 'opacity-40 pointer-events-none'}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
    </section>
  );
}

/* ─────────────────── Professional trading platform ─────────────────── */
function Platform() {
  const grad = { background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  const points = ['Real-time market data', 'One-click trading', 'Advanced charting tools', 'Smart portfolio management'];
  return (
    <section id="platform" className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 grid lg:grid-cols-2 gap-12 items-center">
      {/* Left — copy */}
      <div>
        <h2 className="text-3xl sm:text-[34px] font-extrabold tracking-tight">Professional Trading <span style={grad}>Platform</span></h2>
        <p className="mt-3 text-text-secondary max-w-md">Powerful tools, advanced charts and real-time data to help you trade smarter and faster.</p>
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {points.map((p) => (
            <div key={p} className="flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-bull/15 text-bull flex items-center justify-center shrink-0"><Check /></span>
              <span className="text-sm text-text-secondary">{p}</span>
            </div>
          ))}
        </div>
        <Link to="/register" className="btn-primary mt-8 inline-flex text-base px-7 py-3.5">Explore Platform →</Link>
      </div>
      {/* Right — dark trading terminal mockup (laptop + phone), matches the in-app dark theme */}
      <div className="relative pb-12 pr-2 sm:pr-6">
        {/* Laptop screen */}
        <div className="keep-white rounded-xl border shadow-elevated overflow-hidden" style={{ borderColor: '#1E293B', background: '#0B1220' }}>
          {/* window chrome */}
          <div className="h-7 flex items-center gap-1.5 px-3 border-b" style={{ background: '#0E1626', borderColor: 'rgba(255,255,255,0.08)' }}>
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#FF5F57' }} />
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#FEBC2E' }} />
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#28C840' }} />
            <span className="ml-2 text-[9px] font-semibold" style={{ color: '#64748B' }}>TradePro Terminal</span>
          </div>
          {/* chart + order panel */}
          <div className="p-2.5 grid grid-cols-[1fr_86px] gap-2">
            <div className="rounded-lg border p-2" style={{ background: '#0E1626', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] font-bold text-white">BTC/USD</span>
                  <span className="text-[11px] font-bold" style={{ color: '#22C55E' }}>67,245.30</span>
                  <span className="text-[9px] font-bold" style={{ color: '#22C55E' }}>+1.84%</span>
                </div>
                <div className="hidden sm:flex gap-1.5 text-[7px]" style={{ color: '#64748B' }}>
                  <span>O 65,130</span><span>H 67,540</span><span>L 64,880</span>
                </div>
              </div>
              <ChartSVG />
            </div>
            {/* order panel */}
            <div className="rounded-lg border p-1.5 flex flex-col gap-1" style={{ background: '#0E1626', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="grid grid-cols-2 gap-1">
                <span className="text-center text-[8px] font-bold rounded py-1 text-white" style={{ background: '#16A34A' }}>Buy</span>
                <span className="text-center text-[8px] font-bold rounded py-1" style={{ background: 'rgba(239,68,68,0.16)', color: '#F87171' }}>Sell</span>
              </div>
              {['Amount', 'Price', 'SL', 'TP'].map((l) => (
                <div key={l} className="rounded px-1.5 py-1 flex items-center justify-between border" style={{ background: '#0B1220', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <span className="text-[6.5px]" style={{ color: '#64748B' }}>{l}</span>
                  <span className="w-5 h-1 rounded" style={{ background: 'rgba(255,255,255,0.14)' }} />
                </div>
              ))}
              <span className="mt-auto text-center text-[8px] font-bold rounded py-1.5 text-white" style={{ background: 'linear-gradient(90deg,#2563EB,#3B82F6)' }}>Place Order</span>
            </div>
          </div>
          {/* positions table */}
          <div className="px-2.5 pb-2.5">
            <div className="rounded-lg border overflow-hidden" style={{ background: '#0E1626', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="px-2 py-1 text-[8px] font-bold text-white border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>Open Positions</div>
              {[['ETH/USD', 'BUY', '#22C55E', '+2.31%'], ['SOL/USD', 'BUY', '#22C55E', '+4.12%'], ['XAU/USD', 'SELL', '#EF4444', '-0.80%']].map((r, i) => (
                <div key={i} className="px-2 py-1 flex items-center justify-between border-b last:border-0" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  <span className="text-[8px] font-semibold w-12" style={{ color: '#E2E8F0' }}>{r[0]}</span>
                  <span className="text-[7px] font-bold px-1.5 py-px rounded" style={{ background: `${r[2]}22`, color: r[2] }}>{r[1]}</span>
                  <span className="text-[7px]" style={{ color: '#64748B' }}>0.50</span>
                  <span className="text-[8px] font-bold" style={{ color: r[2] }}>{r[3]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* laptop base / hinge */}
        <div className="h-2.5 rounded-b-md mx-auto w-[82%]" style={{ background: '#1E293B' }} />
        <div className="h-1 rounded-b-lg mx-auto w-[34%]" style={{ background: 'rgba(30,41,59,0.7)' }} />
        {/* phone in front */}
        <div className="keep-white absolute -bottom-2 right-0 sm:right-2 w-24 rounded-[1.3rem] border-4 shadow-elevated overflow-hidden" style={{ borderColor: '#1E293B', background: '#0B1220' }}>
          <div className="px-2 pt-2 pb-1 flex items-center justify-between">
            <span className="text-[8px] font-bold text-white">BTC/USD</span>
            <span className="text-[7px] font-bold" style={{ color: '#22C55E' }}>+1.84%</span>
          </div>
          <div className="px-1"><ChartSVG /></div>
          <div className="p-1.5 grid grid-cols-2 gap-1">
            <div className="rounded py-1 text-center text-[8px] font-bold text-white" style={{ background: '#16A34A' }}>Buy</div>
            <div className="rounded py-1 text-center text-[8px] font-bold text-white" style={{ background: '#EF4444' }}>Sell</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────── Protected around the clock ─────────────────── */
// 3D-style glowing shield illustration (pure SVG — no image asset).
function ShieldHero() {
  return (
    <div className="relative shrink-0 w-28 h-28 flex items-center justify-center">
      <span className="absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle at 50% 58%, rgba(59,130,246,0.5), transparent 65%)' }} />
      <svg width="96" height="104" viewBox="0 0 96 104" className="relative drop-shadow-[0_10px_20px_rgba(37,99,235,0.45)]">
        <defs>
          <linearGradient id="ldShield" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#60A5FA" /><stop offset="0.5" stopColor="#3B82F6" /><stop offset="1" stopColor="#1E3A8A" /></linearGradient>
          <linearGradient id="ldShieldEdge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#BFDBFE" /><stop offset="1" stopColor="#2563EB" /></linearGradient>
          <radialGradient id="ldShieldShine" cx="50%" cy="30%" r="60%"><stop offset="0" stopColor="rgba(191,219,254,0.85)" /><stop offset="1" stopColor="rgba(191,219,254,0)" /></radialGradient>
        </defs>
        <path d="M48 4 L86 18 V52 C86 78 68 92 48 100 C28 92 10 78 10 52 V18 Z" fill="url(#ldShieldEdge)" />
        <path d="M48 11 L79 22 V52 C79 74 64 86 48 93 C32 86 17 74 17 52 V22 Z" fill="url(#ldShield)" />
        <path d="M48 11 L79 22 V41 C70 31 58 27 48 27 Z" fill="url(#ldShieldShine)" opacity="0.55" />
        <rect x="38" y="50" width="20" height="16" rx="3" fill="#EAF2FF" />
        <path d="M41 50 v-4 a7 7 0 0 1 14 0 v4" fill="none" stroke="#EAF2FF" strokeWidth="3.4" />
        <circle cx="48" cy="57" r="2.6" fill="#1E3A8A" />
        <rect x="47" y="58.5" width="2" height="4.5" rx="1" fill="#1E3A8A" />
      </svg>
    </div>
  );
}
function SecIcon({ name }) {
  const p = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'snow': return <svg {...p}><path d="M12 2v20M20.5 7L3.5 17M3.5 7l17 10" /><path d="M12 5.6l2.2-2M12 5.6l-2.2-2M12 18.4l2.2 2M12 18.4l-2.2 2" /></svg>;
    case 'lock': return <svg {...p}><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
    case 'shield': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9.5 12l2 2 3.5-3.5" /></svg>;
    case 'audit': return <svg {...p}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h4" /><path d="M14.5 16.5l1.4 1.4 2.6-3" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}
function ProtectedBanner() {
  const items = [
    { icon: 'snow',   title: 'Cold Storage',    sub: 'Most funds stored offline' },
    { icon: 'lock',   title: 'SSL Encryption',  sub: 'Bank-level 256-bit SSL' },
    { icon: 'shield', title: 'Two-Factor Auth', sub: 'Extra layer on your account' },
    { icon: 'audit',  title: 'Regular Audits',  sub: 'Continuous security checks' },
  ];
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 pb-16">
      <div className="keep-white rounded-2xl p-6 sm:p-10 shadow-elevated relative overflow-hidden" style={{ background: 'radial-gradient(120% 140% at 12% 18%, #16223B 0%, #0B1220 55%, #070C18 100%)' }}>
        <span className="pointer-events-none absolute -left-10 top-1/2 -translate-y-1/2 w-72 h-72 rounded-full opacity-60" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.28), transparent 70%)' }} />
        <span className="pointer-events-none absolute -right-16 -bottom-16 w-72 h-72 rounded-full opacity-40" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.30), transparent 70%)' }} />
        <div className="relative flex flex-col lg:flex-row items-center gap-8">
          <ShieldHero />
          <div className="flex-1 text-center lg:text-left">
            <h3 className="text-2xl sm:text-[28px] font-extrabold leading-tight" style={{ color: '#FFFFFF' }}>Your Assets.<br />Protected Around The Clock</h3>
            <p className="text-sm mt-2 max-w-xl" style={{ color: 'rgba(255,255,255,0.68)' }}>We use industry-leading security measures — cold storage, SSL encryption and 2FA protection — to ensure your assets are always safe with us.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-5 shrink-0">
            {items.map((it) => (
              <div key={it.title} className="flex flex-col items-center lg:items-start text-center lg:text-left">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center mb-2" style={{ background: 'rgba(59,130,246,0.14)', color: '#60A5FA', border: '1px solid rgba(96,165,250,0.25)' }}><SecIcon name={it.icon} /></span>
                <div className="text-[12px] font-bold leading-tight" style={{ color: '#FFFFFF' }}>{it.title}</div>
                <div className="text-[10px] mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,0.5)' }}>{it.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── How it works (4) ───────────────────────── */
function StepIcon({ name }) {
  const p = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'user':   return <svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>;
    case 'verify': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'wallet': return <svg {...p}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M3 10.5h18" /><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" stroke="none" /></svg>;
    case 'trend':  return <svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M17 7h4v4" /></svg>;
    default:       return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}
function Steps() {
  // Each step gets its OWN vibrant gradient + matching accent so the row reads
  // colorful and premium instead of one flat blue.
  const STEP_STYLES = [
    { icon: 'user',   g: 'linear-gradient(135deg,#818CF8,#6366F1)', sh: 'rgba(99,102,241,0.42)', accent: '#6366F1' },
    { icon: 'verify', g: 'linear-gradient(135deg,#34D399,#10B981)', sh: 'rgba(16,185,129,0.42)', accent: '#059669' },
    { icon: 'wallet', g: 'linear-gradient(135deg,#FBBF24,#F97316)', sh: 'rgba(249,115,22,0.42)', accent: '#EA580C' },
    { icon: 'trend',  g: 'linear-gradient(135deg,#22D3EE,#3B82F6)', sh: 'rgba(37,99,235,0.42)',  accent: '#2563EB' },
  ];
  return (
    <section id="how" className="bg-bg-card/40 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-12 sm:py-14">
        <SectionHead eyebrow="Get started" title="How It Works" sub="From sign-up to your first trade in minutes." />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mt-9">
          {STEPS.map((s, i) => {
            const st = STEP_STYLES[i];
            return (
              <div key={s.n} className="group relative card p-6 sm:p-7 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-elevated hover:border-primary-500/40">
                {/* colorful gradient icon badge + floating step number */}
                <div className="relative w-14 h-14 mb-5">
                  <div className="keep-white relative overflow-hidden w-14 h-14 rounded-2xl flex items-center justify-center text-white transition-transform duration-300 group-hover:scale-110" style={{ background: st.g, boxShadow: `0 10px 22px ${st.sh}` }}>
                    <span className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 30% 12%, rgba(255,255,255,0.5), transparent 60%)' }} />
                    <span className="relative"><StepIcon name={st.icon} /></span>
                  </div>
                  <span className="keep-white absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white text-[11px] font-extrabold flex items-center justify-center border border-border-subtle shadow-card" style={{ color: st.accent }}>{s.n}</span>
                </div>
                <h3 className="text-base font-bold">{s.title}</h3>
                <p className="mt-2 text-sm text-text-secondary leading-relaxed">{s.body}</p>
                {/* connector chevron to the next step (desktop only) */}
                {i < STEPS.length - 1 && (
                  <div className="hidden lg:block absolute top-1/2 -translate-y-1/2 -right-[13px] z-10 text-text-muted/50">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Testimonials ───────────────────────── */
// "Why Traders Love TradePro" — testimonial + benefit merged into ONE card each.
// Top: avatar/name/role → stars → review; a separator; then a colorful benefit
// badge pinned to the bottom. The review uses flex-1 so every badge lines up at
// the same baseline → visually equal card heights across the row.
function Testimonials() {
  const BENEFITS = [
    { icon: 'gift',   title: 'Free to Start',     body: 'No signup fees, no platform charges, and a free demo balance to practice risk-free.', g: 'linear-gradient(135deg,#F472B6 0%,#FB7185 45%,#F59E0B 100%)', sh: 'rgba(251,113,133,0.40)', tint: 'rgba(251,113,133,0.08)' },
    { icon: 'clock',  title: '24/7 Access',       body: 'Markets, charts and live support available round the clock.', g: 'linear-gradient(135deg,#22D3EE 0%,#3B82F6 50%,#6366F1 100%)', sh: 'rgba(59,130,246,0.40)', tint: 'rgba(59,130,246,0.08)' },
    { icon: 'shield', title: 'Forever Trustable', body: 'Bank-grade encryption, 2FA, segregated funds and 99.98% uptime.', g: 'linear-gradient(135deg,#34D399 0%,#10B981 50%,#059669 100%)', sh: 'rgba(16,185,129,0.40)', tint: 'rgba(16,185,129,0.08)' },
  ];
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 sm:py-20">
      {/* header — pill eyebrow + prominent title */}
      <div className="text-center max-w-2xl mx-auto">
        <div className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold mb-4" style={{ background: 'rgba(99,102,241,0.10)', color: '#4F46E5' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>
          Loved by thousands of traders
        </div>
        <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight">Why Traders Love TradePro</h2>
        <p className="mt-3 text-text-secondary">Join thousands of traders who trust TradePro every day.</p>
      </div>
      {/* Responsive: 1 col (mobile) → 2 (tablet) → 3 (desktop). Cards stretch to equal height. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-12">
        {TESTIMONIALS.map((t, i) => {
          const b = BENEFITS[i];
          return (
            <div key={t.name} className="group card p-6 sm:p-7 flex flex-col h-full transition-all duration-300 hover:-translate-y-1.5 hover:shadow-elevated">
              {/* Person — photo + name/role */}
              <div className="flex items-center gap-3">
                <span className="relative w-12 h-12 rounded-full overflow-hidden shrink-0 bg-primary-500/10 text-primary-600 font-bold flex items-center justify-center text-sm">
                  {t.init}
                  <img src={t.img} alt={t.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                </span>
                <div>
                  <div className="text-[15px] font-bold">{t.name}</div>
                  <div className="text-xs text-text-muted">{t.role}</div>
                </div>
              </div>
              {/* Stars */}
              <div className="flex gap-0.5 mt-4">
                {[0, 1, 2, 3, 4].map((s) => (
                  <svg key={s} width="16" height="16" viewBox="0 0 24 24" fill="#F59E0B" stroke="none"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 21.2l1.5-6.8L2.2 9.7l6.9-.7z" /></svg>
                ))}
              </div>
              {/* Review — flex-1 pins the badge to the bottom so all cards match height */}
              <p className="mt-4 text-sm text-text-secondary leading-relaxed flex-1">"{t.quote}"</p>
              {/* Separator + colorful benefit badge */}
              <div className="mt-6 pt-5 border-t border-border-subtle">
                <div className="flex items-start gap-3 rounded-xl p-3" style={{ background: b.tint }}>
                  <span className="keep-white relative overflow-hidden w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white transition-transform duration-300 group-hover:scale-110" style={{ background: b.g, boxShadow: `0 8px 18px ${b.sh}` }}>
                    <span className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 30% 12%, rgba(255,255,255,0.45), transparent 60%)' }} />
                    <span className="relative"><FeatureIcon name={b.icon} /></span>
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold">{b.title}</div>
                    <p className="text-[12px] text-text-secondary mt-0.5 leading-snug">{b.body}</p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}


/* ───────────────────── Trade anytime, anywhere ───────────────────── */
function MiniDonut() {
  const segs = [['#3B82F6', 50], ['#22C55E', 23], ['#F59E0B', 13], ['#8B5CF6', 9], ['#38BDF8', 5]];
  const R = 16, SW = 7, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg width="46" height="46" viewBox="0 0 46 46">
      <circle cx="23" cy="23" r={R} fill="none" stroke="#EEF2F6" strokeWidth={SW} />
      {segs.map(([c, p], i) => {
        const len = (p / 100) * C;
        const el = <circle key={i} cx="23" cy="23" r={R} fill="none" stroke={c} strokeWidth={SW} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 23 23)" />;
        off += len;
        return el;
      })}
    </svg>
  );
}

// Mini dashboard chart primitives for the app-download laptop/phone mockups.
function DashArea({ color = '#8B5CF6', id = 'a' }) {
  const gid = `ldDashArea_${id}`;
  return (
    <svg viewBox="0 0 200 90" className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d="M0,70 C20,60 30,64 45,50 C60,38 70,54 90,44 C110,34 120,20 140,28 C160,36 175,18 200,14 L200,90 L0,90 Z" fill={`url(#${gid})`} />
      <path d="M0,70 C20,60 30,64 45,50 C60,38 70,54 90,44 C110,34 120,20 140,28 C160,36 175,18 200,14" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DashBars() {
  const bars = [[0, 30, '#8B5CF6'], [1, 52, '#3B82F6'], [2, 40, '#8B5CF6'], [3, 64, '#3B82F6'], [4, 48, '#8B5CF6'], [5, 72, '#3B82F6'], [6, 58, '#8B5CF6']];
  return (
    <svg viewBox="0 0 140 70" className="w-full h-full" preserveAspectRatio="none">
      {bars.map(([i, h, c]) => (
        <rect key={i} x={6 + i * 19} y={70 - h} width="11" height={h} rx="2" fill={c} opacity="0.85" />
      ))}
    </svg>
  );
}

function AppDownload() {
  const teal = { background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  return (
    <section className="relative z-10 overflow-hidden">
      <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(59,130,246,0.05), transparent 60%)' }} />
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-6 pt-10 pb-8 grid lg:grid-cols-2 gap-12 items-center">
        {/* ── Device mockups (laptop + phone) ── */}
        <div className="relative pb-10 pr-6">
          {/* Laptop — realistic MacBook-style frame (silver lid + black bezel) wrapping the dashboard */}
          <div className="keep-white relative z-10 rounded-[15px] p-[6px]" style={{ background: 'linear-gradient(180deg,#E7EBF1,#C0C8D4)', boxShadow: '0 24px 46px rgba(15,23,42,0.22)' }}>
            <div className="rounded-[10px] p-[5px]" style={{ background: '#0B1220' }}>
              <div className="rounded-[7px] overflow-hidden bg-white flex">
              {/* dark sidebar */}
              <div className="w-16 shrink-0 py-2.5 px-2 space-y-1.5" style={{ background: '#0F1B2E' }}>
                <div className="flex items-center gap-1 mb-2">
                  <span className="w-3 h-3 rounded" style={{ background: 'linear-gradient(135deg,#3B82F6,#6366F1)' }} />
                  <span className="h-1.5 w-8 rounded" style={{ background: 'rgba(255,255,255,0.5)' }} />
                </div>
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded px-1 py-1" style={i === 0 ? { background: 'rgba(59,130,246,0.25)' } : undefined}>
                    <span className="w-2 h-2 rounded-sm" style={{ background: i === 0 ? '#60A5FA' : 'rgba(255,255,255,0.35)' }} />
                    <span className="h-1.5 rounded" style={{ width: 22, background: i === 0 ? 'rgba(147,197,253,0.85)' : 'rgba(255,255,255,0.22)' }} />
                  </div>
                ))}
              </div>
              {/* main panel */}
              <div className="flex-1 min-w-0 p-2.5 space-y-2" style={{ background: '#F8FAFC' }}>
                <div className="flex items-center justify-between">
                  <span className="h-2 w-16 rounded bg-slate-300" />
                  <span className="w-4 h-4 rounded-full bg-slate-300" />
                </div>
                {/* stat cards */}
                <div className="grid grid-cols-4 gap-1.5">
                  {['#3B82F6', '#22C55E', '#8B5CF6', '#F59E0B'].map((c, i) => (
                    <div key={i} className="rounded-md bg-white border border-slate-200 p-1.5 space-y-1">
                      <span className="block h-1 w-6 rounded bg-slate-200" />
                      <span className="block h-2 w-9 rounded bg-slate-300" />
                      <span className="block h-1 w-4 rounded" style={{ background: c }} />
                    </div>
                  ))}
                </div>
                {/* area chart + donut */}
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="col-span-2 rounded-md bg-white border border-slate-200 p-1.5">
                    <span className="block h-1 w-10 rounded bg-slate-200 mb-1" />
                    <div className="h-[46px]"><DashArea id="lap" /></div>
                  </div>
                  <div className="rounded-md bg-white border border-slate-200 p-1.5 flex flex-col items-center justify-center gap-1">
                    <MiniDonut />
                    <span className="h-1 w-8 rounded bg-slate-200" />
                  </div>
                </div>
                {/* bar chart + mini table */}
                <div className="grid grid-cols-3 gap-1.5">
                  <div className="col-span-1 rounded-md bg-white border border-slate-200 p-1.5">
                    <div className="h-[40px]"><DashBars /></div>
                  </div>
                  <div className="col-span-2 rounded-md bg-white border border-slate-200 p-1.5 space-y-1.5">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-slate-200" />
                        <span className="h-1.5 flex-1 rounded bg-slate-200" />
                        <span className="h-1.5 w-6 rounded" style={{ background: i % 2 ? '#22C55E' : '#EF4444', opacity: 0.55 }} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>
          {/* base / deck — realistic wide MacBook hinge with a center notch */}
          <div className="relative z-10 mx-auto" style={{ width: '112%', marginLeft: '-6%', height: 15 }}>
            <div className="absolute inset-x-0 top-0 h-[12px] rounded-b-[11px]" style={{ background: 'linear-gradient(180deg,#CBD2DC,#98A2B2)', boxShadow: '0 8px 12px rgba(15,23,42,0.18)' }} />
            <div className="absolute left-1/2 -translate-x-1/2 top-0 w-24 h-[6px] rounded-b-[8px]" style={{ background: '#8A94A3' }} />
          </div>
          {/* Phone — realistic frame + mini dashboard, overlapping in front */}
          <div className="keep-white absolute -bottom-3 right-1 z-20 w-24 rounded-[1.5rem] p-[3px] shadow-elevated" style={{ background: 'linear-gradient(160deg,#3A424F,#161C26)' }}>
            <div className="relative rounded-[1.3rem] overflow-hidden bg-white">
              <div className="absolute left-1/2 -translate-x-1/2 top-1 w-8 h-1.5 rounded-full z-10" style={{ background: '#161C26' }} />
              <div className="px-2 pt-3 pb-1 flex items-center justify-between"><span className="text-[8px] font-bold">Dashboard</span><span className="w-2.5 h-2.5 rounded-full bg-slate-200" /></div>
              <div className="px-1.5 pb-2 space-y-1">
                <div className="grid grid-cols-2 gap-1">
                  {[0, 1].map((i) => (
                    <div key={i} className="rounded bg-bg-card border border-border-subtle p-1 space-y-0.5"><span className="block h-1 w-4 rounded bg-slate-200" /><span className="block h-1.5 w-6 rounded bg-slate-300" /></div>
                  ))}
                </div>
                <div className="rounded bg-bg-card border border-border-subtle p-1"><div className="h-[30px]"><DashArea id="ph" color="#3B82F6" /></div></div>
                <div className="flex justify-center py-0.5"><MiniDonut /></div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Text + badges + QR ── */}
        <div className="flex flex-col sm:flex-row items-start gap-6">
          <div className="flex-1">
            <h2 className="text-3xl sm:text-[34px] font-extrabold tracking-tight">Trade Anytime, <span style={teal}>Anywhere</span></h2>
            <p className="mt-3 text-text-secondary max-w-md">Download the TradePro app and trade on the go. Available on iOS and Android — your portfolio, always in your pocket.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <StoreBadge store="apple" />
              <StoreBadge store="google" />
            </div>
          </div>
          <div className="text-center shrink-0">
            <QR />
            <div className="text-[11px] text-text-muted mt-2 max-w-[100px] mx-auto">Scan to download</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function StoreBadge({ store }) {
  const apple = store === 'apple';
  return (
    <a href="/download" className="keep-white inline-flex items-center gap-2.5 rounded-xl px-4 py-2.5 hover:opacity-90 transition-opacity" style={{ background: '#0F172A', color: '#fff' }}>
      <span style={{ color: '#fff' }}>
        {apple ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 1.6c0 1.2-.5 2.3-1.3 3.1-.9.9-2 1.5-3.1 1.4-.1-1.2.5-2.4 1.2-3.1.9-.9 2.2-1.5 3.2-1.4zM20 17.1c-.5 1.2-.8 1.7-1.4 2.7-.9 1.4-2.2 3.1-3.8 3.1-1.4 0-1.8-.9-3.7-.9s-2.3.9-3.7.9c-1.6 0-2.8-1.6-3.7-2.9C1.3 17.1.9 12.4 2.5 9.9c1-1.6 2.7-2.6 4.2-2.6 1.6 0 2.6.9 3.9.9 1.3 0 2.1-.9 3.9-.9 1.4 0 2.8.7 3.8 2-3.3 1.8-2.8 6.6.7 7.8z" /></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M6 4 L6 16 L14 16 Z" fill="#00D971" />
            <path d="M6 28 L6 16 L14 16 Z" fill="#00C3FF" />
            <path d="M6 4 L14 16 L26 16 Z" fill="#FFCE00" />
            <path d="M6 28 L14 16 L26 16 Z" fill="#FF3B44" />
          </svg>
        )}
      </span>
      <span className="text-left" style={{ color: '#fff' }}>
        <span className="block text-[9px] leading-none opacity-80">{apple ? 'Download on the' : 'Get it on'}</span>
        <span className="block text-sm font-bold leading-tight">{apple ? 'App Store' : 'Google Play'}</span>
      </span>
    </a>
  );
}

function QR() {
  // Decorative QR-like pattern (fixed, not scannable).
  const cells = [
    [0, 0], [1, 0], [2, 0], [4, 0], [6, 0], [0, 1], [2, 1], [4, 1], [6, 1], [0, 2], [1, 2], [2, 2], [4, 2], [5, 2],
    [1, 3], [3, 3], [5, 3], [6, 3], [0, 4], [2, 4], [3, 4], [6, 4], [0, 5], [2, 5], [4, 5], [5, 5],
    [1, 6], [2, 6], [3, 6], [5, 6], [6, 6], [4, 4], [3, 1],
  ];
  return (
    <svg width="90" height="90" viewBox="0 0 70 70" className="mx-auto">
      <rect x="0" y="0" width="70" height="70" rx="6" fill="#fff" stroke="#E2E8F0" />
      {cells.map(([x, y], i) => (
        <rect key={i} x={6 + x * 8} y={6 + y * 8} width="7" height="7" rx="1.2" fill="#0F172A" />
      ))}
    </svg>
  );
}

/* ───────────────────────────── Final CTA ───────────────────────────── */
function FinalCTA() {
  return (
    <section className="relative z-0 lg:-mt-16 max-w-[1200px] mx-auto px-4 sm:px-6 py-8">
      <div
        className="keep-white relative rounded-2xl overflow-hidden px-6 sm:px-10 py-8 sm:py-9 flex flex-col md:flex-row items-center justify-between gap-6"
        style={{ background: 'linear-gradient(90deg, #2563EB 0%, #3B82F6 45%, #10B981 100%)' }}
      >
        <span className="pointer-events-none absolute inset-0 opacity-25" style={{ background: 'radial-gradient(120% 120% at 15% 10%, rgba(255,255,255,0.35), transparent 55%)' }} />
        <div className="relative text-center md:text-left">
          <h2 className="text-2xl sm:text-3xl font-extrabold" style={{ color: '#FFFFFF' }}>Ready To Start Your Trading Journey?</h2>
          <p className="mt-2 text-sm sm:text-base font-medium" style={{ color: 'rgba(255,255,255,0.88)' }}>Trade Free. Trade Smart. Trade TradePro.</p>
        </div>
        <Link
          to="/register"
          className="keep-white relative shrink-0 bg-white font-bold rounded-xl px-7 py-3.5 text-base hover:shadow-elevated transition-shadow inline-flex items-center gap-2"
          style={{ color: '#0F172A' }}
        >
          Start Trading Free <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}

/* ───────────────────────────── bits ───────────────────────────── */
function SectionHead({ eyebrow, title, sub, align = 'center' }) {
  return (
    <div className={align === 'center' ? 'text-center max-w-2xl mx-auto' : 'text-left'}>
      {eyebrow && <div className="text-xs font-bold uppercase tracking-wider text-primary-600 mb-2">{eyebrow}</div>}
      <h2 className="text-3xl sm:text-[34px] font-extrabold tracking-tight">{title}</h2>
      {sub && <p className="mt-3 text-text-secondary">{sub}</p>}
    </div>
  );
}

const Check = ({ big }) => (
  <svg width={big ? 18 : 13} height={big ? 18 : 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
);

function FeatureIcon({ name }) {
  const p = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'bolt': return <svg {...p}><path d="M13 2L3 14h8l-1 8 10-12h-8z" /></svg>;
    case 'chart': return <svg {...p}><path d="M3 3v18h18" /><path d="M7 15l4-4 4 4 6-7" /></svg>;
    case 'copy': return <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
    case 'shield': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'coins': return <svg {...p}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>;
    case 'support': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5 19l2-3M19 19l-2-3" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>;
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
    case 'gift': return <svg {...p}><path d="M20 12v9H4v-9" /><rect x="2" y="7" width="20" height="5" rx="1" /><path d="M12 22V7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" /></svg>;
    case 'globe': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" /></svg>;
    case 'lock': return <svg {...p}><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
    case 'rupee': return <svg {...p}><text x="6" y="18" fontSize="17" fontWeight="800" fill="currentColor" stroke="none" fontFamily="Inter, sans-serif">₹</text></svg>;
    case 'grid': return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case 'deposit': return <svg {...p}><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><rect x="3" y="17" width="18" height="4" rx="1" /></svg>;
    case 'risk': return <svg {...p}><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
    case 'phone': return <svg {...p}><rect x="6" y="2" width="12" height="20" rx="2.5" /><line x1="10" y1="18" x2="14" y2="18" /></svg>;
    case 'percent': return <svg {...p}><line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

function MarketIcon({ name }) {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'fx': return <svg {...p}><path d="M4 17l5-5 4 4 7-8" /><path d="M3 7h4v4" /></svg>;
    case 'crypto': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 8h4a2 2 0 0 1 0 4h-4m0 0h4.5a2 2 0 0 1 0 4H9.5m0-8v8M11 6v2M11 16v2" /></svg>;
    case 'stock': return <svg {...p}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="13" y="7" width="3" height="10" /></svg>;
    case 'oil': return <svg {...p}><path d="M12 2s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z" /></svg>;
    case 'index': return <svg {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>;
    case 'gold': return <svg {...p}><path d="M4 18h16l-2-7H6z" /><path d="M8 11l1-4h6l1 4" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

function LandingStyles() {
  return (
    <style>{`
      @keyframes lndMarquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      .lnd-marquee { animation: lndMarquee 32s linear infinite; }
      @keyframes lndDraw { from { stroke-dashoffset: 900; } to { stroke-dashoffset: 0; } }
      .lnd-line { stroke-dasharray: 900; animation: lndDraw 2.4s ease-out forwards; }
      @keyframes lndDot { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      .lnd-dot { animation: lndDot 1.6s ease-in-out infinite; }
      @keyframes lndFloatA { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
      @keyframes lndFloatB { 0%,100% { transform: translateY(0); } 50% { transform: translateY(8px); } }
      .float-a { animation: lndFloatA 5s ease-in-out infinite; }
      .float-b { animation: lndFloatB 6s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .lnd-marquee, .lnd-line, .lnd-dot, .float-a, .float-b { animation: none; }
      }
    `}</style>
  );
}
