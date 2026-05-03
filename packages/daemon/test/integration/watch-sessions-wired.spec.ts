// packages/daemon/test/integration/watch-sessions-wired.spec.ts
//
// Wave-3 Task #290 — production daemon-startup wire-up regression for
// SessionService.WatchSessions.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #1, branch research/228-rpc-stub-audit fbb0d60).
//
// Background:
//   - `makeWatchSessionsHandler` (T3.3 / PR #939) is fully implemented and
//     unit-tested at `packages/daemon/test/sessions/watch-sessions.spec.ts`.
//   - Until #290, `packages/daemon/src/index.ts` constructed
//     `makeRouterBindHook({ helloDeps })` WITHOUT a `watchSessionsDeps`
//     argument, so `rpc/router.ts:makeDaemonRoutes` fell to its
//     Hello-only branch and SessionService.WatchSessions resolved to the
//     T2.2 `Unimplemented` stub at boot — the exact "library shipped but
//     never wired" regression class Wave 0/1 + Task #221 exist to catch.
//   - This spec boots the production `runStartup` (no mocks, no harness
//     bypass) and asserts the over-the-wire response to a
//     `WatchSessions(OWN)` call is NOT `Code.Unimplemented`. Reverse
//     verification: deleting the `watchSessionsDeps` line from
//     `index.ts` flips this spec to expect-Unimplemented and it fails.
//
// Why a separate spec from `daemon-boot-end-to-end.spec.ts`:
//   - The audit lists WatchSessions as one of FOUR independent stubs that
//     each need their own wire-up + regression test (CrashService,
//     PtyService, SettingsService, WatchSessions). One spec per gap keeps
//     each PR single-concern; later sub-tasks add sibling specs of the
//     same shape. The boot-end-to-end spec stays the cross-cutting
//     "every component wired" assertion via `result.wired`.
//
// Transport choice:
//   - Identical to daemon-boot-end-to-end.spec.ts:
//     `CCSM_LISTENER_A_FORCE_LOOPBACK=1` keeps Listener A on the
//     cross-OS h2c loopback transport so this spec runs on every CI leg
//     without UDS / named-pipe gating.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  RequestMetaSchema,
  SessionService,
  WatchScope,
  WatchSessionsRequestSchema,
} from '@ccsm/proto';

import { runStartup, type RunStartupResult } from '../../src/index.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { TEST_BEARER_TOKEN } from '../../src/auth/index.js';

interface BootEnv {
  readonly tmpRoot: string;
  readonly origEnv: NodeJS.ProcessEnv;
}

async function setupBootEnv(): Promise<BootEnv> {
  const origEnv = { ...process.env };
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ccsm-watch-sessions-wired-'));
  process.env.CCSM_STATE_DIR = tmpRoot;
  process.env.CCSM_DESCRIPTOR_PATH = join(tmpRoot, 'listener-a.json');
  process.env.CCSM_LISTENER_A_ADDR = join(tmpRoot, 'daemon.sock');
  process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
  if (process.platform === 'win32') {
    process.env.PROGRAMDATA = tmpRoot;
  }
  process.env.CCSM_SUPERVISOR_ADDR =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ccsm-watch-sessions-wired-${process.pid}-${Date.now()}`
      : join(tmpRoot, 'supervisor.sock');
  process.env.CCSM_VERSION = '0.3.0-watch-sessions-wired-test';
  return { tmpRoot, origEnv };
}

async function teardownBootEnv(setup: BootEnv): Promise<void> {
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

async function stopBoot(result: RunStartupResult | null): Promise<void> {
  if (result === null) return;
  result.captureSourcesUnsubscribe?.();
  await result.supervisor?.stop().catch(() => {});
  await result.listenerA?.stop().catch(() => {});
  result.crashPruner.stop();
  try {
    result.db.close();
  } catch {
    /* idempotent */
  }
}

function makeSessionClient(baseUrl: string): Client<typeof SessionService> {
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
  return createClient(SessionService, transport);
}

function newWatchRequest(scope: WatchScope) {
  return create(WatchSessionsRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: `wired-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      clientVersion: '0.3.0-watch-sessions-wired-test',
      clientSendUnixMs: BigInt(Date.now()),
    }),
    scope,
  });
}

describe('SessionService.WatchSessions production wire-up (Task #290)', () => {
  let setup: BootEnv;
  let lifecycle: Lifecycle;
  let result: RunStartupResult | null = null;

  beforeEach(async () => {
    setup = await setupBootEnv();
    lifecycle = new Lifecycle();
    result = await runStartup(lifecycle);
  });

  afterEach(async () => {
    await stopBoot(result);
    result = null;
    await teardownBootEnv(setup);
  });

  it('WatchSessions(OWN) over the production Listener A does NOT return Code.Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    expect(desc.kind).toBe('KIND_TCP_LOOPBACK_H2C');
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    // AbortController scopes the lifetime of the streaming call. After
    // we have observed enough to make the wire-up assertion (either a
    // terminal Unimplemented error or a "stream stayed open past the
    // timeout"), we abort so the http2 stream tears down promptly and
    // afterEach's `listenerA.stop()` does not race a still-open client.
    const ac = new AbortController();
    const client = makeSessionClient(baseUrl);
    const stream = client.watchSessions(newWatchRequest(WatchScope.OWN), {
      signal: ac.signal,
    });

    // The handler is server-streaming with no events queued — when
    // wired, the iterator stays open waiting for the first event from
    // the bus. When NOT wired (the pre-#290 regression), the Connect
    // router responds immediately with Code.Unimplemented and the
    // iterator throws on the first `next()`. Race the iterator's first
    // tick against a short timeout: timeout-wins == handler wired,
    // throw-wins == we caught Unimplemented.
    const iterator = stream[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' }), 250),
    );

    let raised: ConnectError | null = null;
    let timedOut = false;
    try {
      const winner = await Promise.race([
        firstEvent.then(() => ({ kind: 'event' as const })),
        timeout,
      ]);
      timedOut = winner.kind === 'timeout';
    } catch (err) {
      raised = ConnectError.from(err);
    } finally {
      // Tear the streaming call down deterministically: abort the
      // signal (cancels the underlying http2 stream) AND drain the
      // iterator's `return` (closes the JS-side generator). Either alone
      // can race teardown on Windows named-pipe / loopback transports.
      ac.abort();
      await iterator.return?.(undefined).catch(() => {});
      // Swallow the cancellation that the still-pending firstEvent
      // promise will throw once abort propagates — we already have our
      // verdict from the race above.
      await firstEvent.catch(() => {});
    }

    if (raised !== null) {
      // The ONLY acceptable terminal error from this call is something
      // OTHER than Unimplemented. The pre-#290 regression manifests
      // exactly as Code.Unimplemented; a different code (e.g. Canceled
      // from teardown) is fine for the wire-up assertion.
      expect(
        raised.code,
        `WatchSessions returned Unimplemented — production wire-up regressed (audit #228 sub-task 1, message: ${raised.message})`,
      ).not.toBe(Code.Unimplemented);
    } else {
      // Stream stayed open until our timeout — proves the handler is
      // installed AND subscribed to the bus (an Unimplemented stub
      // would have terminated the stream within the first event-loop
      // turn, well before 250ms).
      expect(timedOut).toBe(true);
    }
  });
});
