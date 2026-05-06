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

// v0.3 wave B1 (Task #627): the renderer-side compatibility shim is
// gone. `window.ccsm` is now installed exclusively by the preload bridge
// `electron/preload/bridges/ccsmCore.ts`, which exposes the full surface
// (6 IPC-only + 25 daemon-backed methods) under a single non-enumerable
// configurable property. The type alias re-exports the preload bridge's
// `CCSMAPI` so renderer call sites keep their static typing.
//
// `__getDaemonPort` is preserved as an optional-but-unused declaration:
// no renderer code references it after the shim deletion (the preload
// bridge resolves the daemon port internally via `daemonFetch`), but
// keeping the ambient prevents accidental re-introduction without a
// type-level signal.
import type { CCSMAPI } from '../electron/preload/bridges/ccsmCore';

declare global {
  interface Window {
    // Optional to keep call-site narrowing (`if (!window.ccsm) return;`,
    // `window.ccsm?.foo`) compiling unchanged. The preload bridge
    // guarantees a non-undefined value at runtime before any renderer
    // script evaluates, so the narrowing branches are dead code in
    // practice but still type-check.
    ccsm?: CCSMAPI;
    __getDaemonPort?: () => Promise<number>;
  }
}

export {};
