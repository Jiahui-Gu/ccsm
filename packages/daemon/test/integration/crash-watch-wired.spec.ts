// packages/daemon/test/integration/crash-watch-wired.spec.ts
//
// Wave-3 Task #335 — production daemon-startup wire-up regression for
// CrashService.WatchCrashLog.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task 4b of #228).
//
// Background:
//   - `makeWatchCrashLogHandler` (#335 / this PR) consumes the
//     `defaultCrashEventBus` singleton (Task #340) that
//     `crash/raw-appender.ts:appendCrashRaw` already emits on after fsync.
//   - Until #335, `packages/daemon/src/index.ts` constructed `crashDeps`
//     with `{ getCrashLogDeps: { db } }` only, so
//     `rpc/crash/register.ts:registerCrashService` installed a partial
//     `{ getCrashLog }` impl and `WatchCrashLog` resolved to the T2.2
//     `Unimplemented` stub at boot — the exact "library shipped but
//     never wired" regression class Wave 0/1 + Task #221 exist to catch.
//   - This spec boots the production `runStartup` (no mocks, no harness
//     bypass) and asserts the over-the-wire response to a
//     `WatchCrashLog(OWN)` call is NOT `Code.Unimplemented`. Reverse
//     verification: removing the `watchCrashLogDeps` line from
//     `index.ts`'s `crashDeps` flips this spec to expect-Unimplemented
//     and it fails.
//
// Why a separate spec from `daemon-boot-end-to-end.spec.ts`:
//   - The audit lists each stubbed method as its own wire-up gap (one
//     PR per concern, per dev.md §1 wave-ordering discipline). One spec
//     per gap mirrors the precedent set by `watch-sessions-wired.spec.ts`
//     (#290) and `crash-getlog-wired.spec.ts` (#229). The boot-end-to-end
//     spec stays the cross-cutting "every component wired" assertion via
//     `result.wired`.
//
// Why not extend `crash-stream.spec.ts` instead:
//   - That file's `setup` overrides the CrashService at the harness
//     level with an INLINE stub handler around an in-test `CrashEventBus`
//     stand-in — by design, to test the wire-shape contract independently
//     of the production handler. This file is the complementary
//     "production handler is actually bound at boot" assertion; one
//     verifies the contract, the other verifies the wiring.
//
// Transport choice:
//   - Identical to daemon-boot-end-to-end.spec.ts and
//     watch-sessions-wired.spec.ts / crash-getlog-wired.spec.ts:
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
  CrashService,
  OwnerFilter,
  RequestMetaSchema,
  WatchCrashLogRequestSchema,
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
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ccsm-crash-watch-wired-'));
  process.env.CCSM_STATE_DIR = tmpRoot;
  process.env.CCSM_DESCRIPTOR_PATH = join(tmpRoot, 'listener-a.json');
  process.env.CCSM_LISTENER_A_ADDR = join(tmpRoot, 'daemon.sock');
  process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
  if (process.platform === 'win32') {
    process.env.PROGRAMDATA = tmpRoot;
  }
  process.env.CCSM_SUPERVISOR_ADDR =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ccsm-crash-watch-wired-${process.pid}-${Date.now()}`
      : join(tmpRoot, 'supervisor.sock');
  process.env.CCSM_VERSION = '0.3.0-crash-watch-wired-test';
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

function newWatchRequest(filter: OwnerFilter) {
  return create(WatchCrashLogRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: `wired-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      clientVersion: '0.3.0-crash-watch-wired-test',
      clientSendUnixMs: BigInt(Date.now()),
    }),
    ownerFilter: filter,
  });
}

describe('CrashService.WatchCrashLog production wire-up (Task #335)', () => {
  let setup: BootEnv;
  let lifecycle: Lifecycle;
  let result: RunStartupResult | null = null;

  beforeEach(async () => {
    setup = await setupBootEnv();
    lifecycle = new Lifecycle();
    result = await runStartup(lifecycle);
  });

  // Win32 named-pipe supervisor.stop() can take >10s on a busy host (the
  // default vitest hook timeout); the existing `daemon-boot-end-to-end` /
  // `watch-sessions-wired` specs hit the same shape on slow hosts. Bump
  // both hooks to 30s so the streaming-RPC teardown path (abort →
  // server-side stream close → listener stop → supervisor stop) has
  // headroom even when other vitest workers are competing for I/O.
  afterEach(async () => {
    await stopBoot(result);
    result = null;
    await teardownBootEnv(setup);
  }, 30_000);

  it('WatchCrashLog(OWN) over the production Listener A does NOT return Code.Unimplemented', async () => {
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
    // Same teardown discipline as `watch-sessions-wired.spec.ts`.
    const ac = new AbortController();
    const client = makeCrashClient(baseUrl);
    const stream = client.watchCrashLog(newWatchRequest(OwnerFilter.OWN), {
      signal: ac.signal,
    });

    // The handler is server-streaming with no events queued — when
    // wired, the iterator stays open waiting for the first event from
    // the bus. When NOT wired (the pre-#335 regression), the Connect
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
      ac.abort();
      await iterator.return?.(undefined).catch(() => {});
      await firstEvent.catch(() => {});
    }

    if (raised !== null) {
      expect(
        raised.code,
        `WatchCrashLog returned Unimplemented — production wire-up regressed (audit #228 sub-task 4b, message: ${raised.message})`,
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
