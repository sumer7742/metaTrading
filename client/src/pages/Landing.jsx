import { Link } from 'react-router-dom';
import CmsFooter from '../components/CmsFooter';
import LandingHeader from '../components/LandingHeader';

/**
 * Pre-login marketing landing page. Fully public, self-contained (no API /
 * auth dependency so it always renders), built on the app's light design
 * system (#1D4ED8 primary, bull/bear accents). Reuses the CMS footer.
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
];

const MARKETS = [
  { name: 'Forex', desc: '60+ currency pairs', c: +0.42, icon: 'fx' },
  { name: 'Crypto', desc: 'BTC, ETH & 100+ coins', c: +2.18, icon: 'crypto' },
  { name: 'Stocks', desc: 'Global equities', c: +0.87, icon: 'stock' },
  { name: 'Commodities', desc: 'Oil, gas & more', c: -0.31, icon: 'oil' },
  { name: 'Indices', desc: 'NAS100, SPX, DJI', c: +1.04, icon: 'index' },
  { name: 'Metals', desc: 'Gold, silver, platinum', c: +0.59, icon: 'gold' },
];

const STATS = [
  { v: '$4.2B+', l: 'Monthly volume' },
  { v: '250K+', l: 'Active traders' },
  { v: '500+', l: 'Instruments' },
  { v: '99.98%', l: 'Uptime' },
];

const STEPS = [
  { n: '1', title: 'Create your account', body: 'Sign up in under two minutes — no paperwork, instant access to a demo balance.' },
  { n: '2', title: 'Fund securely', body: 'Top up with your preferred method. Real and demo wallets, your choice.' },
  { n: '3', title: 'Start trading', body: 'Trade 500+ markets with pro tools, copy trading and live analytics.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col bg-white text-text-primary overflow-x-hidden">
      <LandingStyles />
      <LandingHeader />
      <main className="flex-1">
        <Hero />
        <Ticker />
        <Stats />
        <Features />
        <Markets />
        <Platform />
        <Steps />
        <FinalCTA />
      </main>
      <CmsFooter />
    </div>
  );
}

/* ───────────────────────────── Hero ───────────────────────────── */
function Hero() {
  return (
    <section id="top" className="relative">
      {/* decorative gradient blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-[480px] h-[480px] rounded-full opacity-[0.18] blur-3xl" style={{ background: 'radial-gradient(circle,#1D4ED8,transparent 70%)' }} />
        <div className="absolute top-40 -left-32 w-[420px] h-[420px] rounded-full opacity-[0.12] blur-3xl" style={{ background: 'radial-gradient(circle,#00C853,transparent 70%)' }} />
      </div>
      <div className="relative max-w-[1200px] mx-auto px-4 sm:px-6 pt-16 pb-12 lg:pt-24 lg:pb-20 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <span className="badge-primary mb-5">● Live markets · 500+ instruments</span>
          <h1 className="text-[40px] leading-[1.08] sm:text-[56px] font-extrabold tracking-tight">
            Trade the world's<br />markets, <span style={{ background: 'linear-gradient(90deg,#1D4ED8,#3B82F6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>like a pro.</span>
          </h1>
          <p className="mt-5 text-lg text-text-secondary max-w-xl">
            Forex, crypto, stocks, commodities and more — on a lightning-fast platform with pro charts, copy trading and tight spreads.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/register" className="btn-primary text-base px-7 py-3.5 shadow-elevated">Start trading free →</Link>
            <Link to="/login" className="btn-ghost text-base px-7 py-3.5">Sign in</Link>
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-text-muted">
            <span className="inline-flex items-center gap-1.5"><Check /> No paperwork</span>
            <span className="inline-flex items-center gap-1.5"><Check /> Free demo balance</span>
            <span className="inline-flex items-center gap-1.5"><Check /> 2-min sign up</span>
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
          <div className="rounded-lg py-2.5 text-center text-white font-bold text-sm" style={{ background: '#00C853' }}>Buy</div>
          <div className="rounded-lg py-2.5 text-center text-white font-bold text-sm" style={{ background: '#FF3B57' }}>Sell</div>
        </div>
      </div>
      {/* floating P&L card */}
      <div className="hidden sm:block absolute -left-6 bottom-10 z-20 card px-4 py-3 shadow-elevated float-a">
        <div className="text-[10px] text-text-muted font-semibold uppercase tracking-wider">Today's P&L</div>
        <div className="text-lg font-extrabold text-bull">+$2,847.20</div>
      </div>
      {/* floating order fill card */}
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
  // Decorative candlesticks + an animated price line.
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

/* ───────────────────────────── Stats ───────────────────────────── */
function Stats() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-14">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {STATS.map((s) => (
          <div key={s.l} className="card p-6 text-center">
            <div className="text-3xl font-extrabold tracking-tight" style={{ color: '#1D4ED8' }}>{s.v}</div>
            <div className="mt-1 text-sm text-text-muted font-medium">{s.l}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────── Features ───────────────────────────── */
function Features() {
  return (
    <section id="features" className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
      <SectionHead eyebrow="Why TradePro" title="Everything you need to trade" sub="A complete terminal built for speed, depth and control." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
        {FEATURES.map((f) => (
          <div key={f.title} className="card p-6 hover:border-primary-500/40 hover:shadow-elevated transition-all group">
            <div className="w-12 h-12 rounded-xl bg-primary-500/10 text-primary-600 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
              <FeatureIcon name={f.icon} />
            </div>
            <h3 className="text-base font-bold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────────── Markets ───────────────────────────── */
function Markets() {
  return (
    <section id="markets" className="bg-bg-card/50 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
        <SectionHead eyebrow="Markets" title="One account, every market" sub="Trade across asset classes from a single, unified platform." />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
          {MARKETS.map((m) => (
            <div key={m.name} className="card p-5 flex items-center gap-4 hover:border-primary-500/40 hover:shadow-elevated transition-all bg-white">
              <span className="w-12 h-12 rounded-xl bg-primary-500/10 text-primary-600 flex items-center justify-center shrink-0"><MarketIcon name={m.icon} /></span>
              <div className="flex-1 min-w-0">
                <div className="font-bold">{m.name}</div>
                <div className="text-xs text-text-muted">{m.desc}</div>
              </div>
              <span className={`text-sm font-bold ${m.c >= 0 ? 'text-bull' : 'text-bear'}`}>{m.c >= 0 ? '+' : ''}{m.c.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────── Platform ───────────────────────────── */
function Platform() {
  const points = [
    'Multi-chart layouts up to 8 charts with synced crosshair',
    '100+ indicators and full drawing-tool suite',
    'One-click trading with draggable SL / TP on the chart',
    'Copy trading with per-strategy allocation control',
    'Real-time positions, P&L and margin analytics',
  ];
  return (
    <section id="platform" className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 grid lg:grid-cols-2 gap-12 items-center">
      <div className="order-2 lg:order-1">
        <div className="card p-4 shadow-elevated">
          <div className="flex items-center gap-1.5 mb-3 px-1">
            <span className="w-2.5 h-2.5 rounded-full bg-bear/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-warn/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-bull/60" />
          </div>
          <div className="rounded-lg bg-bg-card border border-border-subtle p-4">
            <ChartSVG />
            <div className="grid grid-cols-3 gap-2 mt-3">
              {['EUR/USD', 'BTC/USD', 'XAU/USD'].map((s, i) => (
                <div key={s} className="rounded-md border border-border-subtle p-2 text-center bg-white">
                  <div className="text-[10px] text-text-muted">{s}</div>
                  <div className={`text-xs font-bold ${i === 2 ? 'text-bear' : 'text-bull'}`}>{i === 2 ? '-0.31%' : '+0.62%'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="order-1 lg:order-2">
        <SectionHead align="left" eyebrow="The platform" title="A terminal that keeps up with you" sub="" />
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-bull/15 text-bull flex items-center justify-center shrink-0"><Check /></span>
              <span className="text-text-secondary">{p}</span>
            </li>
          ))}
        </ul>
        <Link to="/register" className="btn-primary mt-8 inline-flex text-base px-7 py-3.5">Open free account →</Link>
      </div>
    </section>
  );
}

/* ───────────────────────────── Steps ───────────────────────────── */
function Steps() {
  return (
    <section id="how" className="bg-bg-card/50 border-y border-border-subtle">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
        <SectionHead eyebrow="Get started" title="Trading in three steps" sub="From sign-up to your first trade in minutes." />
        <div className="grid md:grid-cols-3 gap-4 mt-10">
          {STEPS.map((s) => (
            <div key={s.n} className="card p-7 bg-white relative overflow-hidden">
              <div className="absolute -right-3 -top-4 text-[80px] font-extrabold opacity-[0.06] select-none">{s.n}</div>
              <div className="w-10 h-10 rounded-full text-white font-bold flex items-center justify-center mb-4" style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>{s.n}</div>
              <h3 className="font-bold">{s.title}</h3>
              <p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────── Final CTA ───────────────────────────── */
function FinalCTA() {
  return (
    <section className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16">
      <div className="relative rounded-2xl overflow-hidden px-6 sm:px-12 py-14 text-center" style={{ background: 'linear-gradient(135deg,#1E3A8A 0%,#1D4ED8 55%,#3B82F6 100%)' }}>
        <div className="pointer-events-none absolute inset-0 opacity-20" style={{ background: 'radial-gradient(circle at 20% 20%,#fff,transparent 40%)' }} />
        <h2 className="relative text-3xl sm:text-4xl font-extrabold text-white">Start trading today</h2>
        <p className="relative mt-3 text-white/85 max-w-xl mx-auto">Join thousands of traders. Create your account in under two minutes — demo balance included.</p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/register" className="keep-white bg-white text-primary-600 font-bold rounded-lg px-8 py-3.5 text-base hover:shadow-elevated transition-shadow">Create free account</Link>
          <Link to="/login" className="border border-white/60 text-white font-bold rounded-lg px-8 py-3.5 text-base hover:bg-white/10 transition-colors">Sign in</Link>
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

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
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
