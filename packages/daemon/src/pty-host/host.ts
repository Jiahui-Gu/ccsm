// pty-host parent surface — spawns one OS process per session via
// `child_process.fork`. Spec ch06 §1 (FOREVER-STABLE):
//
//   - `child_process.fork`, NOT `worker_threads`. F3-locked. The
//     architectural reason is failure containment + v0.4 per-principal
//     uid drop additivity (see the spec for the full argument).
//   - One child per session. The child is the parent of the `claude`
//     CLI process; killing the child reaps `claude` automatically.
//   - The IPC channel is the built-in `child.send` / `child.on('message')`
//     pair. JSON envelope is what `child_process.fork` provides; binary
//     payloads (snapshot bytes) cross as `Buffer` instances within the
//     envelope (Node serializes them transparently).
//
// T4.1 scope: the lifecycle skeleton — spawn → ready handshake → close
// or crash. Snapshot / delta / SendInput plumbing wires up in T4.6+.
//
// SRP: this module is a *producer* of child handles (lifecycle events).
// It does NOT decide UTF-8 env (that is `spawn-env.ts`), it does NOT
// touch SQLite (T5.x), and it does NOT fan delta bytes out to Connect
// streams (T4.13). Each of those is a separate module.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeUtf8SpawnEnv } from './spawn-env.js';
import {
  PtySessionEmitter,
  registerEmitter as registerEmitterDefault,
  unregisterEmitter as unregisterEmitterDefault,
} from './pty-emitter.js';
import type {
  ChildExit,
  ChildToHostMessage,
  HostToChildMessage,
  SpawnPayload,
} from './types.js';

/**
 * Configuration for `spawnPtyHostChild`. All fields beyond `payload`
 * are optional and have spec-driven defaults; tests may override
 * `childEntrypoint` to inject a fixture script (e.g. one that exits
 * immediately) without rebuilding the daemon dist.
 */
export interface SpawnPtyHostChildOptions {
  /** Per-session spawn parameters forwarded as the first IPC message. */
  readonly payload: SpawnPayload;
  /**
   * Override the child entrypoint script. Defaults to the sibling
   * `child.js` resolved relative to *this* module's URL — i.e. the
   * compiled `dist/pty-host/child.js` in production builds and the
   * `src/pty-host/child.ts` (via tsx) when imported under the daemon's
   * vitest config (which transparently resolves `.js` to `.ts`).
   *
   * Tests pass an absolute path to a `.cjs` / `.mjs` fixture; production
   * code does not need to set this.
   */
  readonly childEntrypoint?: string;
  /**
   * Override the env passed to the forked child (NOT the env handed to
   * `claude`). Tests use this to set `CCSM_PTY_TEST_*` flags; production
   * leaves it `undefined` to inherit `process.env` verbatim.
   */
  readonly forkEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Override `process.platform` for the UTF-8 spawn-env computation.
   * Useful in cross-platform tests; production omits it.
   */
  readonly platformOverride?: NodeJS.Platform;
  /**
   * macOS UTF-8 locale to use if the daemon's startup probe found that
   * `C.UTF-8` is not registered. Forwarded into `computeUtf8SpawnEnv`.
   */
  readonly darwinFallbackLocale?: string;
  /**
   * Per-session in-memory emitter wiring (T-PA-5 / spec
   * `2026-05-04-pty-attach-handler.md` §2.3, §9.2).
   *
   * When unset (the production default), `spawnPtyHostChild` constructs
   * a {@link PtySessionEmitter} on the child's `'ready'` IPC, registers
   * it in the module-level registry (so `getEmitter(sessionId)` from
   * `pty-emitter.ts` returns it), routes every `'delta'` / `'snapshot'`
   * IPC into the emitter, and tears it down (`emitter.close()` +
   * `unregisterEmitter`) when the child exits. The Attach handler
   * (T-PA-6, future PR) consumes the emitter via `getEmitter(sessionId)`.
   *
   * Tests that exercise the lifecycle skeleton without the emitter
   * surface (e.g. host.spec.ts fixtures that reuse the same sessionId
   * across `it` cases and would otherwise trip the registry's
   * duplicate-id guard) pass `emitterRegistry: 'disabled'`. The IPC
   * 'message' / 'exit' wiring then skips emitter publish/teardown
   * entirely; the rest of the lifecycle (ready / exited / messages
   * iterator) is unaffected.
   *
   * Tests that want to exercise the wire-up without polluting the
   * module-level registry pass a throwaway `{ register, unregister }`
   * pair — the emitter is still constructed, but the lookup path uses
   * the injected registry instead of the module singleton.
   */
  readonly emitterRegistry?:
    | 'disabled'
    | {
        readonly register: (emitter: PtySessionEmitter) => void;
        readonly unregister: (sessionId: string) => boolean;
      };
}

/**
 * Handle returned by `spawnPtyHostChild`. Exposes only the surface the
 * daemon main process needs in T4.1: send the close signal, observe the
 * exit, and read the resolved spawn-env that *would* be passed to the
 * `claude` CLI subprocess (used by T4.2's per-OS argv shaping + by the
 * 1-hour soak harness's snapshot byte-equality assertion).
 *
 * The `messages` async iterator yields every well-formed IPC message
 * from the child until the child exits or disconnects. Malformed
 * messages are dropped silently (the child is trusted code; this is
 * defensive for forward-compat where a future T4.x adds a kind the
 * daemon hasn't been recompiled to handle yet).
 */
export interface PtyHostChildHandle {
  /** Session id this child owns (mirrors `payload.sessionId`). */
  readonly sessionId: string;
  /** Underlying child PID; useful for crash_log rows + log lines. */
  readonly pid: number;
  /** Resolved UTF-8 env that this child will pass to `claude` on
   *  spawn. Computed once at fork time; immutable after. */
  readonly claudeSpawnEnv: Readonly<Record<string, string>>;
  /** Resolves with the child's first `ready` message (after which the
   *  daemon may begin sending input / resize messages). Rejects if the
   *  child exits before sending `ready`. */
  ready(): Promise<void>;
  /** Send a single host→child IPC message. Throws if the channel has
   *  been disconnected or the child has exited. */
  send(msg: HostToChildMessage): void;
  /** Resolves with the child exit outcome. Always resolves (never
   *  rejects); the daemon distinguishes graceful vs crash via
   *  `result.reason` per ch06 §1. */
  exited(): Promise<ChildExit>;
  /** Async iterator over every well-formed child→host message. Ends
   *  when the child disconnects or exits. */
  messages(): AsyncIterable<ChildToHostMessage>;
  /** Convenience: send `{kind:'close'}` and await graceful exit. If the
   *  child does not exit within `timeoutMs`, falls through with a
   *  `SIGKILL` so the caller is never blocked. Returns the observed
   *  {@link ChildExit}. */
  closeAndWait(timeoutMs?: number): Promise<ChildExit>;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Resolve the default child entrypoint path at runtime. We resolve
 * relative to *this module's* URL so the same code works whether the
 * daemon is running from source (`src/pty-host/host.ts` →
 * `src/pty-host/child.ts`) or from the SEA-built dist
 * (`dist/pty-host/host.js` → `dist/pty-host/child.js`).
 */
function defaultChildEntrypoint(): string {
  const here = fileURLToPath(import.meta.url);
  // Replace the basename `host.{ts,js}` with `child.{ts,js}`. Use the
  // same extension as `here` so source-mode and dist-mode both work.
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(here), `child${ext}`);
}

/**
 * Spawn a per-session pty-host child via `child_process.fork`.
 *
 * The returned handle does NOT auto-send the spawn payload — the caller
 * decides when to call `send({kind:'spawn', payload})`. This split keeps
 * the IPC handshake observable in tests (a test can subscribe to
 * `messages()` before the spawn is sent and see the full sequence).
 *
 * Spec invariants enforced here:
 *   - `child_process.fork` is the spawn primitive (not `spawn`, not
 *     `worker_threads.Worker`). Forever-stable.
 *   - The child receives `stdin = stdout = stderr = 'inherit'` so any
 *     accidental `console.log` from native modules is captured by the
 *     daemon's stdout (which the install-time log scrape already tails
 *     per ch10 §6). The IPC channel is `'ipc'` per `fork`'s default.
 *   - The child's env inherits the daemon's env by default. The UTF-8
 *     contract env (the env *for `claude`*, NOT for the child) is
 *     computed eagerly via `computeUtf8SpawnEnv` and surfaced on the
 *     handle so the child can request it via a future RPC if needed —
 *     T4.1 just exposes it.
 */
export function spawnPtyHostChild(opts: SpawnPtyHostChildOptions): PtyHostChildHandle {
  const entrypoint = opts.childEntrypoint ?? defaultChildEntrypoint();
  const platform = opts.platformOverride ?? process.platform;
  const claudeSpawnEnv = computeUtf8SpawnEnv({
    platform,
    inheritedEnv: process.env,
    darwinFallbackLocale: opts.darwinFallbackLocale,
    envExtra: opts.payload.envExtra,
  });

  const child: ChildProcess = fork(entrypoint, [], {
    // 'ipc' is implicit but spelled out for grep-ability.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: opts.forkEnv
      ? Object.fromEntries(
          Object.entries(opts.forkEnv).filter(([, v]) => v !== undefined),
        ) as Record<string, string>
      : process.env as Record<string, string>,
    serialization: 'advanced', // lets us pass Buffer / Uint8Array later
  });

  const sessionId = opts.payload.sessionId;

  // --- T-PA-5 emitter wiring ---------------------------------------------
  // Resolve the registry seam (default: production module-level registry).
  // 'disabled' opts the wire-up out entirely so unit tests that re-use a
  // sessionId across `it` cases don't trip the registry's duplicate-id
  // guard (see SpawnPtyHostChildOptions.emitterRegistry jsdoc).
  const emitterRegistry =
    opts.emitterRegistry === 'disabled'
      ? null
      : opts.emitterRegistry ?? {
          register: registerEmitterDefault,
          unregister: unregisterEmitterDefault,
        };
  // The emitter is constructed lazily on the child's `'ready'` IPC (per
  // spec §2.3: "created when the pty-host child's `ready` IPC fires").
  // Holding a let-binding here lets the `'message'` and `'exit'` handlers
  // both reach it without reaching back into the registry on every IPC.
  let emitter: PtySessionEmitter | null = null;

  // --- Lifecycle wiring ---------------------------------------------------
  let exitOutcome: ChildExit | null = null;
  let observedGracefulExitNotice = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let exitedResolve: ((x: ChildExit) => void) | null = null;
  const exitedPromise = new Promise<ChildExit>((resolve) => {
    exitedResolve = resolve;
  });

  // Buffered message queue + waiters for the async iterator.
  const queue: ChildToHostMessage[] = [];
  const waiters: Array<(r: IteratorResult<ChildToHostMessage>) => void> = [];
  let iteratorClosed = false;

  function pushMessage(msg: ChildToHostMessage): void {
    if (iteratorClosed) return;
    const w = waiters.shift();
    if (w) {
      w({ value: msg, done: false });
    } else {
      queue.push(msg);
    }
  }
  function closeIterator(): void {
    if (iteratorClosed) return;
    iteratorClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: undefined as never, done: true });
    }
  }

  child.on('message', (raw: unknown) => {
    if (!isChildToHostMessage(raw)) {
      // Drop silently — see jsdoc on `messages()` for rationale.
      return;
    }
    if (raw.kind === 'ready' && readyResolve) {
      readyResolve();
      readyResolve = null;
      readyReject = null;
      // T-PA-5 / spec §2.3: construct the per-session emitter on `'ready'`
      // and register it so the Attach handler (T-PA-6) can find it via
      // `getEmitter(sessionId)`. We use the host-side `sessionId`
      // (resolved at fork time from `opts.payload.sessionId`) rather than
      // the IPC payload's sessionId field — the host always knows its own
      // session id and the child currently sends an empty string in the
      // T4.1 stub (see child.ts: `send({kind:'ready', sessionId:''})`).
      if (emitterRegistry !== null && emitter === null) {
        try {
          emitter = new PtySessionEmitter(sessionId);
          emitterRegistry.register(emitter);
        } catch (err) {
          // Registration failure (e.g. duplicate sessionId) is a daemon
          // wire-up bug, not a per-session runtime error. Log and clear
          // the local ref so the IPC route below doesn't try to publish
          // into a half-initialized emitter; the lifecycle (ready /
          // exited / messages iterator) is unaffected.
          // eslint-disable-next-line no-console
          console.error(
            `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitter register failed`,
            err,
          );
          emitter = null;
        }
      }
    }
    if (raw.kind === 'exiting' && raw.reason === 'graceful') {
      observedGracefulExitNotice = true;
    }
    // T-PA-5 / spec §2.3 IPC routing: fan delta + snapshot IPCs into the
    // per-session emitter so subscribers (Attach handler in T-PA-6) see
    // them. The emitter itself is null when wiring is disabled (tests)
    // or when the child sent a delta/snapshot before `'ready'` (a child
    // bug; the fan-out is skipped silently — the daemon's
    // existing-message iterator still surfaces the IPC for diagnosis).
    if (emitter !== null) {
      if (raw.kind === 'snapshot') {
        emitter.publishSnapshot(raw);
      } else if (raw.kind === 'delta') {
        emitter.publishDelta(raw);
      }
    }
    pushMessage(raw);
  });

  child.on('error', (err) => {
    if (readyReject) {
      readyReject(err);
      readyReject = null;
      readyResolve = null;
    }
  });

  child.on('exit', (code, signal) => {
    const reason: ChildExit['reason'] = observedGracefulExitNotice && code === 0
      ? 'graceful'
      : 'crashed';
    exitOutcome = { reason, code: code ?? null, signal: signal ?? null };
    if (readyReject) {
      readyReject(new Error(
        `pty-host child for session ${sessionId} exited before ready ` +
        `(code=${String(code)} signal=${String(signal)})`,
      ));
      readyReject = null;
      readyResolve = null;
    }
    // T-PA-5 / spec §7.2 bullet 3: tear down the per-session emitter
    // BEFORE we resolve `exitedPromise`. Order: close() broadcasts the
    // 'closed' event to every Attach subscriber synchronously (the
    // listener forwards it as Code.Canceled + ErrorDetail.code =
    // 'pty.session_destroyed' on the wire — that mapping lives in
    // T-PA-6's Attach handler), then we drop the registry entry so a
    // late `getEmitter(sessionId)` returns undefined. Both steps are
    // idempotent so the wrapping try/catch only guards against a
    // listener throwing during broadcast.
    if (emitter !== null && emitterRegistry !== null) {
      try {
        emitter.close();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitter.close() threw`,
          err,
        );
      }
      try {
        emitterRegistry.unregister(sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitterRegistry.unregister() threw`,
          err,
        );
      }
      emitter = null;
    }
    exitedResolve?.(exitOutcome);
    closeIterator();
  });

  // --- Public surface -----------------------------------------------------
  const handle: PtyHostChildHandle = {
    sessionId,
    pid: child.pid ?? -1,
    claudeSpawnEnv,
    ready: () => readyPromise,
    send(msg) {
      if (exitOutcome !== null) {
        throw new Error(
          `pty-host child for session ${sessionId} has exited; cannot send ${msg.kind}`,
        );
      }
      if (!child.connected) {
        throw new Error(
          `pty-host child for session ${sessionId} IPC channel disconnected`,
        );
      }
      child.send(msg);
    },
    exited: () => exitedPromise,
    messages(): AsyncIterable<ChildToHostMessage> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ChildToHostMessage> {
          return {
            next(): Promise<IteratorResult<ChildToHostMessage>> {
              const buffered = queue.shift();
              if (buffered !== undefined) {
                return Promise.resolve({ value: buffered, done: false });
              }
              if (iteratorClosed) {
                return Promise.resolve({ value: undefined as never, done: true });
              }
              return new Promise((resolve) => waiters.push(resolve));
            },
            return(): Promise<IteratorResult<ChildToHostMessage>> {
              closeIterator();
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    async closeAndWait(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<ChildExit> {
      if (exitOutcome !== null) {
        return exitOutcome;
      }
      if (child.connected) {
        try {
          child.send({ kind: 'close' } satisfies HostToChildMessage);
        } catch {
          // Race: child disconnected between our check and send. Fall
          // through; the exit handler will resolve `exitedPromise`.
        }
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ChildExit>((resolve) => {
        timer = setTimeout(() => {
          if (exitOutcome === null) {
            child.kill('SIGKILL');
          }
          // The 'exit' handler will resolve `exitedPromise` shortly;
          // forward whichever resolves first (this is racy and that's
          // fine — caller wants "the child is gone", not the exact
          // ordering of why).
          void exitedPromise.then(resolve);
        }, timeoutMs);
      });
      try {
        return await Promise.race([exitedPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };

  return handle;
}

/**
 * Type guard for `ChildToHostMessage`. The unknown surface comes from
 * the IPC channel where Node may hand us anything the child JSON.stringify-d
 * (or, with `serialization: 'advanced'`, anything structured-clonable).
 */
function isChildToHostMessage(x: unknown): x is ChildToHostMessage {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  if (
    k !== 'ready' &&
    k !== 'exiting' &&
    k !== 'delta' &&
    k !== 'snapshot' &&
    k !== 'send-input-rejected'
  ) {
    return false;
  }
  if (k === 'send-input-rejected') {
    // Flat shape per spec 2026-05-04-pty-attach-handler.md §2.2 —
    // pendingWriteBytes + attemptedBytes are top-level fields on the
    // message itself; no nested `payload`, no `sessionId` (the daemon
    // main process knows which child sent it via the IPC channel).
    const pwb = (x as { pendingWriteBytes?: unknown }).pendingWriteBytes;
    const ab = (x as { attemptedBytes?: unknown }).attemptedBytes;
    return (
      typeof pwb === 'number' &&
      Number.isFinite(pwb) &&
      pwb >= 0 &&
      typeof ab === 'number' &&
      Number.isFinite(ab) &&
      ab >= 0
    );
  }
  return true;
}
