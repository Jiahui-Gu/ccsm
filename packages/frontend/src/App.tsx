import { AppShell } from './components/AppShell';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';

export function App() {
  return <AppShell sidebar={<Sidebar />} main={<MainPane />} />;
}
