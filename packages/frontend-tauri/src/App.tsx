// Tauri shell App — R-57 (Task #181) architectural split.
//
// Before: PhaseSwitch hard-gated the entire SPA. Every non-Ready daemon phase
// (notSpawned / spawning / starting / spawnFailed / exited / awaitingAuth /
// authFailed) rendered DaemonStatusOverlay with `position: fixed; inset: 0`,
// so during the 2-3 s daemon spawn window the user saw a full-screen
// "Starting daemon…" panel and Sidebar / MainPane were completely hidden.
// Task #112 originally intended "no daemon also has UI" — the SPA shell
// should be visible immediately and degrade gracefully into placeholders.
//
// After (R-57):
//   <App>
//     = <DaemonStateProvider>
//         <RuntimeProvider hostConfig={hostConfig|null}>
//           <AppShell sidebar={Sidebar+LoginButton} main={MainPane} />
//           <DaemonStatusOverlay phase={phase} mode={chip|banner|dialog} />
//
// RuntimeProvider accepts a nullable hostConfig (built from the Ready
// payload, null otherwise). When null:
//   - api.* rejects with "daemon not ready"
//   - useBootstrap is a no-op
//   - Sidebar "+ New Session" button is disabled with tooltip "Waiting for
//     daemon…"
//   - MainPane prints "[waiting for daemon…]" inside xterm
// Once Ready lands, hostConfig becomes non-null, useMemo mints a fresh
// runtime, and the existing flows take over (Sidebar enables, useBootstrap
// hydrates the session list).
//
// DaemonStatusOverlay routes by phase:
//   loading phases (notSpawned/spawning/starting) → bottom-right chip
//   failure phases (spawnFailed/exited/authFailed) → top sticky banner
//   awaitingAuth → centred dialog (user must read user_code to authorize —
//                  the one remaining blocking surface, by design)
//   ready → null
//
// awaitingAuth keeps modal semantics deliberately: the device-flow login
// flow needs the user's eyes on user_code, and dismissing it accidentally
// would strand the daemon mid-handshake. R-57 task spec gave us discretion
// on this; dialog is the right call for an authorization step.
//
// Exported: PhaseSwitch (legacy name, retained for #138 vitest compat) now
// renders the architectural split; AppShellWithDaemonStatus is the new
// preferred entrypoint.

import {
  AppShell,
  DaemonStatusOverlay,
  MainPane,
  RuntimeProvider,
  Sidebar,
  useBootstrap,
  type HostConfig,
} from '@ccsm/ui';
import { DaemonStateProvider, useDaemonPhase } from './DaemonStateProvider';
import { LoginButton } from './auth/LoginButton';
import type { DaemonPhase } from './types';

function AppContent() {
  // useBootstrap is no-op while hostReady === false (see useBootstrap.ts);
  // it re-fires once the daemon emits Ready and hydrates the session list.
  useBootstrap();
  return (
    <AppShell
      sidebar={
        <div className="tauri-sidebar">
          {/* S4-T8 (#141): device-flow login button. Untouched daemon still
              works in legacy loopback mode if the user never logs in. */}
          <div className="tauri-sidebar__login">
            <LoginButton />
          </div>
          <Sidebar />
        </div>
      }
      main={<MainPane />}
    />
  );
}

function buildHostConfig(port: number, token: string): HostConfig {
  return {
    httpBase: `http://127.0.0.1:${port}`,
    getToken: () => token,
  };
}

/**
 * Resolve the HostConfig to pass into RuntimeProvider for a given daemon
 * phase. Only `ready` yields a real config; every other phase returns null
 * so RuntimeProvider's api rejects with "daemon not ready" and consumers
 * render placeholders.
 *
 * This is intentionally a pure function so unit tests can assert the
 * routing without spinning up React.
 */
export function hostConfigForPhase(phase: DaemonPhase): HostConfig | null {
  if (phase.phase === 'ready') {
    return buildHostConfig(phase.port, phase.token);
  }
  return null;
}

// Exported for Task #138 vitest coverage. The export name "PhaseSwitch" is
// retained for backward-compat with PhaseSwitch.test.tsx; the component no
// longer literally switches phases (it renders the same shell for every
// phase), but the indicator overlay still routes by phase via mode prop.
export function PhaseSwitch() {
  const phase = useDaemonPhase();
  const hostConfig = hostConfigForPhase(phase);
  // Exhaustiveness check: every DaemonPhase variant must be handled by
  // either hostConfigForPhase (ready → config) or DaemonStatusOverlay
  // (non-ready phases → chip/banner/dialog). Adding a new variant without
  // updating either side will fail to type-check here.
  const _exhaustive: DaemonPhase['phase'] = phase.phase;
  void _exhaustive;
  return (
    <RuntimeProvider hostConfig={hostConfig}>
      <AppContent />
      {/* Indicator surface — chip / banner / dialog. Renders nothing on
          ready. Stays above the AppShell via fixed positioning, never
          replaces it. */}
      <DaemonStatusOverlay phase={phase} />
    </RuntimeProvider>
  );
}

export function App() {
  return (
    <DaemonStateProvider>
      <PhaseSwitch />
    </DaemonStateProvider>
  );
}
