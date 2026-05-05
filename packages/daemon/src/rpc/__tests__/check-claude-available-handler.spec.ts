// Unit tests for `PtyService.CheckClaudeAvailable` Connect handler —
// Task #543 / STEP-3.3a / spec
// docs/superpowers/specs/2026-05-05-v03-test-shells.md §2.3.
//
// Verbatim shell names (DO NOT rename — reviewer greps these literals):
//   - 'returns available=true with version when claude on PATH'
//   - 'returns available=false with reason when binary missing'
//   - 'returns available=false with reason when version probe times out'

import { create } from '@bufbuild/protobuf';
import {
  createClient,
  createRouterTransport,
} from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';

import {
  CheckClaudeAvailableRequestSchema,
  PtyService,
  RequestMetaSchema,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../../auth/index.js';

import {
  makeCheckClaudeAvailableHandler,
  type CheckClaudeAvailableDeps,
  type ClaudeBinaryResolver,
  type ClaudeVersionProbe,
} from '../check-claude-available.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE: AuthPrincipal = {
  kind: 'local-user',
  uid: '1000',
  displayName: 'alice',
};

function newMeta() {
  return create(RequestMetaSchema, {
    requestId: '11111111-2222-3333-4444-555555555555',
  });
}

function makeBoundTransport(
  deps: CheckClaudeAvailableDeps,
  principal: AuthPrincipal | null = ALICE,
) {
  return createRouterTransport(
    (router) => {
      router.service(PtyService, {
        checkClaudeAvailable: makeCheckClaudeAvailableHandler(deps),
      });
    },
    {
      router: {
        interceptors: [
          (next) => async (req) => {
            req.contextValues.set(PRINCIPAL_KEY, principal);
            return next(req);
          },
        ],
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PtyService.CheckClaudeAvailable handler', () => {
  it('returns available=true with version when claude on PATH', async () => {
    const resolver: ClaudeBinaryResolver = async () => ({
      kind: 'found',
      path: '/usr/local/bin/claude',
    });
    const versionProbe: ClaudeVersionProbe = async (path) => {
      // Probe MUST be invoked with the resolved path. Capturing it
      // here proves the resolver -> versionProbe seam is wired.
      expect(path).toBe('/usr/local/bin/claude');
      return { kind: 'ok', version: 'claude 1.2.3' };
    };
    const deps: CheckClaudeAvailableDeps = {
      resolver,
      versionProbe,
      versionProbeTimeoutMs: 100,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    const res = await client.checkClaudeAvailable(
      create(CheckClaudeAvailableRequestSchema, { meta: newMeta() }),
    );

    expect(res.available).toBe(true);
    expect(res.resolvedPath).toBe('/usr/local/bin/claude');
    expect(res.version).toBe('claude 1.2.3');
    expect(res.errorCode).toBe('');
  });

  it('returns available=false with reason when binary missing', async () => {
    const resolver: ClaudeBinaryResolver = async () => ({
      kind: 'missing',
      errorCode: 'ENOENT',
    });
    let probeCalled = false;
    const versionProbe: ClaudeVersionProbe = async () => {
      probeCalled = true;
      return { kind: 'ok', version: 'should-not-reach' };
    };
    const deps: CheckClaudeAvailableDeps = {
      resolver,
      versionProbe,
      versionProbeTimeoutMs: 100,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    const res = await client.checkClaudeAvailable(
      create(CheckClaudeAvailableRequestSchema, { meta: newMeta() }),
    );

    expect(res.available).toBe(false);
    expect(res.resolvedPath).toBe('');
    expect(res.version).toBe('');
    // Wire the resolver outcome's errno mnemonic through to the proto
    // `error_code` field per spec ch04 §6 ("ENOENT" / "EACCES" / "").
    expect(res.errorCode).toBe('ENOENT');
    // Version probe MUST NOT run when the resolver fails — saves a
    // pointless spawn AND avoids a confusing "claude --version on a
    // path that does not exist" error in the daemon log.
    expect(probeCalled).toBe(false);
  });

  it('returns available=false with reason when version probe times out', async () => {
    const resolver: ClaudeBinaryResolver = async () => ({
      kind: 'found',
      path: '/usr/local/bin/claude',
    });
    // The probe returns 'timeout' verbatim — exercises the handler's
    // mapping (probe.kind === 'timeout' -> available=false,
    // error_code='ETIMEDOUT'). The full "AbortSignal fires after Nms"
    // dance is the responsibility of `defaultVersionProbe` (covered
    // in its own integration test, STEP-3.3b — Task #543 spec note);
    // this UT pins the handler-side decision.
    const versionProbe: ClaudeVersionProbe = async () => ({ kind: 'timeout' });
    const deps: CheckClaudeAvailableDeps = {
      resolver,
      versionProbe,
      versionProbeTimeoutMs: 100,
    };
    const transport = makeBoundTransport(deps);
    const client = createClient(PtyService, transport);

    const res = await client.checkClaudeAvailable(
      create(CheckClaudeAvailableRequestSchema, { meta: newMeta() }),
    );

    expect(res.available).toBe(false);
    // resolvedPath is preserved so the renderer can render "found at
    // <path> but not runnable" diagnostics. The proto field is
    // `resolved_path` regardless of the runnability.
    expect(res.resolvedPath).toBe('/usr/local/bin/claude');
    expect(res.version).toBe('');
    expect(res.errorCode).toBe('ETIMEDOUT');
  });
});
