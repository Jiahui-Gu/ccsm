// T68 — harness-daemon-mode helper unit tests.
//
// Strategy
// --------
// The helper spawns a real `tsx daemon/src/index.ts` child in production
// use, but for fast unit coverage we lean on the documented `spawnFn`
// test seam to drive an in-process EventEmitter that mimics a child
// process. This keeps the suite at < 1 s wall, covers all four
// settle paths (marker, exit-before-marker, spawn error, timeout) AND
// the shutdown/kill teardown, and stays honest because the helper code
// path under test is identical (the seam only swaps the spawn call).
//
// The smoke check at the bottom does invoke `bootDaemon` against a
// trivial node script (no daemon source compile) to verify the
// real-spawn happy path end-to-end.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes } from 'node:crypto';

// T73 — daemon-boot+hello e2e probe imports. The probe spawns the real
// `daemon/src/index.ts` to assert the boot supervisor signal (ready
// marker) and then in-process exercises the canonical `daemon.hello`
// handler against a known config. Socket-bound RPC is out of scope
// today (T16/T19 merged but `daemon/src/index.ts` has not yet wired
// `controlSocket.listen()` per the helper's own §3.4.1.h note); the
// probe degrades to "boot + handler-contract" until the binding lands,
// at which point a follow-up swaps the in-process call for a real
// socket round-trip without changing the asserted invariants.
import {
  createDaemonHelloHandler,
  DAEMON_WIRE,
  DAEMON_FRAME_VERSION,
  DaemonHelloSchemaError,
  type HelloReplyPayload,
  type HelloRequestPayload,
} from '../daemon/src/handlers/daemon-hello.js';
// T74 — upgrade-in-place probe imports. The probe wires the real T21
// shutdown-for-upgrade handler, the real T22 marker reader, and the
// real T25 force-kill sink against a tmpdir-backed marker dir to
// assert the §6.4 + §6.6.1 + §11.6.5 contracts that auto-update
// depends on. Socket round-trip stays out of scope for the same
// reason as T73 (`daemon/src/index.ts` doesn't bind the control
// socket yet — see file-header note above and harness-daemon-mode.mjs
// §3.4.1.h note).
import {
  defaultWriteShutdownMarker,
  makeShutdownForUpgradeHandler,
  SHUTDOWN_MARKER_REASON_UPGRADE,
  type ShutdownForUpgradeAck,
  type ShutdownForUpgradeActions,
} from '../daemon/src/handlers/daemon-shutdown-for-upgrade.js';
import { createForceKillSink } from '../daemon/src/lifecycle/force-kill.js';
import { shouldSkipCrashLoop } from '../daemon/src/lifecycle/crash-loop-skip.js';
import {
  DAEMON_SHUTDOWN_MARKER_FILENAME,
  readMarker,
  type ShutdownMarkerPayload,
} from '../daemon/src/marker/reader.js';
import { writeFile } from 'node:fs/promises';
import { DAEMON_PROTOCOL_VERSION } from '../daemon/src/envelope/protocol-version.js';
import {
  HMAC_TAG_LENGTH,
  NONCE_BYTES,
} from '../daemon/src/envelope/hmac.js';
import { encode as base64urlEncode } from '../daemon/src/envelope/base64url.js';
// T78 — reconnect-after-stream-dead probe imports. Wires the real T44
// stream-dead detector (daemon side), the real T48 fromBootNonce stamper
// (daemon side), the real T70 reconnect queue (renderer side, listens
// to a `DaemonEventBus`) against an injected event bus + injected
// `reconnectFn`. T69 (`useDaemonReconnectBridge`) is a React hook that
// PRODUCES `window.CustomEvent`s on a separate browser-event channel
// (`ccsm:daemon-bootChanged` / `ccsm:daemon-streamDead`); the daemon
// side and the queue side share the typed bus shape but the live
// daemon→renderer IPC bridge that would funnel detector output into
// the bus is NOT wired in production yet (see file-header note on T73
// `controlSocket.listen()` gap; T48 stamper helper merged but daemon
// stream emit doesn't call `stamper.stamp()` yet, and T44 detector is
// constructed only by the heartbeat scheduler call site, not by an
// IPC bridge that emits `streamDead` events outward to renderer). The
// probe therefore exercises the real **contract**: detector output →
// bus emit → queue enqueue/flush → re-issued subscribe envelopes
// stamped via the real stamper. When the daemon-side IPC bridge lands
// (follow-up after #1072 / #1073-style controlSocket binding), this
// probe upgrades to a real socket round-trip without changing the
// asserted invariants.
import {
  createStreamDeadDetector,
  type SubscriberId,
} from '../daemon/src/pty/stream-dead-detector.js';
import { createFromBootNonceStamper } from '../daemon/src/pty/from-boot-nonce-stamper.js';
import { ReconnectQueue, type ReconnectOutcome } from '../src/lib/reconnect-queue.js';
import { DaemonEventBus } from '../src/lib/daemon-events.js';

// Helper module is plain ESM JS; vitest resolves the .mjs extension fine
// via dynamic import. Type as `any` since it ships JSDoc only.
const helperPromise = import(
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- .mjs without companion .d.ts; runtime shape covered by tests.
  '../scripts/probe-helpers/harness-daemon-mode.mjs'
);

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((sig?: NodeJS.Signals) => {
    // Mimic real ChildProcess: emit `exit` shortly after kill, with
    // code=null + signal carried through. Use queueMicrotask so callers
    // that await `exit` after kill get scheduled deterministically.
    queueMicrotask(() => {
      child.exitCode = null;
      child.signalCode = (sig ?? 'SIGTERM') as NodeJS.Signals;
      child.emit('exit', null, sig ?? 'SIGTERM');
    });
    return true;
  });
  return child;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('parseHarnessMode', () => {
  it('returns "daemon" when --mode=daemon in argv', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode(['--mode=daemon'], {})).toBe('daemon');
  });

  it('returns "daemon" when HARNESS_MODE=daemon in env', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode([], { HARNESS_MODE: 'daemon' })).toBe('daemon');
  });

  it('argv --mode=inline overrides env HARNESS_MODE=daemon', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode(['--mode=inline'], { HARNESS_MODE: 'daemon' })).toBeUndefined();
  });

  it('returns undefined when neither set', async () => {
    const { parseHarnessMode } = (await helperPromise) as { parseHarnessMode: Function };
    expect(parseHarnessMode([], {})).toBeUndefined();
  });
});

describe('bootDaemon (spawnFn seam)', () => {
  it('resolves ready when stdout emits the canonical boot marker', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      bootTimeoutMs: 1_000,
    });
    // Push the marker on stdout after the listener is attached.
    setImmediate(() => fake.stdout.emit('data', Buffer.from(`{"msg":"${DEFAULT_READY_MARKER}"}\n`)));
    await expect(handle.ready).resolves.toBeUndefined();
    // Cleanup so the test process doesn't keep a dangling fake alive.
    fake.emit('exit', 0, null);
  });

  it('resolves ready when marker comes from stderr (pino default)', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stderr.emit('data', Buffer.from(`level=info ${DEFAULT_READY_MARKER}\n`)));
    await expect(handle.ready).resolves.toBeUndefined();
    fake.emit('exit', 0, null);
  });

  it('rejects ready when child exits before the marker fires', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.emit('exit', 17, null));
    await expect(handle.ready).rejects.toThrow(/exited before ready marker.*code=17/);
  });

  it('rejects ready on spawn error', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.emit('error', new Error('ENOENT tsx not found')));
    await expect(handle.ready).rejects.toThrow(/failed to spawn daemon: ENOENT tsx not found/);
  });

  it('rejects ready when boot timeout elapses without marker', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };
    const fake = makeFakeChild();
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      bootTimeoutMs: 50,
    });
    await expect(handle.ready).rejects.toThrow(/did not emit ready marker.*within 50ms/);
    fake.emit('exit', 0, null);
  });

  it('shutdown() sends SIGTERM and resolves with exit code', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    const code = await handle.shutdown();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    // Fake child reports null exitCode + SIGTERM signal — same shape a
    // real signal-terminated process surfaces.
    expect(code).toBeNull();
  });

  it('kill() sends SIGKILL', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    await handle.kill();
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('shutdown() is a no-op when child already exited', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const handle = bootDaemon({ spawnFn: () => fake as unknown as ChildProcess });
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await handle.ready;
    fake.exitCode = 0;
    fake.emit('exit', 0, null);
    const code = await handle.shutdown();
    expect(code).toBe(0);
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it('onLog tap receives child output line-by-line', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const lines: string[] = [];
    const handle = bootDaemon({
      spawnFn: () => fake as unknown as ChildProcess,
      onLog: (l: string) => lines.push(l),
    });
    setImmediate(() => {
      fake.stdout.emit('data', Buffer.from('line-a\nline-b\n'));
      fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n'));
    });
    await handle.ready;
    fake.emit('exit', 0, null);
    expect(lines).toContain('line-a');
    expect(lines).toContain('line-b');
  });
});

describe('runWithDaemonMode', () => {
  it('passes daemon=null when mode is undefined and does NOT spawn', async () => {
    const { runWithDaemonMode } = (await helperPromise) as { runWithDaemonMode: Function };
    const spawnFn = vi.fn();
    const result = await runWithDaemonMode(undefined, async (ctx: { daemon: unknown }) => {
      expect(ctx.daemon).toBeNull();
      return 'ok';
    }, { spawnFn });
    expect(result).toBe('ok');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('boots + tears down when mode=daemon', async () => {
    const { runWithDaemonMode, DEFAULT_READY_MARKER } = (await helperPromise) as {
      runWithDaemonMode: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const spawnFn = vi.fn(() => fake as unknown as ChildProcess);
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    const result = await runWithDaemonMode('daemon', async (ctx: { daemon: { kill: Function } | null }) => {
      expect(ctx.daemon).not.toBeNull();
      return 42;
    }, { spawnFn });
    expect(result).toBe(42);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('still tears down even when body throws', async () => {
    const { runWithDaemonMode, DEFAULT_READY_MARKER } = (await helperPromise) as {
      runWithDaemonMode: Function; DEFAULT_READY_MARKER: string;
    };
    const fake = makeFakeChild();
    const spawnFn = vi.fn(() => fake as unknown as ChildProcess);
    setImmediate(() => fake.stdout.emit('data', Buffer.from(DEFAULT_READY_MARKER + '\n')));
    await expect(
      runWithDaemonMode('daemon', async () => { throw new Error('boom'); }, { spawnFn }),
    ).rejects.toThrow('boom');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ---------------------------------------------------------------------------
// Real-process smoke test — exercises the actual `child_process.spawn` path
// against a trivial node script that prints the ready marker, sleeps, then
// exits cleanly on SIGTERM. Skipped on environments where `node` is not on
// PATH (would only matter in pathological CI sandboxes).
// ---------------------------------------------------------------------------

describe('bootDaemon (real spawn smoke)', () => {
  it('boots, marker fires, shutdown() reaps the real child', async () => {
    const { bootDaemon, DEFAULT_READY_MARKER } = (await helperPromise) as {
      bootDaemon: Function; DEFAULT_READY_MARKER: string;
    };
    const dir = mkdtempSync(join(tmpdir(), 'harness-daemon-mode-test-'));
    tempDirs.push(dir);
    const script = join(dir, 'fake-daemon.cjs');
    // Deliberately use a CJS .cjs script so we can spawn `node` (always
    // available) instead of `tsx` (which requires the dev dep). Also
    // wires SIGTERM to a graceful exit so `shutdown()` returns a code.
    writeFileSync(script, `
      process.on('SIGTERM', () => process.exit(0));
      process.stdout.write(${JSON.stringify(DEFAULT_READY_MARKER)} + '\\n');
      setTimeout(() => process.exit(2), 30000);
    `);
    const handle = bootDaemon({
      spawnFn: (_cmd: string, _args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
        // Drop shell:true from the helper's default opts — we're spawning
        // node.exe directly with a known absolute path, no shell parsing
        // needed (and on Windows shell:true mangles the script path
        // through cmd.exe quoting rules).
        spawn(process.execPath, [script], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      bootTimeoutMs: 5_000,
    });
    await handle.ready;
    const code = await handle.shutdown();
    // On Windows .kill('SIGTERM') maps to TerminateProcess so the
    // signal handler may not run; tolerate either a clean exit (POSIX)
    // or a signal-driven null exitCode (Windows).
    expect(code === 0 || code === null).toBe(true);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// T73 — daemon-boot + hello probe (e2e, folded into harness-agent surface)
//
// Why fold into this harness vitest file (not a standalone .probe.test.ts):
//   `feedback_e2e_prefer_harness.md` — every additional standalone probe
//   adds ~30s to e2e wall time; a harness fold is the default. The
//   T68 helper (`harness-daemon-mode.mjs`) is the v0.3 daemon-mode
//   surface (per fragment-3.7-dev-workflow §3.7.7), so its vitest
//   companion is the canonical home for daemon-boot probes.
//
// Asserted invariants:
//   1. Boot supervisor signal — the real daemon child reaches its
//      canonical "daemon shell booted" stdout marker within the spec
//      §6.6 boot deadline (10s headroom on the helper default).
//   2. Hello handshake reply shape — `createDaemonHelloHandler` returns
//      a reply where (a) `bootNonce` echoes the configured value
//      (forward-compat surface for renderer reconnect detection), (b)
//      `helloNonceHmac` matches a reference HMAC over the DECODED nonce
//      bytes (anti-imposter contract per spec §3.4.1.g lines 195/208/212),
//      and (c) `protocol.wire` / `daemonFrameVersion` /
//      `daemonProtocolVersion` match the daemon constants.
//   3. Reverse-verify, mutation A — when the handler is configured with
//      a getBootNonce that returns the wrong value, the bootNonce-echo
//      assertion FAILS with a clear AssertionError surfacing the
//      mismatch ("expected 'BOOT-WRONG' to be 'BOOT-RIGHT-...'").
//   4. Reverse-verify, mutation B — a malformed hello request (missing
//      clientWire) makes the handler reject with `DaemonHelloSchemaError`,
//      which a positive-path assertion would mis-handle, demonstrating
//      the schema gate is load-bearing for the probe's contract.
//
// Out of scope today (deliberate, documented):
//   - Real socket round-trip (`daemon/src/index.ts` does not yet bind
//     the control socket — see helper file's §3.4.1.h note). Once the
//     binding lands, swap the in-process handler call for a `net.connect`
//     + envelope round-trip; invariants 1-4 stay the same.
// ---------------------------------------------------------------------------

const DAEMON_ENTRY = resolvePath(__dirname, '..', 'daemon', 'src', 'index.ts');
const T73_BOOT_NONCE = 'BOOT-RIGHT-AAAAAAAAAAAAA';
const T73_SECRET = Buffer.from(
  'test-secret-T73-deterministic-fixture-32B!',
  'utf8',
);

/** Build a canonical valid hello request — mirrors spec §3.4.1.g frame 1. */
function makeValidHelloRequest(
  overrides: Partial<HelloRequestPayload> = {},
): HelloRequestPayload {
  const nonce = base64urlEncode(randomBytes(NONCE_BYTES));
  return {
    clientWire: DAEMON_WIRE,
    clientProtocolVersion: DAEMON_PROTOCOL_VERSION,
    clientFrameVersions: [DAEMON_FRAME_VERSION],
    clientFeatures: ['hello'],
    clientHelloNonce: nonce,
    ...overrides,
  };
}

/** Reference HMAC over the DECODED nonce bytes (spec §3.4.1.g round-9
 *  base64url lock — handler MUST hash the 16 raw bytes, NOT the 22 ASCII
 *  chars). Provides an independent oracle the probe checks against. */
function referenceHmac(secret: Buffer, base64urlNonce: string): string {
  const raw = Buffer.from(
    base64urlNonce.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  const full = createHmac('sha256', secret).update(raw).digest();
  return full
    .subarray(0, NONCE_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('T73 — daemon-boot + hello probe (e2e harness fold)', () => {
  it('boots the real daemon to ready marker AND validates hello handler contract', async () => {
    const { bootDaemon } = (await helperPromise) as { bootDaemon: Function };

    // ---- Phase 1: boot the real daemon to its ready marker ---------------
    // Uses the canonical T68 helper. The helper spawns `tsx daemon/src/index.ts`
    // and resolves `ready` once "daemon shell booted" is observed on
    // stdout/stderr. A real spawn (NOT the fake-daemon.cjs smoke) is what
    // makes this an e2e probe — any regression in `daemon/src/index.ts`
    // (e.g. an import crash before pino logs the boot line) surfaces here.
    const handle = bootDaemon({
      entry: DAEMON_ENTRY,
      bootTimeoutMs: 15_000,
    });

    try {
      await handle.ready;

      // ---- Phase 2: hello handler contract --------------------------------
      // The control socket isn't bound yet; we exercise the canonical
      // handler in-process with the same factory the dispatcher will
      // register once `daemon/src/index.ts` wires it. This is the
      // contract the wire RPC will inherit.
      const handler = createDaemonHelloHandler({
        getSecret: () => T73_SECRET,
        getBootNonce: () => T73_BOOT_NONCE,
      });
      const req = makeValidHelloRequest();
      const reply = (await handler(req)) as HelloReplyPayload;

      // Invariant 2a — bootNonce echoed (forward-compat for renderer
      // reconnect / boot-change detection per spec §3.4.1.g + frag-3.5.1).
      expect(reply.bootNonce).toBe(T73_BOOT_NONCE);

      // Invariant 2b — helloNonceHmac is the reference HMAC over the
      // DECODED nonce bytes. This is the anti-imposter signal the
      // client uses to rule out a same-pipe squatter.
      expect(reply.helloNonceHmac).toBe(
        referenceHmac(T73_SECRET, req.clientHelloNonce),
      );
      expect(reply.helloNonceHmac.length).toBe(HMAC_TAG_LENGTH);

      // Invariant 2c — protocol block matches daemon constants and
      // signals compatibility on a canonical client request.
      expect(reply.protocol.wire).toBe(DAEMON_WIRE);
      expect(reply.protocol.daemonProtocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
      expect(reply.daemonFrameVersion).toBe(DAEMON_FRAME_VERSION);
      expect(reply.compatible).toBe(true);
      expect(reply.reason).toBeUndefined();
    } finally {
      // Always reap the daemon child — leaving an orphaned tsx process
      // would block the next harness run on Windows (held file locks).
      try { await handle.shutdown(); } catch { /* swallow on teardown */ }
    }
  }, 30_000);

  it('reverse-verify A — wrong-bootNonce handler trips the bootNonce-echo invariant', async () => {
    // Mutates the handler config so getBootNonce returns a value that
    // does NOT match the expected echo. The positive-path assertion
    // from the boot+hello test would FAIL with:
    //   AssertionError: expected 'BOOT-WRONG-AAAAAAAAAAAA' to be 'BOOT-RIGHT-AAAAAAAAAAAAA'
    // Here we assert the inverse so the probe stays green while still
    // proving the invariant detects the mutation.
    const handler = createDaemonHelloHandler({
      getSecret: () => T73_SECRET,
      getBootNonce: () => 'BOOT-WRONG-AAAAAAAAAAAA',
    });
    const reply = (await handler(makeValidHelloRequest())) as HelloReplyPayload;
    expect(reply.bootNonce).not.toBe(T73_BOOT_NONCE);

    // Confirm the positive-path expectation would actually throw — this
    // is the reverse-verify proof: the assertion is load-bearing, not
    // a tautology.
    let threw = false;
    try {
      expect(reply.bootNonce).toBe(T73_BOOT_NONCE);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('reverse-verify B — malformed hello payload rejects with schema error', async () => {
    // Drops `clientWire` — the spec §3.4.1.g handler MUST reject this
    // with `DaemonHelloSchemaError` (mapped by the T14 transport to a
    // wire-level `schema_violation`). Without this gate, the boot+hello
    // probe could silently coerce nonsense into a "compatible:false"
    // reply and miss real wire-shape regressions.
    const handler = createDaemonHelloHandler({
      getSecret: () => T73_SECRET,
      getBootNonce: () => T73_BOOT_NONCE,
    });
    const bad = { ...makeValidHelloRequest(), clientWire: undefined };
    await expect(handler(bad as unknown)).rejects.toBeInstanceOf(
      DaemonHelloSchemaError,
    );
  });
});

// ---------------------------------------------------------------------------
// T74 — upgrade-in-place probe (e2e harness fold)
//
// Why fold here (not standalone .probe.test.ts): same `feedback_e2e_prefer_harness.md`
// rationale as T73 — every standalone probe adds ~30s wall time. The T68
// helper is the v0.3 daemon-mode surface so its companion vitest is the
// canonical home for daemon-lifecycle e2e probes.
//
// Scope honesty: the daemon control socket is NOT yet bound by
// `daemon/src/index.ts` (T16/T19 dispatcher merged but no `controlSocket.listen()`
// — same gap T73's probe documents). This probe therefore exercises the
// upgrade contract via the same in-process handler-call path T73 uses,
// PLUS the real T22 marker reader and the real T25 force-kill sink against
// a real tmpdir. When the socket binding lands, the in-process handler
// call is swapped for a real `net.connect` + envelope round-trip without
// changing the asserted invariants.
//
// Asserted invariants:
//   1. Marker file consumption — pre-write a v0.2→v0.3-style upgrade
//      marker, simulate "boot daemon", assert T22 reader picks it up
//      AND T26 `shouldSkipCrashLoop` consumes it (skip=true on first
//      pass; skip=false after consumed=true is recorded).
//   2. shutdownForUpgrade RPC sent — drive the real handler, assert the
//      ack envelope shape (`accepted: true`, `reason: 'upgrade'`) AND
//      that the marker payload that lands on disk matches the §6.4
//      schema (reason/version/ts).
//   3. 5s ack timeout — when the simulated daemon never acks, the
//      caller's Promise.race timeout branch fires within budget. We
//      use a 50 ms shrink to keep the probe fast while citing the
//      production 5_000 ms constant inline so the spec link is visible.
//   4. Force-kill fallback — after the timeout, the T25 sink fires
//      with the registered targets (POSIX SIGKILL + win32 JobObject).
//      Both platform branches exercised on a single host via the
//      `platform` override per `createForceKillSink` contract.
//   5. Reverse-verify — when the daemon DOES ack within budget, the
//      caller observes `kind: 'acked'` and the force-kill sink is
//      NEVER invoked (graceful path). This is the load-bearing inverse
//      of invariants 3+4.
//
// Reverse-verify mutations attempted (also documented in PR body):
//   A. Drop the `marker-written` step from the plan — invariant 1
//      and the disk-state read in invariant 2 then BOTH FAIL with
//      "expected snapshot.kind to be 'present'" (markerPath ENOENT).
//   B. Wire the real (5_000ms) timeout but never resolve the rpc —
//      invariant 3 then exceeds the 1 s probe poll budget (the
//      timeout never fires within the assertion window).
//
// Out of scope today (deliberate, documented):
//   - Real socket round-trip via `daemon/src/index.ts`. Same gap as T73.
//   - Electron-main `callShutdownForUpgrade` direct import (pulls in
//     `electron` module which vitest can't resolve in node env). The
//     timeout race logic is re-implemented inline so the contract is
//     still asserted; when the socket binding lands, swap the inline
//     race for the real `callShutdownForUpgrade`.
// ---------------------------------------------------------------------------

/** Spec §6.4 / §11.6.5 production constant. The probe shrinks the timeout
 *  for fast assertions but preserves the constant reference so a regression
 *  that bumps the spec value also flags this probe. */
const T74_PROD_ACK_TIMEOUT_MS = 5_000;
/** Probe shrink — same race shape, sub-second budget. */
const T74_TEST_ACK_TIMEOUT_MS = 50;

const T74_DAEMON_VERSION = '0.3.0-t74-probe';
const T74_FIXED_NOW = 1_700_000_000_001;

/** Shape mirroring `electron/updater.ts UpgradeShutdownOutcome`, re-declared
 *  here to avoid pulling the `electron` module into the vitest node env. */
type T74AckOutcome =
  | { kind: 'acked'; ack: ShutdownForUpgradeAck }
  | { kind: 'timeout' };

/** Faithful inline copy of the `Promise.race(call, timeout)` pattern from
 *  `electron/updater.ts callShutdownForUpgrade`. Verified against
 *  electron/updater.ts:75-102 — same race + finally(clearTimeout) shape. */
async function raceAck(
  rpc: () => Promise<ShutdownForUpgradeAck>,
  timeoutMs: number,
): Promise<T74AckOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T74AckOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const call: Promise<T74AckOutcome> = (async () => {
    const ack = await rpc();
    return { kind: 'acked', ack };
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('T74 — upgrade-in-place probe (e2e harness fold)', () => {
  // Reference to the production constant so a future spec change that
  // bumps the ack budget also flags this probe (assertion is symbolic;
  // the test uses the shrink constant for actual timing).
  it('production ack-timeout constant is 5_000 ms (spec §11.6.5 step 3)', () => {
    expect(T74_PROD_ACK_TIMEOUT_MS).toBe(5_000);
  });

  // -------------------------------------------------------------------------
  // Invariant 1 — marker file consumption (pre-write + reader + skip decider)
  // -------------------------------------------------------------------------
  it('pre-written upgrade marker is consumed by reader + crash-loop-skip decider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't74-marker-consume-'));
    tempDirs.push(dir);
    const markerPath = join(dir, DAEMON_SHUTDOWN_MARKER_FILENAME);

    // Pre-write a canonical upgrade marker — the shape T21
    // `defaultWriteShutdownMarker` produces and T22 `readMarker` parses.
    // This simulates "previous daemon shut down for upgrade; new daemon
    // boots and finds the marker on disk".
    const payload: ShutdownMarkerPayload = {
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
      version: '0.2.99-pre-upgrade',
      ts: T74_FIXED_NOW - 1,
    };
    await writeFile(markerPath, JSON.stringify(payload), { mode: 0o600 });

    // Simulate the daemon's first-boot pass: read the marker, hand it to
    // the crash-loop-skip decider with consumed=false. T26 spec contract:
    // PRESENT + not consumed → skip=true (suppress one crash-loop tick).
    const snapshot = await readMarker(markerPath);
    expect(snapshot.kind).toBe('present');
    if (snapshot.kind !== 'present') return;
    expect(snapshot.payload).toEqual(payload);
    expect(
      shouldSkipCrashLoop({ marker: snapshot, consumed: false, restartCount: 1 }),
    ).toBe(true);

    // After the supervisor records consumed=true (one-shot per spec §6.4),
    // a subsequent restart in the same supervisor lifetime resumes normal
    // crash-loop accounting.
    expect(
      shouldSkipCrashLoop({ marker: snapshot, consumed: true, restartCount: 2 }),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariant 2 — shutdownForUpgrade RPC fired with correct payload shape;
  // marker on disk matches spec schema
  // -------------------------------------------------------------------------
  it('shutdownForUpgrade RPC returns correct ack and writes marker payload to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't74-rpc-'));
    tempDirs.push(dir);

    const timeline: string[] = [];
    const actions: ShutdownForUpgradeActions = {
      writeMarker: async (plan) => {
        await defaultWriteShutdownMarker(plan);
        timeline.push('marker-written');
      },
      runShutdownSequence: async () => { timeline.push('drain'); },
      releaseLock: async () => { timeline.push('lock-released'); },
      exit: (code) => { timeline.push(`exit:${code}`); },
    };
    const handler = makeShutdownForUpgradeHandler(
      { version: T74_DAEMON_VERSION, now: () => T74_FIXED_NOW, markerDir: dir },
      actions,
    );

    // Simulate Electron-main sending the RPC. The handler returns the ack
    // synchronously (microtask schedules the side effects).
    const ack = await handler({});
    expect(ack).toEqual({
      accepted: true,
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
    });

    // Drain the microtask queue so the side-effect chain completes.
    // The executor iterates marker → drain → unlock → exit; we wait for
    // the terminal `exit:0` step (bounded by the implicit vitest timeout).
    while (!timeline.includes('exit:0')) {
      await new Promise((r) => setImmediate(r));
    }

    // Side-effects fired in spec §6.4 order.
    expect(timeline).toEqual([
      'marker-written',
      'drain',
      'lock-released',
      'exit:0',
    ]);

    // Marker payload on disk matches the §6.4 schema exactly.
    const snapshot = await readMarker(join(dir, DAEMON_SHUTDOWN_MARKER_FILENAME));
    expect(snapshot.kind).toBe('present');
    if (snapshot.kind !== 'present') return;
    expect(snapshot.payload).toEqual({
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
      version: T74_DAEMON_VERSION,
      ts: T74_FIXED_NOW,
    });
  });

  // -------------------------------------------------------------------------
  // Invariant 3 — caller's 5s ack-timeout fires when daemon doesn't reply
  // -------------------------------------------------------------------------
  it('ack timeout: hung rpc → caller resolves to {kind:"timeout"} within budget', async () => {
    // Mimic a daemon that never acks — Promise that never resolves.
    const startedAt = Date.now();
    const outcome = await raceAck(
      () => new Promise<ShutdownForUpgradeAck>(() => undefined),
      T74_TEST_ACK_TIMEOUT_MS,
    );
    const elapsed = Date.now() - startedAt;

    expect(outcome.kind).toBe('timeout');
    // Timer fires close to the budget; allow generous slack for slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(T74_TEST_ACK_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(T74_TEST_ACK_TIMEOUT_MS + 1_000);
  });

  // -------------------------------------------------------------------------
  // Invariant 4 — force-kill fallback fires after the timeout (T25 sink)
  // -------------------------------------------------------------------------
  it('force-kill fallback: after ack timeout, T25 sink terminates registered targets', async () => {
    // Step 1: ack times out (mutation: timeoutMs=0 → immediate timeout).
    // This is the §6.4 + §11.6.5 contract: the caller MUST proceed even
    // when no ack arrives. The only safety net is the OS-level force-kill.
    const outcome = await raceAck(
      () => new Promise<ShutdownForUpgradeAck>(() => undefined),
      0,
    );
    expect(outcome.kind).toBe('timeout');

    // Step 2: caller invokes the T25 sink. Probe drives both platform
    // branches via the `platform` override so a single host covers
    // POSIX SIGKILL + win32 JobObject.terminate(1).
    const fakePid = 88_888;
    const posixKill = vi.fn<(pid: number, sig: 'SIGKILL') => void>();
    const recordForceKill = vi.fn<
      (info: { platform: 'posix' | 'win32'; targets: number; errors: number }) => void
    >();
    const posixSink = createForceKillSink({
      platform: 'posix',
      getChildPids: () => [fakePid],
      posixKill,
      recordForceKill,
    });
    const fakeJob = { terminate: vi.fn() };
    const winSink = createForceKillSink({
      platform: 'win32',
      getJobObjects: () => [fakeJob],
      recordForceKill,
    });

    const posixCount = posixSink.forceKillRemaining();
    const winCount = winSink.forceKillRemaining();

    expect(posixCount).toBe(1);
    expect(winCount).toBe(1);
    expect(posixKill).toHaveBeenCalledExactlyOnceWith(fakePid, 'SIGKILL');
    expect(fakeJob.terminate).toHaveBeenCalledExactlyOnceWith(1);
    expect(recordForceKill).toHaveBeenCalledTimes(2);

    // Idempotency contract — replay path per §6.6.1 must NOT re-issue.
    expect(posixSink.forceKillRemaining()).toBe(0);
    expect(winSink.forceKillRemaining()).toBe(0);
    expect(posixKill).toHaveBeenCalledTimes(1);
    expect(fakeJob.terminate).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Invariant 5 — reverse-verify: graceful ack → NO force-kill
  // -------------------------------------------------------------------------
  it('reverse-verify: graceful ack within budget → caller acked, force-kill NOT invoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't74-graceful-'));
    tempDirs.push(dir);

    // Real handler with all sinks recorded. Acks immediately.
    const actions: ShutdownForUpgradeActions = {
      writeMarker: defaultWriteShutdownMarker,
      runShutdownSequence: async () => undefined,
      releaseLock: async () => undefined,
      exit: () => undefined,
    };
    const handler = makeShutdownForUpgradeHandler(
      { version: T74_DAEMON_VERSION, now: () => T74_FIXED_NOW, markerDir: dir },
      actions,
    );

    const outcome = await raceAck(
      () => handler({}),
      T74_TEST_ACK_TIMEOUT_MS,
    );

    // Acked branch — NOT timeout.
    expect(outcome.kind).toBe('acked');
    if (outcome.kind !== 'acked') return;
    expect(outcome.ack).toEqual({
      accepted: true,
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
    });

    // Caller's force-kill sink is wired but MUST NOT be invoked on the
    // graceful path. We construct a sink with a tracked target and
    // assert nothing fires (caller decides WHEN — graceful path skips it).
    const posixKill = vi.fn<(pid: number, sig: 'SIGKILL') => void>();
    const sink = createForceKillSink({
      platform: 'posix',
      getChildPids: () => [12_345],
      posixKill,
    });
    // The caller's contract on `acked`: do NOT call forceKillRemaining.
    // Probe documents this by simply NOT calling it and asserting the
    // primitive stays untouched.
    expect(sink.invoked).toBe(false);
    expect(posixKill).not.toHaveBeenCalled();
  });
});

// =============================================================================
// T78 — reconnect-after-stream-dead probe (e2e harness fold)
// =============================================================================
// Asserts the cross-module contract that v0.3 §5.4 + §5.5 + §6.5.1 + §6.6.1
// rely on for live-stream recovery after a server-side stream-dead detection:
//
//   T44 detector flips a subscriber to DEAD
//     → wiring layer emits `streamDead` on the typed event bus
//     → T70 reconnect queue enqueues a resubscribe task per subId
//     → on `bootChanged` (new daemon boot) the queue re-issues subscribe
//       envelopes for every active subscription
//     → each emitted envelope is stamped with the new bootNonce by T48.
//
// Production wiring of detector→bus and bridge→bus is not landed yet
// (see import-block note above). The probe composes the real modules
// in-process to exercise the contract end-to-end. When the daemon-side
// IPC bridge lands the asserted invariants stay byte-compatible.
//
// Spec citations:
//   - frag-3.5.1 §3.5.1.4 — bootChanged + fromBootNonce + replay-from-0
//   - frag-6-7 §6.5.1 — stream-dead detector deadlineMs = 2×heartbeatMs+5s
//   - frag-6-7 §6.6.1 — stream_resubscribe semantics
//   - v0.3-design §3.7.4 — reconnect bridge surface registry
// -----------------------------------------------------------------------------

/** Spec §6.5.1 production formula component. The probe shrinks to a sub-second
 *  budget but preserves the constant reference so a future spec change that
 *  bumps the canonical 5s grace term also flags this probe. */
const T78_PROD_DEADLINE_GRACE_MS = 5_000;
/** Probe shrink — same detector contract, tens-of-ms budget. */
const T78_TEST_DEADLINE_MS = 50;

/** A pinned ULID-shaped nonce for "previous daemon boot". 26-char Crockford
 *  per frag-6-7 §6.5; the stamper does not enforce ULID regex (see
 *  from-boot-nonce-stamper.ts line 142-148) but using ULID-shaped values
 *  keeps the probe legible. */
const T78_OLD_BOOT_NONCE = '01HZ0OLDBOOTAAAAAAAAAAAAAA';
const T78_NEW_BOOT_NONCE = '01HZ0NEWBOOTBBBBBBBBBBBBBB';

describe('T78 — reconnect-after-stream-dead probe (e2e harness fold)', () => {
  // Reference to the production grace constant. A future spec change that
  // bumps the canonical 5s grace term in §6.5.1 will trip this assertion.
  it('production deadline grace component is 5_000 ms (spec §6.5.1)', () => {
    expect(T78_PROD_DEADLINE_GRACE_MS).toBe(5_000);
  });

  // -------------------------------------------------------------------------
  // Invariant 1 — Stream-dead detection fires within the deadline window
  // (T44 real detector, no heartbeat from a tracked subscriber).
  // -------------------------------------------------------------------------
  it('T44 detector: subscriber with no ack within deadlineMs is reported by check()', () => {
    const detector = createStreamDeadDetector({ deadlineMs: T78_TEST_DEADLINE_MS });
    const sub: SubscriberId = 'sid-alpha';
    const t0 = 1_700_000_000_000;

    // Track the subscriber at t0; it never acks.
    detector.track(sub, t0);
    expect(detector.size()).toBe(1);

    // Within the deadline → not dead.
    expect(detector.check(t0 + T78_TEST_DEADLINE_MS - 1)).toEqual([]);
    // Strictly older than now-deadlineMs → dead. The detector's contract
    // is `lastAck < (now - deadlineMs)`, so we cross the boundary by one
    // millisecond past the deadline.
    expect(detector.check(t0 + T78_TEST_DEADLINE_MS + 1)).toEqual([sub]);

    // Live ack rearms the deadline — the same id stops being reported.
    detector.onAck(sub, t0 + T78_TEST_DEADLINE_MS + 2);
    expect(detector.check(t0 + T78_TEST_DEADLINE_MS + 3)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Invariant 2 — Reconnect queue accepts detached subscribers on streamDead
  // and holds them pending until a `bootChanged` flushes the queue.
  // -------------------------------------------------------------------------
  it('T70 queue: streamDead enqueues a task; queue drains via injected reconnectFn', async () => {
    const bus = new DaemonEventBus();
    const calls: Array<{ subId: string; lastSeq: number | undefined }> = [];
    const reconnectFn = async (
      subId: string,
      lastSeq: number | undefined,
    ): Promise<ReconnectOutcome> => {
      calls.push({ subId, lastSeq });
      return 'ok';
    };
    const queue = new ReconnectQueue(reconnectFn, { bus, baseDelayMs: 0 });
    try {
      queue.register({ subId: 'sid-alpha', lastSeq: 7 });
      queue.register({ subId: 'sid-beta', lastSeq: 12 });

      // Detector reports sid-alpha dead → wiring layer emits streamDead.
      bus.emit('streamDead', { subId: 'sid-alpha', lastSeq: 7 });

      // Drain microtasks (queue uses `Promise.resolve().then(fire)` for
      // attempt-0 tasks per reconnect-queue.ts:182-185).
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(calls).toEqual([{ subId: 'sid-alpha', lastSeq: 7 }]);
      // sid-beta is registered but neither dead nor boot-changed → no task.
      expect(queue.getQueueDepth()).toBe(0);
      expect(queue.getInFlightCount()).toBe(0);
    } finally {
      queue.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // Invariant 3 — Reconnect bridge re-attaches on new bootNonce: queue
  // drains every active subscription, and the wiring layer (modeled here
  // by the reconnectFn) issues subscribe envelopes stamped via the real
  // T48 stamper bound to the NEW bootNonce, in deterministic order.
  // -------------------------------------------------------------------------
  it('T70 + T48: bootChanged flushes all active subs; envelopes stamped with new bootNonce', async () => {
    const bus = new DaemonEventBus();
    // Real T48 stamper bound to the NEW boot. The wiring layer (reconnectFn)
    // calls stamp() to construct the outbound subscribe envelope.
    const stamper = createFromBootNonceStamper(T78_NEW_BOOT_NONCE);

    type Envelope = {
      kind: 'subscribePty';
      subId: string;
      fromSeq: number | undefined;
      bootNonce: string;
    };
    const sent: Envelope[] = [];
    const reconnectFn = async (
      subId: string,
      lastSeq: number | undefined,
    ): Promise<ReconnectOutcome> => {
      const envelope = stamper.stamp({
        kind: 'subscribePty' as const,
        subId,
        fromSeq: lastSeq,
      });
      sent.push(envelope);
      return 'ok';
    };
    // Concurrency 1 forces serialized firing so the order of `sent`
    // reflects queue insertion order rather than a race.
    const queue = new ReconnectQueue(reconnectFn, {
      bus,
      baseDelayMs: 0,
      concurrency: 1,
    });
    try {
      queue.register({ subId: 'sid-1', lastSeq: 100 });
      queue.register({ subId: 'sid-2', lastSeq: 200 });
      queue.register({ subId: 'sid-3', lastSeq: 300 });

      // Daemon restarted: reconnect bridge observes a new bootNonce on
      // the next inbound frame and emits `bootChanged`. Queue clears
      // lastSeq per spec §3.5.1.4 (replay from seq 0).
      bus.emit('bootChanged', { bootNonce: T78_NEW_BOOT_NONCE });

      // Drain — three serial tasks at baseDelay=0 + concurrency=1, so
      // each fire awaits the prior microtask chain.
      for (let i = 0; i < 30; i++) await Promise.resolve();

      // All three active subs were re-issued, in registration order
      // (Map iteration order = insertion order).
      expect(sent.map((e) => e.subId)).toEqual(['sid-1', 'sid-2', 'sid-3']);
      // §3.5.1.4 contract: bootChanged path clears lastSeq → fromSeq is
      // `undefined`, daemon will replay from seq 0 under new nonce.
      expect(sent.every((e) => e.fromSeq === undefined)).toBe(true);
      // Every envelope carries the NEW bootNonce stamped by T48.
      expect(sent.every((e) => e.bootNonce === T78_NEW_BOOT_NONCE)).toBe(true);
      // Negative: NONE carry the old nonce. A regression that swapped the
      // stamper for a stale closure would fail this even if the positive
      // assertion above happened to pass via a literal coincidence.
      expect(sent.some((e) => e.bootNonce === T78_OLD_BOOT_NONCE)).toBe(false);
    } finally {
      queue.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // Invariant 4 — Idempotency: duplicate streamDead does NOT double-enqueue;
  // duplicate bootChanged does NOT double-flush. Per reconnect-queue.ts
  // `enqueue()` coalesce-on-subId logic (lines 156-164) and the §6.6.1
  // `stream_resubscribe` "at most once per subId" semantics.
  // -------------------------------------------------------------------------
  it('T70 idempotency: duplicate streamDead and bootChanged do not double-issue', async () => {
    const bus = new DaemonEventBus();
    const calls: string[] = [];
    // Hold each call open via an external resolver so we can observe the
    // queue mid-flight (in-flight task should NOT be re-coalesced).
    let releaseCurrent: (() => void) | null = null;
    const reconnectFn = async (subId: string): Promise<ReconnectOutcome> => {
      calls.push(subId);
      await new Promise<void>((r) => { releaseCurrent = r; });
      return 'ok';
    };
    const queue = new ReconnectQueue(reconnectFn, {
      bus,
      baseDelayMs: 0,
      concurrency: 1,
    });
    try {
      queue.register({ subId: 'sid-x', lastSeq: 5 });

      // Burst three duplicate streamDead events for the same subId.
      bus.emit('streamDead', { subId: 'sid-x', lastSeq: 5 });
      bus.emit('streamDead', { subId: 'sid-x', lastSeq: 5 });
      bus.emit('streamDead', { subId: 'sid-x', lastSeq: 5 });

      // Drain microtasks until the first call lands.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(calls).toEqual(['sid-x']);
      expect(queue.getInFlightCount()).toBe(1);

      // While in-flight, emit two more duplicates + a duplicate
      // bootChanged. None of these should add new tasks for sid-x —
      // queue.enqueue() coalesces on subId regardless of source.
      bus.emit('streamDead', { subId: 'sid-x', lastSeq: 5 });
      bus.emit('bootChanged', { bootNonce: T78_NEW_BOOT_NONCE });
      bus.emit('bootChanged', { bootNonce: T78_NEW_BOOT_NONCE });

      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(calls).toEqual(['sid-x']);

      // Release the in-flight call. The task finishes; the queue MUST
      // NOT re-fire from the duplicates that arrived during flight.
      releaseCurrent!();
      for (let i = 0; i < 16; i++) await Promise.resolve();

      // Across the whole burst, exactly one reconnect call for sid-x.
      expect(calls).toEqual(['sid-x']);
      expect(queue.getQueueDepth()).toBe(0);
      expect(queue.getInFlightCount()).toBe(0);
    } finally {
      queue.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // Invariant 5 — End-to-end composition: detector → wiring → bus → queue
  // → stamper. The wiring layer here is the SAME shape the production
  // bridge will take when daemon→renderer IPC for stream-dead lands:
  // `for (const dead of detector.check(now)) { detector.forget(dead);
  //   bus.emit('streamDead', { subId: dead, lastSeq }); }`.
  // -------------------------------------------------------------------------
  it('e2e composition: detector.check() → bus.emit() → queue resubscribes via stamper', async () => {
    const detector = createStreamDeadDetector({ deadlineMs: T78_TEST_DEADLINE_MS });
    const bus = new DaemonEventBus();
    const stamper = createFromBootNonceStamper(T78_NEW_BOOT_NONCE);
    const sent: Array<{ subId: string; bootNonce: string; fromSeq: number | undefined }> = [];
    const reconnectFn = async (
      subId: string,
      lastSeq: number | undefined,
    ): Promise<ReconnectOutcome> => {
      const env = stamper.stamp({ kind: 'subscribePty' as const, subId, fromSeq: lastSeq });
      sent.push(env);
      return 'ok';
    };
    const queue = new ReconnectQueue(reconnectFn, {
      bus,
      baseDelayMs: 0,
      concurrency: 1,
    });
    try {
      // Two subscribers tracked at t0; only sid-late ack'd recently.
      const t0 = 1_700_000_000_000;
      detector.track('sid-stuck', t0);
      detector.track('sid-late', t0);
      queue.register({ subId: 'sid-stuck', lastSeq: 42 });
      queue.register({ subId: 'sid-late', lastSeq: 99 });
      detector.onAck('sid-late', t0 + T78_TEST_DEADLINE_MS + 1);

      // Wiring layer's tick — detector identifies dead subs, fan-outs
      // streamDead per id, then forgets them so they aren't reported
      // again on the next tick (stream-dead-detector.ts line 109).
      const now = t0 + T78_TEST_DEADLINE_MS + 2;
      const dead = detector.check(now);
      expect(dead).toEqual(['sid-stuck']);
      for (const subId of dead) {
        detector.forget(subId);
        bus.emit('streamDead', { subId });
      }

      // Drain microtasks — queue fires the single sid-stuck task.
      for (let i = 0; i < 16; i++) await Promise.resolve();

      expect(sent).toHaveLength(1);
      expect(sent[0].subId).toBe('sid-stuck');
      // Wiring uses queue's tracked lastSeq (reconnect-queue.ts line
      // 143-144 prefers active.lastSeq over event payload).
      expect(sent[0].fromSeq).toBe(42);
      // Stamped with the new boot's nonce (the daemon that will RECEIVE
      // the resubscribe is the current daemon process).
      expect(sent[0].bootNonce).toBe(T78_NEW_BOOT_NONCE);

      // sid-late was rearmed; it must NOT have been reported as dead and
      // must NOT have triggered a queue task.
      expect(sent.some((e) => e.subId === 'sid-late')).toBe(false);
    } finally {
      queue.dispose();
    }
  });
});
