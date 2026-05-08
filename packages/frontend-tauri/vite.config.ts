import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the Tauri 2 desktop shell. Default dev port is 1420 so
// `tauri.conf.json` can hard-wire `devUrl: http://localhost:1420` for the
// normal developer workflow (`pnpm tauri dev`, no env). Smoke (and any other
// orchestrator that needs to run multiple instances side-by-side) overrides
// the port via `VITE_DEV_PORT`, paired with a Tauri `--config` override that
// rewrites `build.devUrl` to the same port; see
// `packages/smoke/fixtures/orchestrator.ts`. Tauri controls when this is
// started via `beforeDevCommand`.
const DEV_PORT = Number(process.env.VITE_DEV_PORT ?? 1420);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  // Tauri expects the bundled frontend at `../dist` relative to src-tauri/.
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
