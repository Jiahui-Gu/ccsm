import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api and /ws to the local daemon (default port 17832).
// In production the daemon serves the built frontend itself, so no proxy is needed.
//
// Build modes:
// - default (`vite build`, used by Tauri and the daemon-embedded build): keeps
//   the historical behaviour. Vite's default `base` ('/') already produces
//   absolute `/assets/...` references, which is what both the embedded daemon
//   and the Tauri shell expect.
// - `--mode pages` (Cloudflare Pages deployment): explicitly pins `base: '/'`
//   so generated `index.html` references are root-absolute regardless of any
//   future default changes. Output dir and hashed asset filenames stay at
//   Vite defaults.
//
// `mode` is destructured so future per-mode tweaks have a clear seam; today
// `pages` and the default share the same root-absolute base.
export default defineConfig(({ mode: _mode }) => ({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17832',
        changeOrigin: false,
      },
      '/ws': {
        target: 'http://127.0.0.1:17832',
        ws: true,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
