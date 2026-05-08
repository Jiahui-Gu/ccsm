// s2-spoof-origin.spec.ts — Task #753 (S2 closeout D, split from #744).
//
// Acceptance: prove the daemon's `classifyOrigin` rules hold at the HTTP
// layer in chromium for three independent cases:
//
//   1. Spoof attacker subdomain
//        Origin: https://cc-sm.pages.dev.attacker.com
//        Expectation: 403 (suffix attack must NOT pass exact-match prod gate
//        and must NOT match `.cc-sm.pages.dev` since the env flag is OFF).
//
//   2. PR-preview default reject
//        Origin: https://abc123.cc-sm.pages.dev
//        Daemon spawned with default env (no CCSM_ALLOW_PAGES_PREVIEWS).
//        Expectation: 403.
//
//   3. PR-preview env opt-in
//        Origin: https://abc123.cc-sm.pages.dev
//        Daemon spawned with CCSM_ALLOW_PAGES_PREVIEWS=1.
//        Expectation: 200 + ACAO echoes the preview origin.
//
// Implementation notes:
//   - We deliberately use Playwright's `request` API (no Page) — these are
//     pure HTTP assertions on the daemon. A real browser cannot natively
//     send `Origin: https://abc123.cc-sm.pages.dev` from a chromium tab
//     loaded on some other origin (Origin is set by the UA), but the
//     `request.newContext({ extraHTTPHeaders })` API lets us drive the
//     wire-level header the daemon sees, which is exactly what the auth
//     layer is gating on.
//   - Cases 1+2 reuse the worker-scoped daemon (default env). Case 3 spawns
//     a SECOND daemon with the env flag set; we MUST NOT mutate the first
//     daemon's env mid-flight (and `pagesPreviewsEnabled()` reads
//     `process.env` from the daemon process, not ours, so even if we did
//     it would have no effect). Two real processes = real env-flag check.

import { expect } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';

import { test as daemonTest } from '../fixtures/daemon.ts';
import { startDaemon, stopDaemon, type DaemonHandle } from '../fixtures/daemon.ts';

const test = daemonTest;

test.describe('S2 spoof-origin reject (Task #753)', () => {
  test('Case 1 — spoof `cc-sm.pages.dev.attacker.com` subdomain → 403', async ({
    daemonUrl,
    token,
  }) => {
    const base = new URL(daemonUrl).origin;
    const ctx = await pwRequest.newContext();
    try {
      const resp = await ctx.get(`${base}/api/sessions`, {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://cc-sm.pages.dev.attacker.com',
        },
      });
      expect(
        resp.status(),
        'spoof suffix-attack origin must be rejected with 403',
      ).toBe(403);
      const body = (await resp.json()) as { error?: string };
      expect(body.error).toBe('forbidden_origin');
    } finally {
      await ctx.dispose();
    }
  });

  test('Case 2 — PR-preview `abc123.cc-sm.pages.dev` default reject → 403', async ({
    daemonUrl,
    token,
  }) => {
    const base = new URL(daemonUrl).origin;
    const ctx = await pwRequest.newContext();
    try {
      const resp = await ctx.get(`${base}/api/sessions`, {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'https://abc123.cc-sm.pages.dev',
        },
      });
      expect(
        resp.status(),
        'PR-preview origin must be rejected when CCSM_ALLOW_PAGES_PREVIEWS is unset',
      ).toBe(403);
      const body = (await resp.json()) as { error?: string };
      expect(body.error).toBe('forbidden_origin');
    } finally {
      await ctx.dispose();
    }
  });

  test('Case 3 — PR-preview `abc123.cc-sm.pages.dev` with env opt-in → 200', async () => {
    // Spawn a SECOND daemon with the env flag enabled. Cannot reuse the
    // worker daemon because its process env was fixed at spawn time.
    let optInDaemon: DaemonHandle | null = null;
    try {
      optInDaemon = await startDaemon({
        extraEnv: { CCSM_ALLOW_PAGES_PREVIEWS: '1' },
      });
      const base = new URL(optInDaemon.url).origin;
      const previewOrigin = 'https://abc123.cc-sm.pages.dev';

      const ctx = await pwRequest.newContext();
      try {
        const resp = await ctx.get(`${base}/api/sessions`, {
          headers: {
            authorization: `Bearer ${optInDaemon.token}`,
            origin: previewOrigin,
          },
        });
        expect(
          resp.status(),
          'PR-preview origin must be allowed when CCSM_ALLOW_PAGES_PREVIEWS=1',
        ).toBe(200);
        // ACAO must echo the cross-origin caller, not '*'.
        expect(resp.headers()['access-control-allow-origin']).toBe(previewOrigin);
        const body = (await resp.json()) as { sessions?: unknown };
        expect(Array.isArray(body.sessions)).toBe(true);
      } finally {
        await ctx.dispose();
      }
    } finally {
      if (optInDaemon) await stopDaemon(optInDaemon);
    }
  });
});
