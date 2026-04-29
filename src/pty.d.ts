// Type surface for the `window.ccsmPty` preload bridge defined in
// `electron/preload.ts`. Consumed by TerminalPane (PR-4) and the
// session lifecycle wiring in App / store (PR-6, PR-7).
//
// Kept in `src/` (not `electron/`) because this is the renderer-side
// view of the IPC contract — the main-process handlers in
// `electron/ptyHost/*` own the runtime implementation.

export interface PtySessionInfo {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  /** Working directory the PTY was actually spawned with (post-fallback). */
  cwd: string;
}

export interface AttachResult {
  snapshot: string;
  cols: number;
  rows: number;
  pid: number;
}

export interface SpawnResult {
  ok: boolean;
  sid: string;
  pid?: number;
  error?: string;
}

export interface PtyExitEvent {
  sessionId: string;
  code: number | null;
  signal: number | null;
}

export interface PtyDataEvent {
  sid: string;
  chunk: string;
}

export interface CcsmPtyApi {
  list(): Promise<PtySessionInfo[]>;
  spawn(sid: string, cwd: string): Promise<SpawnResult>;
  attach(sid: string): Promise<AttachResult | null>;
  detach(sid: string): Promise<void>;
  input(sid: string, data: string): Promise<void>;
  resize(sid: string, cols: number, rows: number): Promise<void>;
  kill(sid: string): Promise<{ ok: boolean; killed?: boolean }>;
  get(sid: string): Promise<PtySessionInfo | null>;
  onData(cb: (e: PtyDataEvent) => void): () => void;
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  clipboard: {
    readText(): string;
    writeText(text: string): void;
  };
}

declare global {
  interface Window {
    ccsmPty: CcsmPtyApi;
    __ccsmTerm?: unknown;
  }
}

export {};
