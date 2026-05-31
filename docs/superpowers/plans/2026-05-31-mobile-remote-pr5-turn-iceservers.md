# Mobile Remote PR-5: Desktop TURN/ICE Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop WebRTC answerer use real ICE servers (STUN + optional TURN) fetched from the Cloudflare Worker's `POST /turn/credentials`, degrading gracefully to a Google-STUN fallback, instead of the hardcoded `stun:stun.l.google.com:19302`.

**Architecture:** A new network-injectable `fetchIceServers` helper POSTs `/turn/credentials` with the session JWT and returns `RTCIceServer[] | null` (null on any non-OK/501/network error — never throws). `startMobileRemote` becomes `async`, resolving ICE in priority order: injected `opts.iceServers` > Worker-fetched servers > Google-STUN fallback. `main.ts` passes the existing `WORKER_ORIGIN` constant through and `restartMobileRemote` awaits the now-async start with a generation guard so a stale resolve can't overwrite a newer disposer.

**Tech Stack:** TypeScript, Electron main process, `werift` (`RTCIceServer` type), vitest (plain-Node ABI, `vi.fn`/`vi.mock`).

**Base branch:** `feat/mobile-remote-web-exposure` at integration tip `1f672ef` (after PR-4b). Branch PR-5 from there. Do NOT target `main`.

**Reference spec:** `docs/superpowers/specs/2026-05-31-mobile-remote-pr5-turn-iceservers-design.md`

**Zero Worker changes.** `cloudflare/src/routes/turnCred.ts` already exists (PR-1). Enabling TURN is a user-side `wrangler secret put` action, out of scope for this PR.

---

## Task 1: `fetchIceServers` helper

**Files:**
- Create: `electron/remote/turnCred.ts`
- Test: `electron/remote/__tests__/turnCred.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/remote/__tests__/turnCred.test.ts`:

```ts
// electron/remote/__tests__/turnCred.test.ts
import { describe, it, expect } from 'vitest';
import { fetchIceServers } from '../turnCred';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchIceServers', () => {
  it('POSTs /turn/credentials with the bearer token and returns the iceServers array', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });

    expect(result).toEqual([
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://w.example.dev/turn/credentials');
    expect(calls[0].init?.method).toBe('POST');
    expect(
      (calls[0].init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer JWT');
  });

  it('returns null on a 501 (TURN not configured)', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: 'turn not configured' }, false, 501)) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it('returns null when the body has no iceServers array', async () => {
    const fetchImpl = (async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    const result = await fetchIceServers({
      workerOrigin: 'https://w.example.dev',
      token: 'JWT',
      fetchImpl,
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/turnCred.test.ts`
Expected: FAIL — `Cannot find module '../turnCred'`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/remote/turnCred.ts`:

```ts
// electron/remote/turnCred.ts
import { type RTCIceServer } from 'werift';

/** Fetch ICE servers (STUN + optional TURN) from the Worker's
 *  `POST /turn/credentials`. Returns null — never throws — on any non-OK
 *  response (501 "turn not configured" is the expected default), network
 *  error, or malformed body, so the controller degrades to STUN-only instead
 *  of crashing mobile-remote startup. `fetchImpl` is injectable for tests. */
export async function fetchIceServers(deps: {
  workerOrigin: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<RTCIceServer[] | null> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(new URL('/turn/credentials', deps.workerOrigin).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) ? body.iceServers : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/turnCred.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/turnCred.ts electron/remote/__tests__/turnCred.test.ts
git commit -m "feat(mobile-remote): add fetchIceServers TURN/STUN cred helper (PR-5)"
```

---

## Task 2: Controller resolves ICE servers (async)

**Files:**
- Modify: `electron/remote/mobileRemoteController.ts`
- Test: `electron/remote/__tests__/mobileRemoteController.test.ts`

The controller's three existing tests (`returns null when not logged in`, `builds the DO url...`, `close() disposes the peer`) currently call `startMobileRemote` synchronously and read its return value directly. After this task `startMobileRemote` returns a `Promise`, so each existing test must `await` the call. We also add a new `workerOrigin` + `fetchIce` seam and four new behavior tests.

- [ ] **Step 1: Write the failing test**

Replace the entire body of `electron/remote/__tests__/mobileRemoteController.test.ts` with:

```ts
// electron/remote/__tests__/mobileRemoteController.test.ts
import { describe, it, expect, vi } from 'vitest';

// `mobileRemoteController` statically imports `createDesktopPeer` → `desktopPeer`
// → `../ptyHost` → `electron/ptyHost/index.ts`, which pulls in the real
// `electron` runtime. Under plain-Node vitest (CI) that throws at import time.
// This test injects its own `createPeer`, so it never runs the real peer — it
// only needs `ptyHost` to be importable. Stub it exactly like the sibling
// loopback test does.
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [],
  getBufferSnapshot: async () => ({ snapshot: '', seq: 0 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: () => {},
  resizePtySession: () => {},
  onPtyData: () => () => {},
}));

import { startMobileRemote } from '../mobileRemoteController';
import type { SignalingClient } from '../signaling';

const fakeSignaling: SignalingClient = {
  onOffer: () => {}, onRemoteIce: () => {}, sendAnswer: () => {}, sendIce: () => {}, close: () => {},
};

const GOOGLE_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

describe('startMobileRemote', () => {
  it('returns null when not logged in (token provider yields null)', async () => {
    const handle = await startMobileRemote({
      tokenProvider: () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
  });

  it('does not fetch ICE when logged out', async () => {
    const fetchIce = vi.fn(async () => [{ urls: 'turn:x' }]);
    const handle = await startMobileRemote({
      tokenProvider: () => null,
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
    expect(fetchIce).not.toHaveBeenCalled();
  });

  it('builds the DO url with the token query and wires signaling into the peer', async () => {
    const createSignaling = vi.fn(() => fakeSignaling);
    const createPeer = vi.fn(() => ({ close: () => {} }));
    const handle = await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      fetchIce: async () => null,
      createSignaling,
      createPeer,
    });
    expect(handle).not.toBeNull();
    expect(createSignaling).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'wss://w.example.dev/do/HASH?token=JWT' }),
    );
    expect(createPeer).toHaveBeenCalledWith(
      expect.objectContaining({ signaling: fakeSignaling }),
    );
  });

  it('close() disposes the peer', async () => {
    const close = vi.fn();
    const handle = await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      fetchIce: async () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close }),
    });
    handle!.close();
    expect(close).toHaveBeenCalled();
  });

  it('uses Worker-fetched ICE servers when fetchIce resolves a non-empty array', async () => {
    const fetched = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    ];
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce: async () => fetched,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: fetched }));
  });

  it('passes the session token + workerOrigin to fetchIce', async () => {
    const fetchIce = vi.fn(async () => null);
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(fetchIce).toHaveBeenCalledWith(
      expect.objectContaining({ workerOrigin: 'https://w.example.dev', token: 'JWT' }),
    );
  });

  it('falls back to Google STUN when fetchIce resolves null', async () => {
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce: async () => null,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: GOOGLE_STUN }));
  });

  it('injected opts.iceServers wins over fetchIce', async () => {
    const fetchIce = vi.fn(async () => [{ urls: 'turn:should-not-be-used' }]);
    const injected = [{ urls: 'stun:injected:3478' }];
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      iceServers: injected,
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(fetchIce).not.toHaveBeenCalled();
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: injected }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/mobileRemoteController.test.ts`
Expected: FAIL — new `fetchIce`/`workerOrigin` options are not yet accepted; ICE-source tests fail because the controller still always uses the hardcoded fallback; `await`ed handle is a Promise the current sync code does not return.

- [ ] **Step 3: Write minimal implementation**

Replace the entire body of `electron/remote/mobileRemoteController.ts` with:

```ts
// electron/remote/mobileRemoteController.ts
import { type RTCIceServer } from 'werift';
import { createDesktopPeer } from './desktopPeer';
import { createDoSignalingClient } from './doSignalingClient';
import { readMobileRemoteLogin, type TokenProvider } from './tokenProvider';
import { fetchIceServers } from './turnCred';
import type { PeerClient } from './peerClient';
import type { SignalingClient } from './signaling';

const GOOGLE_STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Component E (detail spec §1.2-E): the desktop entry point for the
 *  public-internet mobile path. Reads login state via the injected token
 *  provider, resolves ICE servers (PR-5: injected > Worker `/turn/credentials`
 *  > Google-STUN fallback), builds the Durable Object wss URL, constructs the
 *  DO signaling client + desktop WebRTC answerer, and returns a disposer.
 *  Returns null when not logged in / feature off — main.ts treats null exactly
 *  like the old server returning null. The signaling/peer/ICE factories are
 *  injected so this is unit-testable without a network or werift, and the
 *  loopback e2e can substitute an in-process bridge. */
export async function startMobileRemote(opts?: {
  tokenProvider?: TokenProvider;
  workerOrigin?: string;
  iceServers?: RTCIceServer[];
  fetchIce?: typeof fetchIceServers;
  createSignaling?: (o: { url: string; peerId: string }) => SignalingClient;
  createPeer?: (o: {
    iceServers: RTCIceServer[];
    signaling: SignalingClient;
    clients: Set<PeerClient>;
  }) => { close: () => void };
}): Promise<{ close: () => void } | null> {
  const tokenProvider = opts?.tokenProvider ?? readMobileRemoteLogin;
  const login = tokenProvider();
  if (!login) return null;

  const peerId = `desktop-${Math.random().toString(36).slice(2, 10)}`;
  const url = `${login.doUrl}?token=${encodeURIComponent(login.token)}`;

  const iceServers = await resolveIceServers(opts, login.token);

  const createSignaling =
    opts?.createSignaling ?? ((o) => createDoSignalingClient({ url: o.url, peerId: o.peerId }));
  const createPeer = opts?.createPeer ?? createDesktopPeer;

  const signaling = createSignaling({ url, peerId });
  const clients = new Set<PeerClient>();
  const peer = createPeer({ iceServers, signaling, clients });

  return { close: () => peer.close() };
}

async function resolveIceServers(
  opts: { workerOrigin?: string; iceServers?: RTCIceServer[]; fetchIce?: typeof fetchIceServers } | undefined,
  token: string,
): Promise<RTCIceServer[]> {
  if (opts?.iceServers) return opts.iceServers;
  if (opts?.workerOrigin) {
    const fetchIce = opts.fetchIce ?? fetchIceServers;
    const fetched = await fetchIce({ workerOrigin: opts.workerOrigin, token });
    if (fetched && fetched.length > 0) return fetched;
  }
  return GOOGLE_STUN;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/mobileRemoteController.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/mobileRemoteController.ts electron/remote/__tests__/mobileRemoteController.test.ts
git commit -m "feat(mobile-remote): resolve ICE servers from Worker, async controller (PR-5)"
```

---

## Task 3: `main.ts` wiring + async restart guard

**Files:**
- Modify: `electron/main.ts` (the `restartMobileRemote` function ~line 175 and the whenReady start call ~line 354)

`startMobileRemote` is now async. Two call sites need updating, and `restartMobileRemote` needs a generation guard so a slow ICE fetch from an earlier login/logout can't overwrite a newer disposer.

Note: this worktree's local `electron/main.ts` is uncommitted-modified and must NOT be edited here. The dev implements this task in their own clean worktree branched from `1f672ef`. The line numbers below refer to the `1f672ef` version of `main.ts`.

- [ ] **Step 1: Update `restartMobileRemote` to be async with a generation guard**

Find (at `1f672ef`, ~line 175):

```ts
function restartMobileRemote() {
  try {
    mobileRemote?.close();
  } catch (err) {
    console.warn('[main] restart close threw', err);
  }
  mobileRemote = mobileRemoteTokenProvider
    ? startMobileRemote({ tokenProvider: mobileRemoteTokenProvider })
    : null;
}
```

Replace with:

```ts
// Bumped on every restart so a slow ICE fetch from a superseded login/logout
// can't overwrite the disposer of a newer one (fast login→logout toggle).
let mobileRemoteGen = 0;

async function restartMobileRemote() {
  const gen = ++mobileRemoteGen;
  try {
    mobileRemote?.close();
  } catch (err) {
    console.warn('[main] restart close threw', err);
  }
  mobileRemote = null;
  if (!mobileRemoteTokenProvider) return;
  const handle = await startMobileRemote({
    tokenProvider: mobileRemoteTokenProvider,
    workerOrigin: WORKER_ORIGIN,
  });
  if (gen !== mobileRemoteGen) {
    // A newer restart superseded us while ICE was being fetched; discard.
    handle?.close();
    return;
  }
  mobileRemote = handle;
}
```

- [ ] **Step 2: Update the whenReady start call**

Find (at `1f672ef`, ~line 354):

```ts
  mobileRemote = startMobileRemote({ tokenProvider: mobileRemoteTokenProvider });
```

Replace with:

```ts
  mobileRemote = await startMobileRemote({
    tokenProvider: mobileRemoteTokenProvider,
    workerOrigin: WORKER_ORIGIN,
  });
```

(The enclosing `app.whenReady().then(async () => { ... })` callback is already async, so `await` is valid here.)

- [ ] **Step 3: Verify the IPC restart callers tolerate the now-async restart**

`registerMobileRemoteIpc` (`electron/ipc/mobileRemoteIpc.ts`) calls `restartMobileRemote()` inside async login/logout handlers without awaiting it. That remains correct: the restart proceeds in the background, the broadcast/return reflect store state (not peer state), and the generation guard keeps overlapping restarts consistent. No change needed in `mobileRemoteIpc.ts`. Its type `restartMobileRemote: () => void` still accepts an `async () => void` function (a Promise-returning function is assignable to `() => void`). Confirm by typecheck in Step 4 — no edit expected.

- [ ] **Step 4: Run the full local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green. Typecheck confirms the async restart assigns cleanly and the `() => void` IPC seam still accepts it.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat(mobile-remote): await async mobile-remote start + restart generation guard (PR-5)"
```

---

## Task 4: Full gate + evidence boundary

**Files:** none (verification only).

- [ ] **Step 1: Run the complete local pre-push gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green (`--max-warnings 0`; no skipped tests).

- [ ] **Step 2: Confirm no Worker changes crept in**

Run: `git diff --name-only 1f672ef..HEAD -- cloudflare/`
Expected: empty output (zero Worker changes — TURN route already exists from PR-1).

- [ ] **Step 3: Confirm the changed surface is exactly the planned files**

Run: `git diff --name-only 1f672ef..HEAD`
Expected (order may vary):
```
electron/main.ts
electron/remote/__tests__/mobileRemoteController.test.ts
electron/remote/__tests__/turnCred.test.ts
electron/remote/mobileRemoteController.ts
electron/remote/turnCred.ts
```

- [ ] **Step 4: Document the evidence boundary in the PR body**

The PR description MUST state explicitly (per spec §7) that automated tests prove only that the **client picks up and applies ICE servers correctly**. They do NOT prove:
- public-internet reachability (a phone on 4G reaching the desktop),
- TURN relaying traffic when P2P hole-punching fails,
- the real GitHub OAuth round-trip in the running app.

Those require **user-only real-device verification**: (1) optional `wrangler secret put TURN_KEY_ID` + `TURN_KEY_API_TOKEN` to enable TURN; (2) desktop real GitHub login via the Settings → Mobile Remote pane; (3) phone on 4G (Wi-Fi OFF) driving a terminal session. Loopback/headless is NOT public-internet evidence.

- [ ] **Step 5: Report to parent for independent review (do NOT self-merge / self-review)**

Report the PR number + the evidence summary to the parent session. The implementing dev MUST NOT call `gh pr merge` and MUST NOT self-review. An independently-spawned reviewer (or the parent) merges after CI is green.

---

## Self-Review (plan author)

- **Spec coverage:** §3.1 → Task 1; §3.2 (async controller, ICE order) → Task 2; §3.3 (main.ts workerOrigin + restart guard) → Task 3; §3.4 (refresh out of scope) → not a task (correct); §5 (error handling = null/fallback) → Task 1 + Task 2 tests; §6 (testing strategy) → Tasks 1–2 tests; §7 (evidence boundary) → Task 4 Step 4. Full coverage.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `fetchIceServers` signature `{workerOrigin, token, fetchImpl?}` is identical in Task 1 impl, Task 2 `fetchIce?: typeof fetchIceServers` seam, and Task 2 test injections. `RTCIceServer` imported from `werift` consistently. `startMobileRemote` returns `Promise<{close}|null>` and all call sites (tests + main.ts) `await` it. `GOOGLE_STUN` constant matches the Google-STUN fallback asserted in tests.
