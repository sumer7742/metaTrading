/**
 * <CountryFlag /> — renders a country flag PNG from flagcdn.com.
 *
 * Why an <img> and not an emoji? Windows ships without the regional-
 * indicator emoji set, so emoji flags fall back to the two-letter ISO
 * code on most Windows browsers. A CDN-served PNG renders identically on
 * macOS, Windows, Linux, iOS and Android. flagcdn.com is free and
 * aggressively cached by browsers.
 *
 * Accepts either:
 *   • `country` — ISO 3166-1 alpha-2 code (US, GB, EU, JP, …)
 *   • `currency` — ISO 4217 code (USD, GBP, EUR, JPY, …) which we map.
 */

const CCY_TO_COUNTRY = {
  USD: 'us',  EUR: 'eu',  GBP: 'gb',  JPY: 'jp',  CHF: 'ch',
  AUD: 'au',  NZD: 'nz',  CAD: 'ca',  INR: 'in',  CNY: 'cn',
  SGD: 'sg',  HKD: 'hk',  TRY: 'tr',  BRL: 'br',  RUB: 'ru',
  KRW: 'kr',  ZAR: 'za',  MXN: 'mx',  SEK: 'se',  NOK: 'no',
};

export default function CountryFlag({ country, currency, width = 20, className = '' }) {
  let code = '';
  if (country) code = String(country).toLowerCase();
  else if (currency) code = CCY_TO_COUNTRY[String(currency).toUpperCase()] || '';
  if (!code) return null;
  const h = Math.round(width * 0.75);
  return (
    <img
      src={`https://flagcdn.com/w40/${code}.png`}
      srcSet={`https://flagcdn.com/w80/${code}.png 2x`}
      width={width}
      height={h}
      alt={country || currency}
      loading="lazy"
      className={`inline-block rounded-sm align-middle ${className}`}
      style={{ objectFit: 'cover' }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
    />
  );
}
