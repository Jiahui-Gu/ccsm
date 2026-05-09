// Tauri shell App — Task #112-T3 (non-blocking bootstrap):
//   <App>
//     = <DaemonStateProvider>
//         <PhaseSwitch>
//           Ready → <RuntimeProvider hostConfig={...}><AppContent/></...>
//           else  → <DaemonStatusOverlay phase={phase} ... />
//
// hostConfig is no longer built in main.tsx and threaded as a prop; instead
// PhaseSwitch builds it from the `Ready` payload of the daemon-state event
// once it arrives. Re-spawning the daemon (future) re-enters Ready with a
// fresh port/token and PhaseSwitch will re-mount RuntimeProvider with the
// new config because hostConfig identity changes (a new object literal per
// render of the Ready branch — RuntimeProvider's `useMemo` keys off the
// fields, see runtime-context.tsx).

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
import type { DaemonPhase } from './types';

function AppContent() {
  useBootstrap();
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}

function buildHostConfig(port: number, token: string): HostConfig {
  return {
    httpBase: `http://127.0.0.1:${port}`,
    getToken: () => token,
  };
}

// Exported for Task #138 e2e-equivalent vitest coverage (PhaseSwitch.test.tsx).
// Tests inject a DaemonStateContext value and assert routing without spinning
// up the real Tauri event channel. No production caller imports it.
export function PhaseSwitch() {
  const phase = useDaemonPhase();
  switch (phase.phase) {
    case 'ready': {
      const hostConfig = buildHostConfig(phase.port, phase.token);
      return (
        <RuntimeProvider hostConfig={hostConfig}>
          <AppContent />
        </RuntimeProvider>
      );
    }
    case 'notSpawned':
    case 'spawning':
    case 'starting':
    case 'tunnelDisconnected':
    case 'tunnelConnected':
      return <DaemonStatusOverlay phase={phase} variant="info" />;
    case 'spawnFailed':
    case 'exited':
    case 'authFailed':
      return <DaemonStatusOverlay phase={phase} variant="error" />;
    case 'awaitingAuth':
      // S4-T8 owns the real awaiting-auth UI. Until then we render the same
      // overlay with a distinct variant so the user has feedback.
      return <DaemonStatusOverlay phase={phase} variant="auth" />;
    default: {
      // Exhaustiveness check: any new DaemonPhase variant added without a
      // case here will fail to type-check.
      const _exhaustive: never = phase;
      throw new Error(
        `unreachable daemon phase: ${(_exhaustive as DaemonPhase).phase}`,
      );
    }
  }
}

export function App() {
  return (
    <DaemonStateProvider>
      <PhaseSwitch />
    </DaemonStateProvider>
  );
}
