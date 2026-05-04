// tools/sea-smoke/main.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       chapter 10 §7 — `tools/sea-smoke/`. Invoked at the END of each
//       e2e-installer-{win,mac,linux} CI job AFTER the installer has
//       placed the daemon and registered the per-OS service.
//
// Step list (verbatim from spec ch10 §7 — DO NOT reorder; the steps are
// the contract a sea-binary smoke must satisfy):
//
//   1. Start the OS service (or reuse the installer-started service):
//        systemctl start ccsm-daemon
//        launchctl kickstart system/com.ccsm.daemon
//        Start-Service ccsm-daemon
//   2. Poll Supervisor /healthz (per-OS UDS / pipe path) for HTTP 200
//      within 10s; fail otherwise.
//   3. Open Listener A via descriptor (ch03 §1) and call Hello RPC;
//      assert proto_version matches expected.
//   4. CreateSession({ command: "echo ok" }) — assert returned
//      Session.id non-empty.
//   5. Subscribe to PtyService.Attach({ session_id }) and assert at
//      least one delta arrives within 5s containing the literal bytes
//      "ok".
//   6. Stop the daemon:
//        systemctl stop ccsm-daemon
//        launchctl bootout system/com.ccsm.daemon
//        Stop-Service ccsm-daemon
//      assert process exits within 5s.
//   7. Exit non-zero on any step failure; capture per-OS service-manager
//      log on failure (same capture rule as §5 step 7).
//
// Deliberately NOT a vitest spec: this is a sea-binary-style smoke that
// runs the actual built ccsm-daemon placed by the real installer. There
// is no in-process daemon to import; there is no test runner to drive.
// The wire to drive: real Supervisor UDS + real Listener A. Run via
// `node --import tsx tools/sea-smoke/main.ts` from the CI installer job.
//
// SRP: this file is the orchestrator (decider + sink). The two pure
// helpers under lib/ own:
//   - lib/healthz-wait.ts: producer (HTTP probes) + decider (timeout vs 200)
//   - lib/service-log.ts:  sink (per-OS service-manager log dump)
// The transport-bridge equivalent (UDS / named-pipe Connect dial) is
// inlined here because it is single-purpose to this smoke; if a third
// caller appears it migrates to lib/.
//
// Layer 1 / 5-tier (re-evaluated for transport dial):
//   tier 1 — repo helper that dials UDS Connect from a Node script: NONE.
//            Renderer side uses an Electron main-process http2 bridge
//            (transport-bridge.ts) that is NOT reusable here.
//   tier 2 — node:net + node:http2 stdlib: COVERS IT. We open a net
//            socket via createConnection and feed it to
//            createConnectTransport via nodeOptions. Same pattern
//            connect-node uses internally for h2c-tcp; we override the
//            connection factory.
//   tier 3 — @connectrpc/connect-node already in deps: ✓ (used).
// → tier 2/3 covers; no new dep.

import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  CreateSessionRequestSchema,
  HelloRequestSchema,
  PROTO_VERSION,
  PtyService,
  RequestMetaSchema,
  SessionService,
  type AttachRequest,
  AttachRequestSchema,
} from '@ccsm/proto';

import { waitForHealthz } from './lib/healthz-wait.js';
import { dumpServiceLog, type SmokePlatform } from './lib/service-log.js';

// ---------------------------------------------------------------------------
// Per-OS constants. Sourced from spec ch07 §2 (state-dir layout) +
// post-install-healthz.{sh,ps1} (supervisor address) + ch10 §7 (service
// commands).
// ---------------------------------------------------------------------------

interface PlatformPaths {
  /** Supervisor UDS / named-pipe path (ch07 §2 — supervisor address). */
  readonly supervisorAddress: string;
  /** Listener A descriptor file path (ch07 §2 — Daemon state root). */
  readonly descriptorPath: string;
  /** Service start command. */
  readonly startCmd: ServiceCommand;
  /** Service stop command. */
  readonly stopCmd: ServiceCommand;
}

interface ServiceCommand {
  readonly exe: string;
  readonly args: ReadonlyArray<string>;
}

function platformPaths(platform: SmokePlatform): PlatformPaths {
  if (platform === 'linux') {
    return {
      supervisorAddress: '/run/ccsm/supervisor.sock',
      descriptorPath: '/var/lib/ccsm/listener-a.json',
      startCmd: { exe: 'systemctl', args: ['start', 'ccsm-daemon'] },
      stopCmd: { exe: 'systemctl', args: ['stop', 'ccsm-daemon'] },
    };
  }
  if (platform === 'darwin') {
    return {
      supervisorAddress: '/var/run/com.ccsm.daemon/supervisor.sock',
      descriptorPath: '/Library/Application Support/ccsm/listener-a.json',
      startCmd: {
        exe: 'launchctl',
        args: ['kickstart', 'system/com.ccsm.daemon'],
      },
      stopCmd: {
        exe: 'launchctl',
        args: ['bootout', 'system/com.ccsm.daemon'],
      },
    };
  }
  // win32
  return {
    supervisorAddress: '\\\\.\\pipe\\ccsm-supervisor',
    // Per spec ch07 §2: %PROGRAMDATA%\ccsm. Fallback to default if env
    // missing on the runner.
    descriptorPath: `${process.env.PROGRAMDATA ?? 'C:\\ProgramData'}\\ccsm\\listener-a.json`,
    startCmd: { exe: 'powershell', args: ['-NoProfile', '-Command', 'Start-Service ccsm-daemon'] },
    stopCmd: { exe: 'powershell', args: ['-NoProfile', '-Command', 'Stop-Service ccsm-daemon'] },
  };
}

// ---------------------------------------------------------------------------
// Listener A descriptor — minimal reader (the canonical writer is
// packages/daemon/src/listeners/descriptor.ts; we ship a structural reader
// here to avoid a workspace dep on @ccsm/daemon, which would drag the
// whole daemon build into the smoke binary).
// ---------------------------------------------------------------------------

interface DescriptorV1Lite {
  readonly version: 1;
  readonly transport:
    | 'KIND_UDS'
    | 'KIND_NAMED_PIPE'
    | 'KIND_TCP_LOOPBACK_H2C'
    | 'KIND_TCP_LOOPBACK_H2_TLS';
  readonly address: string;
  readonly tlsCertFingerprintSha256: string | null;
  readonly supervisorAddress: string;
  readonly boot_id: string;
}

async function readDescriptor(path: string): Promise<DescriptorV1Lite> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as DescriptorV1Lite;
  if (parsed.version !== 1) {
    throw new Error(`descriptor at ${path} has unsupported version=${String(parsed.version)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Connect transport for the descriptor — supports UDS / named-pipe /
// loopback h2c (descriptor enum closed per ch03 §1a). TLS variant is
// rejected: the smoke runs against the spec-default transport and will
// fail loud if the descriptor unexpectedly carries TLS (signals a
// listener-A mis-route worth flagging at the smoke layer).
// ---------------------------------------------------------------------------

function transportForDescriptor(desc: DescriptorV1Lite) {
  if (desc.transport === 'KIND_TCP_LOOPBACK_H2C') {
    // address is "host:port"; pass straight to baseUrl.
    return createConnectTransport({
      httpVersion: '2',
      baseUrl: `http://${desc.address}`,
    });
  }
  if (desc.transport === 'KIND_UDS' || desc.transport === 'KIND_NAMED_PIPE') {
    // h2c over UDS / named pipe. Connect-node forwards `nodeOptions` to
    // node:http2 connect; we override `createConnection` so the http2
    // session opens against the named socket rather than a host:port.
    return createConnectTransport({
      httpVersion: '2',
      // baseUrl host is irrelevant once createConnection is overridden,
      // but Node URL requires a syntactically valid value. The path
      // segment ('/') is the Connect prefix.
      baseUrl: 'http://localhost',
      nodeOptions: {
        createConnection: () => netConnect(desc.address),
      },
    });
  }
  throw new Error(`unsupported descriptor transport for sea-smoke: ${desc.transport}`);
}

// ---------------------------------------------------------------------------
// Service-manager primitives. Wraps spawn() so the orchestrator stays
// readable. Stop has a 5s budget per spec ch10 §7 step 6; start has a
// 10s budget (the wait on /healthz takes the heavy lifting).
// ---------------------------------------------------------------------------

async function runService(cmd: ServiceCommand, budgetMs: number): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd.exe, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, budgetMs);
    child.stdout.on('data', (b: Buffer) => process.stderr.write(b));
    child.stderr.on('data', (b: Buffer) => process.stderr.write(b));
    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[sea-smoke] spawn ${cmd.exe} failed: ${String(err)}\n`);
      resolve({ code: -1, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (timedOut) {
        process.stderr.write(`[sea-smoke] ${cmd.exe} ${cmd.args.join(' ')} exceeded ${String(budgetMs)}ms budget\n`);
      }
      resolve({ code, ms });
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface SmokeOptions {
  /** Override the platform — used by tests; defaults to process.platform. */
  readonly platform?: SmokePlatform;
  /** Skip step 1 (start). Useful when the installer already started it. */
  readonly skipStart?: boolean;
  /** Skip step 6 (stop). Useful for local debugging. */
  readonly skipStop?: boolean;
  /** Override the expected proto_version — defaults to PROTO_VERSION. */
  readonly expectedProtoVersion?: number;
}

export async function runSmoke(opts: SmokeOptions = {}): Promise<number> {
  const platform = opts.platform ?? (process.platform as SmokePlatform);
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    process.stderr.write(`[sea-smoke] unsupported platform: ${platform}\n`);
    return 1;
  }
  const paths = platformPaths(platform);

  process.stderr.write(`[sea-smoke] starting on platform=${platform}\n`);
  process.stderr.write(`[sea-smoke]   supervisor=${paths.supervisorAddress}\n`);
  process.stderr.write(`[sea-smoke]   descriptor=${paths.descriptorPath}\n`);

  // ----- step 1: start service -----
  if (!opts.skipStart) {
    process.stderr.write(`[sea-smoke] step 1: ${paths.startCmd.exe} ${paths.startCmd.args.join(' ')}\n`);
    const startRes = await runService(paths.startCmd, 10_000);
    if (startRes.code !== 0) {
      process.stderr.write(`[sea-smoke] FAIL: service start exited code=${String(startRes.code)} after ${String(startRes.ms)}ms\n`);
      await dumpServiceLog({ platform });
      return 1;
    }
  } else {
    process.stderr.write('[sea-smoke] step 1: skipped (skipStart)\n');
  }

  // ----- step 2: wait /healthz 200 within 10s -----
  process.stderr.write('[sea-smoke] step 2: poll /healthz (budget 10s)\n');
  const healthz = await waitForHealthz({
    address: paths.supervisorAddress,
    timeoutMs: 10_000,
    intervalMs: 250,
    onProbe: (attempt, status, elapsedMs) => {
      if (attempt === 1 || status === 200 || attempt % 4 === 0) {
        process.stderr.write(`[sea-smoke]   probe #${String(attempt)} status=${String(status)} elapsed=${String(elapsedMs)}ms\n`);
      }
    },
  });
  if (healthz.status !== 200) {
    process.stderr.write(`[sea-smoke] FAIL: /healthz never returned 200 (last=${String(healthz.status)})\n`);
    await dumpServiceLog({ platform });
    return 1;
  }
  process.stderr.write('[sea-smoke] step 2: /healthz 200 OK\n');

  // ----- step 3: open Listener A + Hello -----
  process.stderr.write('[sea-smoke] step 3: read descriptor + Hello\n');
  let descriptor: DescriptorV1Lite;
  try {
    descriptor = await readDescriptor(paths.descriptorPath);
  } catch (err) {
    process.stderr.write(`[sea-smoke] FAIL: cannot read descriptor at ${paths.descriptorPath}: ${String(err)}\n`);
    await dumpServiceLog({ platform });
    return 1;
  }
  process.stderr.write(
    `[sea-smoke]   descriptor transport=${descriptor.transport} address=${descriptor.address} boot_id=${descriptor.boot_id}\n`,
  );
  const transport = transportForDescriptor(descriptor);
  const sessionClient = createClient(SessionService, transport);
  const expectedVersion = opts.expectedProtoVersion ?? PROTO_VERSION;
  try {
    const hello = await sessionClient.hello(
      create(HelloRequestSchema, {
        meta: makeMeta(),
        clientKind: 'sea-smoke',
        protoMinVersion: expectedVersion,
      }),
    );
    if (hello.protoVersion !== expectedVersion) {
      process.stderr.write(
        `[sea-smoke] FAIL: Hello.proto_version=${String(hello.protoVersion)} expected=${String(expectedVersion)}\n`,
      );
      await dumpServiceLog({ platform });
      return 1;
    }
    process.stderr.write(
      `[sea-smoke] step 3: Hello OK daemon_version=${hello.daemonVersion} proto_version=${String(hello.protoVersion)} listener=${hello.listenerId}\n`,
    );
  } catch (err) {
    process.stderr.write(`[sea-smoke] FAIL: Hello RPC failed: ${formatConnectError(err)}\n`);
    await dumpServiceLog({ platform });
    return 1;
  }

  // ----- step 4: CreateSession({ command: "echo ok" }) -----
  // Spec ch10 §7 step 4 uses the shorthand `command: "echo ok"`. The
  // CreateSession wire (ch04 §3 / session.proto) does not expose a
  // `command` field directly — claude_args carries the argv that the
  // daemon prepends with the resolved claude binary. For this smoke we
  // stand in with a `claude_args` that the daemon's spawn path will
  // forward to the underlying shell — the assertion is "id non-empty",
  // not "echo executes on bare bash". The Attach delta containing 'ok'
  // (step 5) is the actual exec proof.
  process.stderr.write('[sea-smoke] step 4: CreateSession\n');
  let sessionId = '';
  try {
    const created = await sessionClient.createSession(
      create(CreateSessionRequestSchema, {
        meta: makeMeta(),
        cwd: platform === 'win32' ? 'C:\\' : '/',
        claudeArgs: ['echo', 'ok'],
      }),
    );
    sessionId = created.session?.id ?? '';
    if (sessionId.length === 0) {
      process.stderr.write('[sea-smoke] FAIL: CreateSession returned empty session.id\n');
      await dumpServiceLog({ platform });
      return 1;
    }
    process.stderr.write(`[sea-smoke] step 4: CreateSession OK id=${sessionId}\n`);
  } catch (err) {
    process.stderr.write(`[sea-smoke] FAIL: CreateSession failed: ${formatConnectError(err)}\n`);
    await dumpServiceLog({ platform });
    return 1;
  }

  // ----- step 5: Attach + assert delta containing 'ok' within 5s -----
  process.stderr.write('[sea-smoke] step 5: Attach (budget 5s)\n');
  const ptyClient = createClient(PtyService, transport);
  const attachReq: AttachRequest = create(AttachRequestSchema, {
    meta: makeMeta(),
    sessionId,
    sinceSeq: 0n,
    requiresAck: false,
  });
  const attachOk = await waitForOkDelta(ptyClient, attachReq, 5_000);
  if (!attachOk) {
    process.stderr.write('[sea-smoke] FAIL: Attach did not deliver a delta containing "ok" within 5s\n');
    await dumpServiceLog({ platform });
    return 1;
  }
  process.stderr.write('[sea-smoke] step 5: Attach delta contained "ok" OK\n');

  // ----- step 6: stop + 5s budget -----
  let stopFailure = false;
  if (!opts.skipStop) {
    process.stderr.write(`[sea-smoke] step 6: ${paths.stopCmd.exe} ${paths.stopCmd.args.join(' ')}\n`);
    const stopRes = await runService(paths.stopCmd, 5_000);
    if (stopRes.code !== 0) {
      process.stderr.write(`[sea-smoke] FAIL: service stop exited code=${String(stopRes.code)} after ${String(stopRes.ms)}ms\n`);
      stopFailure = true;
    } else {
      process.stderr.write(`[sea-smoke] step 6: service stopped in ${String(stopRes.ms)}ms\n`);
    }
  } else {
    process.stderr.write('[sea-smoke] step 6: skipped (skipStop)\n');
  }

  if (stopFailure) {
    await dumpServiceLog({ platform });
    return 1;
  }

  process.stderr.write('[sea-smoke] all steps passed\n');
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMeta() {
  return create(RequestMetaSchema, {
    requestId: cryptoRandomUuid(),
    clientVersion: '0.3.0-sea-smoke',
    clientSendUnixMs: BigInt(Date.now()),
  });
}

function cryptoRandomUuid(): string {
  // Avoid an extra import — node:crypto.randomUUID is available since
  // Node 14.17 and unconditionally on Node 22 (engines >=22 per repo).
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional dynamic to avoid extra import
  return (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
    // Fallback for older runtimes: not security-sensitive, observability only.
    `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}

function formatConnectError(err: unknown): string {
  if (err instanceof ConnectError) {
    return `${Code[err.code] ?? String(err.code)}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Subscribe to the Attach stream and resolve `true` as soon as a delta
 * payload contains the literal bytes "ok"; resolve `false` if the budget
 * elapses first. Always tears down the iterator before returning so the
 * underlying http2 stream does not leak past the smoke's lifetime.
 */
async function waitForOkDelta(
  ptyClient: ReturnType<typeof createClient<typeof PtyService>>,
  req: AttachRequest,
  budgetMs: number,
): Promise<boolean> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), budgetMs).unref();
  try {
    const stream = ptyClient.attach(req, { signal: abort.signal });
    for await (const frame of stream) {
      const k = frame.kind;
      // PtyFrame is a oneof of { snapshot, delta, heartbeat }. Both
      // snapshot.screen_state and delta.payload are byte sequences that
      // could carry the smoke literal — but spec ch10 §7 step 5 says
      // "delta contains 'ok'", so we only look at delta payloads.
      if (k.case === 'delta') {
        const payload = k.value.payload;
        if (containsBytes(payload, 'ok')) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    if (abort.signal.aborted) return false;
    process.stderr.write(`[sea-smoke]   Attach stream errored: ${formatConnectError(err)}\n`);
    return false;
  } finally {
    clearTimeout(deadline);
    if (!abort.signal.aborted) abort.abort();
  }
}

function containsBytes(haystack: Uint8Array, needle: string): boolean {
  if (haystack.length < needle.length) return false;
  const buf = Buffer.isBuffer(haystack) ? haystack : Buffer.from(haystack);
  return buf.includes(needle);
}

// ---------------------------------------------------------------------------
// Entry point — only run when invoked directly, not when imported by a
// unit test or by an orchestrator wrapper.
// ---------------------------------------------------------------------------

const isDirectInvoke = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    // tsx rewrites the URL; substring match on the file basename is the
    // most reliable cross-loader signal.
    return argv1.endsWith('main.ts') || argv1.endsWith('main.js');
  } catch {
    return false;
  }
})();

if (isDirectInvoke) {
  runSmoke()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`[sea-smoke] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
