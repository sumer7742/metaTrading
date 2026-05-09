/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Exness-style yellow primary
        primary: {
          50: '#FFFCE5',
          100: '#FFF7B2',
          500: '#FCD535',
          600: '#E6BF1F',
          700: '#B89815',
        },
        teal: {
          accent: '#FCD535',
        },
        bull: '#00C853',
        bear: '#FF3D71',
        warn: '#FFA000',
        bg: {
          dark: '#0F0F12',
          card: '#1A1A1F',
          panel: '#1F1F25',
          hover: '#2A2A30',
          sidebar: '#0A0A0D',
        },
        border: { dark: '#2D2D34' },
        text: {
          primary: '#FFFFFF',
          secondary: '#B0B0B8',
          muted: '#6E6E78',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
      },
    },
  },
  plugins: [],
};
