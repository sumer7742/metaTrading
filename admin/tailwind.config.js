/** @type {import('tailwindcss').Config} */
// Mirrors the client's CSS-variable approach so admin can adopt the same
// premium yellow-accent + sectioned-sidebar look, with a single source of
// truth for surface and text colors.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#FFFCE5',
          100: '#FFF7B2',
          200: '#FFEF80',
          300: '#FFE74D',
          400: '#FFDE26',
          500: '#FCD535',
          600: '#E6BF1F',
          700: '#B89815',
          800: '#8A720F',
          900: '#5C4C0A',
        },
        teal: { accent: '#FCD535', dark: '#8A720F' },
        bull: '#00C853',
        bear: '#FF3D71',
        warn: '#FFA000',
        info: '#2196F3',
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
          accent: '#FCD535',
        },
        text: {
          primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0, 0, 0, 0.3)',
        elevated: '0 4px 12px rgba(0, 0, 0, 0.4)',
        glow: '0 0 0 1px rgba(252, 213, 53, 0.3)',
      },
    },
  },
  plugins: [],
};
