import {
  AppShell,
  MainPane,
  RuntimeProvider,
  Sidebar,
  useBootstrap,
} from '@ccsm/ui';
import { webHostConfig } from './hostConfig';

// Inner component so useBootstrap can run inside <RuntimeProvider> (it
// uses useApi via the context).
function AppContent() {
  useBootstrap();
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}

export function App() {
  return (
    <RuntimeProvider hostConfig={webHostConfig}>
      <AppContent />
    </RuntimeProvider>
  );
}
