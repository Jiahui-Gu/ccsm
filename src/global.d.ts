// Updater status — exported so the renderer's `UpdatesPane` (and any
// future banners/toasts) can import a single source of truth instead of
// redeclaring the union locally. Mirrors the shape broadcast by the
// daemon over the (future) push channel; today the v0.3 shim returns
// it from `updatesStatus()` / `updatesCheck()`.
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

// v0.3 wave 1: the legacy `window.ccsm` IPC bridge moved into the
// renderer-side compatibility shim (`src/lib/window-ccsm-shim.ts`),
// which proxies every call to the local daemon over loopback HTTP.
// The 25-ish call sites elsewhere in the renderer keep using
// `window.ccsm.X(...)` unchanged — the type now points at `CcsmApi`
// from the shim instead of inlined here.
//
// `__getDaemonPort` is the new preload-installed bridge (wave 1
// dev-B) that surfaces the daemon's bound loopback port to the
// renderer at boot. The shim calls it once and caches the result.
import type { CcsmApi } from './lib/window-ccsm-shim';

declare global {
  interface Window {
    // Optional to keep call-site narrowing (`if (!window.ccsm) return;`,
    // `window.ccsm?.foo`) compiling unchanged. The shim guarantees a
    // non-undefined value at runtime once `installCcsmShim()` has been
    // awaited (which happens before React mounts in `index.tsx`), so the
    // narrowing branches are dead code in practice but still type-check.
    ccsm?: CcsmApi;
    __getDaemonPort?: () => Promise<number>;
  }
}

export {};
