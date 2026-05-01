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
import { DAEMON_PROTOCOL_VERSION } from '../daemon/src/envelope/protocol-version.js';
import {
  HMAC_TAG_LENGTH,
  NONCE_BYTES,
} from '../daemon/src/envelope/hmac.js';
import { encode as base64urlEncode } from '../daemon/src/envelope/base64url.js';

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
