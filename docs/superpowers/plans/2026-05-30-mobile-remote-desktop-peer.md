# Mobile Remote Desktop Peer (PR-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the desktop-side WebRTC peer that runs the existing terminal protocol over a werift DataChannel instead of a WebSocket, proven by a werift↔werift local-loopback test — no Cloudflare, no phone, no external accounts required.

**Architecture:** Extract the transport-agnostic core of the current mobile-remote server (`handleClientMessage` + `onPtyData` fan-out + list-poll) behind a minimal `PeerClient` interface (`{ send, subscribedSid }`). Add a `desktopPeer` unit that wraps a werift `RTCPeerConnection`, accepts an offer, answers it, opens a DataChannel, and wires that channel's `onmessage`/`send` to the reused protocol core. A `signalingClient` unit is defined as an injectable interface here but its real Cloudflare wiring is deferred to PR-1/PR-4; this plan injects a fake signaling transport so the peer is fully testable in plain Node.

**Tech Stack:** TypeScript, Electron main process, [werift](https://github.com/shinyoshiaki/werift-webrtc) (pure-TS WebRTC, no native build), vitest. Reuses `electron/remote/remoteMessages.ts` and `electron/ptyHost/`.

---

## Scope & Boundaries

This plan is **PR-2 only** from the detail spec §9. It is deliberately the slice that needs zero external resources, so it can be implemented and reviewed end-to-end offline.

**In scope:**
- Install werift; confirm it adds no native rebuild.
- Extract `PeerClient` interface; make `handleClientMessage` + fan-out depend on it (not `WsClient`).
- `desktopPeer`: werift peer that answers an offer, opens a DataChannel, runs the reused protocol.
- `signalingClient` **interface** (transport-injectable) + a fake in-memory signaling pair for tests.
- werift↔werift loopback test proving `session.input`→`inputPtySession`, `pty.data` fan-out, and `subscribedSid` isolation all work over a DataChannel.

**Explicitly OUT of scope (later PRs):**
- Cloudflare Worker / Durable Object (PR-1).
- Real GitHub OAuth, `userHash`, TURN credential signing (PR-1/PR-5).
- Phone PWA browser client (PR-3).
- `mobileRemoteController` multi-phone real wiring into `main.ts:302` (PR-4) — this plan builds `createDesktopPeer` as a unit but does NOT yet replace `startMobileRemoteServer` in `main.ts`. The old LAN server stays untouched until PR-4 so we never have a half-wired main process.

**Reference:** detail spec `docs/superpowers/specs/2026-05-30-mobile-remote-public-internet-detail.md` §1.2 (C/D), §2, §6.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `electron/remote/peerClient.ts` | Minimal transport-agnostic client interface `PeerClient = { send, subscribedSid }`. The seam that lets one protocol core serve both WS and DataChannel. | Create |
| `electron/remote/remoteMessages.ts` | Reused protocol dispatch. Change its import of `WsClient` → `PeerClient`. Logic unchanged. | Modify (1 type import + signature) |
| `electron/remote/wsProtocol.ts` | `WsClient` keeps its WS-specific fields but now `extends PeerClient` so the existing WS server still type-checks. | Modify (1 line) |
| `electron/remote/ptyFanout.ts` | Transport-agnostic `pty.data` fan-out over a set of `PeerClient`s (extracted from `mobileRemoteServer.ts` so both WS and DataChannel reuse the cross-session-leak gate). | Create |
| `electron/remote/signaling.ts` | `SignalingClient` interface (offer/answer/ice exchange) + types. No Cloudflare here — just the contract the peer depends on. | Create |
| `electron/remote/desktopPeer.ts` | `createDesktopPeer(opts)`: werift `RTCPeerConnection`, answers offer, opens DataChannel, wires to `handleClientMessage` + `ptyFanout`. | Create |
| `electron/remote/__tests__/peerClient.test.ts` | Unit: protocol core runs against a fake `PeerClient`. | Create |
| `electron/remote/__tests__/ptyFanout.test.ts` | Unit: fan-out only delivers to clients whose `subscribedSid` matches. | Create |
| `electron/remote/__tests__/desktopPeer.loopback.test.ts` | Integration: two werift peers build a real DataChannel; the offerer drives the protocol and asserts ptyHost calls + isolation. | Create |

---

## Task 1: Install werift, confirm no native rebuild

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (generated)

- [ ] **Step 1: Install werift**

Run:
```bash
npm install werift
```
Expected: werift added under `dependencies`; install completes without a node-gyp/electron-rebuild compile step for werift (better-sqlite3/node-pty still rebuild as usual — that is pre-existing).

- [ ] **Step 2: Confirm werift pulled no native addon**

Run:
```bash
node -e "const p=require('./package.json'); console.log('werift:', p.dependencies.werift)"
node -e "console.log(require('werift').RTCPeerConnection ? 'RTCPeerConnection OK' : 'MISSING')"
```
Expected: prints the werift version, then `RTCPeerConnection OK`. (If the second errors with a native-binding message, STOP — werift should be pure JS; investigate before continuing.)

- [ ] **Step 3: Typecheck still green**

Run:
```bash
npm run typecheck
```
Expected: PASS (no code changed yet; this baselines the toolchain with werift present).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(mobile-remote): add werift (pure-TS WebRTC) for desktop peer"
```

---

## Task 2: Extract `PeerClient` interface

**Files:**
- Create: `electron/remote/peerClient.ts`
- Modify: `electron/remote/wsProtocol.ts:4-23`
- Test: `electron/remote/__tests__/peerClient.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/remote/__tests__/peerClient.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../ptyHost', () => ({
  listPtySessions: vi.fn(() => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }]),
  getBufferSnapshot: vi.fn(async () => ({ data: 'hello', seq: 0 })),
  getPtySession: vi.fn(() => ({ cols: 80, rows: 24 })),
  inputPtySession: vi.fn(),
  resizePtySession: vi.fn(),
  onPtyData: vi.fn(() => () => {}),
}));

import { handleClientMessage } from '../remoteMessages';
import type { PeerClient } from '../peerClient';
import { inputPtySession } from '../../ptyHost';

function makeFakeClient(): PeerClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, subscribedSid: null, send: (p) => sent.push(p) };
}

describe('handleClientMessage over PeerClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers sessions.list', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'sessions.list' }));
    expect(c.sent).toEqual([{ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24 }] }]);
  });

  it('routes session.input to ptyHost', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'session.input', sid: 's1', data: 'x' }));
    expect(inputPtySession).toHaveBeenCalledWith('s1', 'x');
  });

  it('records subscribedSid on snapshot', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'session.snapshot', sid: 's1' }));
    expect(c.subscribedSid).toBe('s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run electron/remote/__tests__/peerClient.test.ts
```
Expected: FAIL — `Cannot find module '../peerClient'` (file not created yet).

- [ ] **Step 3: Create the `PeerClient` interface**

Create `electron/remote/peerClient.ts`:
```ts
/** The minimal, transport-agnostic surface the terminal protocol needs from a
 *  connected client. Both the LAN WebSocket server (`WsClient`) and the WebRTC
 *  DataChannel peer satisfy this — `handleClientMessage` and the pty.data
 *  fan-out depend ONLY on these two members, so the same protocol core serves
 *  both pipes (detail spec §6 "swap the pipe, keep the protocol"). */
export type PeerClient = {
  /** The single session id this client is viewing, set on `session.snapshot`.
   *  The pty.data fan-out forwards a session's bytes only to clients whose
   *  `subscribedSid` matches — without it every client gets every session's raw
   *  output (cross-session leak). `null` = not subscribed yet. */
  subscribedSid: string | null;
  send: (payload: unknown) => void;
};
```

- [ ] **Step 4: Point `remoteMessages.ts` at `PeerClient`**

In `electron/remote/remoteMessages.ts`, change the import and signature. Replace line 9:
```ts
import type { WsClient } from './wsProtocol';
```
with:
```ts
import type { PeerClient } from './peerClient';
```
and change the `handleClientMessage` signature (line 33) from `client: WsClient` to `client: PeerClient`. No other changes — the body already uses only `client.send` and `client.subscribedSid`.

- [ ] **Step 5: Make `WsClient` extend `PeerClient`**

In `electron/remote/wsProtocol.ts`, change `export type WsClient = {` (line 4) to:
```ts
import type { PeerClient } from './peerClient';

export type WsClient = PeerClient & {
```
and delete the now-duplicated `subscribedSid` and `send` members from the `WsClient` body (they come from `PeerClient`). Keep `socket`, `pending`, `fragment`, `isAlive`.

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
npx vitest run electron/remote/__tests__/peerClient.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck the whole project (the WS server must still compile)**

Run:
```bash
npm run typecheck
```
Expected: PASS — `mobileRemoteServer.ts` still builds because `WsClient` now extends `PeerClient`.

- [ ] **Step 8: Commit**

```bash
git add electron/remote/peerClient.ts electron/remote/remoteMessages.ts electron/remote/wsProtocol.ts electron/remote/__tests__/peerClient.test.ts
git commit -m "refactor(mobile-remote): extract transport-agnostic PeerClient interface"
```

---

## Task 3: Extract transport-agnostic pty.data fan-out

**Files:**
- Create: `electron/remote/ptyFanout.ts`
- Test: `electron/remote/__tests__/ptyFanout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/remote/__tests__/ptyFanout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fanoutPtyData } from '../ptyFanout';
import type { PeerClient } from '../peerClient';

function client(subscribedSid: string | null): PeerClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, subscribedSid, send: (p) => sent.push(p) };
}

describe('fanoutPtyData', () => {
  it('delivers a session\'s bytes only to clients viewing that session', () => {
    const a = client('s1');
    const b = client('s2');
    const c = client(null);
    fanoutPtyData(new Set([a, b, c]), 's1', 'OUT', 7);
    expect(a.sent).toEqual([{ type: 'pty.data', sid: 's1', chunk: 'OUT', seq: 7 }]);
    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run electron/remote/__tests__/ptyFanout.test.ts
```
Expected: FAIL — `Cannot find module '../ptyFanout'`.

- [ ] **Step 3: Create the fan-out**

Create `electron/remote/ptyFanout.ts`:
```ts
import type { PeerClient } from './peerClient';

/** Forward one session's terminal bytes to every connected client viewing that
 *  session. The `subscribedSid` gate is the cross-session-leak guard: without
 *  it every client receives every session's raw output. `seq` is ptyHost's
 *  authoritative per-session chunk counter, forwarded verbatim so the client
 *  can dedupe live chunks already baked into a snapshot. Transport-agnostic:
 *  works for WS and DataChannel clients alike (detail spec §6). */
export function fanoutPtyData(
  clients: Iterable<PeerClient>,
  sid: string,
  chunk: string,
  seq: number,
): void {
  for (const client of clients) {
    if (client.subscribedSid !== sid) continue;
    client.send({ type: 'pty.data', sid, chunk, seq });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run electron/remote/__tests__/ptyFanout.test.ts
```
Expected: PASS.

- [ ] **Step 5: Rewire the existing WS server to use the shared fan-out**

In `electron/remote/mobileRemoteServer.ts`, replace the inline fan-out loop (lines 146-153, the body of the `onPtyData` callback) with a call to the shared helper. The callback becomes:
```ts
  const offPtyData = onPtyData((sid, chunk, seq) => {
    fanoutPtyData(clients, sid, chunk, seq);
  });
```
Add the import at the top: `import { fanoutPtyData } from './ptyFanout';`.

- [ ] **Step 6: Typecheck + run the existing mobile-remote tests**

Run:
```bash
npm run typecheck && npx vitest run electron/remote
```
Expected: PASS — behavior of the WS server is unchanged (same gate, now shared).

- [ ] **Step 7: Commit**

```bash
git add electron/remote/ptyFanout.ts electron/remote/mobileRemoteServer.ts electron/remote/__tests__/ptyFanout.test.ts
git commit -m "refactor(mobile-remote): share pty.data fan-out across transports"
```

---

## Task 4: Define the signaling interface + in-memory fake

**Files:**
- Create: `electron/remote/signaling.ts`

This task creates only the contract + a test double. No real network. The fake is exported from the test file in Task 5; here we define the interface the peer depends on.

- [ ] **Step 1: Create the signaling contract**

Create `electron/remote/signaling.ts`:
```ts
/** WebRTC signaling is the out-of-band exchange of SDP offer/answer and ICE
 *  candidates that lets two peers find each other. In production this rides a
 *  Cloudflare Durable Object WebSocket (detail spec §3); here we depend only on
 *  this interface so the desktop peer is testable with an in-memory fake and
 *  the real transport lands in a later PR without touching peer logic. */
export type SignalDescription = { type: 'offer' | 'answer'; sdp: string };
export type SignalCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

export type SignalingClient = {
  /** Desktop is the answerer: it is handed the phone's offer. */
  onOffer: (cb: (offer: SignalDescription, peerId: string) => void) => void;
  onRemoteIce: (cb: (cand: SignalCandidate, peerId: string) => void) => void;
  sendAnswer: (answer: SignalDescription, peerId: string) => void;
  sendIce: (cand: SignalCandidate, peerId: string) => void;
  close: () => void;
};
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS (interface only, nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add electron/remote/signaling.ts
git commit -m "feat(mobile-remote): define WebRTC signaling interface"
```

---

## Task 5: `createDesktopPeer` — werift answerer wired to the protocol core

**Files:**
- Create: `electron/remote/desktopPeer.ts`
- Test: `electron/remote/__tests__/desktopPeer.loopback.test.ts`

This is the heart of PR-2: a real werift↔werift DataChannel proving the reused protocol runs over WebRTC. The test stands up a phone-side werift peer (the offerer) and an in-memory signaling bus connecting the two.

- [ ] **Step 1: Write the failing loopback test**

Create `electron/remote/__tests__/desktopPeer.loopback.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RTCPeerConnection } from 'werift';

const inputCalls: Array<[string, string]> = [];
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }],
  getBufferSnapshot: async () => ({ data: '', seq: 0 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: (sid: string, data: string) => { inputCalls.push([sid, data]); },
  resizePtySession: () => {},
  onPtyData: (cb: (sid: string, chunk: string, seq: number) => void) => {
    emitPtyData = cb;
    return () => { emitPtyData = null; };
  },
}));

let emitPtyData: ((sid: string, chunk: string, seq: number) => void) | null = null;

import { createDesktopPeer } from '../desktopPeer';
import type { SignalingClient, SignalDescription, SignalCandidate } from '../signaling';

/** In-memory signaling bus: directly hands the desktop side whatever the phone
 *  side produces and vice-versa. No network. */
function makeSignalingPair() {
  let onOfferCb: ((o: SignalDescription, p: string) => void) | null = null;
  let onIceCb: ((c: SignalCandidate, p: string) => void) | null = null;
  const phone = {
    deliverAnswer: null as null | ((a: SignalDescription) => void),
    deliverIce: null as null | ((c: SignalCandidate) => void),
    sendOffer(o: SignalDescription) { onOfferCb?.(o, 'phone1'); },
    sendIce(c: SignalCandidate) { onIceCb?.(c, 'phone1'); },
  };
  const desktopSignaling: SignalingClient = {
    onOffer: (cb) => { onOfferCb = cb; },
    onRemoteIce: (cb) => { onIceCb = cb; },
    sendAnswer: (a) => phone.deliverAnswer?.(a),
    sendIce: (c) => phone.deliverIce?.(c),
    close: () => {},
  };
  return { phone, desktopSignaling };
}

describe('createDesktopPeer loopback', () => {
  beforeEach(() => { inputCalls.length = 0; });

  it('runs session.input over a real DataChannel into ptyHost', async () => {
    const { phone, desktopSignaling } = makeSignalingPair();
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const peer = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    const phonePc = new RTCPeerConnection({ iceServers: [] });
    const dc = phonePc.createDataChannel('terminal');
    phonePc.onIceCandidate.subscribe((c) => { if (c) phone.sendIce(c as SignalCandidate); });
    phone.deliverAnswer = async (a) => { await phonePc.setRemoteDescription(a as any); };
    phone.deliverIce = async (c) => { await phonePc.addIceCandidate(c as any); };

    const offer = await phonePc.createOffer();
    await phonePc.setLocalDescription(offer);
    phone.sendOffer({ type: 'offer', sdp: offer.sdp });

    await new Promise<void>((resolve) => { dc.onopen = () => resolve(); });
    dc.send(JSON.stringify({ type: 'session.input', sid: 's1', data: 'ls\n' }));

    await vi.waitFor(() => expect(inputCalls).toEqual([['s1', 'ls\n']]), { timeout: 5000 });

    peer.close();
    await phonePc.close();
  }, 15000);

  it('forwards pty.data only after subscribe and only for the viewed session', async () => {
    const { phone, desktopSignaling } = makeSignalingPair();
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const peer = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    const phonePc = new RTCPeerConnection({ iceServers: [] });
    const dc = phonePc.createDataChannel('terminal');
    phonePc.onIceCandidate.subscribe((c) => { if (c) phone.sendIce(c as SignalCandidate); });
    phone.deliverAnswer = async (a) => { await phonePc.setRemoteDescription(a as any); };
    phone.deliverIce = async (c) => { await phonePc.addIceCandidate(c as any); };

    const received: any[] = [];
    dc.onmessage = (e) => received.push(JSON.parse(e.data as string));

    const offer = await phonePc.createOffer();
    await phonePc.setLocalDescription(offer);
    phone.sendOffer({ type: 'offer', sdp: offer.sdp });
    await new Promise<void>((resolve) => { dc.onopen = () => resolve(); });

    // Before subscribe: a pty.data for s1 must NOT reach this client.
    emitPtyData?.('s1', 'early', 1);
    // Subscribe to s1, then emit again.
    dc.send(JSON.stringify({ type: 'session.snapshot', sid: 's1' }));
    await vi.waitFor(() => expect(received.some((m) => m.type === 'session.snapshot')).toBe(true), { timeout: 5000 });
    emitPtyData?.('s2', 'wrong-session', 2);
    emitPtyData?.('s1', 'right-session', 3);

    await vi.waitFor(() => {
      const data = received.filter((m) => m.type === 'pty.data');
      expect(data).toEqual([{ type: 'pty.data', sid: 's1', chunk: 'right-session', seq: 3 }]);
    }, { timeout: 5000 });

    peer.close();
    await phonePc.close();
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run electron/remote/__tests__/desktopPeer.loopback.test.ts
```
Expected: FAIL — `Cannot find module '../desktopPeer'`.

- [ ] **Step 3: Implement `createDesktopPeer`**

Create `electron/remote/desktopPeer.ts`:
```ts
import { RTCPeerConnection } from 'werift';
import { onPtyData } from '../ptyHost';
import { handleClientMessage, listEntries } from './remoteMessages';
import { fanoutPtyData } from './ptyFanout';
import type { PeerClient } from './peerClient';
import type { SignalingClient } from './signaling';

/** Builds the desktop WebRTC answerer: it accepts a phone's offer via the
 *  injected signaling transport, opens the `terminal` DataChannel, and runs the
 *  EXISTING terminal protocol (`handleClientMessage` + pty.data fan-out) over
 *  that channel. The DataChannel replaces the WebSocket; the protocol core is
 *  untouched (detail spec §1.2-D, §6). `clients` is the shared peer set the
 *  pty.data fan-out iterates — owned by the caller so multiple phones can be
 *  tracked together (detail spec §5.7). */
export function createDesktopPeer(opts: {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  signaling: SignalingClient;
  clients: Set<PeerClient>;
}): { close: () => void } {
  const { signaling, clients } = opts;
  const pcs = new Set<RTCPeerConnection>();

  const offPtyData = onPtyData((sid, chunk, seq) => {
    fanoutPtyData(clients, sid, chunk, seq);
  });

  signaling.onOffer(async (offer, peerId) => {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    pcs.add(pc);

    pc.onIceCandidate.subscribe((cand) => {
      if (cand) signaling.sendIce(cand, peerId);
    });

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== 'terminal') return;
      const client: PeerClient = {
        subscribedSid: null,
        send: (payload) => {
          if (channel.readyState === 'open') channel.send(JSON.stringify(payload));
        },
      };
      channel.message.subscribe((msg) => {
        const raw = typeof msg === 'string' ? msg : msg.toString();
        void handleClientMessage(client, raw);
      });
      // The phone learns the session list as soon as the channel opens, same as
      // the WS server's initial push (mobileRemoteServer.ts:108). auth.ok is
      // gone — auth happened at the signaling/GitHub layer (detail spec §6).
      const pushList = () => client.send({ type: 'sessions.list', sessions: listEntries() });
      if (channel.readyState === 'open') pushList();
      else channel.stateChanged.subscribe((s) => { if (s === 'open') pushList(); });
      clients.add(client);

      const drop = () => clients.delete(client);
      channel.stateChanged.subscribe((s) => { if (s === 'closed') drop(); });
    });

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.sendAnswer({ type: 'answer', sdp: answer.sdp }, peerId);
  });

  signaling.onRemoteIce(async (cand) => {
    for (const pc of pcs) {
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* candidate may target a different pc; ignore mismatches */
      }
    }
  });

  return {
    close: () => {
      offPtyData();
      signaling.close();
      for (const pc of pcs) void pc.close();
      pcs.clear();
      clients.clear();
    },
  };
}
```

> **werift API note for the implementer:** werift's `RTCPeerConnection` uses observable-style callbacks (`onIceCandidate.subscribe`, `onDataChannel.subscribe`, `channel.message.subscribe`, `channel.stateChanged.subscribe`) rather than browser `on*=` setters. If a method name differs in the installed werift version, check `node_modules/werift/lib/.../peerConnection.d.ts` and adjust — keep the wiring identical, only the event-subscription syntax may shift. The browser-style `dc.onopen`/`dc.onmessage` used in the TEST file is the phone side standing in for a browser; werift also supports those on its channels, but prefer the `.subscribe` form on the desktop side for reliability.

- [ ] **Step 4: Run the loopback test to verify it passes**

Run:
```bash
npx vitest run electron/remote/__tests__/desktopPeer.loopback.test.ts
```
Expected: PASS (2 tests). If the DataChannel never opens (test times out), the most likely cause is ICE not completing on loopback — werift should connect host candidates locally with `iceServers: []`; verify candidates are being relayed through the fake signaling bus (`phone.sendIce` ↔ `signaling.sendIce`).

- [ ] **Step 5: Full gate**

Run:
```bash
npm run typecheck && npm run lint && npx vitest run electron/remote
```
Expected: PASS on all three. Lint runs `--max-warnings 0`, so fix any unused-import/any warnings the new files introduce (the werift candidate `cand` is typed by werift; avoid `as any` in non-test code — use werift's exported candidate type if lint flags it).

- [ ] **Step 6: Commit**

```bash
git add electron/remote/desktopPeer.ts electron/remote/__tests__/desktopPeer.loopback.test.ts
git commit -m "feat(mobile-remote): desktop WebRTC peer runs terminal protocol over DataChannel"
```

---

## Task 6: Full local gate + plan-completion check

**Files:** none (verification only)

- [ ] **Step 1: Run the whole local pre-push gate**

Run:
```bash
npm run typecheck && npm run lint && npm test
```
Expected: all PASS. This is the project's required pre-push gate (memory: local pre-push gate).

- [ ] **Step 2: Confirm the old LAN server is untouched at the wiring level**

Run:
```bash
git diff --stat main -- electron/main.ts
```
Expected: **no changes to `main.ts`** — PR-2 adds the peer as a unit but does not rewire the main process (that is PR-4). `startMobileRemoteServer` still runs as before.

- [ ] **Step 3: Final commit if any lint fixups were needed**

```bash
git add -A
git commit -m "chore(mobile-remote): lint/typecheck fixups for desktop peer" || echo "nothing to commit"
```

---

## What this PR proves (and does not)

**Proves:** the existing terminal protocol runs unmodified over a real werift DataChannel; `session.input` reaches `inputPtySession`; `pty.data` fan-out honors `subscribedSid` isolation over the channel; werift adds no native build.

**Does NOT prove (later PRs / real-device):** public-internet reachability, NAT hole-punching, TURN fallback, GitHub auth, the phone browser client. Per project memory, **loopback is not public-internet evidence** — that requires PR-3+ and a real 4G device test by the user.

---

## Deferred to other PRs (tracked so nothing is silently dropped)

- **PR-1:** Cloudflare Worker + Durable Object signaling, GitHub OAuth, `userHash` pairing, TURN credential signing. Needs the GitHub OAuth App client id/secret (user provides; goes into Worker secret, not the repo) and a `workers.dev` subdomain.
- **PR-3:** Phone PWA browser peer (`phonePeer` + `phoneSignaling`), replacing the old WS mobile client; wires the browser `RTCPeerConnection` to xterm.
- **PR-4:** `mobileRemoteController` + `startMobileRemote()` replacing `startMobileRemoteServer()` at `main.ts:302`; multi-phone peer management; retire the LAN-only server.
- **PR-5:** Short-lived TURN credentials end-to-end; user verifies on a real phone over 4G (the only public-internet evidence).
