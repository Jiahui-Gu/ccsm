// Runtime session registry: owns the live PTY processes (one per sid),
// the per-session ring buffer + outputSeq counter, and the subscriber fan-out
// for OUTPUT/EXIT frames.
//
// Task #668: PTY spawn used to be triggered lazily on the first ws upgrade.
// We've moved it to the HTTP layer (POST /api/sessions creates+spawns;
// POST /api/sessions/:sid/resume re-spawns with `--resume`). This module
// is the shared dependency injected into both http.mts and ws.mts so both
// layers operate on the same runtime Map.
//
// Spike #665 takeaway: `claude --resume <sid>` MUST be re-launched in the
// same cwd that originally created the session, otherwise the CLI exits 1.
// We therefore take the cwd from the StubSession (set at create time and
// retained for the lifetime of the row) when synthesizing the spawn args.

import { createRequire } from 'node:module';

import { encodeExit, encodeFrame, FrameType } from '@ccsm/shared';

import { RingBuffer } from './ring.mjs';

// ---- Public types -------------------------------------------------------

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void): void;
}

export type PtySpawnMode = 'create' | 'resume';

export interface PtySpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  /** Session id. Used to derive the `claude` CLI arg list:
   *   create -> ['--session-id', sid]
   *   resume -> ['--resume', sid]
   */
  sid: string;
  mode: PtySpawnMode;
}

export type PtyFactory = (opts: PtySpawnOpts) => PtyLike;

export interface SessionLike {
  sid: string;
  cwd?: string | undefined;
  alive: boolean;
}

/**
 * Structural interface for a subscriber socket — matches the parts of
 * `ws.WebSocket` we use inside the registry's fan-out loop. Lets us keep
 * the registry independent of the `ws` package types so http.mts can import
 * it without a transitive ws dependency.
 */
export interface SubscriberSocket {
  readyState: number;
  readonly OPEN: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface SubscriberState {
  /** T11 #654: when true, OUTPUT goes to pausedQueue instead of socket.send. */
  paused: boolean;
  /** Pre-encoded frames queued while paused. */
  pausedQueue: Uint8Array[];
  /** Running byte total of pausedQueue, compared to PAUSE_QUEUE_CAP_BYTES. */
  pausedBytes: number;
}

export interface RuntimeSession {
  pty: PtyLike;
  subscribers: Map<SubscriberSocket, SubscriberState>;
  outputSeq: number;
  exited: boolean;
  exitCode: number;
  ring: RingBuffer;
  /**
   * Task #758: resolves AFTER the EXIT frame (FrameType=0x07) has been
   * broadcast to all OPEN subscribers and `exited` flipped to true. The
   * DELETE handler awaits this (with timeout) so that the HTTP 200 is
   * only returned once the wire-level EXIT has reached subscribers — the
   * client's own ws is still OPEN at that moment because it only detaches
   * after seeing the DELETE response. Resolves with the exit code.
   */
  exitPromise: Promise<number>;
}

export interface RuntimeRegistryOptions {
  ptyFactory?: PtyFactory;
  defaultCols?: number;
  defaultRows?: number;
  /** Stub session map, owned by createDaemonHttp. */
  sessions: Map<string, SessionLike>;
}

export interface RuntimeRegistry {
  /** Spawn a PTY for `sid`. No-op (returns existing) if already alive. */
  spawn(sid: string, info: SessionLike, mode: PtySpawnMode): RuntimeSession | null;
  /** Get the live runtime for `sid`, if any. */
  get(sid: string): RuntimeSession | undefined;
  /** Has `sid` got a live runtime? */
  has(sid: string): boolean;
  /**
   * SIGTERM the PTY (and after 2s, SIGKILL if still alive). Resolves once the
   * EXIT frame has been broadcast to OPEN subscribers (i.e. the PTY truly
   * exited and onExit ran), or after `awaitExitTimeoutMs` (default 2000ms)
   * if the PTY hangs — whichever first. Task #758: the DELETE handler
   * `await`s this so the HTTP 200 lands AFTER the wire-level EXIT.
   */
  kill(sid: string, awaitExitTimeoutMs?: number): Promise<void>;
  /** Iterate over all live runtimes (for shutdown). */
  entries(): IterableIterator<[string, RuntimeSession]>;
  /** Tear down everything (used by attached.shutdown). */
  shutdownAll(): void;
}

// ---- Constants ----------------------------------------------------------

const PAUSE_QUEUE_CAP_BYTES = 1 * 1024 * 1024;

// ---- Default PTY factory (real node-pty spawn of `claude`) --------------

const defaultPtyFactory: PtyFactory = (opts) => {
  const requireCjs = createRequire(import.meta.url);
  const nodePty = requireCjs('node-pty') as typeof import('node-pty');
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'claude.cmd' : 'claude';
  // Spike #665: --resume must be paired with the same cwd that was used at
  // create time, otherwise `claude` exits 1 immediately.
  const args = opts.mode === 'resume'
    ? ['--resume', opts.sid]
    : ['--session-id', opts.sid];
  const pty = nodePty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    useConpty: true,
  });
  return {
    write: (d) => pty.write(d),
    resize: (c, r) => pty.resize(c, r),
    kill: (s) => {
      // Task #758: node-pty's WindowsTerminal.kill() THROWS if you pass any
      // signal name ("Signals not supported on windows."). On Windows we
      // must call kill() with no argument (which routes to TerminateJobObject
      // — a hard, immediate kill). The shared PtyLike interface accepts an
      // optional signal so POSIX callers can still pass SIGTERM / SIGKILL.
      if (process.platform === 'win32') {
        pty.kill();
      } else {
        pty.kill(s);
      }
    },
    onData: (cb) => {
      pty.onData(cb);
    },
    onExit: (cb) => {
      pty.onExit(({ exitCode, signal }) => cb({ exitCode, signal }));
    },
  };
};

// ---- Registry implementation -------------------------------------------

export function createRuntimeRegistry(opts: RuntimeRegistryOptions): RuntimeRegistry {
  const ptyFactory = opts.ptyFactory ?? defaultPtyFactory;
  const defaultCols = opts.defaultCols ?? 80;
  const defaultRows = opts.defaultRows ?? 24;
  const sessions = opts.sessions;
  const runtime = new Map<string, RuntimeSession>();

  function spawn(sid: string, info: SessionLike, mode: PtySpawnMode): RuntimeSession | null {
    const existing = runtime.get(sid);
    if (existing && !existing.exited) {
      // Idempotent: caller (e.g. resume API) already has a live runtime; return it.
      return existing;
    }
    let pty: PtyLike;
    try {
      pty = ptyFactory({
        cwd: info.cwd ?? process.cwd(),
        cols: defaultCols,
        rows: defaultRows,
        sid,
        mode,
      });
    } catch (err) {
      console.error(`[ccsm/runtime] pty spawn failed for sid=${sid}:`, (err as Error).message);
      return null;
    }
    const rt: RuntimeSession = {
      pty,
      subscribers: new Map(),
      outputSeq: 0,
      exited: false,
      exitCode: 0,
      ring: new RingBuffer(),
      // Filled in below — onExit resolves it after the EXIT broadcast loop.
      exitPromise: undefined as unknown as Promise<number>,
    };
    let resolveExit!: (code: number) => void;
    rt.exitPromise = new Promise<number>((r) => {
      resolveExit = r;
    });
    runtime.set(sid, rt);

    pty.onData((data) => {
      const payload = Buffer.from(data, 'utf8');
      const payloadView = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      rt.outputSeq = (rt.outputSeq + 1) >>> 0;
      rt.ring.append(rt.outputSeq, payloadView);
      const frame = encodeFrame({
        type: FrameType.OUTPUT,
        seq: rt.outputSeq,
        payload: payloadView,
      });
      for (const [sock, state] of Array.from(rt.subscribers.entries())) {
        if (sock.readyState !== sock.OPEN) continue;
        if (state.paused) {
          state.pausedQueue.push(frame);
          state.pausedBytes += frame.byteLength;
          if (state.pausedBytes > PAUSE_QUEUE_CAP_BYTES) {
            state.pausedQueue = [];
            state.pausedBytes = 0;
            try {
              sock.close(1009, 'pause_queue_overflow');
            } catch {
              // ignore
            }
          }
          continue;
        }
        try {
          sock.send(frame);
        } catch (err) {
          console.warn('[ccsm/runtime] subscriber send failed:', (err as Error).message);
        }
      }
    });

    pty.onExit(({ exitCode }) => {
      const code = exitCode < 0 ? 0xffffffff : (exitCode >>> 0);
      rt.exited = true;
      rt.exitCode = code;
      rt.outputSeq = (rt.outputSeq + 1) >>> 0;
      const frame = encodeFrame({
        type: FrameType.EXIT,
        seq: rt.outputSeq,
        payload: encodeExit(code),
      });
      for (const sock of Array.from(rt.subscribers.keys())) {
        if (sock.readyState === sock.OPEN) {
          try {
            sock.send(frame);
          } catch {
            // ignore
          }
          try {
            sock.close(1000, 'exited');
          } catch {
            // ignore
          }
        }
      }
      const live = sessions.get(sid);
      if (live) live.alive = false;
      runtime.delete(sid);
      // Task #758: signal awaiters (DELETE handler) AFTER broadcast + map
      // cleanup so anyone awaiting `kill()` sees a fully-settled runtime.
      resolveExit(code);
    });

    return rt;
  }

  function kill(sid: string, awaitExitTimeoutMs = 2000): Promise<void> {
    const rt = runtime.get(sid);
    if (!rt) return Promise.resolve();
    if (rt.exited) {
      // onExit already fired — exitPromise is already settled.
      return rt.exitPromise.then(() => undefined);
    }
    // Task #758: send the strongest available signal up-front. On POSIX we
    // start with SIGTERM (gives `claude` a chance to flush state) and
    // escalate to SIGKILL after 200ms if it hasn't exited; on Windows
    // node-pty's kill() ignores the signal name and always calls
    // TerminateJobObject which is a hard kill, so SIGTERM/SIGKILL are
    // equivalent there. The aggressive escalation matters because the
    // DELETE handler awaits the EXIT broadcast — a slow `claude` shutdown
    // (it can dump hundreds of OUTPUT frames as the SIGINT renders before
    // it actually exits) would otherwise hit the 2s await timeout and the
    // EXIT frame would land too late, after the client already detached.
    const isWindows = process.platform === 'win32';
    try {
      rt.pty.kill(isWindows ? 'SIGKILL' : 'SIGTERM');
    } catch (err) {
      console.warn(`[ccsm/runtime] kill sid=${sid}:`, (err as Error).message);
    }
    if (!isWindows) {
      const escalate = setTimeout(() => {
        if (!rt.exited) {
          try {
            rt.pty.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 200);
      escalate.unref();
    }
    // Race the PTY's onExit (which fires after EXIT broadcast) against a
    // wall-clock timeout. Timeout path returns void without rejecting — the
    // caller (DELETE handler) still wants to send 200 to avoid HTTP hang on
    // a wedged PTY. We log a warning so wedged PTYs are visible in logs.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          `[ccsm/runtime] kill sid=${sid}: PTY did not exit within ${awaitExitTimeoutMs}ms; ` +
            `EXIT frame may have been delivered late.`,
        );
        resolve();
      }, awaitExitTimeoutMs);
      timer.unref();
      rt.exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      }, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function shutdownAll(): void {
    for (const [sid, rt] of Array.from(runtime.entries())) {
      for (const sock of Array.from(rt.subscribers.keys())) {
        try {
          sock.close(1001, 'going_away');
        } catch {
          // ignore
        }
      }
      void kill(sid);
    }
    runtime.clear();
  }

  return {
    spawn,
    get: (sid) => runtime.get(sid),
    has: (sid) => runtime.has(sid),
    kill,
    entries: () => runtime.entries(),
    shutdownAll,
  };
}
