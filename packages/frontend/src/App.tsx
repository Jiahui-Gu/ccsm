import { AppShell } from './components/AppShell';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';
import { useBootstrap } from './hooks/useBootstrap';

export function App() {
  useBootstrap();
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}
