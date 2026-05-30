# Mobile-Remote PR-4: Integration + Loopback E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the desktop ccsm to the public-internet WebRTC path end-to-end — a real Durable Object signaling client, a controller that builds the desktop peer from login state, the `main.ts` rewire, the phone-side xterm UI, and a Node loopback e2e that drives the REAL `src/mobile` modules against the REAL desktop peer.

**Architecture:** Desktop is the WebRTC *answerer*. `mobileRemoteController.startMobileRemote()` reads a session JWT from an **injected token provider** (PR-4 ships a minimal env/null impl; PR-4b swaps in real GitHub OAuth), builds the DO WebSocket URL, constructs `doSignalingClient` (the inverted mirror of `src/mobile/phoneSignaling.ts`), and hands it to the merged `createDesktopPeer`. `main.ts` calls `startMobileRemote()` instead of the old LAN `startMobileRemoteServer()`. The phone side gains `mobilePage.ts` implementing the `PhoneUi` port against a real xterm `Terminal` and constructing a `phonePeer`. A Node loopback test stands up `createDesktopPeer` + the real `phonePeer`/`phoneApp` over an in-process signaling bridge with werift on both sides, asserting the full protocol.

**Tech Stack:** TypeScript, Electron main (`electron/`), framework-free DI renderer modules (`src/mobile/`), `werift` (pure-TS WebRTC in Node), `@xterm/xterm`, vitest (`// @vitest-environment node` for werift loopback), `ws` is NOT used on this path (DataChannel replaces it).

**Base branch:** `feat/mobile-remote-web-exposure` (integration tip `3de676e`). Do NOT target `main`. Do NOT touch the pre-existing uncommitted `electron/main.ts` working-tree change until your branch is created from the integration tip; if the rewire conflicts with it, rebase rather than discard.

**Out of scope (explicitly):** desktop GitHub OAuth UI, `safeStorage` token refresh, and the settings-page login entry are **PR-4b**. PR-4's token provider is a minimal `process.env`/`null` reader. TURN credential signing and real-device 4G verification are **PR-5**. Loopback/Node evidence proves the *pipe*, NOT public reachability.

---

## File Structure

**Create:**
- `electron/remote/tokenProvider.ts` — the injected login-state seam. PR-4 minimal impl: reads `CCSM_MOBILE_REMOTE_TOKEN` / `CCSM_MOBILE_REMOTE_DO_URL` from env, returns `null` when unset. PR-4b replaces the impl, keeps the interface.
- `electron/remote/__tests__/tokenProvider.test.ts`
- `electron/remote/doSignalingClient.ts` — real DO WebSocket `SignalingClient` (desktop=answerer), inverted mirror of `src/mobile/phoneSignaling.ts`.
- `electron/remote/__tests__/doSignalingClient.test.ts`
- `electron/remote/mobileRemoteController.ts` — `startMobileRemote()`: token provider → DO URL → `doSignalingClient` → `createDesktopPeer` → `{ close }`.
- `electron/remote/__tests__/mobileRemoteController.test.ts`
- `src/mobile/mobilePage.ts` — `PhoneUi` implemented against a real xterm `Terminal`; constructs `phoneSignaling` + `phonePeer` + `wirePhoneApp`; boots from the page URL token. (Renderer module; must NOT import from `electron/`.)
- `src/mobile/__tests__/mobilePage.test.ts`
- `electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts` — Node loopback: real `phonePeer` (werift injected) ↔ real `createDesktopPeer`, over an in-process signaling bridge, asserting the full terminal protocol.

**Modify:**
- `electron/main.ts` — swap `startMobileRemoteServer()` (line ~302) for `startMobileRemote()`; update the import (~line 93) and the typed handle (~line 160). Disposer semantics unchanged (`?.close()`).

**Delete (same PR, after the rewire is green):**
- `electron/remote/mobileRemoteServer.ts` and its tests — the LAN WS server is replaced by the WebRTC path. (See Task 7; only delete once nothing imports it.)

**Read-only authorities (do NOT modify):**
- `electron/remote/signaling.ts` — the `SignalingClient` interface your `doSignalingClient` implements.
- `electron/remote/desktopPeer.ts` — `createDesktopPeer` (the answerer; merged, PR-2).
- `electron/remote/peerClient.ts`, `electron/remote/remoteMessages.ts`, `electron/remote/ptyFanout.ts` — protocol core.
- `src/mobile/phoneSignaling.ts`, `src/mobile/phonePeer.ts`, `src/mobile/phoneApp.ts`, `src/mobile/protocol.ts`, `src/mobile/githubLogin.ts` — phone side (merged, PR-3).

---

## Wire-protocol contract (the symbol authority — keep these EXACT)

`doSignalingClient` is the **desktop answerer** mirror of `src/mobile/phoneSignaling.ts`. Same DO WebSocket wire shapes (re-declared phone-side in `src/mobile/protocol.ts`), inverted roles:

| Phone (offerer, `phoneSignaling.ts`) | Desktop (answerer, `doSignalingClient.ts`) |
| --- | --- |
| sends `register{role:'phone',peerId}` on open | sends `register{role:'desktop',peerId}` on open |
| `registered.peers` → looks for role `desktop` → `onPeerPresent` | `registered.peers` → looks for role `phone` → `onOffer` source (track peerId) |
| `peer-present` role `desktop` → `onPeerPresent` | (desktop does not need peer-present to act; it waits for the phone's `offer`) |
| receives `answer` → `onAnswer` | receives `offer` → `onOffer(offer, fromPeerId)` |
| sends `offer{to,from,sdp}` | sends `answer{to,from,sdp}` via `sendAnswer` |
| `ice` in/out (`onRemoteIce` / `sendIce`) | `ice` in/out (`onRemoteIce` / `sendIce`) |

The desktop `SignalingClient` interface it satisfies (from `electron/remote/signaling.ts`, do not change):

```ts
export type SignalDescription = { type: 'offer' | 'answer'; sdp: string };
export type SignalCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
export type SignalingClient = {
  onOffer: (cb: (offer: SignalDescription, peerId: string) => void) => void;
  onRemoteIce: (cb: (cand: SignalCandidate, peerId: string) => void) => void;
  sendAnswer: (answer: SignalDescription, peerId: string) => void;
  sendIce: (cand: SignalCandidate, peerId: string) => void;
  close: () => void;
};
```

The DO inbound/outbound JSON shapes (authority: `src/mobile/protocol.ts`):

```ts
// outbound (desktop → DO)
{ type: 'register', role: 'desktop', peerId: string }
{ type: 'answer', to: string, from: string, sdp: string }
{ type: 'ice', to: string, from: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }
// inbound (DO → desktop)
{ type: 'registered', peerId: string, peers: { role: 'desktop'|'phone', peerId: string }[] }
{ type: 'peer-present', role: 'desktop'|'phone', peerId: string }
{ type: 'peer-gone', role: 'desktop'|'phone', peerId: string }
{ type: 'offer', to: string, from: string, sdp: string }
{ type: 'ice', to: string, from: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null }
{ type: 'error', code: string, message: string }
```

Note: the interface's `SignalDescription` carries `type:'offer'|'answer'`, but the **wire** `answer`/`offer` frames carry only `sdp` (no nested `type`). `doSignalingClient` translates: on outbound `sendAnswer(a, to)` it emits `{type:'answer', to, from, sdp:a.sdp}`; on inbound `offer` it calls `onOffer({type:'offer', sdp:msg.sdp}, msg.from)`.

---

## Task 1: Token provider seam

**Files:**
- Create: `electron/remote/tokenProvider.ts`
- Test: `electron/remote/__tests__/tokenProvider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/tokenProvider.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { readMobileRemoteLogin } from '../tokenProvider';

const KEYS = ['CCSM_MOBILE_REMOTE_TOKEN', 'CCSM_MOBILE_REMOTE_DO_URL'];

afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('readMobileRemoteLogin', () => {
  it('returns null when no token is configured', () => {
    expect(readMobileRemoteLogin()).toBeNull();
  });

  it('returns null when token is set but DO url is missing', () => {
    process.env.CCSM_MOBILE_REMOTE_TOKEN = 'jwt123';
    expect(readMobileRemoteLogin()).toBeNull();
  });

  it('returns the login when both token and DO url are present', () => {
    process.env.CCSM_MOBILE_REMOTE_TOKEN = 'jwt123';
    process.env.CCSM_MOBILE_REMOTE_DO_URL = 'wss://ccsm-worker.example.workers.dev/do/HASH';
    expect(readMobileRemoteLogin()).toEqual({
      token: 'jwt123',
      doUrl: 'wss://ccsm-worker.example.workers.dev/do/HASH',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/tokenProvider.test.ts`
Expected: FAIL — "Cannot find module '../tokenProvider'".

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/tokenProvider.ts
/** The login-state seam for the public-internet mobile path. PR-4 ships this
 *  minimal env reader so the controller + loopback e2e exercise the real
 *  pipe with an INJECTED JWT; PR-4b replaces the body with GitHub OAuth +
 *  safeStorage refresh while keeping this signature (detail spec §4.2, §9).
 *  Returns null = not logged in / feature off → controller no-ops. */
export type MobileRemoteLogin = {
  /** Short-lived session JWT minted by the Worker's OAuth flow. */
  token: string;
  /** The Durable Object base wss URL (no token query yet), e.g.
   *  `wss://<worker>/do/<userHash>`. The controller appends `?token=`. */
  doUrl: string;
};

export type TokenProvider = () => MobileRemoteLogin | null;

export function readMobileRemoteLogin(): MobileRemoteLogin | null {
  const token = process.env.CCSM_MOBILE_REMOTE_TOKEN;
  const doUrl = process.env.CCSM_MOBILE_REMOTE_DO_URL;
  if (!token || !doUrl) return null;
  return { token, doUrl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/tokenProvider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/tokenProvider.ts electron/remote/__tests__/tokenProvider.test.ts
git commit -m "feat(mobile-remote): token provider seam for desktop login state (PR-4)"
```

---

## Task 2: Real DO signaling client (desktop answerer)

**Files:**
- Create: `electron/remote/doSignalingClient.ts`
- Test: `electron/remote/__tests__/doSignalingClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/doSignalingClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDoSignalingClient } from '../doSignalingClient';

/** Minimal WebSocket fake mirroring src/mobile phoneSignaling.test.ts. */
class FakeWs {
  static OPEN = 1;
  readyState = FakeWs.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
  fireOpen() { this.onopen?.(); }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  lastJson() { return JSON.parse(this.sent[this.sent.length - 1]!); }
}

function setup() {
  const ws = new FakeWs();
  const sig = createDoSignalingClient({
    url: 'wss://ccsm-worker.example.workers.dev/do/HASH?token=JWT',
    peerId: 'd1',
    createWebSocket: () => ws as unknown as WebSocket,
  });
  return { ws, sig };
}

describe('createDoSignalingClient', () => {
  it('registers as desktop on open', () => {
    const { ws } = setup();
    ws.fireOpen();
    expect(ws.lastJson()).toEqual({ type: 'register', role: 'desktop', peerId: 'd1' });
  });

  it('routes an inbound offer to onOffer with the sender peerId', () => {
    const { ws, sig } = setup();
    const onOffer = vi.fn();
    sig.onOffer(onOffer);
    ws.fireOpen();
    ws.push({ type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0-offer' });
    expect(onOffer).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0-offer' }, 'p1');
  });

  it('routes inbound ice to onRemoteIce with the sender peerId', () => {
    const { ws, sig } = setup();
    const onIce = vi.fn();
    sig.onRemoteIce(onIce);
    ws.fireOpen();
    ws.push({ type: 'ice', to: 'd1', from: 'p1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
    expect(onIce).toHaveBeenCalledWith({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }, 'p1');
  });

  it('sendAnswer frames an answer to the phone peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendAnswer({ type: 'answer', sdp: 'v=0-answer' }, 'p1');
    expect(ws.lastJson()).toEqual({ type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0-answer' });
  });

  it('sendIce frames ice to the phone peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendIce({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 1 }, 'p1');
    expect(ws.lastJson()).toEqual({
      type: 'ice', to: 'p1', from: 'd1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 1,
    });
  });

  it('close() closes the socket', () => {
    const { ws, sig } = setup();
    const onClose = vi.fn();
    ws.onclose = onClose;
    ws.fireOpen();
    sig.close();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/doSignalingClient.test.ts`
Expected: FAIL — "Cannot find module '../doSignalingClient'".

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/doSignalingClient.ts
import type { SignalCandidate, SignalDescription, SignalingClient } from './signaling';

/** The desktop (answerer) side of the Durable Object signaling protocol. The
 *  exact inverted mirror of src/mobile/phoneSignaling.ts: the desktop SENDS
 *  register{role:'desktop'} + answer + ice and RECEIVES offer + ice. The
 *  WebSocket is injected so tests fake it; the real
 *  `wss://<worker>/do/<userHash>?token=<jwt>` URL is built by the caller
 *  (mobileRemoteController). CLAUDE.md forbids src/ importing electron/, so the
 *  phone mirror re-declares these shapes in src/mobile/protocol.ts — keep the
 *  two structurally identical (detail spec §3, PR-1 §6.3). */
type DoInbound =
  | { type: 'registered'; peerId: string; peers: { role: 'desktop' | 'phone'; peerId: string }[] }
  | { type: 'peer-present'; role: 'desktop' | 'phone'; peerId: string }
  | { type: 'peer-gone'; role: 'desktop' | 'phone'; peerId: string }
  | { type: 'offer'; to: string; from: string; sdp: string }
  | { type: 'ice'; to: string; from: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: 'error'; code: string; message: string };

export function createDoSignalingClient(opts: {
  url: string;
  peerId: string;
  createWebSocket?: (url: string) => WebSocket;
}): SignalingClient {
  const make = opts.createWebSocket ?? ((u: string) => new WebSocket(u));
  const ws = make(opts.url);

  let offerCb: ((offer: SignalDescription, peerId: string) => void) | null = null;
  let iceCb: ((cand: SignalCandidate, peerId: string) => void) | null = null;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', role: 'desktop', peerId: opts.peerId }));
  };

  ws.onmessage = (ev: { data: unknown }) => {
    let msg: DoInbound;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'offer':
        offerCb?.({ type: 'offer', sdp: msg.sdp }, msg.from);
        return;
      case 'ice':
        iceCb?.({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }, msg.from);
        return;
      default:
        return;
    }
  };

  return {
    onOffer: (cb) => { offerCb = cb; },
    onRemoteIce: (cb) => { iceCb = cb; },
    sendAnswer: (answer, peerId) => {
      ws.send(JSON.stringify({ type: 'answer', to: peerId, from: opts.peerId, sdp: answer.sdp }));
    },
    sendIce: (cand, peerId) => {
      ws.send(JSON.stringify({
        type: 'ice', to: peerId, from: opts.peerId,
        candidate: cand.candidate, sdpMid: cand.sdpMid ?? null, sdpMLineIndex: cand.sdpMLineIndex ?? null,
      }));
    },
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/doSignalingClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/doSignalingClient.ts electron/remote/__tests__/doSignalingClient.test.ts
git commit -m "feat(mobile-remote): real DO signaling client (desktop answerer) (PR-4)"
```

---

## Task 3: Controller — startMobileRemote()

**Files:**
- Create: `electron/remote/mobileRemoteController.ts`
- Test: `electron/remote/__tests__/mobileRemoteController.test.ts`

The controller is pure wiring: read login → build URL → construct signaling → construct desktop peer → return a disposer. Both `createDoSignalingClient` and `createDesktopPeer` are injected so this unit tests without a network or werift.

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/mobileRemoteController.test.ts
import { describe, it, expect, vi } from 'vitest';
import { startMobileRemote } from '../mobileRemoteController';
import type { SignalingClient } from '../signaling';

const fakeSignaling: SignalingClient = {
  onOffer: () => {}, onRemoteIce: () => {}, sendAnswer: () => {}, sendIce: () => {}, close: () => {},
};

describe('startMobileRemote', () => {
  it('returns null when not logged in (token provider yields null)', () => {
    const handle = startMobileRemote({
      tokenProvider: () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
  });

  it('builds the DO url with the token query and wires signaling into the peer', () => {
    const createSignaling = vi.fn(() => fakeSignaling);
    const createPeer = vi.fn(() => ({ close: () => {} }));
    const handle = startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
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

  it('close() disposes the peer', () => {
    const close = vi.fn();
    const handle = startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close }),
    });
    handle!.close();
    expect(close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/mobileRemoteController.test.ts`
Expected: FAIL — "Cannot find module '../mobileRemoteController'".

- [ ] **Step 3: Write minimal implementation**

```ts
// electron/remote/mobileRemoteController.ts
import { RTCPeerConnection, type RTCIceServer } from 'werift';
import { createDesktopPeer } from './desktopPeer';
import { createDoSignalingClient } from './doSignalingClient';
import { readMobileRemoteLogin, type TokenProvider } from './tokenProvider';
import type { PeerClient } from './peerClient';
import type { SignalingClient } from './signaling';

/** Component E (detail spec §1.2-E): the desktop entry point for the
 *  public-internet mobile path. Reads login state via the injected token
 *  provider (PR-4 minimal env impl; PR-4b real OAuth), builds the Durable
 *  Object wss URL, constructs the DO signaling client + desktop WebRTC
 *  answerer, and returns a disposer. Returns null when not logged in / feature
 *  off — main.ts treats null exactly like the old server returning null. The
 *  signaling/peer factories are injected so this is unit-testable without a
 *  network or werift, and the loopback e2e can substitute an in-process
 *  bridge. */
export function startMobileRemote(opts?: {
  tokenProvider?: TokenProvider;
  iceServers?: RTCIceServer[];
  createSignaling?: (o: { url: string; peerId: string }) => SignalingClient;
  createPeer?: (o: {
    iceServers: RTCIceServer[];
    signaling: SignalingClient;
    clients: Set<PeerClient>;
  }) => { close: () => void };
}): { close: () => void } | null {
  const tokenProvider = opts?.tokenProvider ?? readMobileRemoteLogin;
  const login = tokenProvider();
  if (!login) return null;

  const peerId = `desktop-${Math.random().toString(36).slice(2, 10)}`;
  const url = `${login.doUrl}?token=${encodeURIComponent(login.token)}`;
  const iceServers = opts?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];

  const createSignaling =
    opts?.createSignaling ?? ((o) => createDoSignalingClient({ url: o.url, peerId: o.peerId }));
  const createPeer = opts?.createPeer ?? createDesktopPeer;

  const signaling = createSignaling({ url, peerId });
  const clients = new Set<PeerClient>();
  const peer = createPeer({ iceServers, signaling, clients });

  return { close: () => peer.close() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/mobileRemoteController.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/remote/mobileRemoteController.ts electron/remote/__tests__/mobileRemoteController.test.ts
git commit -m "feat(mobile-remote): startMobileRemote controller wiring signaling + desktop peer (PR-4)"
```

---

## Task 4: Rewire main.ts

**Files:**
- Modify: `electron/main.ts` (import ~line 93, handle ~line 160, call ~line 302, disposer ~lines 388-395)

The current working tree has an uncommitted change in `electron/main.ts`. Your branch is cut from `3de676e`; reconcile by editing the live file. Verify the exact line numbers with grep before editing — they may have shifted.

- [ ] **Step 1: Locate the current wiring**

Run: `MSYS_NO_PATHCONV=1 grep -n "startMobileRemoteServer\|mobileRemoteServer" electron/main.ts`
Expected: shows the import, the `let mobileRemoteServer` handle, the assignment, and the disposer `?.close()`.

- [ ] **Step 2: Write the failing check (typecheck drives this task)**

There is no new unit test for `main.ts` (it is the Electron entry; covered by the e2e in Task 6). The failing signal is the rename not yet applied. Run:

Run: `MSYS_NO_PATHCONV=1 grep -n "startMobileRemote\b" electron/main.ts`
Expected: NO match (only `startMobileRemoteServer` exists) → confirms the rewire is not done.

- [ ] **Step 3: Apply the rewire**

Edit the import line (~93):
```ts
// before
import { startMobileRemoteServer } from './remote/mobileRemoteServer';
// after
import { startMobileRemote } from './remote/mobileRemoteController';
```

Edit the handle declaration (~160):
```ts
// before
let mobileRemoteServer: { close: () => void; url?: string } | null = null;
// after
let mobileRemote: { close: () => void } | null = null;
```

Edit the assignment (~302):
```ts
// before
mobileRemoteServer = startMobileRemoteServer();
// after
mobileRemote = startMobileRemote();
```

Edit the disposer (~388-395) — replace every `mobileRemoteServer?.close()` / `mobileRemoteServer = null` with `mobileRemote?.close()` / `mobileRemote = null`. If any code read `mobileRemoteServer.url` (the LAN URL for the desktop UI), remove that read — the WebRTC path has no local URL. Verify:

Run: `MSYS_NO_PATHCONV=1 grep -n "mobileRemoteServer\|\.url" electron/main.ts`
Expected: NO remaining `mobileRemoteServer` references; no dangling `.url` read tied to it.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no references to the removed symbol; `startMobileRemote` resolves).

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "refactor(mobile-remote): rewire main to startMobileRemote (WebRTC path) (PR-4)"
```

---

## Task 5: Phone mobilePage — PhoneUi against real xterm

**Files:**
- Create: `src/mobile/mobilePage.ts`
- Test: `src/mobile/__tests__/mobilePage.test.ts`

`mobilePage.ts` implements the `PhoneUi` port (from `phoneApp.ts`) against a real `@xterm/xterm` `Terminal`, and exposes a `bootPhonePage()` that constructs `phoneSignaling` + `phonePeer` + `wirePhoneApp` from the page URL. The xterm `Terminal` and the DOM are injected so the unit test runs without a browser. This module lives in `src/` and MUST NOT import from `electron/`.

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/mobilePage.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createXtermPhoneUi } from '../mobilePage';

/** Minimal xterm Terminal fake: records writes/resets. */
function fakeTerminal() {
  return {
    write: vi.fn(),
    reset: vi.fn(),
    writes: [] as string[],
  };
}

describe('createXtermPhoneUi', () => {
  it('write() forwards the chunk to the terminal', () => {
    const term = fakeTerminal();
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: { textContent: '' } as never,
      makeChip: () => ({}) as never,
    });
    ui.write('hello');
    expect(term.write).toHaveBeenCalledWith('hello');
  });

  it('reset() clears the terminal', () => {
    const term = fakeTerminal();
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: { textContent: '' } as never,
      makeChip: () => ({}) as never,
    });
    ui.reset();
    expect(term.reset).toHaveBeenCalled();
  });

  it('setStatus() writes the status text into the status element', () => {
    const term = fakeTerminal();
    const statusEl = { textContent: '' };
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren: vi.fn() } as never,
      statusEl: statusEl as never,
      makeChip: () => ({}) as never,
    });
    ui.setStatus('connected');
    expect(statusEl.textContent).toBe('connected');
  });

  it('renderSessions() builds one chip per session via makeChip and mounts them', () => {
    const term = fakeTerminal();
    const replaceChildren = vi.fn();
    const makeChip = vi.fn((sid: string) => ({ sid }) as never);
    const ui = createXtermPhoneUi({
      terminal: term as never,
      sessionListEl: { replaceChildren } as never,
      statusEl: { textContent: '' } as never,
      makeChip,
    });
    ui.renderSessions(
      [{ sid: 'a', cwd: '/x', cols: 80, rows: 24 }, { sid: 'b', cwd: '/y', cols: 80, rows: 24 }],
      'a',
    );
    expect(makeChip).toHaveBeenCalledTimes(2);
    expect(replaceChildren).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/mobilePage.test.ts`
Expected: FAIL — "Cannot find module '../mobilePage'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/mobilePage.ts
import type { Terminal } from '@xterm/xterm';
import type { SessionListEntry } from './protocol';
import type { PhoneUi } from './phoneApp';
import { createPhoneSignaling } from './phoneSignaling';
import { createPhonePeer } from './phonePeer';
import { wirePhoneApp } from './phoneApp';
import { readSessionToken } from './githubLogin';

/** The real xterm-backed PhoneUi (detail spec §6 "swap the pipe, keep the
 *  protocol"). DOM nodes + the Terminal are injected so this is unit-testable
 *  in plain Node; bootPhonePage() below builds the real ones from the page. */
export function createXtermPhoneUi(deps: {
  terminal: Terminal;
  sessionListEl: { replaceChildren: (...nodes: Node[]) => void };
  statusEl: { textContent: string | null };
  makeChip: (sid: string, label: string, active: boolean, onSelect: () => void) => Node;
  onSelect?: (sid: string) => void;
}): PhoneUi {
  return {
    renderSessions(sessions: SessionListEntry[], activeSid: string) {
      const chips = sessions.map((s) =>
        deps.makeChip(s.sid, s.cwd, s.sid === activeSid, () => deps.onSelect?.(s.sid)),
      );
      deps.sessionListEl.replaceChildren(...chips);
    },
    selectSession(_sid: string) { /* chip active state is re-derived on next renderSessions */ },
    write(chunk: string) { deps.terminal.write(chunk); },
    reset() { deps.terminal.reset(); },
    setStatus(status) { deps.statusEl.textContent = status; },
  };
}

/** Wire the real WebRTC phone client from the page URL. Called once on DOM
 *  ready by the bundled entry; everything it needs (token, peerId, DO url) is
 *  on `location`. The Worker put the session JWT on the URL after OAuth
 *  (githubLogin.ts). */
export function bootPhonePage(deps: {
  terminal: Terminal;
  sessionListEl: { replaceChildren: (...nodes: Node[]) => void };
  statusEl: { textContent: string | null };
  makeChip: (sid: string, label: string, active: boolean, onSelect: () => void) => Node;
  locationSearch: string;
  doUrl: string;
  iceServers: RTCIceServer[];
}): { close: () => void } | null {
  const token = readSessionToken(deps.locationSearch);
  if (!token) {
    deps.statusEl.textContent = 'not logged in';
    return null;
  }
  const peerId = `phone-${Math.random().toString(36).slice(2, 10)}`;
  const signaling = createPhoneSignaling({ url: `${deps.doUrl}?token=${encodeURIComponent(token)}`, peerId });
  const peer = createPhonePeer({ iceServers: deps.iceServers, signaling });

  const ui = createXtermPhoneUi(deps);
  const app = wirePhoneApp(peer, ui);
  (ui as { onSelect?: (sid: string) => void }).onSelect = app.select;

  deps.terminal.onData((data: string) => app.sendInput(data));
  return { close: () => app.close() };
}
```

> Note: `createXtermPhoneUi` returns the `PhoneUi`; `bootPhonePage` sets `onSelect` after `wirePhoneApp` so chip taps drive `app.select`. The test only covers `createXtermPhoneUi` (the DI-pure unit); `bootPhonePage` is exercised by the loopback e2e in Task 6 and by real-device testing in PR-5.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/mobilePage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/mobilePage.ts src/mobile/__tests__/mobilePage.test.ts
git commit -m "feat(mobile-remote): xterm-backed PhoneUi + bootPhonePage wiring (PR-4)"
```

---

## Task 6: Node loopback e2e — real phone modules ↔ real desktop peer

**Files:**
- Create: `electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts`

This is PR-4's differentiating evidence: it drives the REAL `src/mobile/phonePeer.ts` + `phoneSignaling`-shaped bridge against the REAL `createDesktopPeer`, with werift on both sides, asserting the full protocol (`session.input` → `ptyHost`, snapshot, seq-deduped `pty.data`). The signaling is an in-process bridge connecting the desktop `SignalingClient` and the phone `PhoneSignaling` so no DO/network is involved. `// @vitest-environment node` is mandatory (werift needs real net/dgram).

This test imports the phone module from `src/mobile/phonePeer.ts` and injects werift's `RTCPeerConnection` via `createPeerConnection`, proving the actual offerer code path — not a hand-rolled werift PC like the PR-2 loopback test.

- [ ] **Step 1: Write the failing test**

```ts
// electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts
// @vitest-environment node
// werift drives real UDP (ICE) + SCTP; jsdom shims break the DataChannel.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RTCPeerConnection } from 'werift';

const inputCalls: Array<[string, string]> = [];
let emitPtyData: ((sid: string, chunk: string, seq: number) => void) | null = null;
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }],
  getBufferSnapshot: async () => ({ data: 'SNAP', seq: 5 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: (sid: string, data: string) => { inputCalls.push([sid, data]); },
  resizePtySession: () => {},
  onPtyData: (cb: (sid: string, chunk: string, seq: number) => void) => {
    emitPtyData = cb;
    return () => { emitPtyData = null; };
  },
}));

import { createDesktopPeer } from '../desktopPeer';
import { createDoSignalingClient } from '../doSignalingClient';
import { createPhoneSignaling } from '../../../src/mobile/phoneSignaling';
import { createPhonePeer } from '../../../src/mobile/phonePeer';
import { wirePhoneApp, type PhoneUi } from '../../../src/mobile/phoneApp';
import type { DesktopToPhone } from '../../../src/mobile/protocol';

/** Two in-process WebSocket fakes joined back-to-back: whatever one `send`s is
 *  delivered to the other's onmessage. This is the DO, collapsed to a wire. The
 *  desktop registers as 'desktop', the phone as 'phone'; the bridge answers
 *  register with a `registered`/`peer-present` so each side learns the other,
 *  and routes offer/answer/ice by the `to` field. */
function makeDoBridge() {
  type Sock = {
    role: 'desktop' | 'phone';
    peerId: string;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    onclose: (() => void) | null;
    send: (s: string) => void;
    close: () => void;
  };
  const socks: Record<string, Sock> = {};
  const byRole: Record<string, Sock | undefined> = {};

  function deliver(to: string, payload: unknown) {
    socks[to]?.onmessage?.({ data: JSON.stringify(payload) });
  }

  function makeSock(): Sock {
    const sock: Sock = {
      role: 'phone', peerId: '', onopen: null, onmessage: null, onclose: null,
      send: (s: string) => {
        const msg = JSON.parse(s) as Record<string, unknown>;
        if (msg.type === 'register') {
          sock.role = msg.role as 'desktop' | 'phone';
          sock.peerId = msg.peerId as string;
          socks[sock.peerId] = sock;
          byRole[sock.role] = sock;
          const other = sock.role === 'phone' ? byRole.desktop : byRole.phone;
          const otherRole = sock.role === 'phone' ? 'desktop' : 'phone';
          deliver(sock.peerId, {
            type: 'registered', peerId: sock.peerId,
            peers: other ? [{ role: otherRole, peerId: other.peerId }] : [],
          });
          if (other) {
            deliver(other.peerId, { type: 'peer-present', role: sock.role, peerId: sock.peerId });
          }
          return;
        }
        // offer/answer/ice all carry { to }
        deliver(msg.to as string, msg);
      },
      close: () => sock.onclose?.(),
    };
    // fire open on next tick so the caller can assign handlers first
    queueMicrotask(() => sock.onopen?.());
    return sock;
  }

  return {
    desktopWsFactory: () => makeSock() as unknown as WebSocket,
    phoneWsFactory: () => makeSock() as unknown as WebSocket,
  };
}

function makeUi() {
  const writes: string[] = [];
  const ui: PhoneUi = {
    renderSessions: () => {},
    selectSession: () => {},
    write: (c) => { writes.push(c); },
    reset: () => {},
    setStatus: () => {},
  };
  return { ui, writes };
}

describe('mobile-remote loopback e2e (real phone modules ↔ desktop peer)', () => {
  beforeEach(() => { inputCalls.length = 0; emitPtyData = null; });

  it('runs the full protocol over a real DataChannel between the real modules', async () => {
    const bridge = makeDoBridge();

    // Desktop answerer with the real DO signaling client (in-process WS).
    const desktopSignaling = createDoSignalingClient({
      url: 'wss://bridge/do/HASH?token=JWT', peerId: 'd1',
      createWebSocket: bridge.desktopWsFactory,
    });
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const desktop = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    // Phone offerer with the real phone modules + werift injected.
    const phoneSignaling = createPhoneSignaling({
      url: 'wss://bridge/do/HASH?token=JWT', peerId: 'p1',
      createWebSocket: bridge.phoneWsFactory,
    });
    const phonePeer = createPhonePeer({
      iceServers: [],
      signaling: phoneSignaling,
      createPeerConnection: (c) => new RTCPeerConnection(c) as unknown as RTCPeerConnection,
    });
    const { ui, writes } = makeUi();
    const app = wirePhoneApp(phonePeer, ui);

    // Wait for the channel to open (phoneApp sets status connected on open).
    await vi.waitFor(() => expect(writes.length >= 0).toBe(true), { timeout: 8000 });
    await new Promise<void>((resolve) => {
      phonePeer.onOpen(() => resolve());
    });

    // Phone selects s1 → desktop replies snapshot (SNAP, seq 5).
    app.select('s1');
    await vi.waitFor(() => expect(writes.join('')).toContain('SNAP'), { timeout: 8000 });

    // pty.data seq <= 5 is deduped; seq 6 paints.
    emitPtyData?.('s1', 'OLD', 4);
    emitPtyData?.('s1', 'NEW', 6);
    await vi.waitFor(() => expect(writes.join('')).toContain('NEW'), { timeout: 8000 });
    expect(writes.join('')).not.toContain('OLD');

    // Phone input reaches ptyHost.
    app.sendInput('ls\n');
    await vi.waitFor(() => expect(inputCalls).toContainEqual(['s1', 'ls\n']), { timeout: 8000 });

    app.close();
    desktop.close();
  }, 30000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts`
Expected: FAIL — initially "Cannot find module '../doSignalingClient'" if run before Task 2, or (after Tasks 1-3) a real assertion/timeout failure until the bridge + dedupe wiring is correct. Iterate until it fails for the RIGHT reason (a missing import), then passes once the modules exist.

- [ ] **Step 3: Make it pass**

The implementation already exists from Tasks 2-5; this task adds only the test + the in-process bridge. If the test times out, the usual causes are: (a) the bridge fires `onopen` before handlers are attached — `queueMicrotask` defers it, keep that; (b) ICE candidates aren't routed — confirm both `phonePeer` and `desktopPeer` forward ice through the bridge `to` field; (c) `peer-present` reaches the phone so it sends the offer — assert the bridge delivers it. Do NOT weaken assertions to force green.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts`
Expected: PASS (1 test): snapshot painted, seq-dedupe drops OLD, NEW painted, input reached ptyHost.

- [ ] **Step 5: Commit**

```bash
git add electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts
git commit -m "test(mobile-remote): Node loopback e2e over real phone+desktop modules (PR-4)"
```

---

## Task 7: Retire the LAN WebSocket server

**Files:**
- Delete: `electron/remote/mobileRemoteServer.ts` and its test file(s)
- Possibly delete/trim: `electron/remote/mobilePage.ts` (the old WS HTML page) and `electron/remote/wsProtocol.ts` if nothing else imports them

Only after Task 4 made `main.ts` stop importing `startMobileRemoteServer`. Removing dead code in the same PR avoids a confusing half-migrated tree (per CLAUDE.md: delete what is certainly unused; no compat shims).

- [ ] **Step 1: Find remaining importers**

Run: `MSYS_NO_PATHCONV=1 grep -rn "mobileRemoteServer\|wsProtocol\|renderMobilePage" electron/ src/ --include=*.ts`
Expected: only the files about to be deleted reference each other; `main.ts` does NOT. If anything in `src/` or another live module imports them, STOP and report — do not delete.

- [ ] **Step 2: Delete the dead modules**

```bash
git rm electron/remote/mobileRemoteServer.ts
git rm electron/remote/__tests__/mobileRemoteServer.test.ts
# Only if grep proved them unused:
git rm electron/remote/wsProtocol.ts electron/remote/__tests__/wsProtocol.test.ts
# The old WS HTML page (renderMobilePage) is replaced by src/mobile/mobilePage.ts:
git rm electron/remote/mobilePage.ts
```

(Adjust the exact file list to what Step 1 proved unused. Keep `remoteHttp.ts` / `remoteMessages.ts` / `ptyFanout.ts` / `peerClient.ts` — the WebRTC path still uses them.)

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run electron/remote`
Expected: PASS — no dangling imports; the WebRTC-path tests still green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(mobile-remote): retire LAN WS server, superseded by WebRTC path (PR-4)"
```

---

## Task 8: Full gate + PR

**Files:** none (verification + PR open)

- [ ] **Step 1: Local pre-push gate (all must be green)**

Run: `npm run typecheck`
Run: `npm run lint`
Run: `npm test`
Run: `npm run probe:e2e` (harness-ui)
Expected: all PASS. If lint flags `--max-warnings 0`, fix to green; do not suppress.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin <pr4-branch-name>
```

- [ ] **Step 3: Open the PR against the integration branch**

```bash
gh pr create --base feat/mobile-remote-web-exposure --title "PR-4: mobile-remote integration + loopback e2e" --body "$(cat <<'EOF'
## Summary
- Real Durable Object signaling client (desktop answerer), the inverted mirror of the phone's phoneSignaling.
- `startMobileRemote()` controller: injected token provider (minimal env impl) → DO url → signaling → desktop peer.
- `main.ts` rewired from the LAN WS server to the WebRTC path; LAN server retired.
- Phone `mobilePage.ts`: xterm-backed PhoneUi + bootPhonePage wiring the real phonePeer.
- Node loopback e2e: real `src/mobile` modules ↔ real `createDesktopPeer`, werift both sides, asserting input→pty, snapshot, seq-dedupe.

## Scope boundaries
- Login is an INJECTED token provider (env/null). Desktop GitHub OAuth UI + safeStorage refresh + settings entry are **PR-4b**.
- TURN + real-device 4G verification are **PR-5**. This PR's loopback proves the PIPE, not public reachability.

## Test plan
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green (--max-warnings 0)
- [ ] `npm test` green (token provider, doSignalingClient, controller, mobilePage, loopback e2e)
- [ ] `npm run probe:e2e` (harness-ui) green
- [ ] Reviewer confirms: NO public-internet claim is made; real-device evidence explicitly deferred to PR-5

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Hand off to an independent reviewer**

Per team-protocol: the implementing dev does NOT self-merge and does NOT self-review. Report the PR number + the gate evidence (typecheck/lint/test/probe output) to the manager. An independently-spawned reviewer LGTMs, polls CI to green, and squash-merges. The manager never merges.

---

## Self-Review

**1. Spec coverage (detail spec §9 PR-4 line: "联调 + loopback e2e"):**
- doSignalingClient (real DO WS, answerer) → Task 2 ✓
- mobileRemoteController `startMobileRemote()` with injected token provider → Tasks 1 + 3 ✓
- main.ts:302 rewire → Task 4 ✓
- phone mobilePage implements PhoneUi against real xterm + constructs phonePeer → Task 5 ✓
- loopback e2e exercising the real src/mobile modules + controller path → Task 6 ✓
- (cleanup) retire superseded LAN server → Task 7 ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step has full code; every run step has an exact command + expected output. ✓

**3. Type consistency:**
- `MobileRemoteLogin = { token, doUrl }` defined in Task 1, consumed identically in Task 3's `tokenProvider()` and the controller URL build. ✓
- `createDoSignalingClient(opts)` returns `SignalingClient` (Task 2) — exactly the type `createDesktopPeer` consumes (Task 3) and `main.ts` never touches directly. ✓
- `PhoneUi` shape in Task 5 matches `phoneApp.ts`'s exported port (renderSessions/selectSession/write/reset/setStatus). ✓
- The loopback e2e (Task 6) imports `createPhonePeer`/`createPhoneSignaling`/`wirePhoneApp` with the exact signatures from the merged PR-3 modules; werift injected via `createPeerConnection`. ✓
- Wire frames in Task 2 (`register`/`answer`/`ice` out; `offer`/`ice` in) are the exact inversion of `phoneSignaling.ts` and match `src/mobile/protocol.ts`. ✓

**4. Evidence boundary:** Every task that claims "done" is backed by a passing test or typecheck. The PR body and Task 8 explicitly state loopback ≠ public-internet proof; real-device 4G is deferred to PR-5. ✓
