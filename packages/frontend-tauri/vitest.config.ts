import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// @ccsm/frontend-tauri — Task #138 (#112-T5).
// Component-level coverage of the PhaseSwitch routing in src/App.tsx, which
// is the contract that "no daemon spawn => visible UI (DaemonStatusOverlay),
// not a black screen" relies on.
//
// Why vitest + RTL instead of tauri-driver / Playwright (Option A):
//   The full e2e route would require `cargo install tauri-driver` plus an
//   Edge WebDriver pin and a fresh Tauri build per run. That setup blew past
//   the 30 min budget called out in the task spec, so we follow the spec's
//   explicit fallback (Option B): vitest + RTL on the routing component, with
//   a manual Tauri smoke recorded in the PR body. The DaemonStatusOverlay
//   itself is already covered by packages/ui/test/DaemonStatusOverlay.test.tsx
//   (Task #137), so this suite focuses purely on the phase => component map.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
