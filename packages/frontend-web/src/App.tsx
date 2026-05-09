import {
  AppShell,
  MainPane,
  RuntimeProvider,
  Sidebar,
  useBootstrap,
} from '@ccsm/ui';

import { AuthProvider } from './auth/AuthContext';
import { SignInGate } from './auth/SignInGate';
import { webHostConfig } from './hostConfig';

// Inner component so useBootstrap can run inside <RuntimeProvider> (it
// uses useApi via the context).
function AppContent() {
  useBootstrap();
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}

// Task #139 (S4-T7): wrap the existing RuntimeProvider with AuthProvider +
// SignInGate so a visitor without a web JWT lands on SignInScreen instead
// of a hung session list. RuntimeProvider only mounts after the gate
// passes, ensuring the WsClient never opens a connection without a token.
export function App() {
  return (
    <AuthProvider>
      <SignInGate>
        <RuntimeProvider hostConfig={webHostConfig}>
          <AppContent />
        </RuntimeProvider>
      </SignInGate>
    </AuthProvider>
  );
}
