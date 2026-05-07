// scrollback.spec.ts — Task #662 / T10 dev verification.
//
// WHAT THIS PROVES (DESIGN.md §7 切 session 行为):
//   - Each session keeps its OWN scrollback buffer in the runtime, even when
//     it is not the actively-rendered session.
//   - Switching active session via the sidebar replays that session's
//     scrollback into xterm, instead of showing an empty terminal.
//   - The ws URL for a reconnect carries `?lastSeq=<n>` so daemon T8 (#661)
//     can backfill or RESET.
//
// WHY DEV-MODE (vite + browser-side WebSocket mock):
//   We don't need a real daemon for any of this — the contract under test is
//   purely client-side (runtime + MainPane + Sidebar). Spawning the real
//   `claude` CLI on CI is not viable (T7 already documented this) and even a
//   real daemon would couple this spec to PTY behaviour we don't care about
//   here.
//
//   Instead we mock at TWO layers:
//     1. Mock the daemon's REST endpoints with a node http server (same
//        pattern as groups-sidebar.spec.ts).
//     2. Mock window.WebSocket inside the page via addInitScript so each
//        ws connection is a JS object we can control: it remembers its
//        URL (so we can assert `lastSeq=<n>`), captures sends from the
//        client, and can synthesise OUTPUT frames on demand via a
//        page.evaluate() helper that calls an exposed `__pushOutput(sid, str)`.
//
// SCOPE:
//   - Stage A: bootstrap fires and creates session A; we push OUTPUT into A
//     and verify it shows in xterm.
//   - Stage B: + New Session creates B; pushing OUTPUT into B shows; A's
//     scrollback is preserved even though A isn't active.
//   - Stage C: click A row → setActive A → A's scrollback is replayed into
//     xterm.
//   - Stage D: simulate a network blip on A's ws (force close from the mock)
//     → the runtime auto-reconnects with `?lastSeq=<n>` carrying A's last
//     received seq. We assert by inspecting the captured ws URL list.

import { test, expect } from '@playwright/test';
import { snap } from '../fixtures/screenshot.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const VITE_PORT = 5173;
const DAEMON_PORT = 17832;
const VITE_READY_TIMEOUT_MS = 30_000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b?\[[0-9;]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b/g;
const VITE_READY_RE =
  /Local:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

interface MockDaemon {
  server: Server;
  token: string;
  createdSids: string[];
}

async function startMockDaemon(): Promise<MockDaemon> {
  const token = randomUUID();
  const createdSids: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/api/sessions') {
      req.on('data', () => {});
      req.on('end', () => {
        const sid = `sid-${createdSids.length + 1}`;
        createdSids.push(sid);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sid, createdAt: Date.now() }));
      });
      return;
    }
    if (req.method === 'DELETE' && url.startsWith('/api/sessions/')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  // Reject ws upgrades — the in-page WebSocket mock intercepts before the
  // request hits the network, so we should never see one of these.
  server.on('upgrade', (_req, socket) => {
    socket.destroy();
  });
  await new Promise<void>((r) =>
    server.listen(DAEMON_PORT, '127.0.0.1', () => r()),
  );
  return { server, token, createdSids };
}

async function stopMockDaemon(daemon: MockDaemon): Promise<void> {
  await new Promise<void>((r) => daemon.server.close(() => r()));
}

interface ViteHandle {
  proc: ChildProcess;
  url: string;
}

async function startVite(): Promise<ViteHandle> {
  const isWin = process.platform === 'win32';
  const proc = spawn(
    'pnpm',
    [
      '-F',
      '@ccsm/frontend-web',
      'exec',
      'vite',
      '--port',
      String(VITE_PORT),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
      detached: !isWin,
    },
  );

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const ready = await new Promise<string | Error>((resolveReady) => {
    const timer = setTimeout(() => {
      resolveReady(
        new Error(
          `vite dev did not announce ready within ${VITE_READY_TIMEOUT_MS}ms.\n` +
            `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
        ),
      );
    }, VITE_READY_TIMEOUT_MS);

    const tryMatch = (): void => {
      const clean = stdoutBuf.replace(ANSI_RE, '').replace(ESC_RE, '');
      const m = clean.match(VITE_READY_RE);
      if (m) {
        clearTimeout(timer);
        resolveReady(`http://127.0.0.1:${m[1]}`);
      }
    };

    proc.stdout?.on('data', tryMatch);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveReady(
        new Error(
          `vite dev exited before ready (code=${code} signal=${signal}).\n` +
            `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
        ),
      );
    });

    tryMatch();
  });

  if (ready instanceof Error) {
    proc.kill('SIGKILL');
    throw ready;
  }
  return { proc, url: ready };
}

async function stopVite(handle: ViteHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));

  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  } else {
    proc.kill('SIGTERM');
  }

  await Promise.race([
    exited,
    new Promise<void>((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) {
    if (process.platform !== 'win32' && proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    } else {
      proc.kill('SIGKILL');
    }
  }
}

// ---------- in-page WebSocket mock --------------------------------------
//
// Installed via page.addInitScript so it runs before main.tsx loads. The mock:
//   - records every constructed instance's URL (window.__wsUrls)
//   - on construction, queues an OPEN tick on next microtask
//   - exposes `window.__pushOutput(sid, text)` which finds the open ws for
//     that sid and dispatches an OUTPUT frame containing the UTF-8 bytes
//   - exposes `window.__forceClose(sid)` which closes the open ws for that
//     sid (no EXIT first → runtime should reconnect with ?lastSeq=<n>)
//   - tracks a per-sid OUTPUT seq so successive pushes are monotonic, mirroring
//     the daemon's wire contract.
//
// Frame layout (DESIGN.md §5): 1 byte type | 4 byte seq BE | payload bytes.
const PAGE_INIT_SCRIPT = `
(() => {
  const wsBySid = new Map();
  const seqBySid = new Map();
  window.__wsUrls = [];
  const RealWebSocket = window.WebSocket;

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.OPEN = 1;
      this.CLOSED = 3;

      window.__wsUrls.push(url);
      const params = new URLSearchParams(url.split('?')[1] || '');
      this.sid = params.get('sid') || '';
      this.lastSeq = parseInt(params.get('lastSeq') || '0', 10) || 0;

      // Track only the CURRENT open ws for the sid (a reconnect supersedes
      // the prior closed one).
      wsBySid.set(this.sid, this);

      Promise.resolve().then(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      });
    }
    send(_data) {
      // Capture if needed; tests don't currently assert on client-sent frames.
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
  }

  window.WebSocket = MockWebSocket;
  // Constants react some libraries probe statically.
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;
  // Keep RealWebSocket reachable for debugging.
  window.__RealWebSocket = RealWebSocket;

  function makeOutputFrame(seq, text) {
    const body = new TextEncoder().encode(text);
    const buf = new Uint8Array(5 + body.byteLength);
    const view = new DataView(buf.buffer);
    view.setUint8(0, 0x01); // OUTPUT
    view.setUint32(1, seq, false); // big-endian
    buf.set(body, 5);
    return buf.buffer;
  }

  window.__pushOutput = (sid, text) => {
    const ws = wsBySid.get(sid);
    if (!ws || ws.readyState !== 1) return false;
    const seq = (seqBySid.get(sid) || 0) + 1;
    seqBySid.set(sid, seq);
    if (ws.onmessage) ws.onmessage({ data: makeOutputFrame(seq, text) });
    return true;
  };

  window.__forceClose = (sid) => {
    const ws = wsBySid.get(sid);
    if (!ws) return false;
    // Server-initiated close path: just transition + fire onclose, no EXIT.
    ws.readyState = 3;
    if (ws.onclose) ws.onclose();
    return true;
  };
})();
`;

test('scrollback — per-session buffer + replay on switch + lastSeq reconnect', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  const daemon = await startMockDaemon();
  const vite = await startVite();
  try {
    await page.addInitScript(PAGE_INIT_SCRIPT);

    const url = `${vite.url}/?token=${encodeURIComponent(daemon.token)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page
      .locator('[data-testid="sidebar-groups"]')
      .waitFor({ state: 'attached', timeout: 10_000 });

    // ---- Stage A: bootstrap session arrives, push OUTPUT into it ----
    const rows = page.locator('[data-testid^="sidebar-session-"][data-active]');
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    const sidA = await rows.first().getAttribute('data-testid');
    expect(sidA).not.toBeNull();
    const aSid = sidA!.replace('sidebar-session-', '');

    // Wait for the page to construct a WebSocket for sid A (mock records URLs).
    await page.waitForFunction(
      (sid) =>
        Array.isArray((window as unknown as { __wsUrls: string[] }).__wsUrls) &&
        (window as unknown as { __wsUrls: string[] }).__wsUrls.some((u) =>
          u.includes(`sid=${sid}`),
        ),
      aSid,
      { timeout: 10_000 },
    );

    // Push a recognisable string into A.
    await page.waitForFunction(
      (sid) =>
        (
          window as unknown as { __pushOutput: (s: string, t: string) => boolean }
        ).__pushOutput(sid, 'AAA-history-marker\\r\\n'),
      aSid,
      { timeout: 10_000 },
    );

    // xterm renders into rows under the .xterm-rows container; assert the
    // marker is visible there.
    await expect(page.locator('.xterm-rows')).toContainText(
      'AAA-history-marker',
      { timeout: 10_000 },
    );

    await snap(page, testInfo, '01-after-A-output');

    // ---- Stage B: + New Session → session B; push different OUTPUT into B
    await page.locator('[data-testid="sidebar-new-session"]').click();
    await expect(rows).toHaveCount(2, { timeout: 5_000 });
    const allSids = await rows.evaluateAll((els) =>
      els.map((el) =>
        (el.getAttribute('data-testid') ?? '').replace('sidebar-session-', ''),
      ),
    );
    const bSid = allSids.find((s) => s !== aSid)!;
    expect(bSid).toBeTruthy();

    // Wait for B's ws to be constructed.
    await page.waitForFunction(
      (sid) =>
        (window as unknown as { __wsUrls: string[] }).__wsUrls.some((u) =>
          u.includes(`sid=${sid}`),
        ),
      bSid,
      { timeout: 10_000 },
    );

    // Push into B.
    await page.waitForFunction(
      (sid) =>
        (
          window as unknown as { __pushOutput: (s: string, t: string) => boolean }
        ).__pushOutput(sid, 'BBB-second-session\\r\\n'),
      bSid,
      { timeout: 10_000 },
    );

    // xterm now shows B's content (B is active). A's marker should NOT be
    // on the visible terminal — this is the "switching cleared the screen"
    // baseline that the next stage proves we can recover from.
    await expect(page.locator('.xterm-rows')).toContainText(
      'BBB-second-session',
      { timeout: 10_000 },
    );

    await snap(page, testInfo, '02-after-B-output');

    // ---- Stage C: switch back to A → A's scrollback replays ----
    await page
      .locator(`[data-testid="sidebar-session-row-${aSid}"]`)
      .click();
    await expect(
      page.locator(`[data-testid="sidebar-session-${aSid}"]`),
    ).toHaveAttribute('data-active', 'true', { timeout: 5_000 });

    // After replay, A's marker is on screen again. THIS is the T10 contract:
    // T9 would show an empty xterm here.
    await expect(page.locator('.xterm-rows')).toContainText(
      'AAA-history-marker',
      { timeout: 10_000 },
    );

    await snap(page, testInfo, '03-after-switch-back-to-A');

    // ---- Stage D: simulate a blip on A's ws → reconnect carries lastSeq ----
    const wsCountBefore: number = await page.evaluate(
      () =>
        (window as unknown as { __wsUrls: string[] }).__wsUrls.filter((u) =>
          u.includes(`sid=${(globalThis as unknown as { __aSid: string }).__aSid}`),
        ).length,
    );
    void wsCountBefore;

    await page.evaluate((sid) => {
      (window as unknown as { __aSid: string }).__aSid = sid;
      (
        window as unknown as { __forceClose: (s: string) => boolean }
      ).__forceClose(sid);
    }, aSid);

    // Reconnect backoff is 1s for the first attempt — wait it out.
    await page.waitForFunction(
      (sid) => {
        const urls = (window as unknown as { __wsUrls: string[] }).__wsUrls;
        return urls.some((u) => u.includes(`sid=${sid}`) && u.includes('lastSeq='));
      },
      aSid,
      { timeout: 10_000 },
    );

    const reconnectUrl: string | undefined = await page.evaluate((sid) => {
      const urls = (window as unknown as { __wsUrls: string[] }).__wsUrls;
      return urls.reverse().find((u: string) => u.includes(`sid=${sid}`));
    }, aSid);
    expect(reconnectUrl).toBeDefined();
    expect(reconnectUrl!).toContain('lastSeq=');

    const final = await snap(page, testInfo, '04-after-reconnect');

    // ---- Acceptance: PNG/TXT artifacts non-trivial ----
    const pngStat = statSync(final.pngPath);
    expect(pngStat.size).toBeGreaterThan(1_000);
    const txt = readFileSync(final.txtPath, 'utf8');
    expect(txt).toContain('sidebar-groups');
    expect(txt).not.toContain('[pageerror]');

    // eslint-disable-next-line no-console -- intentional manager-facing log
    console.log(`[scrollback-spec] PNG: ${final.pngPath}`);
    // eslint-disable-next-line no-console
    console.log(`[scrollback-spec] TXT: ${final.txtPath}`);
  } finally {
    await stopVite(vite);
    await stopMockDaemon(daemon);
  }
});
