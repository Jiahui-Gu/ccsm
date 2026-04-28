// Renderer-side type augmentation for `window.ccsmCliBridge`. The
// authoritative surface is defined in `electron/preload.ts` (exported as
// `CCSMCliBridgeAPI`) but the renderer's Vite build cannot import from
// the electron tree, so the shape is mirrored here. Keep both in sync.
//
// Per preload.ts: `ccsmCliBridge` is intentionally a separate namespace
// from `window.ccsm` while the in-process SDK runner is being torn out.
// It will fold into the main `ccsm` namespace once that work lands.

type CliBridgeOpenResult =
  | { ok: true; port: number; sid: string }
  | { ok: false; error: string };

type CliBridgeKillResult =
  | { ok: true; killed: boolean }
  | { ok: false; error: string };

type CliBridgeAvailability =
  | { available: true; path: string }
  | { available: false };

type TtydExitEvent = {
  sessionId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

declare global {
  interface Window {
    ccsmCliBridge?: {
      openTtydForSession: (sessionId: string, cwd: string) => Promise<CliBridgeOpenResult>;
      resumeSession: (sessionId: string, cwd: string, sid: string) => Promise<CliBridgeOpenResult>;
      killTtydForSession: (sessionId: string) => Promise<CliBridgeKillResult>;
      getTtydForSession: (sessionId: string) => Promise<{ port: number; sid: string } | null>;
      checkClaudeAvailable: (opts?: { force?: boolean }) => Promise<CliBridgeAvailability>;
      onTtydExit: (handler: (e: TtydExitEvent) => void) => () => void;
    };
  }
}

export {};
