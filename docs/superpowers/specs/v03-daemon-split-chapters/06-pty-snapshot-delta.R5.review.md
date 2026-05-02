# R5 review — 06-pty-snapshot-delta.md

## P0

### P0-06-1. Snapshot encoding `Line` struct contains `cell_count`+`cells[]`+`wrapped` — but `Cell.codepoint` is `uint32` and supports unicode scalars; **no support for grapheme clusters / combining characters / ZWJ sequences**
xterm-headless internally tracks combining marks per cell; SnapshotV1 stores one `codepoint` per cell. Roundtrip with combining characters (e.g. flag emoji 🇺🇸 = 2 codepoints, family emoji = ZWJ sequence of N codepoints) **will lose data** — the spike [snapshot-roundtrip-fidelity] would catch this on real input but the property test uses "1000 random VT byte sequences" which may not stress combining marks. **P0** because ship-gate (c) demands binary-identical SnapshotV1 over a 1-hour soak with "mixed-language code blocks (UTF-8, CJK, RTL)" — a single emoji in a code block fails the gate. Either: (a) extend `Cell` to a `cells: { codepoint, combiners[] }` shape now, (b) document this limitation as an explicit v0.3 ship-blocker that requires schema_version=2 before ship.

## P1

### P1-06-1. Delta seq monotonicity vs snapshot `base_seq`
- §3 "Delta `seq` is per session, monotonically increasing by 1, and never reused. After a snapshot is taken, the snapshot's `base_seq` equals the most recent delta's `seq` at the moment of capture. New deltas after that snapshot start at `base_seq + 1`."
- §5 reconnect: `if since_seq == 0: ... resume_seq := snapshot.base_seq + 1` — if snapshot was taken with no prior deltas, `base_seq` would be 0 or undefined?
First-snapshot-of-session edge case undefined. Pin: a session's first snapshot before any deltas have `base_seq = 0`; first delta has `seq = 1`. State it.

### P1-06-2. `xterm-headless` package name vs API
§1 uses `xterm-headless Terminal`. The actual npm package is `@xterm/headless` (or `xterm/headless`). Package naming is not pinned anywhere in chapter 11. P1 — downstream worker will Google and find an outdated rename.

### P1-06-3. `worker_threads` worker per session — bound count?
§1 "One pty-host worker per Session". If user has 200 sessions, 200 worker threads. Node default thread pool size is small (CPU cores) but worker_threads are independent. Pin a session cap (see also chapter 02 review S1-02-1).

### P1-06-4. "all multi-byte integers are little-endian" — confirms portability
Good. Pinned.

### P1-06-5. `K_TIME = 30 seconds` / `M_DELTAS = 256` / `B_BYTES = 1 MiB` / `DELTA_RETENTION_SEQS = 4096`
Constants pinned by name in §4. Good. But constants not declared anywhere as `const` in code — downstream worker has to find these in the spec. Also, no "configurable via Settings" — chapter 04 §6 `Settings` has only `claude_binary_path`, `default_geometry`, `crash_retention`. If these are non-configurable, document "v0.3 hardcoded; v0.4 may add Settings.pty_*".

### P1-06-6. Ship-gate (c) test file paths
§8 says `packages/daemon/test/integration/pty-soak.test.ts` (note `.test.ts`) but chapter 12 §3 uses `.spec.ts` extension uniformly (`pty-attach-stream.spec.ts`, etc.). Pick one. Vitest accepts both but inconsistency triggers grep noise.

### P1-06-7. "claude_args=[\"--simulate-workload\", \"60m\"]" 
This invokes the **real** `claude` binary path with these args. But chapter 12 §5 says we ship a separate `claude-sim` test binary. The session would need `Settings.claude_binary_path` overridden to point at `claude-sim`. The soak harness (§8 step 2) does not do that. **State explicitly**: ship-gate (c) sets `claude_binary_path = path/to/claude-sim` before CreateSession. Otherwise the test calls real `claude` with an unsupported flag.

### P1-06-8. Vague verbs
- §6 "There is no per-subscriber back-pressure beyond Connect's HTTP/2 flow control" — pinned, OK.
- §7 "writes the post-snapshot deltas back into xterm-headless to bring its in-memory state current" — clear.

## Scalability hotspots

### S1-06-1. `pty_delta` table grows fast
With M_DELTAS=256 and pruning at `seq < base_seq - 4096`, retained delta count per session is ~4352. ×200 sessions × ~16 KiB/delta → ~14 GiB. Even at lower delta sizes this is significant. Pin a per-session byte cap on retained deltas, OR document expected disk usage budget.

### S1-06-2. `Set<Subscriber>` broadcast in §6 has no cap
"A session may have N concurrent Attach streams". N unbounded. Pin (e.g. 8 per session).

## Markdown hygiene
- ASCII-art topology renders fine.
- Pseudo-struct in §2 uses no language tag (raw fence) — should be ` ```c ` or ` ```text `. P1.
- §5 decision tree pseudo-code fence is untagged — same issue.
- §3 "Delta segmentation rules" numbered list OK.
