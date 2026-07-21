// Ambient type declaration for the mobile remote's test-only serialization
// seam (mobile composer/terminal-sync plan, Task 6). Production code
// (`src/mobile/components/PhoneShell.tsx`) assigns `window.__ccsmMobileTest`
// only when `new URLSearchParams(location.search).get('ccsmTest') === '1'`
// — normal production loads (real users, real pairing links) never define
// this global.
//
// Deliberately minimal and JSON-safe: `serializeTerminal()` exposes exactly
// what a Playwright-driven browser needs to compare against an
// `@xterm/headless` + `@xterm/addon-serialize` authoritative buffer, and
// `getSyncState()` exposes a plain-object copy of the pure
// `TerminalSyncState` fields relevant to fault-injection assertions
// (current sid, sync phase, last applied seq, whether a snapshot request is
// outstanding, and which sequence numbers are buffered awaiting a gap
// recovery). This bridge NEVER exposes pairing identity/secret, encryption
// keys, drafts, raw relay frames, the `RelayClient` instance, or the raw
// zustand store — only these two derived, read-only functions.
export type MobileTestSyncState = {
  sid: string | null;
  phase: 'idle' | 'syncing' | 'live';
  lastSeq: number;
  snapshotRequested: boolean;
  bufferedSeqs: number[];
};

export type MobileTestBridge = {
  serializeTerminal(): string;
  getSyncState(): MobileTestSyncState;
};

declare global {
  interface Window {
    __ccsmMobileTest?: MobileTestBridge;
  }
}

export {};
