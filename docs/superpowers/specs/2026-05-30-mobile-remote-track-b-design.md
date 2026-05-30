# Mobile Remote — Track B: WebSocket Robustness (Design)

Date: 2026-05-30
Status: approved direction (user authorized autonomous push A→D until nothing left; user does final real-device verify)
Scope owner: parent session

## Goal

Make the mobile remote WebSocket connection survive the messy reality of a
phone on cellular/Wi-Fi: networks that vanish without a TCP FIN, sockets that
go half-open, and several phones connected at once. PR #1422 + #1436 made the
client *functional* and *pleasant*; this track makes the *server* resilient to
clients that disappear ungracefully.

Non-goal: transport abstraction (Track C), DEBT paydown (Track D), TLS/relay
tuning (tailscale, network-layer).

## Problem statement (verified against current code)

Read of `mobileRemoteServer.ts` + `wsProtocol.ts` confirms:

1. **No server-side liveness detection (the load-bearing gap).** The frame
   decoder *replies* to inbound Ping with Pong (`pongs` in `decodeFrames`) and
   *ignores* inbound Pong (opcode 0xa → "ignore"). But the server never *sends*
   a Ping and has no timer. When a phone drops off the network without a clean
   close (airplane mode, tunnel, Wi-Fi→cellular handoff), TCP gives no FIN for
   minutes. The `WsClient` stays in the `clients` Set, and `onPtyData` keeps
   calling `client.send()` → `socket.write()` into a dead socket. The zombie is
   only reaped if/when the OS eventually errors the socket. Result: leaked
   clients, wasted writes, and (with the Track-A 2 s list poll) repeated
   broadcasts to corpses.

2. **No bound on dead-client accumulation.** Multiple reconnect cycles from one
   flaky phone can leave several zombie `WsClient`s, each still targeted by the
   per-session `pty.data` fan-out loop. Nothing trims them proactively.

3. **Multi-client is *mostly* fine already — verify, don't rebuild.** Each
   client has its own `subscribedSid`; the fan-out gate
   (`client.subscribedSid !== sid`) is per-client; input/resize are addressed by
   `sid` not by client. Two phones on the same session both receive its
   `pty.data` and both can type (bytes interleave at the PTY — acceptable and
   expected for a shared terminal). No code change needed here; Track B adds a
   regression test asserting two simultaneous clients each get only their
   subscribed session's bytes.

### Explicitly NOT a problem (YAGNI — do not build)

- **Disconnect buffering / replay queue.** On reconnect the client already
  re-snapshots from `getBufferSnapshot` (authoritative buffer) and dedupes live
  chunks by `seq <= snapSeq`. That fully repaints correct state. A per-client
  server-side ring buffer of missed chunks would duplicate the snapshot
  mechanism for no user-visible gain and add eviction/memory complexity. The
  roadmap listed "disconnect buffering" as a candidate; this spec **drops it**
  as redundant with the existing snapshot path.

## Design

Two small, isolated additions. All server-side; the client (`mobilePage.ts`)
needs no change because browsers auto-answer server Pings with Pongs at the
WebSocket layer — the page JS never sees them.

### 1. Per-client liveness field (`wsProtocol.ts`)

Add one field to `WsClient`:

```ts
/** Set true whenever a Pong (or any inbound frame) is observed from this
 *  client. The heartbeat sweep clears it before each Ping and reaps the
 *  client on the next sweep if it's still false — i.e. a full Ping interval
 *  passed with zero inbound traffic. */
isAlive: boolean;
```

Initialize `isAlive: true` at client creation. The decoder already returns
`pongs`; the server marks `isAlive = true` on *any* successful decode that
yields messages, pongs, or even a clean partial read with bytes consumed — but
to keep it simple and correct we mark `isAlive = true` specifically when a Pong
is received (the heartbeat's own signal) and also on any inbound data message
(real activity also proves liveness). Concretely: set `isAlive = true` in the
`socket.on('data')` handler whenever `decoded.pongs.length > 0` or
`decoded.messages.length > 0`.

### 2. Heartbeat sweep (`mobileRemoteServer.ts`)

A single `setInterval` (one timer for the whole server, not per-client),
`.unref()`'d like the existing list-poll timer:

```ts
const HEARTBEAT_MS = 30_000;
const heartbeatTimer = setInterval(() => {
  for (const client of clients) {
    if (!client.isAlive) {
      // Missed a full interval with no Pong/activity → half-open. Reap.
      closeSocket(client.socket, 1001); // going away
      clients.delete(client);
      continue;
    }
    client.isAlive = false;            // expect a Pong before next sweep
    if (!client.socket.destroyed) {
      client.socket.write(encodeControlFrame(0x9, Buffer.alloc(0))); // Ping
    }
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref();
```

- 30 s interval: long enough to be negligible traffic/battery on the phone,
  short enough that a dead client is reaped within ~60 s worst case (one
  interval to mark, one to detect). Matches common WS keepalive defaults.
- `closeSocket(socket, 1001)` reuses the existing graceful-close path (flush
  close frame before FIN — the PR #1341 pattern already used elsewhere here).
- Cleared in the server's `close()` alongside the existing
  `clearInterval(listPollTimer)`.

### 3. Multi-client regression test only (no code)

Assert in the test that two clients subscribed to different sids each receive
only their own session's `pty.data`, confirming the existing fan-out gate.

## Files touched

- `electron/remote/wsProtocol.ts` — add `isAlive` to `WsClient` type.
- `electron/remote/mobileRemoteServer.ts` — initialize `isAlive`; mark alive on
  inbound pong/message in the `data` handler; add the heartbeat sweep timer;
  clear it in `close()`. Import `encodeControlFrame` (already imported) +
  `Buffer` (global).
- `electron/__tests__/mobileRemoteServer.test.ts` — (a) heartbeat: a client
  that never Pongs is closed within two sweep intervals; a client that Pongs
  survives; (b) multi-client fan-out isolation.

## Error handling / edge cases

- Client disconnects between sweeps → `socket.on('close')` already deletes it;
  the sweep's `socket.destroyed` guard + `closeSocket` re-entry guard
  (`writableEnded`) make a double-close safe.
- Server `close()` → `clearInterval(heartbeatTimer)` so no Ping fires after
  shutdown; existing per-client `closeSocket(_, 1001)` loop unchanged.
- A browser that for some reason never auto-Pongs would be reaped; that browser
  is non-conformant (all mainstream mobile browsers auto-Pong), and reaping is
  the correct behavior — the client auto-reconnects (Track A backoff) and
  re-snapshots.
- Heartbeat interval is *not* configurable via env — no need; one constant.

## Testing

1. **Unit (committed):**
   - Heartbeat reap: open a real WS client against the compiled server, suppress
     its automatic Pong (or use a raw socket that ignores Ping), advance/await
     past two `HEARTBEAT_MS` intervals (use a short test override or fake timers
     — see note), assert the server closed the socket and dropped the client.
   - Heartbeat survive: a client that *does* answer Pongs stays connected across
     intervals.
   - Multi-client isolation: two clients, two sids; emit `pty.data` for sid A,
     assert only client A's socket received it.
   - Note on timing: 30 s is too long for a unit test. Make `HEARTBEAT_MS`
     overridable in tests via an internal optional param to
     `startMobileRemoteServer` (e.g. `{ heartbeatMs }` options arg defaulting to
     30_000) — keeps prod behavior fixed while letting the test use ~50 ms.
     This is the one small API seam Track B adds; it's test-only surface.
2. **Headless proof (scratch `.mrharness/`, not committed):** extend the
   existing harness to open two browser contexts (two phones), subscribe each to
   a different session, and assert isolation + that a context which goes offline
   (CDP `Network.emulateNetworkConditions` offline, or just close the socket) is
   reaped server-side within the heartbeat window while the other survives.
3. **Real device:** not required for Track B — the behaviors (half-open reap,
   fan-out isolation) are network/server-side and fully provable headless.
   Unlike Track A (soft keyboard), there is no OS-level interaction that
   headless cannot reach. State this explicitly in the PR.

## Local gate before push

`npm run typecheck` + `npm run lint` + `npm test` + the headless harness proof
must all be green locally before opening the PR (per local-pre-push-gate).

## Out of scope (explicitly deferred)

- Disconnect replay buffer → dropped as redundant with snapshot (see above).
- Transport abstraction (`window.ccsm` IPC/WS unification) → Track C.
- TLS/relay/tailscale latency → network-layer, not code.
