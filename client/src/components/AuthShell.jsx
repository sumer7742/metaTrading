import { useEffect, useRef, useState } from 'react';
import CmsFooter from './CmsFooter';
import LandingHeader from './LandingHeader';
import { useThemeStore } from '../store/theme';

/**
 * Shared chrome for the auth pages (Login / Register): the marketing header
 * (with theme toggle), a live "trading" background (animated candlestick
 * canvas, tinted to the active theme — plus an optional real <video> at
 * /trading-bg.mp4) and the CMS footer. The card is rendered as {children}.
 *
 * Everything follows the app theme, so header + card + footer + background all
 * stay consistent (all-dark or all-light) and flip together via the toggle.
 */
export default function AuthShell({ children }) {
  const theme = useThemeStore((s) => s.theme);
  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <div className="relative flex-1 flex flex-col">
        <AuthBackground theme={theme} />
        <LandingHeader sticky={false} />
        <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-10">
          {children}
        </main>
      </div>
      {/* Footer sits flush against the trading background — drop its default
          top margin so no blank band shows between them. */}
      <div className="[&>footer]:mt-0">
        <CmsFooter />
      </div>
    </div>
  );
}

/* Live trading background: an animated scrolling candlestick chart on a
   <canvas>, tinted to the theme. Optional real video on top if present at
   /trading-bg.mp4 (or .webm) in client/public. */
function AuthBackground({ theme }) {
  const canvasRef = useRef(null);
  const [videoOk, setVideoOk] = useState(false);
  const dark = theme === 'dark';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let raf = 0, w = 0, h = 0;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const pal = dark
      ? { g0: '#0B1220', g1: '#0F1B33', grid: 'rgba(148,163,184,0.06)', up: 'rgba(0,200,83,0.5)', down: 'rgba(255,59,87,0.5)', body: 0.45, line: 'rgba(59,130,246,0.9)' }
      : { g0: '#EAF1FF', g1: '#F6F9FF', grid: 'rgba(29,78,216,0.06)', up: 'rgba(0,200,83,0.45)', down: 'rgba(255,59,87,0.4)', body: 0.4, line: 'rgba(29,78,216,0.75)' };

    let price = 100;
    const genCandle = () => {
      const open = price;
      const close = Math.max(20, open + (Math.random() - 0.48) * 6);
      const high = Math.max(open, close) + Math.random() * 3;
      const low = Math.min(open, close) - Math.random() * 3;
      price = close;
      return { open, close, high, low };
    };
    const candles = Array.from({ length: 70 }, genCandle);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    let offset = 0;
    const speed = reduced ? 0 : 0.4;
    const cwOf = () => Math.max(9, w / 46);

    const draw = () => {
      if (w && h) {
        const cw = cwOf();
        ctx.clearRect(0, 0, w, h);
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, pal.g0); g.addColorStop(1, pal.g1);
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
        for (let y = 0; y < h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        for (let x = -(offset % 48); x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        let min = Infinity, max = -Infinity;
        for (const c of candles) { if (c.low < min) min = c.low; if (c.high > max) max = c.high; }
        const pad = (max - min) * 0.15 || 1; min -= pad; max += pad;
        const yOf = (p) => h - ((p - min) / (max - min)) * h * 0.8 - h * 0.1;
        offset += speed;
        if (offset >= cw) { offset -= cw; candles.shift(); candles.push(genCandle()); }
        candles.forEach((c, i) => {
          const x = i * cw - offset + cw / 2;
          const up = c.close >= c.open;
          ctx.strokeStyle = up ? pal.up : pal.down;
          ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(x, yOf(c.high)); ctx.lineTo(x, yOf(c.low)); ctx.stroke();
          const yo = yOf(c.open), yc = yOf(c.close);
          ctx.fillStyle = up ? pal.up : pal.down;
          ctx.fillRect(x - cw * 0.3, Math.min(yo, yc), cw * 0.6, Math.max(1.5, Math.abs(yc - yo)));
        });
        ctx.beginPath();
        candles.forEach((c, i) => { const x = i * cw - offset + cw / 2; const y = yOf(c.close); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
        ctx.strokeStyle = pal.line; ctx.lineWidth = 2;
        ctx.shadowColor = pal.line; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [dark]);

  const overlay = dark
    ? 'linear-gradient(135deg, rgba(11,18,32,0.84) 0%, rgba(15,23,42,0.7) 45%, rgba(29,78,216,0.5) 100%)'
    : 'linear-gradient(135deg, rgba(255,255,255,0.6) 0%, rgba(219,234,254,0.45) 55%, rgba(191,219,254,0.4) 100%)';
  const vignette = dark
    ? 'radial-gradient(circle at 50% 35%, transparent 0%, rgba(2,6,23,0.5) 100%)'
    : 'radial-gradient(circle at 50% 35%, transparent 0%, rgba(148,163,184,0.18) 100%)';

  return (
    <div className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <video
        autoPlay muted loop playsInline
        onCanPlay={() => setVideoOk(true)}
        onError={() => setVideoOk(false)}
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${videoOk ? 'opacity-100' : 'opacity-0'}`}
      >
        <source src="/trading-bg.mp4" type="video/mp4" />
        <source src="/trading-bg.webm" type="video/webm" />
      </video>
      <div className="absolute inset-0" style={{ background: overlay }} />
      <div className="absolute inset-0" style={{ background: vignette }} />
    </div>
  );
}
