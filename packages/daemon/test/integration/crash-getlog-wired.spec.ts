// packages/daemon/test/integration/crash-getlog-wired.spec.ts
//
// Wave-3 Task #229 — production daemon-startup wire-up regression for
// CrashService.GetCrashLog.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #2 of #228).
//
// Background:
//   - `makeGetCrashLogHandler` (#229) reads from the `crash_log` SQLite
//     table that boot already populates via `replayCrashRawOnBoot`.
//   - Until #229, `packages/daemon/src/index.ts` constructed
//     `makeRouterBindHook({ helloDeps, watchSessionsDeps })` WITHOUT
//     a `crashDeps` argument, so `rpc/router.ts:makeDaemonRoutes` never
//     called `registerCrashService` and `CrashService.GetCrashLog`
//     resolved to the T2.2 `Unimplemented` stub at boot — the exact
//     "library shipped but never wired" regression class Wave 0/1 +
//     Task #221 exist to catch.
//   - This spec boots the production `runStartup` (no mocks, no harness
//     bypass) and asserts the over-the-wire response to a
//     `GetCrashLog(OWN)` call is NOT `Code.Unimplemented`. Reverse
//     verification: deleting the `crashDeps` line from `index.ts`
//     flips this spec to expect-Unimplemented and it fails.
//
// Why a separate spec from `daemon-boot-end-to-end.spec.ts`:
//   - The audit lists CrashService.GetCrashLog as one of FOUR
//     independent stubs that each need their own wire-up + regression
//     test (CrashService.GetCrashLog, GetRawCrashLog, WatchCrashLog,
//     and the WatchSessions gap that #290 closed). One spec per gap
//     keeps each PR single-concern and matches the precedent set by
//     `watch-sessions-wired.spec.ts` (#290).
//
// Transport choice:
//   - Identical to daemon-boot-end-to-end.spec.ts and
//     watch-sessions-wired.spec.ts: `CCSM_LISTENER_A_FORCE_LOOPBACK=1`
//     keeps Listener A on the cross-OS h2c loopback transport so this
//     spec runs on every CI leg without UDS / named-pipe gating.

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
  GetCrashLogRequestSchema,
  OwnerFilter,
  RequestMetaSchema,
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
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ccsm-crash-getlog-wired-'));
  process.env.CCSM_STATE_DIR = tmpRoot;
  process.env.CCSM_DESCRIPTOR_PATH = join(tmpRoot, 'listener-a.json');
  process.env.CCSM_LISTENER_A_ADDR = join(tmpRoot, 'daemon.sock');
  process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
  if (process.platform === 'win32') {
    process.env.PROGRAMDATA = tmpRoot;
  }
  process.env.CCSM_SUPERVISOR_ADDR =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ccsm-crash-getlog-wired-${process.pid}-${Date.now()}`
      : join(tmpRoot, 'supervisor.sock');
  process.env.CCSM_VERSION = '0.3.0-crash-getlog-wired-test';
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

function newGetRequest() {
  return create(GetCrashLogRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: `wired-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      clientVersion: '0.3.0-crash-getlog-wired-test',
      clientSendUnixMs: BigInt(Date.now()),
    }),
    limit: 10,
    sinceUnixMs: BigInt(0),
    ownerFilter: OwnerFilter.OWN,
  });
}

describe('CrashService.GetCrashLog production wire-up (Task #229)', () => {
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

  it('GetCrashLog over the production Listener A does NOT return Code.Unimplemented', async () => {
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.listenerA).not.toBeNull();
    const desc = r.listenerA!.descriptor();
    expect(desc.kind).toBe('KIND_TCP_LOOPBACK_H2C');
    if (desc.kind !== 'KIND_TCP_LOOPBACK_H2C') return;
    const baseUrl = `http://127.0.0.1:${desc.port}`;

    const client = makeCrashClient(baseUrl);

    let raised: ConnectError | null = null;
    let entriesLength: number | null = null;
    try {
      const resp = await client.getCrashLog(newGetRequest());
      // Wired path: handler executed, returned a (possibly empty)
      // GetCrashLogResponse. The crash_log table on a fresh boot may
      // or may not have rows depending on whether crash-replay
      // ingested anything (test boot environments without a writable
      // per-OS state dir take the `fileMissing` branch — empty page).
      // Either way, an `entries` array means we got past Unimplemented.
      entriesLength = resp.entries.length;
    } catch (err) {
      raised = ConnectError.from(err);
    }

    if (raised !== null) {
      // The pre-#229 regression manifests EXACTLY as Code.Unimplemented;
      // anything else (e.g. Internal from a malformed env, Unauthenticated
      // from a missing token) is out of scope for this wire-up assertion
      // but still indicates the overlay was reached.
      expect(
        raised.code,
        `GetCrashLog returned Unimplemented — production wire-up regressed (audit #228 sub-task 2, message: ${raised.message})`,
      ).not.toBe(Code.Unimplemented);
    } else {
      // Stream-less unary RPC — handler ran to completion. `entries`
      // is a repeated field so `length` is always defined; an empty
      // array (no rows yet) is a valid wired response.
      expect(entriesLength).not.toBeNull();
      expect(entriesLength).toBeGreaterThanOrEqual(0);
    }
  });

  it('runStartup reports `crash-rpc` in `result.wired`', () => {
    // Pins the `runStartup.lock.ts` REQUIRED_COMPONENTS contract: a
    // future regression that drops the `crashDeps` pass-through in
    // `index.ts` would make `assertWired` throw at boot AND this
    // assertion fail.
    expect(result).not.toBeNull();
    expect(result!.wired).toContain('crash-rpc');
  });
});
