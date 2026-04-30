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
  /** L4 PR-B (#865): per-entry monotonic chunk counter. Renderer uses
   *  this together with `getBufferSnapshot().seq` to drop chunks already
   *  baked into the replayed snapshot. */
  seq: number;
}

export interface BufferSnapshotResult {
  /** SerializeAddon output of the headless authoritative buffer. May be
   *  empty if the sid is not registered or the buffer is empty. */
  snapshot: string;
  /** Value of the per-entry chunk seq captured atomically with the
   *  serialize call. Live `pty:data` chunks with `seq <= this` are
   *  already represented in `snapshot` and must be dropped by the
   *  renderer. */
  seq: number;
}

export type CheckClaudeAvailableResult =
  | { available: true; path: string }
  | { available: false };

export interface CcsmPtyApi {
  list(): Promise<PtySessionInfo[]>;
  spawn(sid: string, cwd: string): Promise<SpawnResult>;
  attach(sid: string): Promise<AttachResult | null>;
  detach(sid: string): Promise<void>;
  input(sid: string, data: string): Promise<void>;
  resize(sid: string, cols: number, rows: number): Promise<void>;
  kill(sid: string): Promise<{ ok: boolean; killed?: boolean }>;
  get(sid: string): Promise<PtySessionInfo | null>;
  /** L4 PR-B (#865): visible xterm attach replay channel. */
  getBufferSnapshot(sid: string): Promise<BufferSnapshotResult>;
  onData(cb: (e: PtyDataEvent) => void): () => void;
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  clipboard: {
    readText(): string;
    writeText(text: string): void;
  };
  checkClaudeAvailable(opts?: { force?: boolean }): Promise<CheckClaudeAvailableResult>;
}

declare global {
  interface Window {
    ccsmPty: CcsmPtyApi;
    __ccsmTerm?: import('@xterm/xterm').Terminal;
  }
}

export {};
