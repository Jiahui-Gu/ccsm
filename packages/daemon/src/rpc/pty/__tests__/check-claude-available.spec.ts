// Unit tests for `rpc/pty/check-claude-available.ts` (Task #464).
//
// Two test surfaces:
//   - Pure decider — `decideCheckClaudeAvailable(ctx)` against inline
//     fakes for the `resolveClaude` and `runVersion` seams. The real
//     `claudeResolver.ts` is covered separately in
//     `ptyHost/__tests__/claudeResolver.spec.ts`.
//   - Connect handler — wired through `createRouterTransport` so the
//     return type unwraps into the proto message shape (calling the
//     handler factory output directly hits the `MessageInit | Promise`
//     ServiceImpl signature, which obscures field access in TS).

import { describe, it, expect, vi } from 'vitest';
import { createClient, createRouterTransport } from '@connectrpc/connect';
import { PtyService } from '@ccsm/proto';
import {
  decideCheckClaudeAvailable,
  defaultRunVersion,
  makeCheckClaudeAvailableHandler,
  VERSION_PROBE_TIMEOUT_MS,
} from '../check-claude-available.js';

describe('decideCheckClaudeAvailable', () => {
  it('returns available=false + ENOENT when resolveClaude returns null', () => {
    const verdict = decideCheckClaudeAvailable({
      resolve: () => null,
      runVersion: () => 'never-called',
    });
    expect(verdict).toEqual({
      available: false,
      resolvedPath: '',
      version: '',
      errorCode: 'ENOENT',
    });
  });

  it('returns available=true + path + parsed version when resolver succeeds', () => {
    const verdict = decideCheckClaudeAvailable({
      resolve: () => '/usr/local/bin/claude',
      runVersion: () => '0.4.2 (Claude Code)',
    });
    expect(verdict).toEqual({
      available: true,
      resolvedPath: '/usr/local/bin/claude',
      version: '0.4.2 (Claude Code)',
      errorCode: '',
    });
  });

  it('returns available=true + empty version when version probe fails', () => {
    // The user has claude installed but `--version` is wedged / parser
    // failed. Per file header: do NOT lock the user out — they get into
    // the main UI; they just don't see version chrome.
    const verdict = decideCheckClaudeAvailable({
      resolve: () => '/usr/local/bin/claude',
      runVersion: () => null,
    });
    expect(verdict).toEqual({
      available: true,
      resolvedPath: '/usr/local/bin/claude',
      version: '',
      errorCode: '',
    });
  });

  it('does NOT call runVersion when the resolver returned null', () => {
    const runVersion = vi.fn(() => '0.0.0');
    decideCheckClaudeAvailable({
      resolve: () => null,
      runVersion,
    });
    expect(runVersion).not.toHaveBeenCalled();
  });
});

describe('makeCheckClaudeAvailableHandler — through router transport', () => {
  function makeBoundTransport(deps: Parameters<typeof makeCheckClaudeAvailableHandler>[0]) {
    return createRouterTransport((router) => {
      router.service(PtyService, {
        checkClaudeAvailable: makeCheckClaudeAvailableHandler(deps),
      });
    });
  }

  it('echoes the request_id back on the response meta', async () => {
    const transport = makeBoundTransport({
      resolveClaude: () => '/bin/claude',
      runVersion: () => '0.0.1',
    });
    const client = createClient(PtyService, transport);
    const res = await client.checkClaudeAvailable({
      meta: {
        requestId: 'rid-abc',
        clientVersion: 'test/0.0.0',
        clientSendUnixMs: 0n,
      },
    });
    expect(res.meta?.requestId).toBe('rid-abc');
  });

  it('encodes available=false branch into the proto response', async () => {
    const transport = makeBoundTransport({
      resolveClaude: () => null,
      runVersion: () => 'irrelevant',
    });
    const client = createClient(PtyService, transport);
    const res = await client.checkClaudeAvailable({
      meta: { requestId: 'rid-1', clientVersion: 't', clientSendUnixMs: 0n },
    });
    expect(res.available).toBe(false);
    expect(res.resolvedPath).toBe('');
    expect(res.version).toBe('');
    expect(res.errorCode).toBe('ENOENT');
  });

  it('encodes available=true branch with path + version', async () => {
    const transport = makeBoundTransport({
      resolveClaude: () => 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
      runVersion: () => '0.4.2',
    });
    const client = createClient(PtyService, transport);
    const res = await client.checkClaudeAvailable({
      meta: { requestId: 'rid-2', clientVersion: 't', clientSendUnixMs: 0n },
    });
    expect(res.available).toBe(true);
    expect(res.resolvedPath).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
    );
    expect(res.version).toBe('0.4.2');
    expect(res.errorCode).toBe('');
  });

  it('uses production defaults when deps are omitted (smoke)', async () => {
    // We don't mock `node:child_process` here — we just verify the
    // handler is constructable / callable without throwing when no deps
    // are supplied. Whether claude is on the test machine's PATH is
    // irrelevant; both branches (`available: true|false`) are valid
    // outputs from this call path.
    const transport = createRouterTransport((router) => {
      router.service(PtyService, {
        checkClaudeAvailable: makeCheckClaudeAvailableHandler(),
      });
    });
    const client = createClient(PtyService, transport);
    const res = await client.checkClaudeAvailable({
      meta: { requestId: 'rid-smoke', clientVersion: 't', clientSendUnixMs: 0n },
    });
    expect(typeof res.available).toBe('boolean');
    expect(res.meta?.requestId).toBe('rid-smoke');
  });
});

describe('VERSION_PROBE_TIMEOUT_MS', () => {
  it('is a positive number sized for a worst-case slow disk (~5s)', () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VERSION_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('defaultRunVersion', () => {
  it('returns null when invoked against a non-existent binary', () => {
    // ENOENT path — spawnSync throws or returns nonzero status. Either
    // outcome maps to `null` (the decider then yields version='').
    const r = defaultRunVersion(
      '/this/path/definitely/does/not/exist/claude',
    );
    expect(r).toBeNull();
  });
});
