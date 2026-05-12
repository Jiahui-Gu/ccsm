/**
 * S4-T9 (Task #135): cross-user isolation cloud-e2e spec.
 *
 * Sibling to `two-tab-pairing.spec.ts`. Where that spec verifies "one user,
 * two tabs each get their own PTY" against the deployed ccsm-worker.jiahuigu.workers.dev SPA,
 * this spec verifies the per-user TunnelDO routing introduced by S4-T5 (the
 * `CCSM_AUTH_MODE=jwt` switch that derives DO id from the JWT subject):
 *
 *   - alice's daemon ws and alice's browser ws land in `user:gh-1` DO.
 *   - bob's daemon ws and bob's browser ws land in `user:gh-2` DO.
 *   - frames flowing through alice's DO must NEVER appear at bob's browser
 *     (and vice versa) — cross-user data leakage is the whole class of bug
 *     S4 was opened to prevent.
 *   - alice's *own* two browser tabs sharing one alice daemon still pair on
 *     distinct sids (R-41 sid envelope; regression guard so the per-user
 *     routing change doesn't accidentally break wave-2 multi-tab support).
 *
 * Why raw WebSocket clients (no Playwright browser, no real daemon process,
 * no SPA boot)?
 *   - The intent is to verify the **wire-level routing** decision the
 *     cf-worker + TunnelDO pair makes when given two different JWT subjects.
 *     Any Playwright/SPA layer on top would couple the test to OAuth + UI
 *     state and re-cover ground T5 (vitest) and T7/T8 already own.
 *   - Two raw `WebSocket` clients (one impersonating each daemon) plus two
 *     more (one impersonating each browser) is the smallest possible
 *     fixture that exercises the full per-user DO path through wrangler dev
 *     (workerd) — i.e. **production-shape DO**, not vitest stubs.
 *   - Skipping the SPA also means we don't depend on the
 *     frontend-web ↔ Pages Function ↔ Worker service binding plumbing that
 *     `reference_local_e2e_full_stack.md` documents, so this spec runs with
 *     just `wrangler dev --port 8787` (no Pages dev required).
 *
 * Required env (set by the harness operator before `pnpm test`):
 *   CCSM_CLOUD_WS_BASE       — ws origin of the running wrangler dev,
 *                              e.g. ws://127.0.0.1:8787 (REQUIRED).
 *   JWT_SIGNING_KEY          — hex HS256 key, must match the worker's
 *                              `.dev.vars` JWT_SIGNING_KEY exactly
 *                              (REQUIRED).
 *   JWT_REFRESH_SIGNING_KEY  — hex HS256 key for tunnel JWTs, must match
 *                              `.dev.vars` JWT_REFRESH_SIGNING_KEY (REQUIRED).
 *
 * The worker MUST be running with `CCSM_AUTH_MODE=jwt` (default in
 * wrangler.toml is `legacy`); start it with either
 *   `wrangler dev --port 8787 --var CCSM_AUTH_MODE:jwt`
 * or by editing wrangler.toml `[vars]` locally (don't commit the edit).
 *
 * Skipping: the test auto-skips when the env vars above are absent, so
 * `pnpm test` against deployed ccsm-worker.jiahuigu.workers.dev (the existing two-tab spec's
 * default) still runs without manual configuration. CI must set these env
 * vars when it wants the cross-user gate.
 */
import { test, expect } from '@playwright/test';
import { signWebJwt, signTunnelJwt } from '../fixtures/jwt-sign';

/**
 * Encode a sid envelope matching `tunnel-do.ts:encodeSidEnvelope`. Daemon
 * sends `[sidLen u8][sid utf8][payload bytes]`; the DO strips the envelope
 * and routes the payload to the browser ws tagged `browser-sid:<sid>`.
 */
function encodeSidEnvelope(sid: string, payload: Uint8Array): Uint8Array {
  const sidBytes = new TextEncoder().encode(sid);
  if (sidBytes.length === 0 || sidBytes.length > 64) {
    throw new Error('encodeSidEnvelope: bad sid length ' + sidBytes.length);
  }
  const out = new Uint8Array(1 + sidBytes.length + payload.byteLength);
  out[0] = sidBytes.length;
  out.set(sidBytes, 1);
  out.set(payload, 1 + sidBytes.length);
  return out;
}

interface HelloFrame {
  token: string;
  sid: string;
  identity?: { login: string; user_id: string };
}

interface DaemonHandle {
  ws: WebSocket;
  /** Hello frames received in arrival order. waitForHello shifts from this queue. */
  helloFrames: HelloFrame[];
  /** Resolved when the next hello arrives (returns the full hello incl. identity). */
  waitForHello: (timeoutMs?: number) => Promise<HelloFrame>;
  close: () => void;
}

interface BrowserHandle {
  ws: WebSocket;
  /** Binary payloads received from the daemon (envelope already stripped by DO). */
  received: Array<Uint8Array>;
  /** Text frames received (hello echoes / control). */
  receivedText: string[];
  close: () => void;
}

const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_FRAME_TIMEOUT_MS = 5_000;

function waitOpen(ws: WebSocket, timeoutMs = DEFAULT_OPEN_TIMEOUT_MS): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('ws open timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      const msg = (ev as unknown as { message?: string }).message ?? 'ws error';
      reject(new Error('ws error before open: ' + msg));
    }, { once: true });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      reject(new Error('ws closed before open: code=' + ev.code + ' reason=' + ev.reason));
    }, { once: true });
  });
}

async function connectDaemon(opts: {
  base: string;
  tunnelJwt: string;
  label: string;
}): Promise<DaemonHandle> {
  const ws = new WebSocket(opts.base + '/tunnel/default', ['ccsm.' + opts.tunnelJwt]);
  ws.binaryType = 'arraybuffer';
  const helloFrames: HelloFrame[] = [];
  const helloWaiters: Array<(v: HelloFrame) => void> = [];

  ws.addEventListener('message', (ev) => {
    const data = ev.data;
    if (typeof data !== 'string') {
      // The DO never sends binary daemon-bound except echoes; ignore.
      process.stderr.write(`[${opts.label} daemon] unexpected binary len=${(data as ArrayBuffer).byteLength}\n`);
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch {
      process.stderr.write(`[${opts.label} daemon] non-JSON text frame: ${data.slice(0, 80)}\n`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const obj = parsed as { type?: unknown; token?: unknown; sid?: unknown; identity?: unknown };
    if (obj.type === 'hello' && typeof obj.token === 'string' && typeof obj.sid === 'string') {
      const frame: HelloFrame = { token: obj.token, sid: obj.sid };
      if (obj.identity && typeof obj.identity === 'object') {
        const id = obj.identity as { login?: unknown; user_id?: unknown };
        if (typeof id.login === 'string' && typeof id.user_id === 'string') {
          frame.identity = { login: id.login, user_id: id.user_id };
        }
      }
      const waiter = helloWaiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        helloFrames.push(frame);
      }
    }
  });

  await waitOpen(ws);

  return {
    ws,
    helloFrames,
    waitForHello(timeoutMs = DEFAULT_FRAME_TIMEOUT_MS) {
      const next = helloFrames.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        const resolveWrapper = (v: HelloFrame) => {
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          const idx = helloWaiters.indexOf(resolveWrapper);
          if (idx >= 0) helloWaiters.splice(idx, 1);
          reject(new Error('[' + opts.label + ' daemon] hello frame not received within ' + timeoutMs + 'ms'));
        }, timeoutMs);
        helloWaiters.push(resolveWrapper);
      });
    },
    close() {
      try { ws.close(1000, 'test done'); } catch { /* ignore */ }
    },
  };
}

async function connectBrowser(opts: {
  base: string;
  webJwt: string;
  sid: string;
  label: string;
}): Promise<BrowserHandle> {
  const url = opts.base + '/ws/default?sid=' + encodeURIComponent(opts.sid) + '&lastSeq=0';
  const ws = new WebSocket(url, ['ccsm.' + opts.webJwt]);
  ws.binaryType = 'arraybuffer';
  const received: Uint8Array[] = [];
  const receivedText: string[] = [];

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      receivedText.push(ev.data);
    } else {
      received.push(new Uint8Array(ev.data as ArrayBuffer));
    }
  });

  await waitOpen(ws);

  return {
    ws,
    received,
    receivedText,
    close() {
      try { ws.close(1000, 'test done'); } catch { /* ignore */ }
    },
  };
}

function waitForBytes(
  handle: BrowserHandle,
  predicate: (frame: Uint8Array) => boolean,
  label: string,
  timeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
): Promise<Uint8Array> {
  // Already-received case.
  for (const f of handle.received) {
    if (predicate(f)) return Promise.resolve(f);
  }
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') return;
      const frame = new Uint8Array(ev.data as ArrayBuffer);
      if (predicate(frame)) {
        clearTimeout(timer);
        handle.ws.removeEventListener('message', onMsg as EventListener);
        resolve(frame);
      }
    };
    const timer = setTimeout(() => {
      handle.ws.removeEventListener('message', onMsg as EventListener);
      reject(new Error('[' + label + '] expected frame not received within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    handle.ws.addEventListener('message', onMsg as EventListener);
  });
}

/**
 * Assert that, over a quiet window, NO frame matching predicate has shown up.
 * Used for the cross-contamination check: alice's frame must NEVER reach bob.
 */
async function assertNoFrame(
  handle: BrowserHandle,
  predicate: (frame: Uint8Array) => boolean,
  label: string,
  windowMs = 1500,
): Promise<void> {
  // Check anything already received.
  for (const f of handle.received) {
    if (predicate(f)) {
      throw new Error('[' + label + '] cross-contamination: forbidden frame already in receive buffer (len=' + f.byteLength + ')');
    }
  }
  await new Promise<void>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') return;
      const frame = new Uint8Array(ev.data as ArrayBuffer);
      if (predicate(frame)) {
        cleanup();
        reject(new Error('[' + label + '] cross-contamination: forbidden frame arrived during quiet window (len=' + frame.byteLength + ')'));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, windowMs);
    function cleanup() {
      clearTimeout(timer);
      handle.ws.removeEventListener('message', onMsg as EventListener);
    }
    handle.ws.addEventListener('message', onMsg as EventListener);
  });
}

const WS_BASE = process.env.CCSM_CLOUD_WS_BASE ?? '';
const WEB_KEY = process.env.JWT_SIGNING_KEY ?? '';
const TUNNEL_KEY = process.env.JWT_REFRESH_SIGNING_KEY ?? '';

/**
 * Hard-fail (NOT skip) when the harness env is missing. Skipping would
 * silently drop a green check on PRs that lacked the secret bag — exactly
 * the failure mode that lets cross-user leaks ship. Operators who don't
 * want the cross-user gate must filter the spec out explicitly via
 * `playwright test --grep-invert "cross-user"` (CI matrices already do
 * this for the legacy-mode lane against deployed ccsm-worker.jiahuigu.workers.dev).
 */
function requireEnv(): { wsBase: string; webKey: string; tunnelKey: string } {
  const missing: string[] = [];
  if (WS_BASE.length === 0) missing.push('CCSM_CLOUD_WS_BASE');
  if (WEB_KEY.length === 0) missing.push('JWT_SIGNING_KEY');
  if (TUNNEL_KEY.length === 0) missing.push('JWT_REFRESH_SIGNING_KEY');
  if (missing.length > 0) {
    throw new Error(
      'cross-user-isolation.spec requires env: ' + missing.join(', ') +
      '. Start `wrangler dev --port 8787 --var CCSM_AUTH_MODE:jwt` against ' +
      'a `.dev.vars` populated with matching JWT keys, then re-run with ' +
      'CCSM_CLOUD_WS_BASE=ws://127.0.0.1:8787. See spec header for the ' +
      'full setup. Filter this spec out with `--grep-invert "cross-user"` ' +
      'when targeting deployed ccsm-worker.jiahuigu.workers.dev (legacy-mode lane).',
    );
  }
  return { wsBase: WS_BASE, webKey: WEB_KEY, tunnelKey: TUNNEL_KEY };
}

test.describe('cross-user TunnelDO isolation (S4-T9, Task #135)', () => {
  test('alice and bob land in distinct DO instances; their frames never cross', async () => {
    const { wsBase, webKey, tunnelKey } = requireEnv();
    test.setTimeout(30_000);
    const aliceTunnelJwt = signTunnelJwt('gh-1', 'alice', tunnelKey);
    const bobTunnelJwt = signTunnelJwt('gh-2', 'bob', tunnelKey);
    const aliceWebJwt = signWebJwt('gh-1', 'alice', webKey);
    const bobWebJwt = signWebJwt('gh-2', 'bob', webKey);

    // 1. Both daemons dial in. Each must succeed (no 401) and land in a
    //    DIFFERENT DO instance — verified indirectly by the hello-frame
    //    routing below: alice's daemon must NEVER receive bob's hello.
    const aliceDaemon = await connectDaemon({ base: wsBase, tunnelJwt: aliceTunnelJwt, label: 'alice' });
    const bobDaemon = await connectDaemon({ base: wsBase, tunnelJwt: bobTunnelJwt, label: 'bob' });

    try {
      // 2. Both browsers connect with distinct sids. The DO will fire the
      //    hello frame to its paired daemon as soon as the browser ws is
      //    accepted.
      const aliceSid = 'alice-sid-' + Math.random().toString(16).slice(2, 8);
      const bobSid = 'bob-sid-' + Math.random().toString(16).slice(2, 8);
      const aliceBrowser = await connectBrowser({ base: wsBase, webJwt: aliceWebJwt, sid: aliceSid, label: 'alice' });
      const bobBrowser = await connectBrowser({ base: wsBase, webJwt: bobWebJwt, sid: bobSid, label: 'bob' });

      try {
        // 3. Each daemon must receive its OWN hello (sid + identity) — that
        //    proves the worker mapped each JWT subject to a per-user DO.
        const aliceHello = await aliceDaemon.waitForHello();
        const bobHello = await bobDaemon.waitForHello();

        expect(aliceHello.sid, 'alice daemon must see alice sid in hello').toBe(aliceSid);
        expect(bobHello.sid, 'bob daemon must see bob sid in hello').toBe(bobSid);

        // 4. Cross-routing assertion — neither daemon may have observed the
        //    OTHER user's hello. If both daemons landed in the same DO this
        //    would fail (one of them would see two hellos with different
        //    sids; in legacy mode that's exactly how two-tab pairing works).
        // (helloFrames was already drained by waitForHello above; consult
        // both the consumed hello and the residual queue.)
        const aliceAllSids = [aliceHello.sid, ...aliceDaemon.helloFrames.map((h) => h.sid)];
        const bobAllSids = [bobHello.sid, ...bobDaemon.helloFrames.map((h) => h.sid)];
        expect(
          aliceAllSids.includes(bobSid),
          'alice daemon must NOT see bob sid in any hello (cross-user leak)',
        ).toBe(false);
        expect(
          bobAllSids.includes(aliceSid),
          'bob daemon must NOT see alice sid in any hello (cross-user leak)',
        ).toBe(false);

        // 5. T6 identity injection sanity: in jwt-mode the worker injects
        //    X-CCSM-Identity-* headers and the DO echoes them in hello.
        expect(aliceHello.sid).toBe(aliceSid);
        expect(aliceHello.identity?.login, 'alice hello carries login=alice').toBe('alice');
        expect(aliceHello.identity?.user_id, 'alice hello carries user_id=gh-1').toBe('gh-1');
        expect(bobHello.identity?.login, 'bob hello carries login=bob').toBe('bob');
        expect(bobHello.identity?.user_id, 'bob hello carries user_id=gh-2').toBe('gh-2');

        // 6. PTY-data isolation: alice daemon emits a unique payload bound
        //    to alice's sid; the DO must route it to alice's browser ONLY.
        const aliceMagic = new TextEncoder().encode('ALICE-PTY-MAGIC-' + aliceSid);
        const bobMagic = new TextEncoder().encode('BOB-PTY-MAGIC-' + bobSid);
        aliceDaemon.ws.send(encodeSidEnvelope(aliceSid, aliceMagic));
        bobDaemon.ws.send(encodeSidEnvelope(bobSid, bobMagic));

        const aliceFrame = await waitForBytes(
          aliceBrowser,
          (f) => Buffer.from(f).includes(Buffer.from(aliceMagic)),
          'alice browser',
        );
        const bobFrame = await waitForBytes(
          bobBrowser,
          (f) => Buffer.from(f).includes(Buffer.from(bobMagic)),
          'bob browser',
        );
        expect(aliceFrame.byteLength, 'alice browser received its payload').toBeGreaterThan(0);
        expect(bobFrame.byteLength, 'bob browser received its payload').toBeGreaterThan(0);

        // 7. Cross-contamination quiet-window — alice's payload must not
        //    surface at bob's browser, and vice versa, even after the DO
        //    has had a chance to process both. 1.5s is plenty for workerd
        //    on a single-machine wrangler dev (frames typically arrive
        //    within 5-50ms).
        await assertNoFrame(
          bobBrowser,
          (f) => Buffer.from(f).includes(Buffer.from(aliceMagic)),
          'bob browser (must not see alice payload)',
        );
        await assertNoFrame(
          aliceBrowser,
          (f) => Buffer.from(f).includes(Buffer.from(bobMagic)),
          'alice browser (must not see bob payload)',
        );
      } finally {
        aliceBrowser.close();
        bobBrowser.close();
      }
    } finally {
      aliceDaemon.close();
      bobDaemon.close();
    }
  });

  test('alice owning two browser tabs still pair on distinct sids (R-41 regression guard)', async () => {
    const { wsBase, webKey, tunnelKey } = requireEnv();
    test.setTimeout(30_000);
    const aliceTunnelJwt = signTunnelJwt('gh-1', 'alice', tunnelKey);
    const aliceWebJwt = signWebJwt('gh-1', 'alice', webKey);

    const daemon = await connectDaemon({ base: wsBase, tunnelJwt: aliceTunnelJwt, label: 'alice' });
    try {
      const sidA = 'alice-tabA-' + Math.random().toString(16).slice(2, 6);
      const sidB = 'alice-tabB-' + Math.random().toString(16).slice(2, 6);
      const tabA = await connectBrowser({ base: wsBase, webJwt: aliceWebJwt, sid: sidA, label: 'tabA' });
      const tabB = await connectBrowser({ base: wsBase, webJwt: aliceWebJwt, sid: sidB, label: 'tabB' });
      try {
        // Daemon receives two distinct hellos, one per sid.
        const seenSids = new Set<string>();
        seenSids.add((await daemon.waitForHello()).sid);
        seenSids.add((await daemon.waitForHello()).sid);
        expect(seenSids.has(sidA), 'daemon saw tabA hello').toBe(true);
        expect(seenSids.has(sidB), 'daemon saw tabB hello').toBe(true);

        // Daemon emits sid-specific binary; only the matching tab receives.
        const payloadA = new TextEncoder().encode('TAB-A-' + sidA);
        const payloadB = new TextEncoder().encode('TAB-B-' + sidB);
        daemon.ws.send(encodeSidEnvelope(sidA, payloadA));
        daemon.ws.send(encodeSidEnvelope(sidB, payloadB));

        await waitForBytes(tabA, (f) => Buffer.from(f).includes(Buffer.from(payloadA)), 'tabA');
        await waitForBytes(tabB, (f) => Buffer.from(f).includes(Buffer.from(payloadB)), 'tabB');
        await assertNoFrame(
          tabA,
          (f) => Buffer.from(f).includes(Buffer.from(payloadB)),
          'tabA (must not see tabB payload)',
        );
        await assertNoFrame(
          tabB,
          (f) => Buffer.from(f).includes(Buffer.from(payloadA)),
          'tabB (must not see tabA payload)',
        );
      } finally {
        tabA.close();
        tabB.close();
      }
    } finally {
      daemon.close();
    }
  });
});
