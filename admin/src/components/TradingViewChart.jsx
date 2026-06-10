import { useEffect, useRef, useState } from 'react';

/**
 * View-only TradingView Advanced Chart (admin exposure dashboard).
 *
 * Embeds TradingView's official widget — it natively provides the symbol
 * search, timeframe selector, indicators and fullscreen, with NO order /
 * trading controls of any kind. This page is read-only, so the embed is the
 * cleanest "professional chart, zero trading actions" option.
 *
 * `tvSymbol` is a TradingView-format symbol (e.g. "BINANCE:BTCUSDT",
 * "FX:GBPUSD"); the parent maps platform instruments to these.
 */
let tvScriptPromise = null;
function loadTv() {
  if (window.TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;
  tvScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/tv.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { tvScriptPromise = null; reject(new Error('tv-load-failed')); };
    document.body.appendChild(s);
  });
  return tvScriptPromise;
}

const isDarkTheme = () =>
  (document.documentElement.getAttribute('data-theme') || 'dark') !== 'light';

export default function TradingViewChart({ tvSymbol, height = 460 }) {
  const holderRef = useRef(null);
  const idRef = useRef(`tv_${Math.random().toString(36).slice(2)}`);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadTv()
      .then(() => {
        if (cancelled || !holderRef.current || !window.TradingView) return;
        holderRef.current.innerHTML = `<div id="${idRef.current}" style="height:100%;width:100%"></div>`;
        // eslint-disable-next-line no-new
        new window.TradingView.widget({
          autosize: true,
          symbol: tvSymbol || 'BINANCE:BTCUSDT',
          interval: 'D',
          timezone: 'Etc/UTC',
          theme: isDarkTheme() ? 'dark' : 'light',
          style: '1',
          locale: 'en',
          enable_publishing: false,
          allow_symbol_change: true,    // symbol selector
          hide_side_toolbar: false,     // indicators / drawing
          withdateranges: true,         // timeframe ranges
          container_id: idRef.current,
        });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [tvSymbol]);

  if (failed) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border-dark bg-bg-dark/40 text-text-muted text-sm"
        style={{ height }}>
        Chart unavailable (could not reach TradingView).
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden border border-border-dark" style={{ height }}>
      <div ref={holderRef} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
