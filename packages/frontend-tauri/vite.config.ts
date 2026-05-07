import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the Tauri 2 desktop shell. Uses a fixed dev port so
// `tauri.conf.json` can hard-wire `devUrl: http://localhost:1420`.
// Tauri controls when this is started via `beforeDevCommand`.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // Tauri expects the bundled frontend at `../dist` relative to src-tauri/.
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
