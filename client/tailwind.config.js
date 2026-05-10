/** @type {import('tailwindcss').Config} */
// Colors below use the `rgb(var(--color-X) / <alpha-value>)` form so a single
// stylesheet (index.css) can flip the entire palette between dark and light
// themes without rewriting any component class. The `<alpha-value>` token is
// substituted by Tailwind at compile time, which keeps utilities like
// `bg-bg-card/50` working in both themes.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Brand yellow stays the same in both themes.
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
        teal: {
          accent: '#FCD535',
          dark: '#8A720F',
        },
        // Bull / bear / warn / info — same in both themes (colorblind-friendly,
        // and they need to read consistently on charts regardless of mode).
        bull: '#00C853',
        bear: '#FF3D71',
        warn: '#FFA000',
        info: '#2196F3',
        // Theme-driven surfaces. Each resolves through a CSS variable.
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
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
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
