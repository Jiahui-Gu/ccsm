# 06 — PTY: Snapshot + Delta

The PTY subsystem is the highest-risk component in v0.3: it is the only piece that must survive a hard Electron kill with binary-identical state on reattach (ship-gate (b) and (c) — see brief §11). This chapter pins the per-session topology, the snapshot encoding, the delta wire format (precisely, because v0.3 freezes it), the persistence cadence, the reconnect/replay semantics, and the 1-hour zero-loss validation harness. The proto envelope is in [04](./04-proto-and-rpc-surface.md) §4; this chapter pins the bytes inside `PtySnapshot.screen_state` and the bytes inside `PtyDelta.payload`.

### 1. Per-session topology

```
       claude CLI (subprocess of pty-host)
            │ stdio
            ▼
   ┌────────────────┐
   │ node-pty master│ ◀── SendInput RPC bytes (raw) forwarded over IPC from daemon
   └────────┬───────┘
            │ raw VT bytes (master.onData)
            ▼
   ┌──────────────────────────────────┐
   │ pty-host CHILD PROCESS (per sess)│
   │  - xterm-headless Terminal       │   ◀── used as state machine, never rendered
   │  - delta accumulator             │
   │  - snapshot scheduler            │
   │  - subscribers list (Attach RPCs)│
   └──────────────────────────────────┘
            │  IPC (Node `child_process.fork` channel)
            ▼
   ┌──────────────────────────────────┐
   │ daemon main process              │
   │  - SQLite write coalescer        │   ◀── single sqlite handle, all sessions
   │  - Connect handler dispatch      │
   │  - per-session subscriber fanout │
   └──────────────────────────────────┘
            │
            ├──▶ in-memory ring of last N deltas (N = 4096) — held in pty-host child
            ├──▶ SQLite `pty_delta` table (every delta, capped retention)
            └──▶ SQLite `pty_snapshot` table (every K seconds OR every M deltas)
```

**One pty-host CHILD PROCESS per Session** — `child_process.fork(pty-host.js)` from the daemon, NOT a `worker_threads` Worker. This is the F3-locked v0.3 position. **Why a process boundary, not a thread**:

- A worker crash from a memory-corruption bug in `node-pty` or its native dependency would take the whole daemon process down (workers share v8 heap and the daemon's address space). A child-process crash is contained: the OS reaps the child, the daemon `child.on('exit')` handler writes a `crash_log` row, marks the session `CRASHED`, and the daemon keeps serving every other session.
- v0.4 multi-principal lands additively on top of this boundary: each session's pty-host child already runs as a separate OS process and can be respawned with reduced privileges (per-principal uid drop) without touching the daemon main process. Locking the worker_threads model in v0.3 would have required a v0.4 reshape (worker → process) to get the same isolation — that reshape would be a non-additive zero-rework violation. Locking the process boundary now is forever-additive.
- IPC overhead is acceptable for v0.3: the per-session bandwidth is bounded by ship-gate (c)'s 250 MB / 60 min budget (≈ 70 KB/s average; bursty to ~20 MB/s for short windows). Node's `child_process.fork` IPC channel handles this comfortably; the SQLite write path is identical (the child sends `(delta_bytes, seq, ts)` tuples to the daemon main thread which appends to the write coalescer).
- SQLite stays single-handle in the daemon main process (avoiding multi-writer contention); the per-session child does NOT open SQLite. Snapshot bytes (post-zstd, see §2) cross the IPC channel as `Buffer`s.
- The child-process boundary makes the v0.4 "per-principal helper process" model a no-op design extension: the same child architecture, just spawned with a different uid. v0.4 does NOT add a new process boundary; it inherits this one.

`child_process.fork` is preferred over `child_process.spawn` because the IPC channel is built-in and `Buffer` transfers serialize cleanly. The pty-host child entrypoint is a small TypeScript file (`packages/daemon/src/pty/pty-host.ts`); it imports `node-pty` and `xterm-headless` directly. The `claude` CLI is the child of the pty-host (NOT of the daemon), so killing the pty-host kills `claude` automatically — the daemon never has to clean up orphaned `claude` processes after a pty-host crash.

> **MUST-SPIKE [child-process-pty-throughput]** (replaces the v0.2-era worker-thread spike): hypothesis: a Node 22 child process with `node-pty` + `xterm-headless` and an IPC channel back to the daemon keeps up with `claude` CLI's burstiest output (initial code-block dump ≥ 2 MB) without dropping or coalescing-with-loss. · validation: synthetic emitter writing 50 MB of mixed VT in 30s; assert every byte appears in the child's xterm Terminal state and every delta's seq is contiguous when received in the daemon main process. · fallback: tighten the segmentation cadence (16 ms / 16 KiB → 8 ms / 8 KiB) and/or apply zstd compression to delta payloads on the IPC channel (snapshots are already zstd-compressed per §2).

### 2. Snapshot: encoding (bytes inside `PtySnapshot.screen_state`)

`schema_version = 1` for v0.3. **The on-wire `PtySnapshot.screen_state` bytes are zstd-compressed from day one** (F3-locked) — uncompressed v1 is 5-7 MB for a 80×24 terminal with 10k scrollback lines, which is too large for cold-start replay over CF Tunnel in v0.4 and is wasteful even on loopback. Shipping compression in v0.3 means v0.4 NEVER has to bump `schema_version` to add compression — the compression is part of v1.

The on-wire byte layout is:

```
struct SnapshotV1Wire {
  uint8  outer_magic[4];     // "CSS1" — Ccsm Snapshot v1
  uint8  codec;              // 1 = zstd (forever-stable v1 default); 2 = gzip-via-DecompressionStream (browser fallback, v0.4 web client may emit/accept)
  uint8  reserved[3];        // MUST be zero in v1; reader rejects non-zero so v2 can repurpose
  uint32 inner_len;          // length of the compressed payload that follows
  uint8  inner[inner_len];   // codec-compressed bytes; decompress yields SnapshotV1Inner below
}

struct SnapshotV1Inner {
  uint8  inner_magic[4];     // "CSS1" — same magic; nesting is intentional so a corrupted outer header doesn't smuggle in a different inner schema
  uint16 cols;
  uint16 rows;
  uint32 cursor_row;        // 0-based
  uint32 cursor_col;        // 0-based
  uint8  cursor_visible;    // 0 or 1
  uint8  cursor_style;      // 0=block, 1=underline, 2=bar
  uint32 scrollback_lines;  // count of lines below
  uint32 viewport_lines;    // == rows; included for forward-compat
  uint8  modes_bitmap[8];   // app-cursor, app-keypad, alt-screen, mouse-modes, ...
                            // bit positions are FOREVER-STABLE; new modes use new bits
  uint32 attrs_palette_len;
  AttrEntry attrs_palette[attrs_palette_len];   // dedup table for cell attrs
  // lines: scrollback first (oldest→newest), then viewport (top→bottom)
  Line lines[scrollback_lines + viewport_lines];
}

struct AttrEntry {
  uint32 fg_rgb;       // 0xRRGGBB; 0xFF000001 = default
  uint32 bg_rgb;       // same
  uint16 flags;        // bold, italic, underline, blink, reverse, dim, strike, hidden
}

struct Line {
  uint16 cell_count;
  Cell   cells[cell_count];
  uint8  wrapped;      // continuation-line marker
}

struct Cell {
  uint32 codepoint;    // unicode scalar value; 0 = empty
  uint32 attrs_index;  // index into attrs_palette
  uint8  width;        // 1 or 2 (for east-asian wide)
}
```

**Codec rules** (forever-stable v1):

- Daemon ALWAYS emits `codec = 1` (zstd) in v0.3. The zstd dictionary is the empty dictionary (no shared dict) so the bytes are self-contained.
- Web/iOS clients in v0.4 MAY consume `codec = 1` via the `@bokuweb/zstd-wasm` (or equivalent) wasm module; for browsers without wasm or for size-constrained mobile builds, daemon MAY be configured (server-side `Settings`) to emit `codec = 2` (gzip), which decompresses via the browser's native `DecompressionStream("gzip")` with no extra wasm. v0.3 daemon MUST support reading both codecs (round-trip tests cover this) but MUST emit `codec = 1` by default.
- Both codecs decompress to the SAME `SnapshotV1Inner` byte layout; the inner bytes are forever-stable.
- `reserved` bytes MUST be zero in v1; readers MUST reject non-zero so v2 can repurpose them (e.g., chunked snapshots, dictionary-id, etc.).

All multi-byte integers are little-endian. The format is **stable for `schema_version == 1`** (covering both inner layout AND outer codec wrapper). New fields require `schema_version = 2`; daemon and client both retain code for every shipped version forever. Compression-codec additions stay inside `codec` byte (open enum bounded by what readers tolerate); they do NOT bump `schema_version`.

**Why a custom binary, not e.g. xterm-headless's serializer**: (a) xterm.js's `SerializeAddon` produces ANSI text which loses cell-level attribute precision for some edge cases (256-color blends, wide cell continuation); (b) we want to checksum the snapshot deterministically so replay tests can compare bytes; (c) we want the wire size predictable (uncompressed inner payload ≤ ~5-7 MB for 80×24 + 10k lines scrollback typical; zstd-compressed `screen_state` typically 200-800 KB which is dogfood-acceptable on loopback AND survives a v0.4 cold cf-tunnel attach without a multi-second stall).

> **MUST-SPIKE [snapshot-roundtrip-fidelity]**: hypothesis: a SnapshotV1 encoded from xterm-headless state X, decoded in a fresh xterm-headless instance Y, and re-encoded, produces byte-identical SnapshotV1. · validation: property-based test with 1000 random VT byte sequences fed into X, assert encode(X) == encode(decode(encode(X))). · fallback: lower the bar to "rendered text + cursor + style match"; would weaken ship-gate (c) — escalate to user before lowering.

### 3. Delta: wire format (bytes inside `PtyDelta.payload`)

A delta payload is **a contiguous slice of raw VT bytes** as emitted by `node-pty` master. No re-encoding, no escape-sequence parsing on the daemon side before storing. **Why raw**:

- xterm-headless on the client side replays raw VT correctly by definition (it's the same state machine as on the daemon side).
- Storing raw avoids round-trip loss (any encode/decode would be a bug surface).
- It is the smallest representation (no per-cell expansion).

Delta segmentation rules (daemon-side):

1. The pty-host worker reads from `node-pty` master `data` events. Each event yields a `Buffer`.
2. The worker accumulates bytes for **at most 16 ms or 16 KiB**, whichever first; emits a `PtyDelta` with monotonic `seq` (per session, starting at 1 after each snapshot's `base_seq`).
3. Empty intervals (no bytes) emit no delta.
4. The worker also feeds the same bytes into its xterm-headless `Terminal.write()` so its in-memory state stays current for snapshot generation.

Delta `seq` is **per session**, **monotonically increasing by 1**, and **never reused**. After a snapshot is taken, the snapshot's `base_seq` equals the most recent delta's `seq` at the moment of capture. New deltas after that snapshot start at `base_seq + 1`.

### 4. Snapshot cadence

Daemon takes a snapshot for each session when ANY of:
- `K_TIME = 30 seconds` since last snapshot AND at least one delta since.
- `M_DELTAS = 256` deltas since last snapshot.
- `B_BYTES = 1 MiB` total delta bytes since last snapshot.
- An explicit `Resize` was processed (geometry change is hard to replay via deltas alone).

On snapshot, the daemon writes a `pty_snapshot` row (see [07](./07-data-and-state.md) §3) and **prunes** `pty_delta` rows with `seq < new_snapshot.base_seq - DELTA_RETENTION_SEQS` where `DELTA_RETENTION_SEQS = 4096` — keeping a window large enough that any client connected within the last few snapshots can resume by delta replay rather than re-fetching a snapshot.

### 5. Reconnect / replay semantics

Client calls `Attach(session_id, since_seq)`. Daemon decision tree:

```
if since_seq == 0:
  # fresh client; send snapshot then live deltas
  snapshot := load latest pty_snapshot for session
  emit PtyFrame.snapshot(snapshot)
  resume_seq := snapshot.base_seq + 1
elif since_seq >= oldest_retained_delta_seq:
  # client can resume; replay missing deltas
  replay := pty_delta WHERE seq > since_seq AND seq <= current_max_seq
  resume_seq := since_seq + 1
else:
  # client too far behind retained window; fall back to snapshot
  snapshot := load latest pty_snapshot
  emit PtyFrame.snapshot(snapshot)
  resume_seq := snapshot.base_seq + 1

stream every delta from resume_seq onward as PtyFrame.delta;
emit PtyFrame.heartbeat every 10s when no delta in flight.
```

The client (Electron) maintains its own `lastAppliedSeq`. On any Attach, it sends `since_seq = lastAppliedSeq`. On disconnect mid-stream, it reconnects with the last seq it actually applied (NOT the last seq it received, in case of partial application).

**Per-frame ack** (F3): `AttachRequest.requires_ack` (chapter [04](./04-proto-and-rpc-surface.md) §4) is `false` by default; v0.3 Electron leaves it false (HTTP/2 flow control + `since_seq` resume tree are sufficient over loopback). v0.4 web/iOS clients running over CF Tunnel set `requires_ack = true` and call `PtyService.AckPty(session_id, applied_seq)` after persisting each frame. When `requires_ack` is true, the daemon tracks per-subscriber `last_acked_seq`; if a subscriber's unacked-frame backlog exceeds N=4096 deltas, the daemon closes that subscriber's stream with `RESOURCE_EXHAUSTED("subscriber ack backlog exceeded")` and the client reconnects with the last-acked seq. The mechanism ships in v0.3 so v0.4 reliability over high-latency transports requires zero proto change.

### 6. Daemon-side multi-attach

A session may have N concurrent Attach streams (e.g., Electron crashed and relaunched while the old stream is still being torn down; a future v0.4 web client attaching alongside Electron). The pty-host worker maintains a `Set<Subscriber>` and broadcasts every delta to all. There is no per-subscriber back-pressure beyond Connect's HTTP/2 flow control — if one subscriber is slow, its stream falls behind; if it falls outside the retention window, the daemon closes its stream with `PreconditionFailed("subscriber too slow; reattach")` and the client reconnects.

### 7. Daemon restart replay

On daemon restart, the pty-host worker for a recovered session starts with the most recent snapshot from SQLite, then writes the post-snapshot deltas back into xterm-headless to bring its in-memory state current, then starts emitting fresh deltas as `claude` CLI continues to produce output. (See [05](./05-session-and-principal.md) §7 for the full restore flow.)

### 8. 1-hour zero-loss validation harness (ship-gate (c))

Test name: `pty-soak-1h`. Lives in `packages/daemon/test/integration/pty-soak.test.ts` and the corresponding Electron-side harness in `packages/electron/test/e2e/pty-soak-reconnect.test.ts`.

```
1. Boot daemon under test (in-process for unit; service-installed for E2E).
2. CreateSession with cwd=tmpdir, claude_args=["--simulate-workload", "60m"].
   The test build of claude CLI emits a deterministic stream:
     - mixed-language code blocks (UTF-8, CJK, RTL)
     - 256-color sequences and SGR resets
     - cursor positioning (CUP, CUU, CUD)
     - alt-screen enter/exit cycles (vim simulator phase)
     - bursts (1 MB in 50 ms) and idles (10 s of nothing)
     Total volume: ~250 MB over 60 minutes.
3. Electron-side harness Attach(session_id, since_seq=0); records every applied frame.
4. At t=10m, t=25m, t=40m: SIGKILL the Electron harness; immediately relaunch;
   Attach with the recorded last applied seq.
5. At t=60m: stop session; export the daemon-side xterm-headless Terminal state as SnapshotV1.
6. Compare against the client-side xterm-headless Terminal state (after replaying every applied frame from boot).
7. Assert SnapshotV1 byte-equality.
```

Pass criterion: SnapshotV1 byte-equality. Allowed deviation: zero. Test runs in CI nightly and gates v0.3 ship.

### 9. v0.4 delta

- **Add** v0.4 web/iOS clients call the same `PtyService.Attach`; the daemon already broadcasts to N subscribers (§6) and `AckPty` (chapter [04](./04-proto-and-rpc-surface.md) §4) is already wired so high-latency clients get reliable ack-driven flow control. No daemon change.
- **Add** new `codec` enum values to the SnapshotV1 wrapper (§2) if profiling demands a denser codec (e.g., zstd-with-dictionary); v0.3-shipped `codec = 1` (zstd) and `codec = 2` (gzip) retained forever. `schema_version` stays at 1.
- **Add** delta batching mode for high-latency networks (web client over CF Tunnel); add new optional `Attach.batch_window_ms` field; daemon defaults to current behavior. Existing field numbers and semantics: unchanged.
- **Unchanged**: SnapshotV1 inner encoding, raw-VT delta payload, snapshot cadence, reconnect decision tree, multi-attach broadcast, daemon restart replay, the 1-hour soak harness, the pty-host child-process boundary.
