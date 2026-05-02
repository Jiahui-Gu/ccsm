# R0 (zero-rework) review of 06-pty-snapshot-delta.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 PTY hosts as `worker_threads` share daemon address space — single-tenant assumption

**Location**: `06-pty-snapshot-delta.md` §1; flagged as author sub-decision in `15-zero-rework-audit.md` §4 item 1
**Issue**: One `worker_threads` Worker per session, all sharing the daemon's V8 isolate group and process address space. Justification: zero-copy `Buffer` transfer + single SQLite handle. v0.3 has one principal so trust-domain is uniform. v0.4 introduces cf-access principals (potentially many distinct humans, federated through CF Access) whose sessions create workers in the *same* daemon process as `local-user` workers. There is no OS-level isolation between principal trust domains. A buggy or hostile PTY host (e.g., a worker compromised by a `claude` CLI subprocess that breaks out via a node-pty native-module bug) corrupts other principals' worker memory. This is an additive-shape regression: v0.3 picks the wrong process boundary; v0.4 must reshape.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 single-tenant assumption that becomes wrong with multi-principal (Listener B brings cf-access principals)" — explicitly cited in the rubric; the audit chapter §4 item 1 acknowledges the risk and says "Reviewer should consider mandating `child_process` per session if isolation outweighs perf". This review takes that recommendation: mandate it.
**Suggested fix**: Switch to `child_process` per session in v0.3. Eats the zero-copy benefit; honest about isolation. Coalesce SQLite writes via an explicit RPC-over-stdio protocol from helper to daemon (already needed for the multi-process model). Alternative: ship a process-group-per-principal model now (one helper process per `principalKey`, hosting all that principal's session workers as worker_threads inside it). Either way, the *process boundary* must be set in v0.3 because v0.4 cannot add one without reshaping every place that touches `pty-host worker`.

### P0.2 SnapshotV1 binary `screen_state` is uncompressed and network-infeasible for v0.4 web/iOS

**Location**: `06-pty-snapshot-delta.md` §2; flagged as author sub-decision in `15-zero-rework-audit.md` §4 item 2
**Issue**: SnapshotV1 encodes each cell as `{uint32 codepoint, uint32 attrs_index, uint8 width}` = 9 bytes plus per-line headers. A typical 80×50 viewport = ~36 KB; with the spec's "10k lines scrollback typical" the snapshot is **~7 MB uncompressed**. Over loopback (v0.3 Electron) this is fine. Over CF Tunnel from a v0.4 web/iOS client on residential broadband, a 7 MB snapshot every reattach is unusable (multi-second blocking). The v0.4 delta in §9 says "Add optional snapshot compression (zstd) as `schema_version = 2` if profiling demands it; v1 retained forever." But: web/iOS clients in v0.4 will REQUIRE schema_version=2; meanwhile the daemon must continue serving v1 to v0.3 Electron clients (forever-stable contract). The daemon then ships **two snapshot encoders forever**, with per-attach branching on client capability — code-path divergence the v0.3 design could have avoided. Worse, v1 becomes "the legacy format nobody uses except a v0.3 Electron that nobody runs anymore" and gets bit-rot.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 message field whose semantics shift in v0.4" applied to `PtySnapshot.screen_state`'s effective schema; also "Any v0.3 listener API that's not symmetric with what B will need".
**Suggested fix**: Ship SnapshotV1 with mandatory zstd compression of the cell array from day one (or at minimum, ship it with cell-attr palette + RLE for runs of empty cells). The on-the-wire format becomes `{header, attrs_palette, zstd-compressed cell-stream}`. v0.3 Electron decompresses locally — trivial CPU. v0.4 web/iOS use the same wire format. No `schema_version=2` ever needed. If zstd-in-browser is a constraint, use a JS-friendly codec (gzip via DecompressionStream native to evergreen browsers) — this is a v0.3 decision to make NOW.

### P0.3 `Attach.since_seq` is `uint64` but the stream is delivered without per-frame ack, so the client can't reliably resume after partial application

**Location**: `06-pty-snapshot-delta.md` §5
**Issue**: "The client (Electron) maintains its own `lastAppliedSeq`. On any Attach, it sends `since_seq = lastAppliedSeq`. On disconnect mid-stream, it reconnects with the last seq it actually applied (NOT the last seq it received, in case of partial application)." Fine for v0.3 Electron (in-process xterm renderer applies synchronously). For v0.4 web client over CF Tunnel: HTTP/2 stream framing may deliver bytes that the JS event loop has not yet applied to the on-screen xterm at the moment the connection drops. The web client cannot atomically know "applied seq" at disconnect time — it only knows "received seq". Reattaching with `since_seq = lastReceivedSeq` risks **dropping deltas that arrived but were not applied**; reattaching with the last-confidently-applied seq risks **redelivery of already-applied deltas** which corrupt xterm state (raw VT replay is non-idempotent). v0.3 design has no protocol-level ack; v0.4 will need one and adding it forces either a new RPC or a new field with semantic shift on existing `Attach`.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 listener API that's not symmetric with what B will need" — the streaming protocol requires explicit acks for non-loopback clients.
**Suggested fix**: Ship in v0.3 a client-side ack stream as a *bidi* RPC OR add a periodic `AckPty(session_id, applied_seq)` unary RPC. v0.3 Electron can no-op the ack (loopback never disconnects mid-byte); v0.4 web/iOS use it for accurate resume. Add `bool requires_ack = N;` to `AttachRequest` so the daemon knows whether to retain unack'd deltas separately from snapshot-window pruning.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Delta `payload = raw VT bytes` assumes daemon-locale matches client interpretation

**Location**: `06-pty-snapshot-delta.md` §3
**Issue**: `node-pty` master emits whatever bytes the spawned child writes; for `claude` CLI (Node-based, UTF-8) on a daemon whose service-account locale is UTF-8, this is fine. On Windows (`LocalService` runs with system locale, often a CP-125x codepage on legacy installs) bytes may not be UTF-8. v0.3 Electron renders in xterm-headless (which assumes UTF-8 by default unless `windowsMode` is set). v0.4 web/iOS clients have less control over this assumption. The chapter does not pin "deltas are UTF-8" as a contract.
**Why P1**: Soft contract gap; v0.4 web/iOS will hit it; daemon-side fix (force `LANG=C.UTF-8` / equivalent in the spawned child env) is additive and cheap if pinned now.
**Suggested fix**: In §3 add: "Delta payload bytes MUST be UTF-8 sequences as written by the spawned subprocess. Daemon ensures this by setting `LANG=C.UTF-8` (linux/mac) and `chcp 65001` (win) in the spawn environment of every `claude` CLI subprocess." Lock this in v0.3.

### P1.2 16ms / 16KiB cut policy is not negotiable per-attach — bad for high-latency v0.4 clients

**Location**: `06-pty-snapshot-delta.md` §3 (segmentation rules) and §9 (v0.4 delta acknowledges the gap)
**Issue**: §9 says "Add delta batching mode for high-latency networks (web client over CF Tunnel); add new optional `Attach.batch_window_ms` field; daemon defaults to current behavior." This IS additive — fine — but the segmentation happens **once per session, broadcast to all subscribers**. If one subscriber is loopback Electron (wants 16ms) and another is CF-Tunnel web (wants 100ms batches), the daemon today batches once; per-subscriber batching needs new code paths.
**Why P1**: v0.4 multi-subscriber heterogeneity not designed-in.
**Suggested fix**: Document that v0.3 emits at the daemon's chosen cadence; per-subscriber re-batching is a v0.4 *consumer-side* (or proxy-side) concern, not daemon. Add to chapter 15 §3 forbidden-patterns: "Daemon delta segmentation cadence is per-session, not per-subscriber; v0.4 MUST NOT change this." This forecloses the temptation to reshape.

### P1.3 Snapshot taken on `Resize` blocks deltas for that session — increases tail latency

**Location**: `06-pty-snapshot-delta.md` §4
**Issue**: "An explicit `Resize` was processed (geometry change is hard to replay via deltas alone)" triggers a snapshot; §5 cadence section says snapshot writes "block deltas for that session for the snapshot duration". Resize is user-driven (window drag) — frequent during a UI resize gesture — and each one stalls the byte stream. v0.3 Electron user notices a brief freeze. v0.4 web/iOS users ALSO call Resize but over high-latency tunnel; the stall window stretches to seconds.
**Why P1**: Performance regression at the v0.3-to-v0.4 boundary; not a code-shape rework.
**Suggested fix**: Coalesce resize-triggered snapshots: take at most one snapshot per 500ms regardless of how many `Resize` calls land. Lock this in v0.3 §4.
