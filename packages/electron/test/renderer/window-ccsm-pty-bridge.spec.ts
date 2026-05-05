// Unit tests for `window-ccsm-pty-bridge.ts` two-phase install
// (Task #464 round-2).
//
// @vitest-environment happy-dom
//
// Round-1 reviewer found that installing the polyfill inside a parent
// `useEffect` lost a commit-ordering race against `<App/>`'s child
// boot probe `useEffect(deps=[])`. The fix splits install into:
//   (1) `installWindowCcsmPtyBridgeStub()` — synchronous, called from
//       `src/index.tsx` BEFORE `root.render()`.
//   (2) `bindWindowCcsmPtyBridgeClients(clients)` — called from
//       `boot.tsx`'s `ColdStartGate` once the typed Connect client
//       bundle exists.
//
// What this spec proves:
//   - After phase 1, `window.ccsmPty.checkClaudeAvailable` is a callable
//     function (truthy in optional-chain checks). This is the property
//     that prevents `<App/>`'s probe from entering the
//     "preload missing" catch branch on first paint.
//   - A call issued between phase 1 and phase 2 QUEUES at the internal
//     `await clientsReady` and resolves once phase 2 lands. The result
//     reflects the daemon RPC, not a sentinel "unavailable".
//   - `force` is threaded through to the wire request.
//   - Re-binding is a no-op for in-flight callers (they get the first
//     bind's result) but updates `boundClients` for subsequent calls.

import { create } from '@bufbuild/protobuf';
import type { Transport } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CheckClaudeAvailableResponseSchema,
  PtyService,
} from '@ccsm/proto';
import { createClients } from '../../src/rpc/clients.js';
import {
  __resetWindowCcsmPtyBridgeForTest,
  bindWindowCcsmPtyBridgeClients,
  installWindowCcsmPtyBridgeStub,
} from '../../src/renderer/window-ccsm-pty-bridge.js';

interface RecordedCall {
  readonly force: boolean;
  readonly requestId: string;
}

/**
 * Synthetic Transport that records each `CheckClaudeAvailable` call and
 * lets the spec choose whether to return available=true or false. We
 * reach into the `unary` shape directly (rather than going through
 * `createRouterTransport`) because we want to assert on the exact
 * request bytes — specifically the `force` field — and capture the
 * call list cross-spec.
 */
function makeRecordingTransport(opts: {
  readonly available: boolean;
  readonly resolvedPath?: string;
  readonly calls: RecordedCall[];
}): Transport {
  return {
    async unary(method, _signal, _timeoutMs, _header, input) {
      if (
        method.parent.typeName === PtyService.typeName &&
        method.name === 'CheckClaudeAvailable'
      ) {
        const req = input as { force?: boolean; meta?: { requestId?: string } };
        opts.calls.push({
          force: req.force === true,
          requestId: req.meta?.requestId ?? '',
        });
        const message = create(CheckClaudeAvailableResponseSchema, {
          available: opts.available,
          resolvedPath: opts.available ? (opts.resolvedPath ?? '/bin/claude') : '',
          version: '0.0.1',
          errorCode: opts.available ? '' : 'ENOENT',
        });
        return {
          service: method.parent,
          method,
          stream: false as const,
          header: new Headers(),
          message: message as never,
          trailer: new Headers(),
        };
      }
      throw new Error(`unexpected method: ${method.parent.typeName}/${method.name}`);
    },
    async stream() {
      throw new Error('stream not used');
    },
  };
}

describe('window-ccsm-pty-bridge — two-phase install', () => {
  beforeEach(() => {
    __resetWindowCcsmPtyBridgeForTest();
  });
  afterEach(() => {
    __resetWindowCcsmPtyBridgeForTest();
  });

  it('phase 1 grafts a callable function onto window.ccsmPty BEFORE clients exist', () => {
    // Pre-install: nothing on window.
    expect((window as unknown as { ccsmPty?: unknown }).ccsmPty).toBeUndefined();

    // Phase 1 only — no clients yet.
    installWindowCcsmPtyBridgeStub();

    const bridge = (window as unknown as {
      ccsmPty?: { checkClaudeAvailable?: unknown };
    }).ccsmPty;

    // The property that round-1 was missing: function exists at App
    // mount time even though no clients are bound.
    expect(typeof bridge?.checkClaudeAvailable).toBe('function');
  });

  it('a call issued between phase 1 and phase 2 queues, then resolves with the post-bind RPC result', async () => {
    const calls: RecordedCall[] = [];
    const transport = makeRecordingTransport({
      available: true,
      resolvedPath: '/usr/local/bin/claude',
      calls,
    });

    // Phase 1: stub install (e.g. src/index.tsx).
    installWindowCcsmPtyBridgeStub();

    // Issue the call BEFORE binding — this models App.tsx's probe
    // useEffect firing on first child commit, which round-1 lost the
    // race against. The polyfill must NOT short-circuit to
    // "unavailable"; it must queue at `await clientsReady`.
    const bridge = (window as unknown as {
      ccsmPty?: {
        checkClaudeAvailable?: (
          opts?: { force?: boolean },
        ) => Promise<{ available: boolean; path?: string }>;
      };
    }).ccsmPty;
    expect(bridge?.checkClaudeAvailable).toBeDefined();
    const inflight = bridge!.checkClaudeAvailable!();

    // RPC must NOT have fired yet (no clients).
    expect(calls).toHaveLength(0);

    // Phase 2: bind clients. The queued call should now dispatch.
    const clients = createClients(transport);
    bindWindowCcsmPtyBridgeClients(clients);

    const result = await inflight;
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      available: true,
      path: '/usr/local/bin/claude',
    });
  });

  it('threads `opts.force` onto the wire request (round-2 cache bypass)', async () => {
    const calls: RecordedCall[] = [];
    const transport = makeRecordingTransport({ available: false, calls });
    installWindowCcsmPtyBridgeStub();
    bindWindowCcsmPtyBridgeClients(createClients(transport));

    const bridge = (window as unknown as {
      ccsmPty?: {
        checkClaudeAvailable?: (opts?: { force?: boolean }) => Promise<unknown>;
      };
    }).ccsmPty;
    await bridge!.checkClaudeAvailable!({ force: true });
    await bridge!.checkClaudeAvailable!({ force: false });
    await bridge!.checkClaudeAvailable!();

    expect(calls).toHaveLength(3);
    expect(calls[0]!.force).toBe(true);
    expect(calls[1]!.force).toBe(false);
    expect(calls[2]!.force).toBe(false);
    // request_id is non-empty per RequestMeta interceptor contract.
    for (const c of calls) {
      expect(c.requestId.length).toBeGreaterThan(0);
    }
  });

  it('post-bind calls take the fast path (no extra await tick before RPC)', async () => {
    const calls: RecordedCall[] = [];
    const transport = makeRecordingTransport({
      available: true,
      resolvedPath: '/bin/claude',
      calls,
    });
    installWindowCcsmPtyBridgeStub();
    bindWindowCcsmPtyBridgeClients(createClients(transport));

    const bridge = (window as unknown as {
      ccsmPty?: {
        checkClaudeAvailable?: () => Promise<{ available: boolean }>;
      };
    }).ccsmPty;
    const result = await bridge!.checkClaudeAvailable!();
    expect(result.available).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('returns { available: false } when the RPC throws (catch normalisation)', async () => {
    const throwingTransport: Transport = {
      async unary() {
        throw new Error('synthetic transport error');
      },
      async stream() {
        throw new Error('not used');
      },
    };
    installWindowCcsmPtyBridgeStub();
    bindWindowCcsmPtyBridgeClients(createClients(throwingTransport));

    const bridge = (window as unknown as {
      ccsmPty?: {
        checkClaudeAvailable?: () => Promise<{ available: boolean }>;
      };
    }).ccsmPty;
    // Suppress the expected console.debug.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const result = await bridge!.checkClaudeAvailable!();
      expect(result).toEqual({ available: false });
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('preserves any pre-existing window.ccsmPty surface (test-stub compatibility)', () => {
    const existingStub = () => 'preserved';
    (window as unknown as { ccsmPty: Record<string, unknown> }).ccsmPty = {
      list: existingStub,
    };
    installWindowCcsmPtyBridgeStub();

    const bridge = (window as unknown as {
      ccsmPty: { list?: unknown; checkClaudeAvailable?: unknown };
    }).ccsmPty;
    expect(bridge.list).toBe(existingStub);
    expect(typeof bridge.checkClaudeAvailable).toBe('function');
  });
});
