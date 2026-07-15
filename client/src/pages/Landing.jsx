import { Link } from 'react-router-dom';
import CmsFooter from '../components/CmsFooter';
import LandingHeader from '../components/LandingHeader';

/**
 * Pre-login marketing landing page. Fully public, self-contained (no API /
 * auth dependency so it always renders), built on the app's light design
 * system (#1D4ED8 primary, bull/bear accents). Reuses the CMS footer.
 *
 * Section order mirrors the reference marketing layout: Hero → Ticker →
 * Trust badges → Why Choose → Everything you need → Built for Every Trader
 * → Markets → Platform → Protected banner → How It Works → Testimonials →
 * Pillars → App download → Final CTA.
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
  { name: 'Crypto', desc: 'BTC, ETH & 100+ coins', c: +0.42, icon: 'crypto' },
  { name: 'Forex', desc: '60+ currency pairs', c: -0.32, icon: 'fx' },
  { name: 'Stocks', desc: 'Global equities', c: +0.62, icon: 'stock' },
  { name: 'Commodities', desc: 'Oil, gas & metals', c: +0.42, icon: 'oil' },
  { name: 'Indices', desc: 'NAS100, SPX, DJI', c: +0.42, icon: 'index' },
];

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
        <Pillars />
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
  const row = [...TICKER, ...TICKER];
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
const MKT_TINT = { crypto: '#F7931A', fx: '#3B82F6', stock: '#10B981', oil: '#F59E0B', index: '#8B5CF6' };
function Markets() {
  const grad = { background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  return (
    <section id="markets" className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-16 pb-4">
      <h2 className="text-3xl sm:text-[34px] font-extrabold tracking-tight text-center">Trade <span style={grad}>Every Market</span></h2>
      <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {MARKETS.map((m) => (
          <div key={m.name} className="card p-4 text-center hover:border-primary-500/40 hover:shadow-elevated transition-all">
            <span className="w-11 h-11 rounded-xl flex items-center justify-center mx-auto mb-3" style={{ background: `${MKT_TINT[m.icon]}18`, color: MKT_TINT[m.icon] }}><MarketIcon name={m.icon} /></span>
            <div className="font-bold text-sm">{m.name}</div>
            <div className="text-[11px] text-text-muted truncate">{m.desc}</div>
            <div className={`text-xs font-bold mt-1 ${m.c >= 0 ? 'text-bull' : 'text-bear'}`}>{m.c >= 0 ? '+' : ''}{m.c.toFixed(2)}%</div>
          </div>
        ))}
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
      {/* Right — laptop + phone trading mockup */}
      <div className="relative pb-10 pr-4">
        <div className="rounded-t-xl border border-border-dark bg-white shadow-elevated overflow-hidden">
          <div className="h-6 bg-bg-card border-b border-border-subtle flex items-center gap-1.5 px-3">
            <span className="w-2 h-2 rounded-full bg-bear/60" /><span className="w-2 h-2 rounded-full bg-warn/60" /><span className="w-2 h-2 rounded-full bg-bull/60" />
          </div>
          <div className="p-3 bg-bg-card">
            <div className="rounded-lg bg-white border border-border-subtle p-2">
              <div className="flex items-center justify-between mb-1.5 px-1">
                <span className="text-[11px] font-bold">BTC/USD <span className="text-bull">+1.84%</span></span>
                <div className="flex gap-1">
                  <span className="keep-white text-[8px] font-bold px-2 py-0.5 rounded" style={{ background: '#00C853', color: '#fff' }}>Buy</span>
                  <span className="keep-white text-[8px] font-bold px-2 py-0.5 rounded" style={{ background: '#FF3B57', color: '#fff' }}>Sell</span>
                </div>
              </div>
              <ChartSVG />
            </div>
          </div>
        </div>
        <div className="h-2.5 bg-border-dark rounded-b-md mx-auto w-[78%]" />
        <div className="h-1 bg-border-dark/60 rounded-b-lg mx-auto w-[36%]" />
        {/* phone in front */}
        <div className="absolute -bottom-1 right-0 w-24 rounded-[1.2rem] border-4 border-border-dark bg-white shadow-elevated overflow-hidden">
          <div className="px-2 pt-1.5 pb-1 flex items-center justify-between"><span className="text-[8px] font-bold">BTC/USD</span><span className="text-[7px] text-bull font-bold">+1.8%</span></div>
          <div className="px-1.5"><ChartSVG /></div>
          <div className="p-1.5 grid grid-cols-2 gap-1">
            <div className="keep-white rounded py-1 text-center text-[8px] font-bold" style={{ background: '#00C853', color: '#fff' }}>Buy</div>
            <div className="keep-white rounded py-1 text-center text-[8px] font-bold" style={{ background: '#FF3B57', color: '#fff' }}>Sell</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────── Protected around the clock ─────────────────── */
function ProtectedBanner() {
  const items = [
    { icon: 'lock', title: 'Bank-Grade Security', sub: 'Encrypted end-to-end' },
    { icon: 'shield', title: '256-bit Encryption', sub: 'Military-grade' },
    { icon: 'coins', title: 'Segregated Funds', sub: 'Kept separate & safe' },
    { icon: 'clock', title: '24/7 Monitoring', sub: 'Always watching' },
  ];
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 pb-16">
      <div className="keep-white rounded-2xl p-6 sm:p-8 shadow-elevated relative overflow-hidden" style={{ background: 'linear-gradient(135deg,#0F172A 0%,#1E293B 100%)' }}>
        <span className="pointer-events-none absolute -right-16 -bottom-16 w-64 h-64 rounded-full opacity-40" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 70%)' }} />
        <div className="relative flex flex-col lg:flex-row items-center gap-6">
          <span className="keep-white w-16 h-16 rounded-2xl flex items-center justify-center shrink-0" style={{ background: 'rgba(59,130,246,0.2)', color: '#60A5FA' }}><FeatureIcon name="shield" /></span>
          <div className="flex-1 text-center lg:text-left">
            <h3 className="text-xl font-bold" style={{ color: '#FFFFFF' }}>Your Assets, Protected Around The Clock</h3>
            <p className="text-sm mt-1 max-w-lg" style={{ color: 'rgba(255,255,255,0.72)' }}>Bank-grade encryption, segregated funds and continuous monitoring keep your capital safe every second of every day.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 shrink-0">
            {items.map((it) => (
              <div key={it.title} className="text-center">
                <span className="keep-white w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-2" style={{ background: 'rgba(255,255,255,0.08)', color: '#60A5FA' }}><FeatureIcon name={it.icon} /></span>
                <div className="text-[11px] font-bold leading-tight" style={{ color: '#FFFFFF' }}>{it.title}</div>
                <div className="text-[9px] mt-0.5" style={{ color: 'rgba(255,255,255,0.55)' }}>{it.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── How it works (4) ───────────────────────── */
function Steps() {
  return (
    <section id="how" className="bg-bg-card/50 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
        <SectionHead eyebrow="Get started" title="How It Works" sub="From sign-up to your first trade in minutes." />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
          {STEPS.map((s) => (
            <div key={s.n} className="card p-7 bg-white relative overflow-hidden">
              <div className="absolute -right-3 -top-4 text-[80px] font-extrabold opacity-[0.06] select-none">{s.n}</div>
              <div className="keep-white w-10 h-10 rounded-full font-bold flex items-center justify-center mb-4" style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)', color: '#fff' }}>{s.n}</div>
              <h3 className="font-bold">{s.title}</h3>
              <p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Testimonials ───────────────────────── */
function Testimonials() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
      <SectionHead eyebrow="Testimonials" title="What Our Traders Say" sub="Join thousands of traders who trust TradePro every day." />
      <div className="grid md:grid-cols-3 gap-4 mt-10">
        {TESTIMONIALS.map((t) => (
          <div key={t.name} className="card p-6 hover:shadow-elevated transition-all">
            {/* Person — photo + name/role on top */}
            <div className="flex items-center gap-3">
              <span className="relative w-11 h-11 rounded-full overflow-hidden shrink-0 bg-primary-500/10 text-primary-600 font-bold flex items-center justify-center text-sm">
                {t.init}
                <img src={t.img} alt={t.name} loading="lazy" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              </span>
              <div>
                <div className="text-sm font-bold">{t.name}</div>
                <div className="text-[11px] text-text-muted">{t.role}</div>
              </div>
            </div>
            {/* Stars */}
            <div className="flex gap-0.5 mt-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <svg key={i} width="15" height="15" viewBox="0 0 24 24" fill="#F59E0B" stroke="none"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 21.2l1.5-6.8L2.2 9.7l6.9-.7z" /></svg>
              ))}
            </div>
            {/* Quote */}
            <p className="mt-3 text-sm text-text-secondary leading-relaxed">"{t.quote}"</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────── Pillars ───────────────────────────── */
function Pillars() {
  const items = [
    { icon: 'gift',   title: 'Free to start',     body: 'No signup fees, no platform charges, and a free demo balance to practice risk-free. Keep more of what you make.', g: 'linear-gradient(135deg,#F472B6 0%,#FB7185 45%,#F59E0B 100%)', sh: 'rgba(251,113,133,0.45)' },
    { icon: 'clock',  title: '24/7 access',       body: 'Markets, charts and live support available round the clock — trade crypto any hour and manage positions whenever you want.', g: 'linear-gradient(135deg,#22D3EE 0%,#3B82F6 50%,#6366F1 100%)', sh: 'rgba(59,130,246,0.45)' },
    { icon: 'shield', title: 'Forever trustable', body: 'Bank-grade encryption, 2FA, segregated funds and 99.98% uptime. A platform built to stay reliable for the long run.', g: 'linear-gradient(135deg,#34D399 0%,#10B981 50%,#059669 100%)', sh: 'rgba(16,185,129,0.45)' },
  ];
  return (
    <section className="bg-bg-card/50 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
        <div className="grid md:grid-cols-3 gap-4">
          {items.map((it) => (
            <div key={it.title} className="card p-7 text-center bg-white hover:border-primary-500/40 hover:shadow-elevated transition-all">
              <div className="keep-white relative overflow-hidden w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: it.g, color: '#FFFFFF', boxShadow: `0 12px 26px ${it.sh}` }}>
                <span className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 30% 12%, rgba(255,255,255,0.45), transparent 60%)' }} />
                <span className="relative scale-125"><FeatureIcon name={it.icon} /></span>
              </div>
              <h3 className="text-lg font-bold">{it.title}</h3>
              <p className="mt-2 text-sm text-text-secondary leading-relaxed">{it.body}</p>
            </div>
          ))}
        </div>
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

function AppDownload() {
  const teal = { background: 'linear-gradient(90deg,#06B6D4,#0EA5E9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' };
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(59,130,246,0.05), transparent 60%)' }} />
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-6 pt-10 pb-8 grid lg:grid-cols-2 gap-12 items-center">
        {/* ── Device mockups (laptop + phone) ── */}
        <div className="relative pb-10 pr-6">
          {/* Laptop */}
          <div className="rounded-t-xl border border-border-dark bg-white shadow-elevated overflow-hidden">
            <div className="h-6 bg-bg-card border-b border-border-subtle flex items-center gap-1.5 px-3">
              <span className="w-2 h-2 rounded-full bg-bear/60" /><span className="w-2 h-2 rounded-full bg-warn/60" /><span className="w-2 h-2 rounded-full bg-bull/60" />
            </div>
            <div className="flex gap-2.5 p-3">
              {/* sidebar */}
              <div className="w-12 shrink-0 space-y-1.5">
                {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className={`h-2 rounded ${i === 0 ? 'bg-primary-500/40' : 'bg-bg-hover'}`} />)}
              </div>
              {/* main */}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => <div key={i} className="h-9 rounded bg-bg-hover" />)}
                </div>
                <div className="grid grid-cols-3 gap-2 items-center">
                  <div className="col-span-2 rounded bg-bg-card border border-border-subtle p-1.5"><ChartSVG /></div>
                  <div className="flex justify-center items-center rounded bg-bg-card border border-border-subtle py-2"><MiniDonut /></div>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[0, 1, 2, 3].map((i) => <div key={i} className="h-4 rounded bg-bg-hover" />)}
                </div>
              </div>
            </div>
          </div>
          {/* laptop base */}
          <div className="h-2.5 bg-border-dark rounded-b-md mx-auto w-[78%]" />
          <div className="h-1 bg-border-dark/60 rounded-b-lg mx-auto w-[36%]" />
          {/* Phone overlapping in front */}
          <div className="absolute -bottom-1 right-0 w-24 rounded-[1.2rem] border-4 border-border-dark bg-white shadow-elevated overflow-hidden">
            <div className="px-2 pt-1.5 pb-1 flex items-center justify-between"><span className="text-[8px] font-bold">Portfolio</span><span className="text-[7px] text-bull font-bold">+1.6%</span></div>
            <div className="px-1.5"><ChartSVG /></div>
            <div className="p-1.5 grid grid-cols-2 gap-1">
              <div className="keep-white rounded py-1 text-center text-[8px] font-bold" style={{ background: '#00C853', color: '#fff' }}>Buy</div>
              <div className="keep-white rounded py-1 text-center text-[8px] font-bold" style={{ background: '#FF3B57', color: '#fff' }}>Sell</div>
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
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M3.6 2.3c-.2.2-.3.5-.3.9v17.6c0 .4.1.7.3.9l.1.1L13.4 12 3.7 2.2l-.1.1zM17 15.3l-3.2-3.3L17 8.7l3.9 2.2c1.1.6 1.1 1.6 0 2.3L17 15.3zm-.6.6L13.1 12.6l-9.5 9.5c.4.3.9.3 1.5 0l11.3-6.2zM4.9 2.1l11.5 6.3-3.3 3.3-9.4-9.5c.3-.2.8-.3 1.2-.1z" /></svg>
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
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-8">
      <div
        className="relative rounded-2xl overflow-hidden px-6 sm:px-12 py-10 text-center"
        style={{
          background: [
            'radial-gradient(at 15% 18%, rgba(56,189,248,0.55) 0px, transparent 55%)',
            'radial-gradient(at 85% 8%, rgba(139,92,246,0.55) 0px, transparent 50%)',
            'radial-gradient(at 92% 88%, rgba(37,99,235,0.65) 0px, transparent 55%)',
            'radial-gradient(at 8% 92%, rgba(20,184,166,0.40) 0px, transparent 50%)',
            'linear-gradient(135deg, #1E3A8A 0%, #1D4ED8 50%, #4F46E5 100%)',
          ].join(', '),
        }}
      >
        <div className="pointer-events-none absolute inset-0 opacity-25" style={{ background: 'radial-gradient(120% 90% at 30% 8%, rgba(255,255,255,0.5), transparent 55%)' }} />
        <h2 className="keep-white relative text-3xl sm:text-4xl font-extrabold" style={{ color: '#FFFFFF' }}>Ready to Start Your Trading Journey?</h2>
        <p className="keep-white relative mt-3 max-w-xl mx-auto" style={{ color: 'rgba(255,255,255,0.9)' }}>Join thousands of traders on a platform built to be trusted. Free to start, open 24/7, demo balance included — set up in under two minutes.</p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/register" className="keep-white bg-white font-bold rounded-lg px-8 py-3.5 text-base hover:shadow-elevated transition-shadow" style={{ color: '#1D4ED8' }}>Start Trading Now →</Link>
          <Link to="/login" className="keep-white border font-bold rounded-lg px-8 py-3.5 text-base hover:bg-white/10 transition-colors" style={{ color: '#FFFFFF', borderColor: 'rgba(255,255,255,0.6)' }}>Sign in</Link>
        </div>
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
