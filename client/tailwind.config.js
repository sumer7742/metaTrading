/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Exness-style yellow as primary brand color
        primary: {
          50: '#FFFCE5',
          100: '#FFF7B2',
          200: '#FFEF80',
          300: '#FFE74D',
          400: '#FFDE26',
          500: '#FCD535',  // primary brand yellow (Exness signature)
          600: '#E6BF1F',
          700: '#B89815',
          800: '#8A720F',
          900: '#5C4C0A',
        },
        // Backwards compatibility - teal-accent now points to yellow
        teal: {
          accent: '#FCD535',
          dark: '#8A720F',
        },
        // Bull/bear (slightly punchier than before)
        bull: '#00C853',
        bear: '#FF3D71',
        warn: '#FFA000',
        info: '#2196F3',
        // Backgrounds (Exness uses very dark with subtle warmth)
        bg: {
          dark: '#0F0F12',     // deep dark
          card: '#1A1A1F',     // slightly lighter
          panel: '#1F1F25',    // panel/elevated surface
          hover: '#2A2A30',    // hover state
          sidebar: '#0A0A0D',  // sidebar even darker
        },
        border: {
          dark: '#2D2D34',
          subtle: '#1F1F25',
          accent: '#FCD535',
        },
        // Text shades
        text: {
          primary: '#FFFFFF',
          secondary: '#B0B0B8',
          muted: '#6E6E78',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        // Exness uses sharp/medium corners (4-8px mostly)
        DEFAULT: '6px',
        sm: '4px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        // Subtle Exness-style shadows
        card: '0 1px 3px rgba(0, 0, 0, 0.3)',
        elevated: '0 4px 12px rgba(0, 0, 0, 0.4)',
        glow: '0 0 0 1px rgba(252, 213, 53, 0.3)',
      },
    },
  },
  plugins: [],
};
