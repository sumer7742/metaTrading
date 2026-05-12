import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` controls the public path under which the built SPA is served.
// Dev (`vite dev`) → '/' (root, no prefix).
// Combined-container prod → set VITE_BASE=/admin/ at build time so all
// asset URLs in the emitted index.html resolve under /admin/.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  base: process.env.VITE_BASE || '/',
});
