# 08 — Session model: backend-authoritative + snapshot+delta + broadcast + LWW

> **Hard rule:** the PTY/session model is N≥3-correct from the first commit. There is no "v0.3 only has Electron, optimize for N=1, generalize later" path.

## Why backend-authoritative

Final-architecture §2 principle 7: the daemon owns session state; clients are pure subscribers. This is the load-bearing decision for multi-client (web + iOS in v0.4) — but it is **also** the right model for desktop-only v0.3 because:

- Electron renderer reload (Cmd-R, devtools refresh) MUST not lose terminal state. Snapshot+delta from a backend-authoritative source serves this perfectly.
- Multiple Electron windows on the same session (split-pane future) need the same broadcast contract.

## Session manager

Module: `daemon/src/sessions/manager.ts`. Responsibilities:

- Registry of `Session` objects keyed by `sessionId`.
- Lifecycle: `create` (allocates id + spawns PTY via PtyHost), `get`, `list`, `update` (metadata), `close` (kill PTY + archive metadata to SQLite).
- Hands out subscription handles to subscribers.

`Session` object holds:

- `id`, `metadata` (title, color, cwd, createdAt).
- Reference to the PTY child handle (owned by PtyHost; see [09](./09-pty-host.md)).
- Ring buffer (see "Snapshot ring buffer" below).
- Subscriber registry (see "Broadcast" below).
- `lastSeq` counter (monotonically increasing per output frame).
- `bootNonce` (daemon's bootNonce; included in every snapshot; client uses to detect daemon restart).

Persistence: session **metadata** is written to SQLite on create / update / close. Session **scrollback** is RAM-only (see "Persistence boundary" below).

## Snapshot ring buffer

Per session, an in-RAM ring buffer of recent PTY output keyed by `seq`. Backed by `xterm-headless` running server-side to compute terminal state (cursor pos, scrollback lines, mode flags). Bounded by:

- Max bytes: 256 KiB per session (matches the v0.3 frag-3.5.1 replay budget).
- Max lines: 1000 lines of scrollback (matches xterm-headless default).

When the buffer fills, oldest frames are evicted; oldest retained `seq` is published to subscribers as `firstAvailableSeq` so they know when delta-only resume is no longer possible (and they need a fresh snapshot).

### `snapshot` envelope

A snapshot is the full xterm-headless state serialized as:

- The visible screen (rows × cols cell grid with attributes).
- Scrollback (up to ring-buffer cap).
- Cursor position + visibility.
- Terminal mode flags (cursor key application mode, alt-screen, etc.).
- The `seq` of the most recent delta included in the snapshot.

Wire form: a `PtySnapshot` proto message (see [06](./06-proto-schema.md) §`PtyService.Subscribe`).

## Broadcast (N≥3 fan-out from day 1)

When PTY emits output:

1. PtyHost calls `session.appendOutput(bytes)`.
2. Session assigns next `seq`, appends to ring buffer, updates xterm-headless.
3. Session iterates `subscribers` and pushes `PtyDelta { seq, bytes, ts }` to each subscriber's stream queue.
4. **Slow subscribers do not block fast subscribers.** Each subscriber has a per-subscriber bounded queue (1 MiB, matching frag-3.5.1 watermark). On overflow → the slowest subscriber is **dropped** (its stream is closed with `ResourceExhausted`); it MUST resubscribe (which gets it a fresh snapshot).

**Why drop-slowest at the subscriber, not at the source:** dropping at source punishes all clients for one slow client. Dropping at subscriber preserves the model's semantics for everyone else.

## Last-writer-wins (LWW) on input

When two clients send `pty.Input` concurrently:

- Each input RPC is unary; arrival at the daemon is serialized by the Connect-Node event loop / mutex on the PTY write side.
- PTY child writes happen in arrival order. There is **no** lock, no "primary client" concept, no input merging.
- The PTY child's interpretation of interleaved keystrokes IS the LWW semantics. The daemon does not editorialize.

This matches final-architecture §2 principle 7. The PTY layer is the serialization point.

## Subscribe + resubscribe

Initial subscribe (`PtyService.Subscribe { session_id }`):

1. Server immediately sends a `PtyEvent.snapshot` (current xterm-headless state).
2. Then streams `PtyEvent.delta { seq, bytes }` for every subsequent PTY output.
3. Sends `PtyEvent.heartbeat` every 30 s with `{ seq: <current lastSeq> }` so client can detect dead streams.
4. On PTY exit, sends `PtyEvent.exit { code, signal }` then closes the stream.

Resubscribe (`PtyService.Subscribe { session_id, from_seq }`):

- If `from_seq >= firstAvailableSeq` (still in ring buffer): server skips snapshot, sends only deltas from `from_seq + 1` forward.
- If `from_seq < firstAvailableSeq`: server sends a snapshot then resumes deltas. Client treats this as "you missed too much; here's everything from current state".
- If `bootNonce` in client's recent state ≠ daemon's current bootNonce: server always sends snapshot (daemon restarted; nothing to delta-from).

Client uses bootNonce comparison (from `daemon.hello` response on reconnect) to know whether to trust its own `from_seq`. Renderer reload of Electron can pass `from_seq` through main process's snapshot cache.

## Persistence boundary

- **In SQLite:** session metadata only (title, color, cwd, createdAt, closedAt, exitCode).
- **NOT in SQLite (v0.3):** scrollback bytes, snapshots, deltas. RAM-only.
- The PTY host module's external interface MUST treat persistence as a future-add: append/snapshot operations go through `session.appendOutput(bytes)`, not through "write to ring buffer". v0.5 can interpose a writer that also persists, without changing PTY-host or session-manager external API.

**Why deferred (v0.5):** scrollback persistence requires policy decisions (size cap per session, retention window, eviction strategy). Punting allows the v0.3 ship without baking in a wrong policy.

## Concurrency model

- Single Node event loop. Session manager + PtyHost share state; mutations are synchronous within a tick.
- PTY output arrival is libuv-driven; each chunk is processed atomically.
- Subscriber queue writes are non-blocking (drop on overflow as above).
- No worker threads in v0.3.

## Test matrix (MUST in v0.3)

| # | Scenario                                                               | Expected |
| - | ---------------------------------------------------------------------- | -------- |
| 1 | 1 subscriber, normal PTY output                                        | snapshot then deltas in order |
| 2 | **3 concurrent subscribers**, same session                              | each receives identical snapshot + same delta stream |
| 3 | **3 subscribers** + 2 clients sending interleaved input               | PTY echoes show LWW interleave; all 3 subscribers see identical output |
| 4 | Slow subscriber (1 MiB backlog reached)                                | slow subscriber stream closed `ResourceExhausted`; fast subscribers unaffected |
| 5 | Resubscribe with valid `from_seq` (in ring)                            | no snapshot; deltas from `from_seq+1` |
| 6 | Resubscribe with stale `from_seq` (evicted)                            | snapshot then deltas |
| 7 | Resubscribe after daemon restart (bootNonce changed)                   | snapshot regardless of `from_seq` |
| 8 | PTY exits while subscribers attached                                   | `PtyEvent.exit` to all, streams closed |
| 9 | Subscriber disconnect mid-stream                                        | session continues, PTY unaffected, other subscribers unaffected |
| 10 | Heartbeat: subscriber receives `hb` events at ~30 s interval          | observed via fake clock |

## What this chapter does NOT cover

- Specific xterm-headless version pin → see [13 §deps](./13-packaging-and-release.md).
- Session metadata DB schema → see [10](./10-sqlite-and-db-rpc.md).
- PTY child spawn details / signal handling → see [09](./09-pty-host.md).
- Electron's per-session snapshot cache (renderer reload speed) → see [12](./12-electron-thin-client.md).

## Cross-refs

- [01 — Goals (G5)](./01-goals-and-non-goals.md)
- [06 — Proto schema (PtyService server-streaming signature)](./06-proto-schema.md)
- [07 — Connect server (handler dependency wiring)](./07-connect-server.md)
- [09 — PTY host](./09-pty-host.md)
- [10 — SQLite (session metadata only)](./10-sqlite-and-db-rpc.md)
- [12 — Electron (snapshot cache + bootNonce reconnect)](./12-electron-thin-client.md)
- [15 — Testing strategy](./15-testing-strategy.md)
