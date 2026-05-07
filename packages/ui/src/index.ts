// @ccsm/ui — shared React layer for the web + Tauri shells (Wave-2 T6).
//
// Public surface:
//   - <RuntimeProvider hostConfig={...}>{children}</RuntimeProvider>
//   - useRuntime() / useApi() / useGetToken() / HttpError
//   - <AppShell>, <Sidebar>, <MainPane> — composed by shells
//   - useBootstrap() — fetches the session list on token transitions
//   - useStore — zustand store (token / sessions / activeSid / statuses)
//   - HostConfig — shape shells inject into RuntimeProvider
//
// Shells own:
//   - mounting React (createRoot in main.tsx)
//   - building hostConfig (web: window.location + sessionStorage; tauri:
//     daemon spawn handshake)
//   - styles.css import path (consumers import '@ccsm/ui/styles.css')

export { AppShell } from './components/AppShell';
export { Sidebar } from './components/Sidebar';
export { MainPane } from './components/MainPane';
export { useBootstrap } from './hooks/useBootstrap';
export { useStore } from './store';
export {
  RuntimeProvider,
  useRuntime,
  useApi,
  useGetToken,
  HttpError,
  type BoundApi,
  type RuntimeContextValue,
  type RuntimeProviderProps,
} from './runtime-context';
export type { HostConfig } from './types';
