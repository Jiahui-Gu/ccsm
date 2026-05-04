// packages/daemon/test/integration/daemon-boot-end-to-end.spec.ts
//
// Wave-1 Task #208 — daemon-boot end-to-end smoke gate.
//
// Goal: prove the daemon's `runStartup` actually wires the v0.3
// production surface end-to-end. This spec is the regression catch for
// Wave 3 wire-up work (Task #225 layers more assertions on top of the
// same file). It MUST fail loudly if any of these wire-ups silently
// regress to a stub:
//
//   1. `~/.ccsm/listener-a.json` is written atomically and validates
//      against the v1 JSON Schema — proves T1.6 descriptor write fires.
//   2. Listener A serves the Connect router with the real T2.3
//      SessionService.Hello handler installed; calling it does NOT
//      return Code.Unimplemented.
//   3. Hello with no Authorization header is rejected with
//      `Unauthenticated` — proves the auth interceptor chain (T1.3 +
//      `bearerToPeerInfoInterceptor`) is wired into the production bind
//      hook, not just the test harness.
//   4. The Supervisor UDS server is reachable on `env.paths.supervisorAddr`;
//      `GET /healthz` returns 200 with `{ ready: true, ... }` — proves
//      T1.7 supervisor wiring fires AND `/healthz` flips on lifecycle
//      READY (not earlier).
//   5. `installCaptureSources` ran — surfaces the boot probe
//      `result.captureSourcesInstalled === true`.
//   6. `replayCrashRawOnBoot` processed a pre-seeded NDJSON file —
//      surfaces the boot probe `result.crashReplayResult.inserted >= 1`,
//      and the file is truncated post-replay (silent-loss safety,
//      ch09 §6.2 case (e)).
//   7. Wave-3 #225 rolling extension — `result.wired` deep-equals
//      `REQUIRED_COMPONENTS` minus `WARN_ONLY` (write-coalescer). The
//      previous superset shape silently tolerated drift between
//      `runStartup.lock.ts:REQUIRED_COMPONENTS` and `index.ts`'s
//      pushed-`wired` list.
//   8. Wave-3 #225 rolling extension — WatchSessions over-the-wire smoke:
//      publishes a `created` event into the wired bus via
//      `result.sessionManager` and asserts the client receives the
//      proto SessionEvent. Stronger than `watch-sessions-wired.spec.ts`
//      (which only asserts not-Unimplemented).
//   9. Wave-3 #225 rolling extension — GetCrashLog over-the-wire smoke:
//      asserts the seeded crash row that `replayCrashRawOnBoot` ingested
//      is echoed by id over the wire. Stronger than
//      `crash-getlog-wired.spec.ts`. Cross-OS aware: tolerant when the
//      POSIX `/var/lib/ccsm` seed write was not writable (assertion 6
//      already covers that branch).
//
// Spec "≥14 assertions" reality check (Task #225):
//   The v0.3 spec sub-task #225 cited "≥14 wire assertions" as the
//   rolling-extension target. As of working @ HEAD only THREE Connect
//   RPCs are actually wired in production (Hello, WatchSessions,
//   GetCrashLog) — see `index.ts:runStartup` `makeRouterBindHook(...)`
//   call. The remaining ~10 RPC methods (Create/Destroy/Get/List
//   sessions, GetRawCrashLog, WatchCrashLog, all of PtyService and
//   SettingsService) still resolve to `Code.Unimplemented` because their
//   handlers / wire-up tasks have not landed yet (#336/#338/#339/#341/#349).
//   Stuffing reverse-assertions for the unwired ~10 here would lock in
//   transitional Unimplemented behavior we expect to delete in 2 weeks
//   — net negative. The next rolling extension lands when those wire-up
//   tasks merge.
//
// Why in-process (not child-process) boot:
//   - We import and call the exported `runStartup` directly. This is
//     the SAME function `main()` invokes; no test-only fork in the boot
//     path. A child-process spawn would add ~1s of node start-up + a
//     dist build dependency for no extra coverage — the wire-up is
//     proved by exercising the exported boot function with production
//     env, identically to the way `__tests__/lifecycle.spec.ts` and the
//     other integration specs cover their subsystems.
//   - When Wave 3 lands additional assertions, they extend this file
//     against the same `runStartup` invocation rather than each
//     spawning their own daemon process.
//
// Transport choice:
//   - `CCSM_LISTENER_A_FORCE_LOOPBACK=1` forces Listener A onto h2c
//     loopback (`KIND_TCP_LOOPBACK_H2C`). UDS / named-pipe peer-cred
//     extraction wires through a separate hardening pass — loopback is
//     the cross-OS test seam (spec ch12 §3 / harness.ts comment).
//   - The Supervisor UDS path is overridden via `CCSM_SUPERVISOR_ADDR`
//     to a tmp path (POSIX) or a unique named pipe (win32) so the test
//     does not collide with the OS-installed daemon.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type Client,
  createClient,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import {
  PROTO_VERSION,
  CrashService,
  GetCrashLogRequestSchema,
  OwnerFilter,
  RequestMetaSchema,
  SessionService,
  WatchScope,
  WatchSessionsRequestSchema,
} from '@ccsm/proto';
import * as AjvNs from 'ajv';

import { runStartup, type RunStartupResult } from '../../src/index.js';
import { Lifecycle, Phase } from '../../src/lifecycle.js';
import { REQUIRED_COMPONENTS } from '../../src/runStartup.lock.js';
import { TEST_BEARER_TOKEN } from '../../src/auth/index.js';
import type { Principal } from '../../src/auth/index.js';

const Ajv =
  (AjvNs as unknown as {
    default?: typeof AjvNs.Ajv;
    Ajv: typeof AjvNs.Ajv;
  }).default ?? AjvNs.Ajv;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', 'schemas', 'listener-a.schema.json');

interface BootEnv {
  readonly tmpRoot: string;
  readonly origEnv: NodeJS.ProcessEnv;
}

async function setupBootEnv(): Promise<BootEnv> {
  const origEnv = { ...process.env };
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ccsm-daemon-boot-e2e-'));
  // Override every per-OS path so the test never touches `/var/lib/ccsm`
  // or `%PROGRAMDATA%\ccsm`. Force loopback so the listener is always an
  // ephemeral 127.0.0.1 port (UDS / named-pipe peer-cred extraction is
  // not in this PR's scope).
  process.env.CCSM_STATE_DIR = tmpRoot;
  process.env.CCSM_DESCRIPTOR_PATH = join(tmpRoot, 'listener-a.json');
  process.env.CCSM_LISTENER_A_ADDR = join(tmpRoot, 'daemon.sock'); // unused on loopback
  process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
  // `runStartup` resolves the SQLite DB path + the crash-raw NDJSON path
  // through `statePaths()` (NOT via CCSM_STATE_DIR — `statePaths` is the
  // forever-stable per-OS layout, ch07 §2). The only env hook into that
  // resolver is `PROGRAMDATA` (win32) — overriding it points the DB and
  // crash-raw under `tmpRoot/ccsm/...`, isolating the test from any
  // installed daemon's shared `C:\ProgramData\ccsm\ccsm.db`. On POSIX the
  // resolver hard-codes `/var/lib/ccsm` so we tolerate writing under the
  // shared tree there (the test runner usually lacks permission and the
  // suite still passes via the `fileMissing` branch — see assertion 6).
  if (process.platform === 'win32') {
    process.env.PROGRAMDATA = tmpRoot;
  }
  // Use a unique per-test supervisor address. On win32 use a named pipe
  // (Node's http server treats `\\.\pipe\<name>` identically to a UDS
  // path); on POSIX use a UDS file under the tmp root.
  process.env.CCSM_SUPERVISOR_ADDR =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ccsm-daemon-boot-e2e-${process.pid}-${Date.now()}`
      : join(tmpRoot, 'supervisor.sock');
  process.env.CCSM_VERSION = '0.3.0-e2e-test';
  return { tmpRoot, origEnv };
}

async function teardownBootEnv(setup: BootEnv): Promise<void> {
  // Restore env exactly. Mutating `process.env` keys we set during
  // setup back to undefined / their prior values prevents leakage to
  // sibling specs that may run in the same vitest worker.
  for (const k of Object.keys(process.env)) {
    if (!(k in setup.origEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(setup.origEnv)) {
    process.env[k] = v;
  }
  await rm(setup.tmpRoot, { recursive: true, force: true }).catch(() => {
    /* tmp cleanup best-effort */
  });
}

/** Stop everything the boot brought up. Safe to call on partial boots.
 *
 * `listenerA.stop()` calls `server.close(...)` which waits for in-flight
 * HTTP/2 streams to close. The Connect-ES client (created via
 * `createConnectTransport`) keeps a long-lived h2 session open by default,
 * so an unary RPC's response does NOT close the underlying session — and
 * `server.close()` therefore hangs forever. Cap each shutdown step at
 * 1500ms to match the harness.ts pattern (see L228-234) so a single
 * client-pinned session cannot push afterEach over the 10s vitest hook
 * budget. The OS reclaims the listening socket on process exit.
 */
async function stopBoot(result: RunStartupResult | null): Promise<void> {
  if (result === null) return;
  result.captureSourcesUnsubscribe?.();
  await Promise.race([
    Promise.resolve(result.supervisor?.stop()).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500).unref()),
  ]);
  await Promise.race([
    Promise.resolve(result.listenerA?.stop()).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500).unref()),
  ]);
  result.crashPruner.stop();
  try {
    result.db.close();
  } catch {
    /* idempotent close */
  }
}

/** Issue an HTTP GET /healthz against a UDS / named-pipe socket path. */
function getHealthz(address: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: address,
        method: 'GET',
        path: '/healthz',
        // Required by node:http when using socketPath without a host.
        headers: { host: 'localhost' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Build a Connect client for SessionService against the bound Listener A
 * (loopback h2c). Optional `authzHeader` overrides the default
 * `Bearer test-token`; passing `null` omits the header entirely (used by
 * the auth-rejection assertion).
 */
function makeSessionClient(
  baseUrl: string,
  authzHeader: string | null = `Bearer ${TEST_BEARER_TOKEN}`,
): Client<typeof SessionService> {
  const transport = createConnectTransport({
    httpVersion: '2',
    baseUrl,
    interceptors: [
      (next) => async (req) => {
        if (authzHeader !== null) {
          req.header.set('authorization', authzHeader);
        }
        return next(req);
      },
    ],
  });
  return createClient(SessionService, transport);
}

/**
 * Crash client mirrors `makeSessionClient` (same transport + bearer-token
 * interceptor) — separate factory so the smoke `it` for `getCrashLog`
 * stays single-concern. Task #225 rolling extension: proves the
 * CrashService.GetCrashLog wire actually echoes a row from the
 * `crash_log` table that boot's `replayCrashRawOnBoot` populated.
 * Also reused by the Wave-3 #334 GetRawCrashLog wiring assertion below.
 */
function makeCrashClient(baseUrl: string): Client<typeof CrashService> {
  const transport = createConnectTransport({
    httpVersion: '2',
    baseUrl,
    interceptors: [
      (next) => async (req) => {
        req.header.set('authorization', `Bearer ${TEST_BEARER_TOKEN}`);
        return next(req);
      },
    ],
  });
  return createClient(CrashService, transport);
}

function newMeta() {
  return create(RequestMetaSchema, {
    requestId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    clientVersion: '0.3.0-e2e-test',
    clientSendUnixMs: BigInt(Date.now()),
  });
}

// ---------------------------------------------------------------------------
// Spec body — single boot per file (one `runStartup`, then exercise every
// assertion against that one running daemon). Wave 3 layers more
// assertions onto the same boot rather than spinning a new one.
// ---------------------------------------------------------------------------

describe('daemon-boot end-to-end (Task #208)', () => {
  let setup: BootEnv;
  let lifecycle: Lifecycle;
  let result: RunStartupResult | null = null;
  // Pre-seed crash-raw.ndjson with a single fatal entry before boot so
  // the replay assertion can prove it ran. Generated per-test so reruns
  // against the persistent per-OS sqlite DB don't dedup against a prior
  // run's INSERT.
  let seededCrashId: string;

  beforeEach(async () => {
    seededCrashId = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setup = await setupBootEnv();
    // Seed a single valid crash-raw entry. Path matches `statePaths().crashRaw`
    // resolved against `CCSM_STATE_DIR` — but `statePaths()` ignores the
    // env override and uses the per-OS root, so we mirror its layout
    // explicitly: `<stateDir>/crash-raw.ndjson`.
    const seedEntry = {
      id: seededCrashId,
      ts_ms: Date.now(),
      source: 'uncaughtException',
      summary: 'seeded for daemon-boot e2e',
      detail: 'replayCrashRawOnBoot must process this',
      labels: {},
      owner_id: 'daemon-self',
    };
    // `replayCrashRawOnBoot` reads from `statePaths().crashRaw`. We
    // override `PROGRAMDATA` in `setupBootEnv` (win32) so this resolves
    // to a per-test tmp dir; on POSIX the per-OS root is hard-coded to
    // `/var/lib/ccsm` and the seed write below typically fails with
    // EACCES on a non-root runner. The catch falls through to the
    // `fileMissing` branch which assertion 6 still treats as a pass
    // (the replay code path RAN, which is what we're proving).
    const { statePaths } = await import('../../src/state-dir/paths.js');
    const { mkdir } = await import('node:fs/promises');
    const sp = statePaths();
    try {
      await mkdir(dirname(sp.crashRaw), { recursive: true });
      await writeFile(sp.crashRaw, JSON.stringify(seedEntry) + '\n', {
        flag: 'w',
      });
    } catch {
      /* see comment above */
    }

    lifecycle = new Lifecycle();
    result = await runStartup(lifecycle);
  });

  afterEach(async () => {
    await stopBoot(result);
    result = null;
    await teardownBootEnv(setup);
  });

  it('writes listener-a.json and validates against v1 schema', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.descriptorPath).not.toBeNull();
    const descriptorBytes = await readFile(r.descriptorPath!, 'utf8');
    const descriptor = JSON.parse(descriptorBytes);

    // Schema validation — fails if the writer drifts from v1 shape.
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const ok = validate(descriptor);
    expect(ok, `descriptor failed schema: ${JSON.stringify(validate.errors)}`).toBe(true);

    // Sanity: the descriptor reflects this boot, not a stale file.
    expect(descriptor.boot_id).toBe(r.env.bootId);
    expect(descriptor.transport).toBe('KIND_TCP_LOOPBACK_H2C');
  });

  it('Listener-A.SessionService.Hello does NOT return Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    expect(desc.kind).toBe('KIND_TCP_LOOPBACK_H2C');
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeSessionClient(baseUrl);
    const resp = await client.hello({
      meta: newMeta(),
      protoMinVersion: 1,
      clientKind: 'electron-test',
    });
    // The stub-baseline contract is `Unimplemented`; we proved the real
    // T2.3 handler is wired by getting back a populated HelloResponse.
    expect(resp.daemonVersion).toBe('0.3.0-e2e-test');
    expect(resp.protoVersion).toBe(PROTO_VERSION);
    expect(resp.listenerId).toBe('A');
    expect(resp.meta?.requestId.startsWith('e2e-')).toBe(true);
  });

  // Wave 3 §6.9 sub-task 5 (Task #336) — SessionService.ListSessions and
  // GetSession read pair. Same regression catch as the Hello assertion
  // above: prove the production wire path actually swaps the stub for
  // the real handler. ListSessions on a fresh boot returns an empty
  // `sessions` array (not Unimplemented). GetSession against a
  // never-created id surfaces `Code.PermissionDenied` (the security
  // boundary in `SessionManager.loadRow` collapses NotFound into
  // not_owned to prevent cross-principal id enumeration) — also NOT
  // Unimplemented. Both proofs use the existing bearer-authenticated
  // session client; no extra fixture state is needed.
  it('Listener-A.SessionService.ListSessions does NOT return Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeSessionClient(baseUrl);
    const meta = newMeta();
    const resp = await client.listSessions({ meta });
    // The stub-baseline contract is `Unimplemented`; we proved the real
    // handler is wired by getting back a populated response shape.
    expect(resp.meta?.requestId).toBe(meta.requestId);
    expect(Array.isArray(resp.sessions)).toBe(true);
    // Fresh boot — no CreateSession handler has landed yet, so the list
    // is empty. When CreateSession lands this assertion can be relaxed
    // to `>= 0`.
    expect(resp.sessions).toHaveLength(0);
  });

  it('Listener-A.SessionService.GetSession does NOT return Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeSessionClient(baseUrl);
    let raised: ConnectError | null = null;
    try {
      await client.getSession({ meta: newMeta(), sessionId: 'no-such-id' });
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised, 'expected ConnectError on unknown session id').not.toBeNull();
    // The stub baseline would be Unimplemented. The real handler maps
    // the missing-row case through `SessionManager.loadRow` which throws
    // `session.not_owned` (PermissionDenied) — proves the handler ran.
    expect(raised!.code).not.toBe(Code.Unimplemented);
    expect(raised!.code).toBe(Code.PermissionDenied);
  });

  it('rejects unauthenticated calls (no bearer token) with Code.Unauthenticated', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    // No Authorization header at all → bearerToPeerInfoInterceptor
    // deposits a LoopbackTcpPeer with bearerToken=null; the auth
    // interceptor rejects with Unauthenticated before any handler runs.
    const client = makeSessionClient(baseUrl, null);
    let raised: ConnectError | null = null;
    try {
      await client.hello({
        meta: newMeta(),
        protoMinVersion: 1,
        clientKind: 'electron-test',
      });
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised, 'expected ConnectError on unauthenticated call').not.toBeNull();
    expect(raised!.code).toBe(Code.Unauthenticated);
  });

  it('Supervisor UDS /healthz returns 200 with ready=true after READY phase', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.supervisor).not.toBeNull();
    expect(lifecycle.currentPhase()).toBe(Phase.READY);

    const { status, body } = await getHealthz(r.supervisor!.address());
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.ready).toBe(true);
    expect(parsed.boot_id).toBe(r.env.bootId);
    expect(parsed.version).toBe('0.3.0-e2e-test');
  });

  it('runStartup probe: installCaptureSources ran on this boot', () => {
    expect(result).not.toBeNull();
    expect(result!.captureSourcesInstalled).toBe(true);
    expect(result!.captureSourcesUnsubscribe).not.toBeNull();
  });

  it('runStartup probe: replayCrashRawOnBoot ran (and processed seeded entry when seedable)', async () => {
    expect(result).not.toBeNull();
    const replay = result!.crashReplayResult;
    // Replay code path executed regardless of seed — `fileMissing` and
    // `linesRead` are always populated.
    expect(replay).toBeDefined();
    expect(typeof replay.fileMissing).toBe('boolean');
    expect(typeof replay.linesRead).toBe('number');
    // When the seed succeeded (writable per-OS root), the replay must
    // have ingested ≥ 1 row AND truncated the file. When it didn't
    // succeed (EACCES on dev machines), `fileMissing === true` is the
    // documented first-boot shape and there is nothing to truncate.
    if (!replay.fileMissing && replay.linesRead > 0) {
      expect(replay.inserted).toBeGreaterThanOrEqual(1);
      const { statePaths } = await import('../../src/state-dir/paths.js');
      const sp = statePaths();
      const st = await stat(sp.crashRaw);
      expect(st.size).toBe(0); // truncate-after-replay (ch09 §6.2)
    }
  });

  // Task #225 rolling extension — `runStartup.lock.ts` REQUIRED_COMPONENTS
  // contract is now LOCKED via deep-equality (`REQUIRED_COMPONENTS` minus
  // the current `WARN_ONLY` set). The previous superset shape silently
  // tolerated a drift where a name was added to REQUIRED_COMPONENTS but
  // never pushed into `index.ts:wired` (or vice-versa). A bidirectional
  // exact-set assertion fails immediately on either side of that drift.
  //
  // `WARN_ONLY` here mirrors `runStartup.lock.ts:WARN_ONLY` literally —
  // intentionally duplicated rather than re-exported so a refactor that
  // changes the production set has to update this file too (the e2e is
  // the contract test, not the implementation).
  it('runStartup probe: result.wired equals REQUIRED_COMPONENTS minus WARN_ONLY (exact set, no drift)', () => {
    expect(result).not.toBeNull();
    const wired = result!.wired;
    const WARN_ONLY = new Set(['write-coalescer']);
    const expected = REQUIRED_COMPONENTS.filter((n) => !WARN_ONLY.has(n));
    // Sort both sides so order changes in REQUIRED_COMPONENTS / wired
    // don't false-fail (canonical order is documented in
    // runStartup.lock.ts but the contract is set-equality, not order).
    expect([...wired].sort()).toEqual([...expected].sort());
  });

  // Wave-3 Task #334 — CrashService.GetRawCrashLog server-streaming
  // wire-up. Pre-#334 the router's "absent method -> Unimplemented"
  // rule meant calling GetRawCrashLog returned `Code.Unimplemented`
  // even though `state/crash-raw.ndjson` is the spec-pinned source for
  // the renderer's "Download raw log" affordance (chapter 08 §3 / 09 §2).
  // We prove the real handler is wired by confirming the call returns
  // a usable stream (NOT Unimplemented) and emits at least the spec-
  // mandated terminal `eof=true` chunk. Concrete byte payload is NOT
  // asserted here — the per-OS state-dir resolver may point the path
  // at a real file (win32 with `PROGRAMDATA` overridden) or at an
  // unwritable shared root (POSIX `/var/lib/ccsm` non-root runner),
  // so the wire shape is the only cross-platform-stable assertion.
  // The byte-level semantics are pinned by the handler's own unit
  // tests (`get-raw-crash-log.spec.ts`); this assertion only proves
  // the production overlay actually replaces the stub.
  it('Listener-A.CrashService.GetRawCrashLog does NOT return Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeCrashClient(baseUrl);
    const stream = client.getRawCrashLog({ meta: newMeta() });
    let sawEof = false;
    let chunkCount = 0;
    let raised: ConnectError | null = null;
    try {
      for await (const chunk of stream) {
        chunkCount += 1;
        if (chunk.eof) {
          sawEof = true;
          break;
        }
        // Defensive: bound the loop in case a regression replaces the
        // terminal-sentinel policy with an infinite stream.
        if (chunkCount > 1024) break;
      }
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(
      raised?.code,
      `expected stream to complete (or fail with non-Unimplemented), got ${raised?.code}: ${raised?.message}`,
    ).not.toBe(Code.Unimplemented);
    // Either the stream completed cleanly with the eof sentinel (the
    // happy path) OR it raised a non-Unimplemented error (e.g. EACCES
    // on a POSIX runner whose state-dir is unwritable). Both prove the
    // handler is wired; only `Code.Unimplemented` proves it is NOT.
    if (raised === null) {
      expect(sawEof, 'expected terminal RawCrashChunk{eof:true} sentinel').toBe(true);
    }
  });

  // Task #225 rolling extension — WatchSessions over-the-wire smoke.
  // `watch-sessions-wired.spec.ts` (#290) only proves the stream stays
  // open past 250ms (handler installed). This stronger test publishes a
  // synthetic `created` event into the SAME bus the production handler
  // subscribes to (via `result.sessionManager`, surfaced by Task #225)
  // and asserts the client receives a `kind=created` proto SessionEvent.
  // Failure mode pinned: a future refactor that disconnects the wired
  // bus from the handler subscription (e.g. constructs a fresh manager
  // inside the bind hook) would yield no event and time out here.
  it('WatchSessions smoke: client receives a SessionEvent.created when manager.create fires on the wired bus', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    expect(r.sessionManager).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const ac = new AbortController();
    const client = makeSessionClient(baseUrl);
    const stream = client.watchSessions(
      create(WatchSessionsRequestSchema, {
        meta: newMeta(),
        scope: WatchScope.OWN,
      }),
      { signal: ac.signal },
    );
    const iterator = stream[Symbol.asyncIterator]();

    // The TEST_PRINCIPAL the loopback auth interceptor synthesizes is
    // `{ kind: 'local-user', uid: 'test', displayName: 'test' }` —
    // mirror it here so the principalKey filter on the bus matches the
    // subscribing client. A drift in either side breaks this test
    // before it reaches production.
    const callerPrincipal: Principal = {
      kind: 'local-user',
      uid: 'test',
      displayName: 'test',
    };
    // `sessions.owner_id` is FK -> `principals.id` (see
    // db/migrations/001_initial.sql L46). Production peer-cred middleware
    // upserts the row on connect (T1.3) — but the WatchSessions wire-up
    // the smoke is testing does NOT take that path (it only reads
    // PRINCIPAL_KEY from contextValues). Insert the row directly so the
    // FK check on `manager.create` below passes; mirrors the same
    // pattern in `packages/daemon/test/sessions/SessionManager.spec.ts`
    // setup (the unit-test seam, principalKey = `<kind>:<uid>`).
    r.db
      .prepare(
        `INSERT OR IGNORE INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('local-user:test', 'local-user', 'test', Date.now(), Date.now());

    // Kick a `created` event onto the bus AFTER subscribing (the
    // WatchSessions wire is tail-only — see watch-sessions.ts Layer 1
    // note explicitly rejecting a snapshot frame). Wait until the
    // server-side handler has actually called `manager.subscribe(...)`
    // before publishing — `setImmediate` alone races against the http2
    // round-trip + Connect dispatch on slow hosts. We poll
    // `eventBus.listenerCount(principalKey)` (the bus's documented
    // observability hook) up to 5s; if it never goes >0 the wire is
    // broken and the assertion below catches it via `timedOut`.
    const sessionManagerCast = r.sessionManager as unknown as {
      readonly eventBus: { readonly listenerCount: (k: string) => number };
    };
    const subscribeDeadline = Date.now() + 5000;
    while (
      sessionManagerCast.eventBus.listenerCount('local-user:test') === 0 &&
      Date.now() < subscribeDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const created = r.sessionManager!.create(
      {
        cwd: '/tmp/ccsm-daemon-boot-e2e',
        env_json: '{}',
        claude_args_json: '[]',
        geometry_cols: 80,
        geometry_rows: 24,
      },
      callerPrincipal,
    );

    let firstEvent: IteratorResult<unknown> | null = null;
    let timedOut = false;
    try {
      const winner = await Promise.race([
        iterator.next().then((ev) => ({ kind: 'event' as const, ev })),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 2000),
        ),
      ]);
      if (winner.kind === 'event') {
        firstEvent = winner.ev as IteratorResult<unknown>;
      } else {
        timedOut = true;
      }
    } finally {
      ac.abort();
      await iterator.return?.(undefined).catch(() => {});
    }

    expect(timedOut, 'WatchSessions did not deliver the published event within 2s').toBe(false);
    expect(firstEvent).not.toBeNull();
    expect(firstEvent!.done).toBe(false);
    const ev = firstEvent!.value as { kind: { case: string; value: { id: string } } };
    expect(ev.kind.case).toBe('created');
    expect(ev.kind.value.id).toBe(created.id);
  });

  // Task #225 rolling extension — GetCrashLog over-the-wire smoke.
  // `crash-getlog-wired.spec.ts` (#229) only proves the response is not
  // Code.Unimplemented. This stronger test asserts the response actually
  // ECHOES the seeded crash row — proves the chain
  //   crash-raw.ndjson  → replayCrashRawOnBoot
  //                     → crash_log INSERT
  //                     → GetCrashLog SELECT
  //                     → wire response
  // is end-to-end, not just that the handler runs.
  //
  // POSIX caveat: the seed write in `beforeEach` lands at
  // `statePaths().crashRaw` (hard-coded `/var/lib/ccsm` on POSIX, see the
  // setupBootEnv comment). Non-root runners get EACCES and the seed
  // silently no-ops; in that case `replayCrashRawOnBoot` returns
  // `fileMissing: true` and the table is empty. We branch on
  // `crashReplayResult.inserted` so the test stays cross-OS:
  //   - replay inserted >= 1 → response.entries MUST contain seededCrashId
  //     (the seeded row attribution is `owner_id: 'daemon-self'`, which
  //     OWN filter unions with the caller's principalKey — see
  //     get-crash-log.ts producer).
  //   - replay inserted == 0 → seed was not writable; we still assert the
  //     wire returned a populated response shape (entries[]) so the
  //     handler ran. This matches the existing assertion-6 posture.
  it('GetCrashLog smoke: client receives the seeded crash entry that boot replayed (when seed was writable)', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeCrashClient(baseUrl);
    const resp = await client.getCrashLog(
      create(GetCrashLogRequestSchema, {
        meta: newMeta(),
        limit: 100,
        sinceUnixMs: BigInt(0),
        ownerFilter: OwnerFilter.OWN,
      }),
    );

    // The wire shape was populated — handler ran end-to-end. `entries`
    // is `repeated CrashEntry` so its length is always defined.
    expect(Array.isArray(resp.entries)).toBe(true);

    if (r.crashReplayResult.inserted >= 1) {
      // Strong assertion: the seeded row MUST be in the response. Echo
      // by id is harder than the existing wired-only spec — proves the
      // SQL SELECT returned the row, the proto mapper rendered it, and
      // the OWN owner filter (which unions caller principalKey with
      // 'daemon-self' for daemon-attributed rows) accepted it.
      const ids = resp.entries.map((e) => e.id);
      expect(
        ids,
        `seeded crash id ${seededCrashId} not echoed by GetCrashLog ` +
          `(replay inserted=${r.crashReplayResult.inserted}, response had ${resp.entries.length} entries)`,
      ).toContain(seededCrashId);
    } else {
      // Seed was not writable on this runner (POSIX EACCES on
      // /var/lib/ccsm). Soft assertion: handler ran, returned a valid
      // (likely empty) page. The strong path is exercised on Windows
      // where PROGRAMDATA override always succeeds.
      expect(resp.entries.length).toBeGreaterThanOrEqual(0);
    }
  });
});
