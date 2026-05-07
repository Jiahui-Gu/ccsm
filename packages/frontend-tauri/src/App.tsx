// Tauri shell App — same composition as frontend-web (Wave-2 T6 / T10):
// <RuntimeProvider hostConfig={...}> wraps useBootstrap + AppShell. The
// hostConfig is built by main.tsx from the daemon handshake and passed in
// as a prop, so that re-spawning the daemon (future) just re-mounts <App>
// with a fresh config.

import {
  AppShell,
  MainPane,
  RuntimeProvider,
  Sidebar,
  useBootstrap,
  type HostConfig,
} from '@ccsm/ui';

function AppContent() {
  useBootstrap();
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}

export interface AppProps {
  hostConfig: HostConfig;
}

export function App({ hostConfig }: AppProps) {
  return (
    <RuntimeProvider hostConfig={hostConfig}>
      <AppContent />
    </RuntimeProvider>
  );
}
