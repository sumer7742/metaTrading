/** @type {import('tailwindcss').Config} */
// Groww-inspired design system. Surface tokens resolve through CSS variables
// (rgb(var(--color-X) / <alpha-value>)) so any component class works with a
// single light Groww palette. Primary is the Groww green (#00D09C); bull/bear
// stay distinct from primary so chart colors don't collide with the brand.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Brand — dark blue per redesign.
        primary: {
          50:  '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          300: '#93C5FD',
          400: '#3B82F6',
          500: '#1D4ED8',   // primary — dark royal blue
          600: '#1E40AF',   // hover  — slightly darker
          700: '#1E3A8A',
          800: '#172554',
          900: '#0F172A',
        },
        // Legacy alias retained so any old reference still resolves.
        teal: {
          accent: '#1D4ED8',
          dark:   '#1E3A8A',
        },
        bull: '#00C853',
        bear: '#FF3B57',
        warn: '#3B82F6',   // re-tinted to blue (was amber #F59E0B). All
                           // "PENDING / IN_PROGRESS / cooldown" chips that
                           // use bg-warn / text-warn now read blue.
        info: '#3B82F6',
        bg: {
          dark: 'rgb(var(--color-bg-dark) / <alpha-value>)',
          card: 'rgb(var(--color-bg-card) / <alpha-value>)',
          panel: 'rgb(var(--color-bg-panel) / <alpha-value>)',
          hover: 'rgb(var(--color-bg-hover) / <alpha-value>)',
          sidebar: 'rgb(var(--color-bg-sidebar) / <alpha-value>)',
        },
        border: {
          dark: 'rgb(var(--color-border-dark) / <alpha-value>)',
          subtle: 'rgb(var(--color-border-subtle) / <alpha-value>)',
          accent: '#1D4ED8',
        },
        text: {
          primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        sm: '6px',
        md: '8px',
        lg: '10px',
        xl: '14px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(17, 24, 39, 0.06), 0 2px 6px rgba(17, 24, 39, 0.07)',
        elevated: '0 8px 28px rgba(17, 24, 39, 0.12)',
        glow: '0 0 0 3px rgba(29, 78, 216, 0.22)',
      },
    },
  },
  plugins: [],
};
