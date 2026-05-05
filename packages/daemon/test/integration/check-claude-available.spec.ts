// packages/daemon/test/integration/check-claude-available.spec.ts
//
// Task #464 ship-gate: PtyService.CheckClaudeAvailable end-to-end against
// the in-process Connect harness. Three legs:
//
//   1. claude binary present (resolver returns a path) → response carries
//      `available=true`, `resolved_path` mirrors the resolver, no error
//      code.
//   2. claude binary absent (resolver returns null) → response carries
//      `available=false`, empty `resolved_path`, `error_code=ENOENT`.
//   3. daemon "restart" path: production wiring binds `() =>
//      resolveClaude({force: true})` so EVERY RPC re-probes the OS,
//      bypassing the per-process cache in `claudeResolver.ts`. We model
//      a daemon restart by flipping the injected resolver's return value
//      between two calls on the same harness; the handler MUST observe
//      the post-flip truth (a stale cached `null` would be the #464 bug
//      we are closing). The cache primitive itself has unit coverage in
//      `ptyHost/__tests__/claudeResolver.spec.ts` ("force:true bypasses
//      the cache" + "__resetClaudeResolverForTest clears the cache");
//      this leg locks in that the WIRING through the handler honors that
//      contract, not that the cache works in isolation.
//
// Why an integration spec (not a UT against `decideClaudeAvailability`):
//   the decider is already small and pure; the load-bearing surface for
//   this ship-gate is the wire path (renderer → Connect → handler →
//   resolver). The UI bug we are closing (#464) showed up because the
//   handler stayed `Code.Unimplemented` even when the decider would have
//   answered correctly — only an end-to-end spec catches that regression.
//
// Spec ref: pty.proto §F6 (forever-stable response shape) +
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch08 §6.1
// (renderer's ClaudeMissingGuide consumes the wire result).

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PtyService,
  CheckClaudeAvailableRequestSchema,
} from '@ccsm/proto';
import { create } from '@bufbuild/protobuf';

import { registerPtyService } from '../../src/rpc/router.js';
import { newRequestMeta, startHarness, type Harness } from './harness.js';

// Stand-in PtyAttachDeps — registerPtyService requires the Attach overlay
// shape, but no test in this file invokes Attach/AckPty. The structural
// emitter port returns undefined for every session id, which would only
// matter if a wire call exercised attach/ackPty (it does not).
const NO_OP_ATTACH_DEPS = {
  getEmitter: () => undefined,
};

describe('PtyService.CheckClaudeAvailable — wire integration (#464 ship-gate)', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.stop();
      harness = null;
    }
    vi.restoreAllMocks();
  });

  it('returns available=true with the resolved path when the resolver finds claude', async () => {
    const fakePath = '/fake/usr/local/bin/claude';
    const resolveClaudeFake = vi.fn(() => fakePath);

    harness = await startHarness({
      setup: (router) => {
        registerPtyService(router, {
          ...NO_OP_ATTACH_DEPS,
          checkClaudeAvailableDeps: { resolveClaude: resolveClaudeFake },
        });
      },
    });

    const client = harness.makeClient(PtyService);
    const reply = await client.checkClaudeAvailable(
      create(CheckClaudeAvailableRequestSchema, { meta: newRequestMeta() }),
    );

    expect(reply.available).toBe(true);
    expect(reply.resolvedPath).toBe(fakePath);
    expect(reply.errorCode).toBe('');
    // version is best-effort; v0.3 wires empty (see decider commentary).
    expect(reply.version).toBe('');
    expect(resolveClaudeFake).toHaveBeenCalledTimes(1);
  });

  it('returns available=false with ENOENT when the resolver returns null', async () => {
    const resolveClaudeFake = vi.fn(() => null);

    harness = await startHarness({
      setup: (router) => {
        registerPtyService(router, {
          ...NO_OP_ATTACH_DEPS,
          checkClaudeAvailableDeps: { resolveClaude: resolveClaudeFake },
        });
      },
    });

    const client = harness.makeClient(PtyService);
    const reply = await client.checkClaudeAvailable(
      create(CheckClaudeAvailableRequestSchema, { meta: newRequestMeta() }),
    );

    expect(reply.available).toBe(false);
    expect(reply.resolvedPath).toBe('');
    expect(reply.errorCode).toBe('ENOENT');
  });

  it(
    'binds an injected resolver and observes its post-flip truth on every RPC (cache-bypass wiring)',
    async () => {
      // Production wiring binds `() => resolveClaude({force: true})`,
      // i.e. each handler invocation is a fresh probe. This leg models a
      // daemon "restart" (or a user installing claude in another
      // terminal between probes) by flipping the injected resolver's
      // return value between two RPCs on the same harness. If the
      // handler ever cached the first result, the second response would
      // still claim available=true — the #464 regression we are
      // preventing.
      const fakePath =
        process.platform === 'win32'
          ? 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'
          : '/usr/local/bin/claude';
      let installed = true;
      const resolveClaudeFake = vi.fn(() => (installed ? fakePath : null));

      harness = await startHarness({
        setup: (router) => {
          registerPtyService(router, {
            ...NO_OP_ATTACH_DEPS,
            checkClaudeAvailableDeps: { resolveClaude: resolveClaudeFake },
          });
        },
      });

      const client = harness.makeClient(PtyService);

      // Boot 1 — claude installed.
      const reply1 = await client.checkClaudeAvailable(
        create(CheckClaudeAvailableRequestSchema, { meta: newRequestMeta() }),
      );
      expect(reply1.available).toBe(true);
      expect(reply1.resolvedPath).toBe(fakePath);

      // Model "user uninstalled claude" / "daemon restarted with cleared
      // cache" between probes by flipping the resolver result.
      installed = false;

      // Boot 2 — claude gone. The handler MUST re-probe (per-call
      // wiring), not return the cached truth from boot 1.
      const reply2 = await client.checkClaudeAvailable(
        create(CheckClaudeAvailableRequestSchema, { meta: newRequestMeta() }),
      );
      expect(reply2.available).toBe(false);
      expect(reply2.errorCode).toBe('ENOENT');

      // Sanity: the resolver was actually invoked twice — once per RPC.
      expect(resolveClaudeFake).toHaveBeenCalledTimes(2);
    },
  );
});
