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

<!-- F5: closes R0 06-P1.1 — UTF-8 spawn env locked so multi-byte/CJK is byte-identical across OSes; the delta wire format is raw VT (§3) and must not depend on the host's user locale. -->

**Spawn env UTF-8 contract (FOREVER-STABLE, ship-gate (c) prerequisite)** — when the pty-host child spawns the `claude` CLI via `node-pty`, the spawn env MUST include the following overrides regardless of the daemon's inherited environment:

- Linux + macOS: `LANG=C.UTF-8` AND `LC_ALL=C.UTF-8` (override any inherited `LANG`/`LC_ALL`/`LC_CTYPE`). On macOS where `C.UTF-8` is not a registered locale on every system, fall back to `en_US.UTF-8`; the daemon probes `locale -a | grep -F C.UTF-8` once at startup and caches the choice.
- Windows: pre-spawn run `chcp 65001` in the same console session via `node-pty`'s `cols`/`rows` initialization wrapper (the pty-host writes `cmd /c chcp 65001 >nul && claude.exe ...` as the spawn argv when on Windows), AND set env `PYTHONIOENCODING=utf-8` for any subprocess `claude` may spawn that respects it.

Any `claude` output bytes must be decodable as UTF-8 by xterm-headless on the daemon side AND xterm.js on the renderer side; the snapshot byte-equality assertion in ship-gate (c) (§8) only holds when both ends decode the exact same byte sequence. The spawn env contract is locked here (forever-stable in v0.3); v0.4 multi-principal helpers inherit the same env override.

<!-- F5: closes R3 P0-06-01 (escalated) — PTY input backpressure cap; SendInput must be bounded so a stuck child cannot bloat daemon RAM unboundedly. -->

**PTY input backpressure (FOREVER-STABLE)** — the daemon enforces a per-session pending-write byte cap of **1 MiB** on the `node-pty` master write queue. The pty-host child tracks `pendingWriteBytes` (sum of bytes passed to `master.write(buf)` minus bytes drained per node-pty's `drain` event). On `SendInput(session_id, bytes)`:

- If `pendingWriteBytes + bytes.length > 1 MiB`: the RPC returns `RESOURCE_EXHAUSTED` (Connect status code) with `ErrorDetail.code = "pty.input_overflow"` and the daemon writes a `crash_log` row (`source = "pty_input_overflow"`, `summary` includes `session_id` + current `pendingWriteBytes`); NO bytes from this `SendInput` are written to the master.
- The cap is per session (not aggregate across sessions). The cap is hard (no queueing on the daemon side); clients implement their own retry on `RESOURCE_EXHAUSTED`.
- This bounds pty-host child RSS growth when `claude` is unresponsive; combined with the in-memory delta ring cap N=4096 (§2 / §6) and snapshot-write failure handling below, the daemon is bounded in worst case to: (snapshot ring × 4096 entries) + (pty-host pending writes 1 MiB) + (subscriber unacked backlog 4096 deltas, see §5).

<!-- F5: closes R3 P1-06-04 (escalated) — child-process crash semantics (note: F3 moved this off worker_threads to child_process; the wording here adapts the original "worker crash" finding to child-process exit). -->

**Child-process crash semantics (FOREVER-STABLE)** — the daemon's `child.on('exit', (code, signal) => ...)` handler treats any non-zero exit (or any signal-induced termination) as a fatal pty-host crash for that session:

1. The daemon issues `SIGKILL` to the `claude` CLI process (which is the grandchild via the pty-host); on Linux/macOS the daemon also `kill(-pgid, SIGKILL)` to ensure any `claude`-spawned subprocesses are reaped.
2. The session's `state` flips to `CRASHED` (NOT `CLOSED`) and `should_be_running` is set to `0` so the daemon does NOT respawn it on next boot.
3. The daemon writes a `crash_log` row (`source = "pty_host_crash"`, includes exit code/signal, child-process pid, session_id).
4. All Attach subscribers for this session receive `PtyFrame.session_ended` with `reason = CRASHED` and stream is closed with `INTERNAL`.
5. The user MUST explicitly recreate the session (CreateSession with the same cwd/claude_args is the supported path); the daemon does NOT auto-recreate.

**Test-only crash branch (FOREVER-STABLE)** — to make the crash path testable in `pty-host-crash.spec.ts`, the pty-host child entrypoint reads env `CCSM_PTY_TEST_CRASH_ON` (set ONLY by the test harness; daemon production code never sets it). When set to e.g. `after-bytes:1024`, the pty-host child calls `process.exit(137)` after the first 1024 bytes of `claude` output cross the IPC boundary. This branch is gated by `if (process.env.NODE_ENV !== 'production')` AND the env var presence; production sea builds strip the branch via `tsc` dead-code elimination since the env-var name is a string literal compared against an undefined env in production.

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
  uint32 codepoint;    // unicode scalar value of the BASE grapheme cluster character; 0 = empty
  uint32 attrs_index;  // index into attrs_palette
  uint8  width;        // 1 or 2 (for east-asian wide)
  uint8  combiner_count;        // number of combining marks following this cell (0 if none)
  uint32 combiners[combiner_count]; // unicode scalar values of combining marks (in original sequence order)
}
```

**Codec rules** (forever-stable v1):

- Daemon ALWAYS emits `codec = 1` (zstd) in v0.3. The zstd dictionary is the empty dictionary (no shared dict) so the bytes are self-contained.
- Web/iOS clients in v0.4 MAY consume `codec = 1` via the `@bokuweb/zstd-wasm` (or equivalent) wasm module; for browsers without wasm or for size-constrained mobile builds, daemon MAY be configured (server-side `Settings`) to emit `codec = 2` (gzip), which decompresses via the browser's native `DecompressionStream("gzip")` with no extra wasm. v0.3 daemon MUST support reading both codecs (round-trip tests cover this) but MUST emit `codec = 1` by default.
- Both codecs decompress to the SAME `SnapshotV1Inner` byte layout; the inner bytes are forever-stable.
- `reserved` bytes MUST be zero in v1; readers MUST reject non-zero so v2 can repurpose them (e.g., chunked snapshots, dictionary-id, etc.).

<!-- F5: closes R4 P0 ch 06 SnapshotV1 encoder non-determinism — palette ordering and modes_bitmap bit→mode mapping pinned so encode(state) is byte-identical across runs and across daemon vs client. -->

**Encoder determinism rules** (FOREVER-STABLE v1; ship-gate (c) byte-equality depends on these):

- **`attrs_palette` ordering**: the encoder walks cells in canonical order — **scrollback lines oldest→newest, then viewport lines top→bottom; within each line left→right** — and appends each previously-unseen `(fg_rgb, bg_rgb, flags)` tuple to the palette **in order of first appearance**. The first cell scanned that has the default attrs produces palette entry `0`. Two encoders given the same input cells MUST produce the same palette ordering.
- **`modes_bitmap[8]` bit→mode mapping** (each byte LSB→MSB; bit 0 of byte 0 is the lowest):
  - byte 0 bit 0: DECCKM (application cursor keys, `CSI ? 1 h`)
  - byte 0 bit 1: DECKPAM (application keypad, `ESC =`)
  - byte 0 bit 2: alt-screen active (`CSI ? 1049 h`)
  - byte 0 bit 3: bracketed paste (`CSI ? 2004 h`)
  - byte 0 bit 4: mouse mode X10 (`CSI ? 9 h`)
  - byte 0 bit 5: mouse mode VT200 (`CSI ? 1000 h`)
  - byte 0 bit 6: mouse mode any-event (`CSI ? 1003 h`)
  - byte 0 bit 7: mouse SGR encoding (`CSI ? 1006 h`)
  - byte 1 bit 0: DECTCEM cursor visible (`CSI ? 25 h`) — redundant with `cursor_visible` field; kept here for forward-compat
  - byte 1 bit 1: focus-tracking (`CSI ? 1004 h`)
  - byte 1 bit 2: DECOM origin mode (`CSI ? 6 h`)
  - byte 1 bit 3: DECAWM auto-wrap (`CSI ? 7 h`)
  - byte 1 bit 4: reverse video (`CSI ? 5 h`)
  - byte 1 bits 5-7 + bytes 2-7: RESERVED, MUST be zero in v1 (readers reject non-zero so v2 can grow). New modes in v0.4+ use the next contiguous bit.
- **Grapheme cluster handling** (R5 P0-06-1): the encoder MUST preserve combining marks. For each xterm-headless cell, the base character goes into `Cell.codepoint`; any combining marks attached to that cell go into `Cell.combiners[]` in their original sequence order with `combiner_count` set accordingly. A bare ASCII cell has `combiner_count = 0` and emits zero `combiners` bytes. A cell with `e + COMBINING ACUTE ACCENT` has `codepoint = U+0065`, `combiner_count = 1`, `combiners[0] = U+0301`. xterm-headless's internal cell representation already preserves the combining-mark chain via its `Cell.getChars()` API; the encoder iterates over the full grapheme cluster string and decomposes into base + combiners. This is mandatory for ship-gate (c) which mixes UTF-8 / CJK / RTL workloads (§8 step 2) — without combiners, accented Latin and Hangul precomposed-vs-decomposed sequences would lose information across encode/decode/re-encode.

**Decoder spec** (FOREVER-STABLE v1; ship-gate (c) replay path):

The v0.3 client (Electron renderer) decodes `SnapshotV1` via a **custom decoder that mutates an xterm.js `Terminal` buffer directly** (`packages/electron/src/renderer/pty/snapshot-decoder.ts`). xterm.js's `SerializeAddon` is **explicitly rejected** for the inverse path (it produces ANSI text which round-trips lossily — see "Why a custom binary" below). The decoder steps:

1. Validate outer magic (`"CSS1"`), `codec`, `reserved` bytes; reject non-v1 wrappers.
2. Decompress `inner` per `codec` (zstd or gzip) → `SnapshotV1Inner` bytes.
3. Validate inner magic, `cols`/`rows`; create a fresh xterm.js `Terminal({ cols, rows, scrollback: scrollback_lines })`.
4. For each scrollback line then each viewport line, for each cell, call into the (private but stable) xterm.js buffer API to write `(codepoint + combiners) → BufferLine` directly with the resolved attrs from `attrs_palette[attrs_index]`. Width is taken from `Cell.width`; wide-cell continuation cells are inserted as required by xterm.js's invariants.
5. Apply `modes_bitmap` bit-by-bit by writing the corresponding `CSI ? N h/l` sequences through `Terminal.write()` so xterm.js's mode-state machine stays consistent.
6. Position cursor (`cursor_row`, `cursor_col`) and apply `cursor_visible` / `cursor_style`.

The decoder lives client-side; the daemon never decodes its own snapshots in production. Test code in `packages/daemon/test/integration/snapshot-roundtrip.spec.ts` imports the decoder from a shared package (`packages/snapshot-codec/`) so daemon-side property tests can do `decode(encode(state)) ≈ state`. This shared codec package has zero runtime dependencies beyond zstd; it is forever-stable.

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

<!-- F5: closes R0 06-P1.2 — segmentation cadence is per-session, NOT per-subscriber. The forbidden-pattern lock lives in chapter 15 §3 (F8 owns); the narrative lock lives here. -->

**Segmentation cadence is per-session** (FOREVER-STABLE) — the 16 ms / 16 KiB accumulator runs once per session in the pty-host child, BEFORE the multi-subscriber broadcast (§6). Every Attach subscriber for the same session sees the SAME delta `seq` boundaries; the daemon does NOT re-segment per subscriber. This invariant is what makes `since_seq` resume cheap (the daemon stores deltas keyed by `(session_id, seq)`, not `(session_id, subscriber_id, seq)`) and what makes the in-memory ring (§5) shareable across subscribers. v0.4 web/iOS subscribers do not re-segment either; they get the exact same byte boundaries as Electron.

### 4. Snapshot cadence

Daemon takes a snapshot for each session when ANY of:
- `K_TIME = 30 seconds` since last snapshot AND at least one delta since.
- `M_DELTAS = 256` deltas since last snapshot.
- `B_BYTES = 1 MiB` total delta bytes since last snapshot.
- An explicit `Resize` was processed (geometry change is hard to replay via deltas alone).

<!-- F5: closes R0 06-P1.3 — Resize-triggered snapshot coalescing (drag-resize emits Resize many times per second; without coalescing the daemon would queue a snapshot per Resize). -->

**Resize-snapshot coalescing** (FOREVER-STABLE) — when multiple `Resize` RPCs arrive for the same session within a 500 ms window, the daemon takes **at most one** Resize-triggered snapshot per 500 ms per session. The pty-host child holds a per-session `resizeSnapshotPendingUntil: number | null` timestamp; on Resize, if `pendingUntil > now` the snapshot is suppressed (the geometry update still applies to xterm-headless and is reflected in the next time-or-delta-or-byte-triggered snapshot); otherwise the snapshot is taken and `pendingUntil = now + 500`. The K_TIME / M_DELTAS / B_BYTES triggers still fire normally regardless of resize coalescing.

<!-- F5: closes R3 P1-06-02 (escalated) — snapshot write failure handling; in-memory ring N=4096; 3 consecutive failures → DEGRADED state. -->

**In-memory delta ring + snapshot write failure** (FOREVER-STABLE) — the pty-host child holds an in-memory ring of the last `N=4096` deltas per session (the same N as `DELTA_RETENTION_SEQS`). On snapshot generation, the child serializes the SnapshotV1 bytes and `postMessage`s them to the daemon main process which writes the `pty_snapshot` row through the write coalescer (chapter [07](./07-data-and-state.md) §5).

If the SQLite write of a snapshot fails (disk full, I/O error, write-coalescer rejects with `RESOURCE_EXHAUSTED`):
- The daemon writes a `crash_log` row with `source = "pty_snapshot_write"`, `summary` includes session_id and the SQLite error code, `detail` includes the snapshot's `base_seq` and byte length.
- The session continues to stream live deltas to subscribers. The in-memory ring still holds the last 4096 deltas so reconnect-via-delta-replay still works for clients that haven't fallen too far behind.
- A per-session counter `consecutiveSnapshotWriteFailures` increments. On reaching `3`, the session transitions to a `DEGRADED` state (new SessionState enum value, additive in v0.3): subscribers receive `PtyFrame.session_state_changed(DEGRADED)`, the daemon stops attempting snapshot writes for this session for the next 60 seconds, and the daemon emits a `crash_log` row with `source = "pty_session_degraded"`. After the cool-down window, the daemon retries; on success the counter resets and state returns to `RUNNING`. The daemon process itself does NOT crash; other sessions are unaffected.

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

Test name: `pty-soak-1h`. Lives in `packages/daemon/test/integration/pty-soak-1h.spec.ts` and the corresponding Electron-side harness in `packages/electron/test/e2e/pty-soak-reconnect.spec.ts`.

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

### 10. Test inventory (ship-gate (b) + (c) verifiability)

<!-- F5: closes R4 P0/P1 ch 06 test-additions — every behavioral lock above gets a named spec file referenced from chapter 12 §3. -->

The following spec files MUST exist and pass in CI before v0.3 ship. Paths are relative to `packages/daemon/` unless noted otherwise.

| Spec file | Purpose | Closes |
| --- | --- | --- |
| `test/integration/pty-soak-1h.spec.ts` | 1-hour zero-loss workload (§8) | ship-gate (c) |
| `test/integration/pty-daemon-restart-replay.spec.ts` | Daemon restart mid-session; reattach; replay yields byte-identical Terminal state (ship-gate (b) for daemon-restart variant) | R4 P0 ch 06 |
| `test/integration/pty-multi-attach.spec.ts` | N concurrent Attach streams receive same byte boundaries; one slow subscriber doesn't block others; eviction at retention boundary (§6) | R4 P1 ch 06 multi-attach |
| `test/integration/pty/snapshot-cadence.spec.ts` | K_TIME / M_DELTAS / B_BYTES triggers at extreme low (1-byte burst) and extreme high (saturated 50 MB/s) workloads; Resize coalescing (§4 500 ms cap) | R4 P1 ch 06 cadence |
| `test/integration/pty-host-crash.spec.ts` | Test-only `CCSM_PTY_TEST_CRASH_ON` env triggers child-process exit; daemon writes `crash_log source=pty_host_crash`; session state CRASHED; subscribers receive `session_ended`; daemon survives | R4 P1 ch 06 worker→child crash testability |
| `test/integration/daemon-restart-claude-spawn-fail.spec.ts` | On daemon restart, simulate `claude` binary missing; daemon writes `crash_log source=claude_spawn_fail`; session marked CRASHED; UI surfaces failure | R4 P1 ch 06 daemon-restart claude-spawn-fail |
| `test/integration/snapshot-roundtrip.spec.ts` (property-based) | encode(state) == encode(decode(encode(state))) for 1000 random VT byte sequences (covers grapheme clusters, modes_bitmap, palette ordering — §2) | MUST-SPIKE [snapshot-roundtrip-fidelity] |

The `pty-soak-1h` test runs nightly only (60 min); all others run per-PR.
