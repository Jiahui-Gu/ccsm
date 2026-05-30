# Mobile Remote Phone PWA (PR-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the phone-side WebRTC **offerer** that runs the existing terminal protocol over a browser-native `RTCDataChannel` — driven by the real Cloudflare Durable Object signaling transport (PR-1) — proven by vitest unit tests against faked `RTCPeerConnection` / `WebSocket` / `fetch`, no real browser, no Cloudflare account, no phone required at this stage.

**Architecture:** PR-2 built the desktop **answerer** behind two seams: `SignalingClient` (offer/answer/ice exchange) and `PeerClient` (`{ send, subscribedSid }`). PR-3 builds the symmetric **offerer** half as framework-free, dependency-injected TypeScript modules under `src/mobile/`. `phoneSignaling` implements the *phone* side of the PR-1 Durable Object WebSocket protocol (`register{role:"phone"}` → `peer-present` → send `offer` → receive `answer` → trickle `ice`). `phonePeer` wraps a browser `RTCPeerConnection`, **creates** the `terminal` DataChannel, generates the offer, and exposes the same message stream the existing `mobilePage.ts` xterm glue already consumes (`sessions.list` / `session.snapshot` / `pty.data`). A thin `phoneApp` wiring layer swaps the existing `WebSocket('/ws')` transport in the mobile page for `phonePeer`'s DataChannel — "swap the pipe, keep the protocol," mirroring PR-2. All browser APIs are injected as factories so vitest fakes them in plain Node.

**Tech Stack:** TypeScript, browser-native WebRTC (`RTCPeerConnection`, `RTCDataChannel`), `WebSocket`, `fetch`, vitest (jsdom for DOM-touching tests, node default elsewhere). Reuses the terminal-protocol **message shapes** from `electron/remote/remoteMessages.ts` (by re-declaring the wire types in `src/`, NOT by importing `electron/`). Reuses the existing xterm UI in `electron/remote/mobilePage.ts`.

---

## Scope & Boundaries

This plan is **PR-3 only** from the detail spec §9. It is the phone browser client, symmetric to PR-2's desktop peer. Like PR-2 it needs **zero external resources to implement and review**: every browser/Cloudflare API is injected and faked in tests. The real DO/GitHub endpoints are only exercised by humans at PR-4 (loopback e2e) and PR-5 (real-device 4G).

**In scope:**
- `src/mobile/protocol.ts` — re-declared terminal-protocol wire types + signaling wire types (the `src/`-side mirror of the shapes PR-1's DO and PR-2's `remoteMessages.ts` already speak). No `electron/` import.
- `src/mobile/phoneSignaling.ts` — phone half of the PR-1 DO WebSocket protocol, behind an injected WebSocket factory. Emits offer-send / answer-received / ice callbacks symmetric to PR-2's `SignalingClient`.
- `src/mobile/phonePeer.ts` — `createPhonePeer(opts)`: browser `RTCPeerConnection` (injected factory), **creates** the `terminal` DataChannel, makes the offer, trickles ICE, and surfaces decoded terminal messages + a `send()` for `session.input`/`session.resize`/`session.snapshot`.
- `src/mobile/githubLogin.ts` — turns the GitHub OAuth redirect result (a `?token=<sessionJWT>` on the PWA URL) into the bearer the signaling transport uses to open the DO WebSocket. Pure URL/string logic; no network.
- `src/mobile/phoneApp.ts` — thin wiring: given a `phonePeer`, drive the existing xterm UI (the `mobilePage.ts` render layer) — `selectSession`, `term.write`, resize forwarding. Transport-swap only; protocol untouched.
- Unit tests for each, using faked `RTCPeerConnection` / `WebSocket` / `fetch` (no real browser, no Cloudflare).

**Explicitly OUT of scope (later PRs):**
- Wiring `phoneApp` into the served HTML (`mobilePage.ts` still ships its WS client). PR-3 builds the modules + tests; the page rewire to DataChannel transport lands in **PR-4** (联调), so we never ship a half-swapped page. (Symmetric to PR-2 deliberately NOT touching `main.ts:302`.)
- Real Cloudflare DO / GitHub OAuth round-trips, TURN credential fetch (PR-1 owns the server; PR-5 owns TURN + real-device).
- `werift↔headless-Chromium` loopback e2e (PR-4).
- Real-device 4G verification — the ONLY public-internet evidence (PR-5).

**Reference:** detail spec `docs/superpowers/specs/2026-05-30-mobile-remote-public-internet-detail.md` §1.3-F, §2, §3, §6; PR-1 detail `docs/superpowers/specs/2026-05-30-mobile-remote-pr1-cloudflare-detail.md` §6.3 (DO WS message schema). PR-2 answerer (the half this mirrors): `electron/remote/{signaling,peerClient,desktopPeer,ptyFanout}.ts` on `origin/feat/mobile-remote-web-exposure`.

---

## CLAUDE.md hard rule (do not violate)

`src/` MUST NOT import from `electron/`. The phone is pure browser code. The terminal-protocol and signaling **wire types** are therefore *re-declared* in `src/mobile/protocol.ts`. They must stay structurally identical to `electron/remote/remoteMessages.ts` (terminal msgs) and `electron/remote/signaling.ts` + PR-1 `pairingDo.ts` (signaling msgs). A drift between the two declarations is a wire-incompatibility bug; Task 1 Step 1 pins the shapes with an explicit comment cross-referencing both authorities.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/mobile/protocol.ts` | Re-declared wire types: terminal (`SessionListEntry`, client→desktop and desktop→phone message unions) mirroring `remoteMessages.ts`, and signaling (`register`/`peer-present`/`offer`/`answer`/`ice`/`error`) mirroring PR-1 DO schema §6.3. No `electron/` import. | Create |
| `src/mobile/phoneSignaling.ts` | `createPhoneSignaling(opts)`: opens the DO WebSocket (injected factory) to `wss://<host>/do/<userHash>?token=<jwt>`, sends `register{role:"phone"}`, exposes `onPeerPresent` / `onAnswer` / `onRemoteIce` and `sendOffer` / `sendIce`. The phone-side mirror of PR-2's `SignalingClient`. | Create |
| `src/mobile/phonePeer.ts` | `createPhonePeer(opts)`: browser `RTCPeerConnection` (injected), creates the `terminal` DataChannel, `createOffer`→`setLocalDescription`→`sendOffer`, applies the answer, trickles ICE both ways, decodes inbound JSON to typed terminal messages, exposes `send()` + `onMessage` + `onOpen`. The offerer symmetric to `desktopPeer.ts`. | Create |
| `src/mobile/githubLogin.ts` | `readSessionToken(locationSearch)`: extract the session JWT the PWA was handed via `?token=` after the Worker's OAuth callback redirect; `buildLoginUrl(workerOrigin, redirectUri)`: the URL the "Login with GitHub" button points at. Pure string/URL logic. | Create |
| `src/mobile/phoneApp.ts` | `wirePhoneApp(peer, ui)`: connects a `phonePeer`'s message stream + `send` to the xterm UI callbacks (select session, write bytes, forward input/resize). Transport-swap glue; no protocol logic. | Create |
| `src/mobile/__tests__/protocol.test.ts` | Type/shape guards: a sample of each wire message round-trips JSON and matches the declared type (compile-time + runtime field assertions). | Create |
| `src/mobile/__tests__/phoneSignaling.test.ts` | Unit: faked WebSocket. Asserts `register{role:"phone"}` sent on open, `peer-present` fires `onPeerPresent`, inbound `answer`/`ice` fire callbacks, `sendOffer`/`sendIce` emit correct framed JSON with `to`/`from`. | Create |
| `src/mobile/__tests__/phonePeer.test.ts` | Unit: faked `RTCPeerConnection` + `RTCDataChannel`. Asserts offer created & sent via signaling, answer applied, ICE trickled both directions, inbound channel JSON decoded to `onMessage`, `send()` serializes to the channel. | Create |
| `src/mobile/__tests__/githubLogin.test.ts` | Unit: token extraction from query string (present / absent / malformed), login URL construction. | Create |
| `src/mobile/__tests__/phoneApp.test.ts` | Unit (jsdom): faked peer + a fake UI object; asserts `sessions.list`→render, first session auto-selected, `pty.data`→`ui.write`, `session.snapshot`→reset+write, input/resize forwarded to `peer.send`. | Create |

All new code lives under `src/mobile/`. No file under `src/` imports anything under `electron/`.

---

## Task 1: Re-declare the wire types in `src/mobile/protocol.ts`

**Files:**
- Create: `src/mobile/protocol.ts`
- Test: `src/mobile/__tests__/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/protocol.test.ts
import { describe, it, expect } from 'vitest';
import type {
  SessionListEntry,
  PhoneToDesktop,
  DesktopToPhone,
  SignalRegister,
  SignalOffer,
  SignalAnswer,
  SignalIce,
} from '../protocol';

describe('protocol wire shapes', () => {
  it('terminal client→desktop messages serialize with required fields', () => {
    const input: PhoneToDesktop = { type: 'session.input', sid: 's1', data: 'ls\r' };
    const resize: PhoneToDesktop = { type: 'session.resize', sid: 's1', cols: 80, rows: 24 };
    const snap: PhoneToDesktop = { type: 'session.snapshot', sid: 's1' };
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    expect(JSON.parse(JSON.stringify(resize))).toEqual(resize);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('terminal desktop→phone messages carry the fields the xterm UI reads', () => {
    const list: DesktopToPhone = {
      type: 'sessions.list',
      sessions: [{ sid: 's1', cwd: '/repo', cols: 80, rows: 24 } satisfies SessionListEntry],
    };
    const data: DesktopToPhone = { type: 'pty.data', sid: 's1', chunk: 'x', seq: 7 };
    expect(list.sessions[0].sid).toBe('s1');
    expect(data.seq).toBe(7);
  });

  it('signaling messages mirror the PR-1 DO schema (§6.3)', () => {
    const reg: SignalRegister = { type: 'register', role: 'phone', peerId: 'p1' };
    const offer: SignalOffer = { type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0...' };
    const answer: SignalAnswer = { type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0...' };
    const ice: SignalIce = { type: 'ice', to: 'd1', from: 'p1', candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 };
    expect(reg.role).toBe('phone');
    expect(offer.to).toBe('d1');
    expect(answer.from).toBe('d1');
    expect(ice.sdpMLineIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/protocol.test.ts`
Expected: FAIL — `Cannot find module '../protocol'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/protocol.ts
/** Phone-side mirror of the on-the-wire message shapes. CLAUDE.md forbids
 *  src/ importing electron/, so these are RE-DECLARED here and must stay
 *  structurally identical to their authorities:
 *   - terminal messages  ↔ electron/remote/remoteMessages.ts
 *   - signaling messages ↔ PR-1 Durable Object schema, pr1-cloudflare-detail
 *     §6.3, and electron/remote/signaling.ts (PR-2 desktop side).
 *  Any drift here is a wire-incompatibility bug. */

// ---- terminal protocol (DataChannel payloads, detail spec §6) ----

export type SessionListEntry = { sid: string; cwd: string; cols: number; rows: number };

export type PhoneToDesktop =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.resize'; sid: string; cols: number; rows: number };

export type DesktopToPhone =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | { type: 'session.snapshot'; sid: string; cols: number | null; rows: number | null; snapshot: string; seq: number }
  | { type: 'pty.data'; sid: string; chunk: string; seq: number }
  | { type: 'error'; message: string };

// ---- signaling protocol (DO WebSocket, detail spec §3, PR-1 §6.3) ----

export type SignalRole = 'desktop' | 'phone';

export type SignalRegister = { type: 'register'; role: SignalRole; peerId: string };
export type SignalOffer = { type: 'offer'; to: string; from: string; sdp: string };
export type SignalAnswer = { type: 'answer'; to: string; from: string; sdp: string };
export type SignalIce = {
  type: 'ice';
  to: string;
  from: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

export type SignalRegistered = { type: 'registered'; peerId: string; peers: { role: SignalRole; peerId: string }[] };
export type SignalPeerPresent = { type: 'peer-present'; role: SignalRole; peerId: string };
export type SignalPeerGone = { type: 'peer-gone'; role: SignalRole; peerId: string };
export type SignalError = { type: 'error'; code: string; message: string };

export type SignalInbound =
  | SignalRegistered
  | SignalPeerPresent
  | SignalPeerGone
  | SignalOffer
  | SignalAnswer
  | SignalIce
  | SignalError;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/protocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/protocol.ts src/mobile/__tests__/protocol.test.ts
git commit -m "feat(mobile-remote): declare phone-side wire types for PR-3"
```

---

## Task 2: `phoneSignaling` — phone half of the DO WebSocket protocol

**Files:**
- Create: `src/mobile/phoneSignaling.ts`
- Test: `src/mobile/__tests__/phoneSignaling.test.ts`

The signaling transport is injected as a `WebSocket`-like factory so the test drives it with a fake. This mirrors PR-2's `SignalingClient` interface but on the phone (offerer) side: the phone learns the desktop peerId via `peer-present`/`registered`, then sends `offer`/`ice` and receives `answer`/`ice`.

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/phoneSignaling.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPhoneSignaling } from '../phoneSignaling';
import type { SignalInbound } from '../protocol';

/** Minimal WebSocket fake: records sent frames, lets the test push inbound. */
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
  // test helpers
  fireOpen() { this.onopen?.(); }
  push(msg: SignalInbound) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  lastJson() { return JSON.parse(this.sent[this.sent.length - 1]); }
}

function setup() {
  const ws = new FakeWs();
  const sig = createPhoneSignaling({
    url: 'wss://ccsm-worker.example.workers.dev/do/HASH?token=JWT',
    peerId: 'p1',
    createWebSocket: () => ws as unknown as WebSocket,
  });
  return { ws, sig };
}

describe('createPhoneSignaling', () => {
  it('registers as phone on open', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    expect(ws.lastJson()).toEqual({ type: 'register', role: 'phone', peerId: 'p1' });
    sig.close();
  });

  it('reports the desktop peer from registered.peers and peer-present', () => {
    const { ws, sig } = setup();
    const onPeer = vi.fn();
    sig.onPeerPresent(onPeer);
    ws.fireOpen();
    ws.push({ type: 'registered', peerId: 'p1', peers: [{ role: 'desktop', peerId: 'd1' }] });
    expect(onPeer).toHaveBeenCalledWith('d1');
    ws.push({ type: 'peer-present', role: 'desktop', peerId: 'd2' });
    expect(onPeer).toHaveBeenCalledWith('d2');
    sig.close();
  });

  it('ignores a phone peer in registered/peer-present (only desktop matters)', () => {
    const { ws, sig } = setup();
    const onPeer = vi.fn();
    sig.onPeerPresent(onPeer);
    ws.fireOpen();
    ws.push({ type: 'registered', peerId: 'p1', peers: [{ role: 'phone', peerId: 'pX' }] });
    ws.push({ type: 'peer-present', role: 'phone', peerId: 'pY' });
    expect(onPeer).not.toHaveBeenCalled();
    sig.close();
  });

  it('sendOffer / sendIce frame to the desktop peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendOffer({ sdp: 'v=0-offer' }, 'd1');
    expect(ws.lastJson()).toEqual({ type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0-offer' });
    sig.sendIce({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }, 'd1');
    expect(ws.lastJson()).toEqual({
      type: 'ice', to: 'd1', from: 'p1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0,
    });
    sig.close();
  });

  it('routes inbound answer and ice to callbacks', () => {
    const { ws, sig } = setup();
    const onAnswer = vi.fn();
    const onIce = vi.fn();
    sig.onAnswer(onAnswer);
    sig.onRemoteIce(onIce);
    ws.fireOpen();
    ws.push({ type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0-answer' });
    expect(onAnswer).toHaveBeenCalledWith({ sdp: 'v=0-answer' }, 'd1');
    ws.push({ type: 'ice', to: 'p1', from: 'd1', candidate: 'c2', sdpMid: '0', sdpMLineIndex: 1 });
    expect(onIce).toHaveBeenCalledWith({ candidate: 'c2', sdpMid: '0', sdpMLineIndex: 1 }, 'd1');
    sig.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/phoneSignaling.test.ts`
Expected: FAIL — `Cannot find module '../phoneSignaling'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/phoneSignaling.ts
import type { SignalInbound, SignalRegister, SignalOffer, SignalIce } from './protocol';

export type SignalDescription = { sdp: string };
export type SignalCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

/** The phone (offerer) side of the Durable Object signaling protocol. Mirrors
 *  the desktop SignalingClient (PR-2) but inverted: the phone SENDS offer/ice
 *  and RECEIVES answer/ice. The WebSocket is injected so tests fake it and the
 *  real `wss://<host>/do/<userHash>?token=<jwt>` URL is built by the caller
 *  (detail spec §3, PR-1 §6.3). */
export function createPhoneSignaling(opts: {
  url: string;
  peerId: string;
  createWebSocket?: (url: string) => WebSocket;
}) {
  const make = opts.createWebSocket ?? ((u: string) => new WebSocket(u));
  const ws = make(opts.url);

  let peerCb: ((desktopPeerId: string) => void) | null = null;
  let answerCb: ((answer: SignalDescription, from: string) => void) | null = null;
  let iceCb: ((cand: SignalCandidate, from: string) => void) | null = null;

  ws.onopen = () => {
    const reg: SignalRegister = { type: 'register', role: 'phone', peerId: opts.peerId };
    ws.send(JSON.stringify(reg));
  };

  ws.onmessage = (ev: { data: unknown }) => {
    let msg: SignalInbound;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'registered':
        for (const p of msg.peers) if (p.role === 'desktop') peerCb?.(p.peerId);
        return;
      case 'peer-present':
        if (msg.role === 'desktop') peerCb?.(msg.peerId);
        return;
      case 'answer':
        answerCb?.({ sdp: msg.sdp }, msg.from);
        return;
      case 'ice':
        iceCb?.({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }, msg.from);
        return;
      default:
        return;
    }
  };

  return {
    onPeerPresent: (cb: (desktopPeerId: string) => void) => { peerCb = cb; },
    onAnswer: (cb: (answer: SignalDescription, from: string) => void) => { answerCb = cb; },
    onRemoteIce: (cb: (cand: SignalCandidate, from: string) => void) => { iceCb = cb; },
    sendOffer: (offer: SignalDescription, to: string) => {
      const m: SignalOffer = { type: 'offer', to, from: opts.peerId, sdp: offer.sdp };
      ws.send(JSON.stringify(m));
    },
    sendIce: (cand: SignalCandidate, to: string) => {
      const m: SignalIce = {
        type: 'ice', to, from: opts.peerId,
        candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex,
      };
      ws.send(JSON.stringify(m));
    },
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/phoneSignaling.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/phoneSignaling.ts src/mobile/__tests__/phoneSignaling.test.ts
git commit -m "feat(mobile-remote): phone-side DO signaling transport (offerer)"
```

---

## Task 3: `phonePeer` — browser offerer over a DataChannel

**Files:**
- Create: `src/mobile/phonePeer.ts`
- Test: `src/mobile/__tests__/phonePeer.test.ts`

`phonePeer` is the symmetric counterpart of `desktopPeer.ts`: the desktop is the answerer (waits for an offer, `onDataChannel`); the phone is the **offerer** — it **creates** the `terminal` DataChannel, builds the offer, sends it via signaling, applies the answer, and trickles ICE. Browser `RTCPeerConnection` is injected so the test drives a fake. Inbound channel JSON is decoded to typed `DesktopToPhone` messages; `send()` serializes `PhoneToDesktop`.

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/phonePeer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPhonePeer } from '../phonePeer';
import type { DesktopToPhone } from '../protocol';

/** Fake RTCDataChannel: records sent frames, lets the test push inbound + open. */
class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(s: string) { this.sent.push(s); }
  fireOpen() { this.readyState = 'open'; this.onopen?.(); }
  push(msg: DesktopToPhone) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

/** Fake RTCPeerConnection capturing the offer/answer/ice flow. */
class FakePc {
  channel = new FakeChannel();
  localDesc: any = null;
  remoteDesc: any = null;
  added: any[] = [];
  onicecandidate: ((ev: { candidate: any }) => void) | null = null;
  createDataChannel(label: string) {
    expect(label).toBe('terminal');
    return this.channel as unknown as RTCDataChannel;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0-offer' }; }
  async setLocalDescription(d: any) { this.localDesc = d; }
  async setRemoteDescription(d: any) { this.remoteDesc = d; }
  async addIceCandidate(c: any) { this.added.push(c); }
  close() {}
  // test helper
  fireIce(candidate: any) { this.onicecandidate?.({ candidate }); }
}

function setup() {
  const pc = new FakePc();
  const signaling = {
    onPeerPresent: vi.fn(),
    onAnswer: vi.fn(),
    onRemoteIce: vi.fn(),
    sendOffer: vi.fn(),
    sendIce: vi.fn(),
    close: vi.fn(),
  };
  const peer = createPhonePeer({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    signaling,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
  });
  return { pc, signaling, peer };
}

describe('createPhonePeer (offerer)', () => {
  it('on peer-present, creates the terminal channel and sends an offer', async () => {
    const { pc, signaling } = setup();
    const onPresent = signaling.onPeerPresent.mock.calls[0][0];
    await onPresent('d1');
    expect(pc.localDesc).toEqual({ type: 'offer', sdp: 'v=0-offer' });
    expect(signaling.sendOffer).toHaveBeenCalledWith({ sdp: 'v=0-offer' }, 'd1');
  });

  it('applies the answer it receives', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0][0]('d1');
    const onAnswer = signaling.onAnswer.mock.calls[0][0];
    await onAnswer({ sdp: 'v=0-answer' }, 'd1');
    expect(pc.remoteDesc).toEqual({ type: 'answer', sdp: 'v=0-answer' });
  });

  it('trickles local ICE to signaling and applies remote ICE', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0][0]('d1');
    pc.fireIce({ candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 });
    expect(signaling.sendIce).toHaveBeenCalledWith(
      { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 }, 'd1',
    );
    const onIce = signaling.onRemoteIce.mock.calls[0][0];
    await onIce({ candidate: 'rc', sdpMid: '0', sdpMLineIndex: 1 }, 'd1');
    expect(pc.added[0]).toEqual({ candidate: 'rc', sdpMid: '0', sdpMLineIndex: 1 });
  });

  it('null local ICE candidate (end-of-candidates) is not forwarded', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0][0]('d1');
    pc.fireIce(null);
    expect(signaling.sendIce).not.toHaveBeenCalled();
  });

  it('decodes inbound channel JSON to onMessage and fires onOpen', async () => {
    const { pc, peer } = setup();
    await pc; // ensure constructed
    const onMessage = vi.fn();
    const onOpen = vi.fn();
    peer.onMessage(onMessage);
    peer.onOpen(onOpen);
    pc.channel.fireOpen();
    expect(onOpen).toHaveBeenCalled();
    pc.channel.push({ type: 'pty.data', sid: 's1', chunk: 'x', seq: 1 });
    expect(onMessage).toHaveBeenCalledWith({ type: 'pty.data', sid: 's1', chunk: 'x', seq: 1 });
  });

  it('send() serializes a PhoneToDesktop message onto the open channel', async () => {
    const { pc, peer } = setup();
    pc.channel.fireOpen();
    peer.send({ type: 'session.input', sid: 's1', data: 'ls\r' });
    expect(JSON.parse(pc.channel.sent[0])).toEqual({ type: 'session.input', sid: 's1', data: 'ls\r' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/phonePeer.test.ts`
Expected: FAIL — `Cannot find module '../phonePeer'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/phonePeer.ts
import type { DesktopToPhone, PhoneToDesktop } from './protocol';
import type { SignalCandidate, SignalDescription } from './phoneSignaling';

type PhoneSignaling = {
  onPeerPresent: (cb: (desktopPeerId: string) => void) => void;
  onAnswer: (cb: (answer: SignalDescription, from: string) => void) => void;
  onRemoteIce: (cb: (cand: SignalCandidate, from: string) => void) => void;
  sendOffer: (offer: SignalDescription, to: string) => void;
  sendIce: (cand: SignalCandidate, to: string) => void;
  close: () => void;
};

/** Phone WebRTC offerer. Symmetric to the desktop answerer (desktopPeer.ts):
 *  the phone CREATES the `terminal` DataChannel and the offer, the desktop
 *  answers. Browser RTCPeerConnection is injected so this is unit-testable in
 *  plain Node (detail spec §1.3-F, §2). Terminal payloads on the channel are
 *  the unchanged protocol (§6). */
export function createPhonePeer(opts: {
  iceServers: RTCIceServer[];
  signaling: PhoneSignaling;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}): {
  send: (msg: PhoneToDesktop) => void;
  onMessage: (cb: (msg: DesktopToPhone) => void) => void;
  onOpen: (cb: () => void) => void;
  close: () => void;
} {
  const { signaling } = opts;
  const make = opts.createPeerConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const pc = make({ iceServers: opts.iceServers });
  const channel = pc.createDataChannel('terminal');

  let desktopPeerId: string | null = null;
  let messageCb: ((msg: DesktopToPhone) => void) | null = null;
  let openCb: (() => void) | null = null;

  channel.onopen = () => openCb?.();
  channel.onmessage = (ev: MessageEvent) => {
    let msg: DesktopToPhone;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    messageCb?.(msg);
  };

  pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
    const c = ev.candidate;
    // null candidate = end-of-candidates; nothing to forward.
    if (!c || !desktopPeerId) return;
    signaling.sendIce(
      { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
      desktopPeerId,
    );
  };

  signaling.onPeerPresent(async (id) => {
    desktopPeerId = id;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendOffer({ sdp: offer.sdp ?? '' }, id);
  });

  signaling.onAnswer(async (answer) => {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  });

  signaling.onRemoteIce(async (cand) => {
    try {
      await pc.addIceCandidate({
        candidate: cand.candidate,
        sdpMid: cand.sdpMid ?? undefined,
        sdpMLineIndex: cand.sdpMLineIndex ?? undefined,
      });
    } catch { /* candidate may arrive before remoteDescription; browser retries */ }
  });

  return {
    send: (msg: PhoneToDesktop) => {
      if (channel.readyState === 'open') channel.send(JSON.stringify(msg));
    },
    onMessage: (cb) => { messageCb = cb; },
    onOpen: (cb) => { openCb = cb; },
    close: () => {
      signaling.close();
      try { pc.close(); } catch { /* already closed */ }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/phonePeer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/phonePeer.ts src/mobile/__tests__/phonePeer.test.ts
git commit -m "feat(mobile-remote): phone WebRTC offerer over DataChannel"
```

---

## Task 4: `githubLogin` — session-token plumbing

**Files:**
- Create: `src/mobile/githubLogin.ts`
- Test: `src/mobile/__tests__/githubLogin.test.ts`

The Worker runs the GitHub OAuth web flow and redirects the PWA back with a short-lived session JWT on the URL (`?token=<jwt>`), per detail spec §4.1. The phone code does NOT see the GitHub access token (minimal权限). This unit is the small, pure surface that reads that token and builds the login-button URL — no network, so it is trivially testable.

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/githubLogin.test.ts
import { describe, it, expect } from 'vitest';
import { readSessionToken, buildLoginUrl } from '../githubLogin';

describe('githubLogin', () => {
  it('reads the session token from the query string', () => {
    expect(readSessionToken('?token=abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null when no token is present', () => {
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('?foo=bar')).toBeNull();
  });

  it('url-decodes the token', () => {
    expect(readSessionToken('?token=a%2Bb')).toBe('a+b');
  });

  it('builds the GitHub login URL pointing at the Worker callback', () => {
    const url = buildLoginUrl('https://ccsm-worker.example.workers.dev', 'https://pwa.example/');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://ccsm-worker.example.workers.dev');
    expect(parsed.pathname).toBe('/auth/github/login');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://pwa.example/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/githubLogin.test.ts`
Expected: FAIL — `Cannot find module '../githubLogin'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/githubLogin.ts
/** The Worker completes the GitHub OAuth web flow (it holds the client secret)
 *  and redirects the PWA back with a short-lived session JWT on the URL. The
 *  phone never sees the GitHub access token — minimal privilege (detail spec
 *  §4.1). This module is the pure token/URL plumbing around that. */

export function readSessionToken(locationSearch: string): string | null {
  return new URLSearchParams(locationSearch).get('token');
}

export function buildLoginUrl(workerOrigin: string, redirectUri: string): string {
  const url = new URL('/auth/github/login', workerOrigin);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/githubLogin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/githubLogin.ts src/mobile/__tests__/githubLogin.test.ts
git commit -m "feat(mobile-remote): phone GitHub session-token plumbing"
```

---

## Task 5: `phoneApp` — wire the peer to the xterm UI

**Files:**
- Create: `src/mobile/phoneApp.ts`
- Test: `src/mobile/__tests__/phoneApp.test.ts`

`phoneApp` is the transport-swap glue, symmetric to how `mobilePage.ts`'s inline `ws.onmessage` drives xterm today — but reading from a `phonePeer` instead of a `WebSocket`. It is deliberately UI-agnostic: it takes a small `ui` port (the operations the xterm layer exposes) so the test uses a fake UI and no real DOM/xterm. The real `mobilePage.ts` rewire to call this is **PR-4**, not here (§ Scope).

- [ ] **Step 1: Write the failing test**

```ts
// src/mobile/__tests__/phoneApp.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { wirePhoneApp } from '../phoneApp';
import type { DesktopToPhone, PhoneToDesktop } from '../protocol';

/** A fake phonePeer: lets the test push inbound messages and capture sends. */
function fakePeer() {
  let msgCb: ((m: DesktopToPhone) => void) | null = null;
  let openCb: (() => void) | null = null;
  const sent: PhoneToDesktop[] = [];
  return {
    peer: {
      send: (m: PhoneToDesktop) => sent.push(m),
      onMessage: (cb: (m: DesktopToPhone) => void) => { msgCb = cb; },
      onOpen: (cb: () => void) => { openCb = cb; },
      close: () => {},
    },
    push: (m: DesktopToPhone) => msgCb?.(m),
    fireOpen: () => openCb?.(),
    sent,
  };
}

function fakeUi() {
  return {
    renderSessions: vi.fn(),
    selectSession: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    setStatus: vi.fn(),
  };
}

describe('wirePhoneApp', () => {
  it('on open, sets status and requests the session list', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.fireOpen();
    expect(ui.setStatus).toHaveBeenCalledWith('connected');
    expect(f.sent).toContainEqual({ type: 'sessions.list' });
  });

  it('renders sessions.list and auto-selects the first session', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [
      { sid: 's1', cwd: '/a', cols: 80, rows: 24 },
      { sid: 's2', cwd: '/b', cols: 80, rows: 24 },
    ]});
    expect(ui.renderSessions).toHaveBeenCalled();
    expect(ui.selectSession).toHaveBeenCalledWith('s1');
    // selecting requests a snapshot
    expect(f.sent).toContainEqual({ type: 'session.snapshot', sid: 's1' });
  });

  it('paints a snapshot then live pty.data, dropping chunks already in the snapshot', () => {
    const f = fakePeer();
    const ui = fakeUi();
    const app = wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    f.push({ type: 'session.snapshot', sid: 's1', cols: 80, rows: 24, snapshot: 'HELLO', seq: 5 });
    expect(ui.reset).toHaveBeenCalled();
    expect(ui.write).toHaveBeenCalledWith('HELLO');
    // seq <= snapshot seq is already baked in → dropped
    f.push({ type: 'pty.data', sid: 's1', chunk: 'old', seq: 5 });
    // seq > snapshot seq → painted
    f.push({ type: 'pty.data', sid: 's1', chunk: 'new', seq: 6 });
    expect(ui.write).not.toHaveBeenCalledWith('old');
    expect(ui.write).toHaveBeenCalledWith('new');
    void app;
  });

  it('forwards input and resize to the peer', () => {
    const f = fakePeer();
    const ui = fakeUi();
    const app = wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    app.sendInput('ls\r');
    app.sendResize(100, 40);
    expect(f.sent).toContainEqual({ type: 'session.input', sid: 's1', data: 'ls\r' });
    expect(f.sent).toContainEqual({ type: 'session.resize', sid: 's1', cols: 100, rows: 40 });
  });

  it('ignores pty.data / snapshot for a non-active session', () => {
    const f = fakePeer();
    const ui = fakeUi();
    wirePhoneApp(f.peer, ui);
    f.push({ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/a', cols: 80, rows: 24 }] });
    ui.write.mockClear();
    f.push({ type: 'pty.data', sid: 'OTHER', chunk: 'z', seq: 9 });
    expect(ui.write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mobile/__tests__/phoneApp.test.ts`
Expected: FAIL — `Cannot find module '../phoneApp'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mobile/phoneApp.ts
import type { DesktopToPhone, PhoneToDesktop, SessionListEntry } from './protocol';

type PhonePeer = {
  send: (msg: PhoneToDesktop) => void;
  onMessage: (cb: (msg: DesktopToPhone) => void) => void;
  onOpen: (cb: () => void) => void;
  close: () => void;
};

/** The UI port the xterm layer exposes. Keeping it abstract lets the wiring be
 *  tested without a real DOM/xterm; mobilePage.ts implements it against the
 *  actual Terminal in PR-4. */
export type PhoneUi = {
  renderSessions: (sessions: SessionListEntry[], activeSid: string) => void;
  selectSession: (sid: string) => void;
  write: (chunk: string) => void;
  reset: () => void;
  setStatus: (status: 'connecting' | 'connected' | 'reconnecting') => void;
};

/** Drive the xterm UI from a phonePeer's message stream — the DataChannel
 *  analogue of mobilePage.ts's `ws.onmessage`. Protocol unchanged: this is the
 *  "swap the pipe, keep the protocol" wiring (detail spec §6). */
export function wirePhoneApp(peer: PhonePeer, ui: PhoneUi) {
  let activeSid = '';
  // Live pty.data chunks with seq <= snapSeq are already in the snapshot we
  // painted; drop them to avoid double-paint (mirrors mobilePage.ts).
  let snapSeq = -1;

  function select(sid: string) {
    activeSid = sid;
    snapSeq = -1;
    ui.selectSession(sid);
    ui.reset();
    peer.send({ type: 'session.snapshot', sid });
  }

  peer.onOpen(() => {
    ui.setStatus('connected');
    peer.send({ type: 'sessions.list' });
  });

  peer.onMessage((msg) => {
    if (msg.type === 'sessions.list') {
      ui.renderSessions(msg.sessions, activeSid);
      if (!activeSid && msg.sessions.length) select(msg.sessions[0].sid);
      return;
    }
    if (msg.type === 'session.snapshot' && msg.sid === activeSid) {
      ui.reset();
      ui.write(msg.snapshot || '');
      snapSeq = Number.isInteger(msg.seq) ? msg.seq : -1;
      return;
    }
    if (msg.type === 'pty.data' && msg.sid === activeSid) {
      if (Number.isInteger(msg.seq) && msg.seq <= snapSeq) return;
      ui.write(msg.chunk || '');
      return;
    }
  });

  return {
    select,
    sendInput: (data: string) => {
      if (activeSid) peer.send({ type: 'session.input', sid: activeSid, data });
    },
    sendResize: (cols: number, rows: number) => {
      if (activeSid) peer.send({ type: 'session.resize', sid: activeSid, cols, rows });
    },
    close: () => peer.close(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mobile/__tests__/phoneApp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mobile/phoneApp.ts src/mobile/__tests__/phoneApp.test.ts
git commit -m "feat(mobile-remote): wire phone peer to xterm UI (transport swap)"
```

---

## Task 6: Full gate + confirm no `electron/` import and no page rewire

**Files:**
- Verify only (no product change)

- [ ] **Step 1: Assert `src/mobile/` does not import `electron/`**

Run:
```bash
grep -rn "from '.*electron/" src/mobile/ || echo "OK: no electron import"
grep -rn 'from "\.\..*electron/' src/mobile/ || echo "OK: no electron import (double-quote)"
```
Expected: both print `OK: no electron import`. (CLAUDE.md hard rule.)

- [ ] **Step 2: Assert the served page was NOT rewired (that is PR-4)**

Run:
```bash
git diff --stat origin/feat/mobile-remote-web-exposure -- electron/remote/mobilePage.ts
```
Expected: EMPTY output — `mobilePage.ts` is untouched; the WS client still ships. PR-3 only adds `src/mobile/` modules + tests.

- [ ] **Step 3: Full local pre-push gate**

Run:
```bash
npm run typecheck && npm run lint && npm test
```
Expected: all green. (Project memory: typecheck + lint + unit must be green locally before push — `--max-warnings 0`.)

- [ ] **Step 4: Confirm the new test count**

Run:
```bash
npx vitest run src/mobile/ --reporter=basic
```
Expected: 5 test files, all passing (protocol 3, phoneSignaling 5, phonePeer 6, githubLogin 4, phoneApp 5 = 23 tests).

- [ ] **Step 5: Push the branch and open the PR (do NOT self-merge)**

```bash
git push -u origin <pr3-branch>
gh pr create --base feat/mobile-remote-web-exposure \
  --title "feat(mobile-remote): PR-3 phone PWA WebRTC offerer + DO signaling" \
  --body "$(cat <<'EOF'
## Summary
- Phone-side (offerer) of the public-internet mobile remote, symmetric to PR-2's desktop answerer.
- `src/mobile/`: `protocol` (re-declared wire types), `phoneSignaling` (DO WS, phone half), `phonePeer` (browser offerer over DataChannel), `githubLogin` (session-token plumbing), `phoneApp` (transport-swap glue to xterm UI).
- All browser/Cloudflare APIs injected and faked; 23 unit tests, no real browser/Cloudflare needed.
- `src/` does NOT import `electron/`. The served `mobilePage.ts` is NOT rewired (transport swap lands in PR-4).

## Test plan
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green (`--max-warnings 0`)
- [ ] `npm test` green
- [ ] Independent reviewer confirms: no `electron/` import in `src/mobile/`; `mobilePage.ts` diff empty; wire types match PR-1 §6.3 + `remoteMessages.ts`.
- [ ] NOT public-internet evidence — real-device 4G is PR-5.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

> **Implementer note (team-protocol):** Stop here. Report the PR number + the local gate evidence to the manager. Do NOT run `gh pr merge`. An independent reviewer reviews and merges (project memory: implementing agent never self-merges, never self-reviews).

---

## Self-Review

**1. Spec coverage (detail §1.3-F):** GitHub login → `githubLogin.ts` (Task 4); 连 DO → `phoneSignaling.ts` (Task 2); 作为 offerer 发起 WebRTC → `phonePeer.ts` (Task 3); 建 DataChannel → `phonePeer` creates `'terminal'` channel; 接到 xterm UI → `phoneApp.ts` (Task 5). 依赖浏览器原生 `RTCPeerConnection`/`fetch`/`WebSocket` → all injected as factories. `src/` 不 import `electron/` → Task 6 Step 1 asserts it. Terminal protocol unchanged (§6) → `protocol.ts` re-declares the exact shapes; `phoneApp` mirrors `mobilePage.ts` logic incl. `snapSeq` dedupe. Signaling protocol (§3 / PR-1 §6.3) → `phoneSignaling` sends `register{role:"phone"}`, handles `registered`/`peer-present`/`answer`/`ice`, frames `offer`/`ice` with `to`/`from`.

**2. Placeholder scan:** No TBD/TODO; every code step has full code; every run step has an exact command + expected output.

**3. Type consistency:** `SignalDescription`/`SignalCandidate` are defined in `phoneSignaling.ts` and imported by `phonePeer.ts` (matches). `PhoneToDesktop`/`DesktopToPhone`/`SessionListEntry` defined in `protocol.ts`, consumed by `phonePeer` + `phoneApp` (matches). `PhoneUi`/`PhonePeer` ports defined once and reused. `createPhonePeer` returns `{ send, onMessage, onOpen, close }` — the fake in Task 5 and the impl agree. Channel label `'terminal'` matches PR-2's `desktopPeer` answerer check.

**4. Symmetry check vs PR-2:** desktop = answerer (`onDataChannel`, `setRemoteDescription(offer)`→`createAnswer`→`sendAnswer`); phone = offerer (`createDataChannel`, `createOffer`→`setLocalDescription`→`sendOffer`, apply answer). ICE trickle both ways on both sides. `null` candidate guard present on both. Confirmed symmetric.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Per the standing team-protocol directive, this will be executed subagent-driven: an independent plan reviewer first, then a dev subagent implements task-by-task, then an independent code reviewer reviews + merges. The manager never self-merges.
