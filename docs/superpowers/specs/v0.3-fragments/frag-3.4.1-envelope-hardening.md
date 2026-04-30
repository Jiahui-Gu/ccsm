# Fragment: §3.4.1 Envelope hardening (frame cap + chunk + binary)

**Owner**: worker dispatched per Task #932
**Target spec section**: insert after §3.4 in main spec (already referenced at §3.1.1 line 80: "Envelope hard cap: 16 MiB per frame ... DoS protection from Connect adapter §3.4.1 below.")
**P0 items addressed (round-1)**: envelope cap (security M3), head-of-line blocking (perf MUST-FIX #2), binary frame format (perf MUST-FIX #1).
**P0 items addressed (round-2)**: interceptor + headers + traceId in envelope header (fwdcompat P0-1, observability P0-2, perf P0-A); hello/version handshake (fwdcompat P0-2, lockin P0-1); RPC namespace rule (fwdcompat P0-3); per-chunk amplification mitigations (perf P0-A/P0-B); reserved header keys for runtime tunables (fwdcompat P1-2); streamId allocation (fwdcompat P2-2); handler-arg schema responsibility split (security P1-S1); traceId validation (security P1-S2).

**P0 items addressed (round-3)**: hello wire shape switched from plaintext bearer to HMAC challenge-response (security r3 P0-1) so `daemon.secret` never traverses the wire; explicit frame-version-nibble-then-length-then-cap parsing order (security r3 CC-1); traceId-optional-on-chunk/heartbeat validator carve-out (security r3 CC-2); `bootNonce` camelCase locked across all fragments (fwdcompat r3 CC-2); `x-ccsm-deadline-ms` clamp raised to 120 s and unified with frag-3.5.1 (fwdcompat r3 CC-3); `daemonAcceptedWires[]` advertised in hello reply (fwdcompat r3 P1-5); `clientImposterSecret` removed from redact list (no longer exists post-HMAC switch — lockin r3 CF-3); `seq` zero-padded to fixed 10-digit ASCII to keep header-skeleton fast path stable past `seq=10000` (perf r3 P1-1); explicit feature-add-vs-version-bump rule (fwdcompat r3 P1-4); optional warn on unknown `x-ccsm-*` header keys (fwdcompat r3 P1-7); `control-socket` (data plane control RPCs) and `-sup` socket (supervisor `/healthz`) clarified as TWO separate sockets with explicit table (perf r3 CF-1); subscribe RPC contract canonical owner cross-ref (fwdcompat r3 P1-2); `statsVersion` dropped from `/healthz` (fwdcompat r3 P1-3, owned by frag-6-7).

---

### 3.4.1 Envelope hardening (v0.3 local channel)

The hand-written length-prefixed JSON envelope used in v0.3 (Plan Task 5; replaced by real Connect-RPC over HTTP/2 in v0.4) ships with the hardening rules below. They are local-channel only — v0.4 Connect+Protobuf gets these natively.

#### 3.4.1.a Hard 16 MiB cap per envelope

`connectAdapter.ts` reads `len = buffer.readUInt32BE(0)` and currently accumulates up to 4 GiB before parsing. Trivial DoS via memory exhaustion from a single co-tenant process (security review M3, `~/spike-reports/v03-review-security.md` §3).

**Frame-header parsing order (round-3 security CC-1)**: the 4-byte frame header MUST be processed in this exact sequence — getting the order wrong either resurrects a 256 MiB DoS or leaks a stale-client crash:

1. Read 4 bytes → `raw = buffer.readUInt32BE(0)`.
2. **Extract the version nibble FIRST**: `nibble = (raw >>> 28) & 0x0F`. If `nibble` is not in the daemon's known-version set (v0.3 daemon: `{0x0}`; v0.4 daemon: `{0x0, 0x1}`), reject with `{ code: "UNSUPPORTED_FRAME_VERSION", nibble }` and `socket.destroy()`. Do NOT mask + length-check first; an attacker setting `nibble = 0x1` against a v0.3 daemon would otherwise produce a `len > 16 MiB` reading from raw bits and the cap-check error would mask the real reason.
3. **Then mask** the low 28 bits to compute payload length: `len = raw & 0x0FFFFFFF` (max 256 MiB by construction).
4. **Then cap-check**: if `len > 16 * 1024 * 1024`, run the rejection sequence below.

**Rule**: if `len > 16 * 1024 * 1024`, immediately:
1. emit `pino.warn({ peer, peerPid, len }, "envelope_oversize")` — `peerPid` from the §3.1.1 peer-cred check, included for forensic correlation per round-2 reliability S-R5,
2. write a synthetic `{ id: 0, error: { code: "envelope_too_large", message: "max 16 MiB" } }` reply (best-effort),
3. `socket.destroy()`.

Mirrored at §3.1.1 (socket-level cap) for defense in depth: the listener also caps the per-connection inbound byte budget at 64 MiB across all in-flight frames so an attacker cannot dribble 16 MiB frames in a tight loop.

Rationale for 16 MiB: PTY input is keystroke-sized; the largest legitimate envelope is a single PTY-snapshot header (post-3.4.1.c, payload moves out of JSON), well under 1 MiB. Settings RPC payloads cap at a few KiB. 16 MiB is two orders of magnitude above the largest legitimate use, well below realistic memory-pressure on a 16 GiB dev box.

Rationale for the 64 MiB per-connection in-flight ceiling: 4× the per-frame cap, chosen as a worst-case "attacker dribbles in 4 max-frames before any can be parsed". Not measurement-derived; flagged as a v0.4 tuning candidate (round-2 perf §4 vibes table, P2 only).

**Pre-accept rate cap (round-2 security T15)**: the listener also caps `accept()` calls at 50/sec (`MAX_ACCEPT_PER_SEC`); excess connections fail with `EAGAIN` and a once-per-minute rate-limited log. Cheap defence vs co-tenant connect-flood DoS.

#### 3.4.1.b Head-of-line mitigation: chunk stream payloads to ≤16 KiB

The local socket multiplexes all RPCs (unary + server-streams, Plan Task 11 step 1 extends envelope with `streamId`). The socket is byte-serialized: a 10 MB PTY-snapshot envelope being framed-and-written **blocks the unary `listSessions` reply queued behind it** for 50–200 ms on a local pipe — visible UI stutter (perf review §3 throughput, MUST-FIX #2, `~/spike-reports/v03-review-perf.md`).

**Rule**: any stream-message payload (`stream.kind === "chunk"`) larger than **16 KiB** is split into N ≤16 KiB sub-chunks at the adapter boundary, each emitted as its own length-prefixed frame with the same `streamId` and a per-stream monotonic `seq`. Receiver re-assembles by `streamId`. Unary RPC frames may interleave between sub-chunks.

**Wording correction (round-2 perf §4 vibes table)**: 16 KiB matches HTTP/2's *default frame size* and so the byte-level chunking idiom is wire-compatible with the v0.4 Connect/HTTP-2 swap. It does **NOT** replicate HTTP/2's per-stream flow-control windows or multiplexing primitives — the v0.3 hand-rolled byte-stream is FIFO across streams, with chunking as the only fairness mechanism. Genuine flow control arrives in v0.4.

Snapshot bootstrap (`getBufferSnapshot`, lifecycle.ts:178-203) is the worst offender — already chunked **on the daemon side** but currently re-collapsed into one wire envelope. Snapshot must stream as `stream.kind === "chunk"` sub-frames the same way live deltas flow (perf MUST-FIX #3). Snapshot `chunk` boundaries align with the existing 1000-line async-chunk boundary on the daemon side; no extra serialization passes.

**`streamId` allocation (round-2 fwdcompat P2-2 / HTTP-2 parity)**: `streamId` is `uint32`. Client-initiated streams use **odd ids starting at 1**; server-pushed streams (none in v0.3 — reserved for v0.4 server-push notifications) use **even ids starting at 2**. Identical to HTTP/2's stream-id convention, so the v0.4 native swap reuses the same wire ids byte-for-byte. Each side maintains its own monotonic counter; collisions are impossible by construction.

**Replay bound on resubscribe (round-2 resource P0-1)**: when a client resubscribes with `fromSeq = lastSeenSeq + 1` (§3.7.5 contract), the daemon ships at most **256 KiB of replay** before declaring `gap: true` and forcing a fresh snapshot. The 1 MiB per-subscriber drop-slowest watermark (frag-3.5.1 §3.5.1.5) is measured **after** the initial replay burst lands (replay treated as one prioritized initial write, not slow-subscriber accounting). Without this rule a nodemon-storm reconnect into a hot stream loops drop-and-resubscribe.

**Subscribe RPC contract — canonical owner (round-3 fwdcompat P1-2)**: the `subscribe(sessionId, { fromSeq?, fromBootNonce?, heartbeatMs? })` request shape is **canonically owned by frag-3.5.1 §3.5.1.4**. This fragment owns only the wire-level chunking + replay-budget mechanics; field naming, defaults, clamps, and protobuf message definition (for v0.4) live in frag-3.5.1. Other fragments referencing subscribe (frag-3.7 §3.7.5 reconnect, frag-6-7 §6.5 supervisor exception) cite frag-3.5.1 §3.5.1.4 as the source of truth.

#### 3.4.1.c Binary frame format for PTY chunks

Today's envelope is `[len:4][JSON utf8]`. PTY output strings round-tripped through `JSON.stringify` + `JSON.parse` cost 5–30 ms per 64 KiB+ chunk and a fresh string allocation on the client side (perf §2 latency table, MUST-FIX #1). If `node-pty` is ever switched to `encoding: null` (raw `Buffer`), base64 inflates the payload 1.33× and adds ~50 MB/s ceiling.

**Rule**: extend the envelope to a header-JSON + raw-bytes-trailer form for any frame whose payload is binary-ish (PTY output, future blob fields):

```
[totalLen:4][headerLen:2][headerJSON:headerLen][payloadBytes:totalLen-2-headerLen]
```

Note: the high 4 bits of `totalLen` are **reserved as a frame-version nibble** (round-2 lockin P0-1). v0.3 sets the nibble to `0x0`; readers MUST mask it off before computing the actual length. Payload length is therefore capped at 2^28 − 1 ≈ 256 MiB, well above the 16 MiB per-frame cap. v0.4 protobuf wire uses `0x1`; receivers reject unknown nibbles with `frame_version_unsupported` + `socket.destroy()`.

The `headerJSON` schema (round-2 P0 additions in **bold**):

```ts
interface FrameHeader {
  id: number;                          // RPC id
  method?: string;                     // unary RPC method name
  stream?: { streamId: number; seq: number; kind: "open" | "chunk" | "close" | "heartbeat" };
  payloadType: "json" | "binary";
  payloadLen: number;
  /** round-2 fwdcompat P0-1 / observability P0-2 */
  traceId?: string;                    // Crockford ULID, 26 chars; required on call-originating frames
  /** round-2 fwdcompat P0-1 / P1-2 */
  headers?: Record<string, string>;    // case-insensitive; reserved keys below
}
```

- Pure-JSON frames (control RPCs: `listSessions`, settings, etc.) keep the existing form via `payloadType: "json"` (or absence — default JSON for backward compat during the lift). The JSON body lives in the header object as before.
- For `payloadType: "binary"`, `payloadBytes` is the raw `Buffer` straight from `node-pty` (UTF-8 byte buffer; no base64, no `JSON.stringify` of the body).
- Header still validated against the TypeBox contract at the adapter boundary (§3.1.1 schema rule); the binary trailer is opaque to *envelope* validation. **Per-method handler-arg validation of `payloadBytes` is the handler's responsibility** (round-2 security P1-S1) — see §3.4.1.d.

**`traceId` validation (round-2 security P1-S2, round-3 security CC-2)**: validation runs **only when `traceId` is present** in the header. Inheriting sub-frames (`stream.kind === "chunk" | "heartbeat"`) carry no `traceId` by design (see §3.4.1.c omission rule below); for those frames the validator skips the regex check and resolves the call's traceId from the `streamId → traceId` map established at `kind: "open"` time. **Missing inherited mapping** (chunk/heartbeat arrives for an unknown `streamId`) is itself a protocol error and closes the stream with `RESOURCE_EXHAUSTED`. When `traceId` IS present (open frames + all unary frames), it is validated against the Crockford ULID regex `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`. Mismatch → reject + `socket.destroy()`. Renderer-supplied `traceId` is treated as untrusted input; daemon log lines additionally include a daemon-generated `daemonTraceId` so forensic correlation never relies on caller-supplied data alone. Pino formatters strip `\n\r` from any string field destined for non-JSON destinations (defence vs log-injection via crafted `traceId` / `headers` values).

**`traceId` placement on stream frames (round-2 perf §5.3, round-9 manager lock — r8 envelope P1-2)** `[manager r9 lock: r8 envelope P1-2 — close-frame traceId carriage rule]`: `traceId` is required on call-originating frames (`stream.kind === "open"`, all unary frames) AND on `stream.kind === "close"` (so terminal log lines correlate even after the `streamId → traceId` map entry is GC'd). It is **omitted** from `stream.kind === "chunk"` and `stream.kind === "heartbeat"` sub-frames — receivers inherit the call's traceId from the `streamId → traceId` map established at `kind: "open"` time. Saves ~34 B per chunk and removes redundant ULID strings from the high-volume PTY path. **Map-entry GC ordering**: the `streamId → traceId` entry is removed AFTER processing `kind: "close"` so the close frame's own traceId takes precedence over the (now-removed) map entry; this avoids a race where a fast subsequent `kind: "open"` on a reused streamId could overwrite the map entry mid-close-handling.

**Reserved `headers` keys (round-2 fwdcompat P1-2, round-3 fwdcompat CC-3 + P1-7, round-9 manager lock — r8 envelope P0-3)**: `x-ccsm-deadline-ms` (per-call deadline override; v0.3 honored, **clamp `100 ms ≤ x ≤ 120 s`** — unified with frag-3.5.1 §3.5.1.3 to allow v0.5 web snapshot bootstrap with 30 s+ headroom), `x-ccsm-heartbeat-ms` (stream heartbeat override; v0.3 reserved, no-op), `x-ccsm-backpressure-bytes` (per-subscriber drop-slowest override; v0.3 reserved, no-op), `x-ccsm-trace-parent` (W3C traceparent for v0.5 OTLP; v0.3 reserved), **`x-ccsm-boot-nonce`** (subscribe RPC last-known boot nonce; v0.3 honored, see §3.4.1.g — `[manager r9 lock: r8 envelope P0-3 — added to reserved-keys allowlist so deadlineInterceptor stops warning on every PTY subscribe; precedence + RPC-param coexistence rule in §3.4.1.g]`). Daemon advertises defaults via the §3.4.1.g hello block. Workers may NOT define new `x-ccsm-*` keys without spec amendment; arbitrary other keys (no `x-ccsm-` prefix) are permitted (passed through to interceptors in §3.4.1.f). The `deadlineInterceptor` MUST `pino.warn({ key, method, peerPid }, "unknown_xccsm_header")` (rate-limited once per `key` per minute) when an `x-ccsm-`-prefixed header arrives outside the reserved allowlist — catches v0.3.x worker squatting before it hardens into a wire contract.

**Hot-path optimizations (round-2 perf P0-A, resource SHOULD-3, round-3 perf P1-1)**: a 1 MiB PTY-snapshot stream becomes 64 sub-frames; the per-frame `JSON.stringify(header)` + `JSON.parse(header)` becomes the dominant CPU cost. The adapter MUST:
1. **Cache the per-stream header skeleton** at `kind: "open"` time. Sub-chunks (`kind: "chunk"`) reuse the cached bytes with only the fixed-width `seq` field patched in-place per frame. **`seq` is encoded as zero-padded 10-digit ASCII** (covers full uint32 range — `4294967295` is 10 digits) so the skeleton byte length never shifts as `seq` crosses 10/100/1000/10000/… boundaries. Without zero-padding, the cached skeleton would silently fall back to full `JSON.parse` past `seq=10000` (4-byte → 5-byte width shift), a silent perf cliff. Receiver-side, after first `kind: "open"` is parsed for a `streamId`, subsequent same-`streamId` `kind: "chunk"` frames take a fast path that reads `seq` + `payloadLen` from fixed offsets without invoking `JSON.parse` on the full header. Falls back to full parse on any header-byte change vs the cached skeleton (defensive).
2. **`socket.cork()` before the header `write` and `socket.uncork()` after the trailer `write`** so the kernel emits one packet per sub-frame (eliminates the 320× syscall amplification on a 5 MiB snapshot stream).

**Single-frame caching for fan-out (round-2 perf P0-B)**: when frag-3.5.1 §3.5.1.5's fan-out registry distributes a chunk to N subscribers, the adapter MUST stringify+frame the chunk **once** and call `socket.write(sharedBuffer)` N times (header is identical across subscribers; only the destination socket differs). Latent in v0.3 (single subscriber per session) but the wire contract is locked here; switching later means re-doing fan-out. Cross-referenced from frag-3.5.1 §3.5.1.5.

Cost: ~30 LOC in `connectAdapter.ts` + symmetric change in `testHelpers.ts` (Plan Task 5). v0.4 Connect+Protobuf provides this natively (`bytes` field type) — no migration churn.

#### 3.4.1.d Schema validation hook

Per §3.1.1, every decoded envelope is validated against the TypeBox contract **before** dispatch into handlers. This subsumes the `JSON.parse` reviver concern from security review M3 (no `__proto__` pollution into downstream Maps). Reject malformed → write `{ id, error: { code: "schema_violation" } }` → `socket.destroy()`. Validation happens on the header for binary frames (3.4.1.c).

**Handler-arg validation responsibility (round-2 security P1-S1)**: the adapter check covers only routing fields (`id`, `method`, `stream`, `payloadType`, `payloadLen`, `traceId`, `headers`). For `payloadType === "binary"` frames, **handlers MUST validate the trailer bytes against a per-method byte schema** as their first statement: length cap from `payloadLen` (already known to be ≤ 16 MiB minus header), optional content sniff (e.g. UTF-8 well-formedness for `ptyWrite` data, escape-sequence sanitization for renderer-bound output). For `payloadType === "json"` frames whose handler argument is non-trivial, handlers MUST `Check(MethodArgsSchema, decoded)` as their first statement. ESLint rule `no-handler-without-check` enforces this at lint time.

#### 3.4.1.e Open: spawn imposter handshake

Per §3.1.1 sender peer-cred check, the daemon already verifies the connecting UID. Security review S2 (`~/spike-reports/v03-review-security.md` §4) raises a complementary concern: an attacker who races daemon boot and binds the pipe first can impersonate the daemon to Electron. The §3.4.1.g hello handshake (per-installation shared secret proven via HMAC challenge-response — secret never traverses the wire — plus protocol-version exchange) closes this; the secret lifecycle (installer-time generation, atomic ACL, rotation on auto-update, redact-list) is owned by **frag-6-7 §7.2** (cross-frag rationale below).

#### 3.4.1.f Interceptor pipeline + request context

Round-1 fwdcompat asked for a clean seam to insert v0.5 CF Access JWT verification, audit logging, and rate-limit middleware without rewriting every handler. Round-2 fwdcompat P0-1 escalated to MUST after frag-12 claimed the seam was addressed but no fragment defined it.

```ts
interface ReqCtx {
  method: string;
  headers: Record<string, string>;     // case-insensitive; from envelope header (§3.4.1.c)
  traceId: string;                     // caller-supplied (validated) OR generated by entry interceptor
  daemonTraceId: string;               // daemon-generated, authoritative for log correlation
  peer: { uid: number; pid: number };  // from §3.1.1 peer-cred check
  signal: AbortSignal;                 // composes with handler-internal aborts (§3.5.1.3)
  deadlineMs: number;                  // resolved deadline (default 5 s, headers override per §3.4.1.c)
}

type Handler<Req = unknown, Res = unknown> = (req: Req, ctx: ReqCtx) => Promise<Res>;
type Interceptor = (ctx: ReqCtx, next: () => Promise<unknown>) => Promise<unknown>;

function mountConnectAdapter(opts: {
  socket: Duplex;
  handlers: Map<string, Handler>;
  interceptors?: Interceptor[];        // executed in array order, onion-style (first wraps all)
}): void;
```

v0.3 ships the following interceptors in order:
0. `helloInterceptor` `[manager r7 lock: r6 reliability P1-R6 — explicit ordering #0 so handshake-required check fires BEFORE migrationGateInterceptor; otherwise a non-hello RPC during migration would short-circuit with MIGRATION_PENDING and leak pre-handshake daemon state to an unverified peer]` — runs FIRST on every envelope. Allowlist `["ccsm.v1/daemon.hello"]`; for any other method on a connection that has not yet completed handshake, rejects with `hello_required` and `socket.destroy()` (per §3.4.1.g semantics). `helloInterceptor` short-circuits the rest of the chain on rejection — subsequent interceptors (trace / deadline / migrationGate / metrics) do NOT run, so no log noise, no metric increment, and crucially no `MIGRATION_PENDING` leak. On a connection that HAS completed handshake, `helloInterceptor` is a no-op pass-through.
1. `traceInterceptor` — fills/validates `traceId`, mints `daemonTraceId`, attaches to logger child.
2. `deadlineInterceptor` — reads `headers["x-ccsm-deadline-ms"]` (clamped 100ms ≤ x ≤ 120s per §3.4.1.c), composes `AbortSignal.timeout(deadlineMs)` with handler-supplied signal via `AbortSignal.any` (frag-3.5.1 §3.5.1.3). Also emits the `unknown_xccsm_header` warn (§3.4.1.c) for any non-reserved `x-ccsm-*` key.
3. `migrationGateInterceptor` — short-circuits with `MIGRATION_PENDING` for data RPCs while migration is in progress; allows the canonical `SUPERVISOR_RPCS` constant (declared in §3.4.1.h) through unconditionally (round-2 reliability P1-R3). `[manager r9 lock: r8 envelope P0-1 + r8 devx P0-1 — replaced hardcoded 3-element list with reference to canonical SUPERVISOR_RPCS constant; previously enumerated only `/healthz`, `/stats`, `daemon.hello` and would have wrongly blocked `daemon.shutdown` + `daemon.shutdownForUpgrade` mid-migration]`.
4. `metricsInterceptor` — records `{ method, durationMs, outcome }` per call.

v0.5 appends `cfAccessJwtInterceptor` to the array; no existing handler signatures change. The interceptor array is the only public seam that survives the v0.4 Connect swap (Connect's native interceptor concept maps 1:1).

Cost: ~30 LOC + 1 unit test (interceptor sees `headers={}` for Win named-pipe / unix-socket transports in v0.3).

#### 3.4.1.g Hello / version handshake (frame-version + protocol-version + HMAC imposter check)

`[manager r5 lock: 2-frame HMAC handshake, client issues nonce, daemon proves possession; reason: client identity already proven by peer-cred + socket ACL, daemon identity is what needs proof; saves 1 RT vs 3-frame; aligns with frag-6-7 §7.2.]`

Round-1 §3.3 asked for a versioned handshake; round-2 fwdcompat P0-2 + lockin P0-1 escalated after the round-2 reviewers found the v1 spec/plan never wired it. **Round-3 security P0-1** replaced the original plaintext-bearer imposter check with an HMAC challenge-response after a reviewer noted that the round-2 shape sent `daemon.secret` cleartext on every connection (visible in `strace -e trace=read,write`, every TLS-pcap on v0.5 web, every crash dump), and that `Buffer.compare` is not constant-time so the bearer form additionally leaks the secret byte-by-byte to a probing co-tenant. **Round-5 manager lock**: the wire shape is collapsed from 3 frames to 2 frames, aligned 1:1 with frag-6-7 §7.2 (canonical owner of secret lifecycle + HMAC contract).

**DO NOT send `daemon.secret` on the wire.** The handshake proves possession of the secret without transmitting it.

**Two-frame handshake** (round-3 security P0-1, round-5 manager lock — wire shape mirrors frag-6-7 §7.2 step 1-3):

```ts
// (1) Client → daemon — first envelope on every new connection; carries challenge nonce
{ id: <n>, method: "ccsm.v1/daemon.hello",
  payload: {
    clientWire: "v0.3-json-envelope",        // wire format identifier
    clientProtocolVersion: 1,                // INTEGER (uint, semver-major); bumped on breaking wire change; client's max accepted protocol
    clientFrameVersions: [0],                // frame-version nibbles client can read (§3.4.1.c)
    clientFeatures: ["binary-frames", "stream-heartbeat", "interceptors", "traceId", "bootNonce", "hello"],
    clientHelloNonce: "<base64-16>"          // 16 random bytes (~22 chars on wire); per-connection challenge for daemon to HMAC
  }
}

// (2) Daemon → client — same envelope id; proves possession of daemon.secret AND advertises protocol
{ id: <n>,
  payload: {
    helloNonceHmac: "<base64-22>",           // HMAC-SHA256(daemon.secret, clientHelloNonce) truncated to 16 bytes, base64
    protocol: {                              // canonical version-negotiation block; mirrored 1:1 from frag-6-7 §6.5 healthz
      wire: "v0.3-json-envelope",
      minClient: "v0.3",
      daemonProtocolVersion: 1,              // INTEGER (uint, semver-major); bumped on breaking wire change; bump rule below `[manager r9 lock: r8 envelope P1-4 — type pinned to integer literal; TypeBox Type.Integer({minimum:1}); compare numerically; schema validation REJECTS string values with schema_violation]`
      daemonAcceptedWires: ["v0.3-json-envelope"], // round-3 fwdcompat P1-5; v0.4 ships [..., "v0.4-protobuf"]
      // single source of truth: frag-6-7 §6.5; this list mirrors that
      features: ["binary-frames", "stream-heartbeat", "interceptors", "traceId", "bootNonce", "hello"]
    },
    daemonFrameVersion: 0,                   // active frame-version nibble for this session (§3.4.1.c)
    bootNonce: "<ULID>",                     // mirrors frag-6-7 §6.5 healthz bootNonce; renderer must check after reconnect
    defaults: {                              // see §3.4.1.c reserved headers
      deadlineMs: 5000,
      heartbeatMs: 30000,
      backpressureBytes: 1048576
    },
    compatible: true,
    reason: undefined                        // string only when compatible === false
  }
}
```

The **client** computes the same HMAC over its own `clientHelloNonce` using its loaded `daemon.secret`, and compares against the daemon's `helloNonceHmac` field using **`crypto.timingSafeEqual`** (constant-time; non-negotiable — `Buffer.compare` is forbidden here, byte-by-byte timing leak). Mismatch → client treats the listener as imposter, logs `{ offenderPid }`, refuses to talk, falls back to spawning the real daemon under a fresh socket name (Win named-pipe collision: append `-rescue-<ulid>`). Reverse-direction proof (client proves to daemon) is unnecessary because peer-cred (§3.1.1) + ACL (§7.1) already authenticate the client.

**Base64 variant (round-9 manager lock — r8 envelope P1-1)** `[manager r9 lock: r8 envelope P1-1 — base64url-no-pad locked for both clientHelloNonce + helloNonceHmac]`: both `clientHelloNonce` (16 raw random bytes) and `helloNonceHmac` (truncated 16-byte HMAC-SHA256 output) MUST be encoded on the wire via `Buffer.from(buf).toString('base64url')` — URL-safe alphabet, **no `=` padding**. 16 bytes round-trips to exactly 22 ASCII chars, matching the `<base64-22>` placeholders in the schema. Both sides MUST decode the wire string back to a 16-byte `Buffer` via `Buffer.from(s, 'base64url')` BEFORE invoking `crypto.timingSafeEqual` — comparing the ASCII strings directly bypasses the constant-time guarantee. Padded standard `base64` (24 chars with trailing `==`) is FORBIDDEN; mixing padded vs unpadded variants between client and daemon causes `RangeError [ERR_OUT_OF_RANGE]: Input buffers must have the same byte length` on the very first connection — every install ships dead-on-arrival.

Daemon refuses to dispatch any RPC other than `daemon.hello` on the connection until the handshake completes (`helloInterceptor` enforces; rejects with `hello_required` + `socket.destroy()`). On the daemon side the per-connection `clientHelloNonce` is single-use: any further `daemon.hello` on the same socket after the first is rejected with `hello_replay`.

**Client-side handshake timeout + failure classification (round-7 manager lock — r6 reliability P0-R1)** `[manager r7 lock: r6 reliability P0-R1 — explicit 2 s handshake deadline + dedicated failure class so handshake-failure storms cannot bypass the 250 ms reconnect hold-off and exhaust the queue, and so handshake-stuck remediation (reinstall ccsm) stays distinct from post-handshake hang remediation (restart daemon)]`:

- **Handshake timeout = 2 s**, measured from socket-connect (TCP/pipe accept observed client-side) to receipt of the daemon's frame-2 reply (`helloNonceHmac` + `protocol`). Sits between the §3.7.4 first-attempt backoff (200 ms) and the §3.5.1.3 unary default deadline (5 s) so handshake-failure surfaces faster than a generic stuck unary RPC but does NOT race the first reconnect step. On timeout, the client closes the socket with no synthetic error frame (handshake is pre-RPC, no envelope id to bind a reply to), increments the §3.7.4 reconnect backoff schedule, and emits one `daemon_handshake_timeout` log line `{ peer, durationMs, attemptN }`. The rejection class is `HANDSHAKE_TIMEOUT` (NOT `BridgeTimeoutError` — distinct path so `bridgeTimeoutSpike` aggregation in §6.1.1 is not falsely tripped).
- **Handshake-failure does NOT count toward `bridgeTimeoutSpike` (frag-6-7 §6.1.1) 3-in-10s detector.** The two failure classes are distinct: `bridgeTimeoutSpike` aggregates POST-handshake unary RPC `BridgeTimeoutError`s; handshake failures (timeout, `hello_required`, `hello_replay`, `schema_violation` on `daemon.hello`, HMAC mismatch via `crypto.timingSafeEqual`, `compatible: false` reasons) are treated identically by the client — close socket, count toward §3.7.4 reconnect backoff schedule, surface only via the existing supervisor heartbeat / reconnect surfaces (frag-6-7 §6.1.1 `daemon.healthDegraded` → `daemon.healthUnreachable` ladder + §6.8 reconnect toast). No new modal row is added; remediation copy ("if this persists, ccsm may need to be reinstalled") is folded into the body of the existing `daemon.healthUnreachable` banner (frag-6-7 §6.1.1 owns the copy edit; cross-frag handoff to fixer A — surface registry trim — preserves the row count). Without this carve-out, a daemon stuck rejecting handshakes (corrupted `daemon.secret` after partial auto-update swap, binary mismatch) would falsely trip the 3-in-10s `daemon.bridgeTimeouts` banner whose copy ("the background service may be busy") points the user at the wrong remediation.
- **Reinstall vs restart remediation distinction**: handshake-stuck = binary or secret mismatch (reinstall ccsm); post-handshake hang = handler stuck or daemon thrashing (restart daemon). The `daemon.healthUnreachable` body MUST cover both — since handshake failure surfaces through the same banner, body copy reads roughly `Trying to restart it. If this persists, reinstall ccsm.` (frag-6-7 §6.1.1 owns final wording; cross-frag handoff to fixer A).
- **`clientHelloNonce` regeneration is MANDATORY per connection attempt.** Each new socket (including every reconnect attempt under §3.7.4 backoff) MUST allocate a fresh 16-byte `crypto.randomBytes(16)` value; clients MUST NOT cache or reuse the nonce across attempts. Reuse would let a passive observer correlate reconnect storms; more importantly, the daemon's single-use-per-socket invariant (`hello_replay` rejection) would falsely fire for the second connection if the same nonce arrived. (Already implied by "per-connection challenge" but stated as MUST so a worker doesn't hoist nonce generation out of the connect loop.)

On `compatible: false`, daemon does NOT close the socket immediately — the reply still carries `helloNonceHmac` (so client can rule out imposter) plus `reason` ∈ `{"wire-mismatch", "version-mismatch", "frame-version-mismatch"}` so the client can read the structured error and surface "ccsm needs to be updated" modal (frag-6-7 §6.8 surface registry) before the connection is torn down.

**Wire-debug logging**: pino debug logs MAY include `clientHelloNonce` and `helloNonceHmac` fields verbatim (both are useless without the secret), but they are nonetheless on the redact list curated in **frag-6-7 §6.6 / §7.2** (entries: `daemonSecret`, `installSecret`, `imposterSecret`, `clientImposterSecret`, `*.clientImposterSecret`, `pingSecret`, `helloNonce`, `clientHelloNonce`, `helloNonceHmac`, `*.secret`) for defense in depth. There is no `imposterSecret` cleartext field anywhere in v0.3 post-r3; only `clientHelloNonce` (public, per-connection challenge issued by client) and `helloNonceHmac` (daemon's response, no secret bits leak).

**Compatibility rule**: `compatible = (clientFrameVersions includes daemonFrameVersion) AND (clientProtocolVersion ≥ daemonProtocolVersion's minimum) AND (clientWire is in protocol.daemonAcceptedWires)`. Mismatch → `compatible: false` + `reason` ∈ `{"wire-mismatch", "version-mismatch", "frame-version-mismatch"}`. Client surfaces "ccsm needs to be updated" modal (frag-6-7 §6.8 surface registry); daemon does NOT close the socket immediately so the client can read both `helloNonceHmac` (rules out imposter) and `reason` (drives modal copy).

**Version-bump discipline (round-3 fwdcompat P1-4)**:
- `daemonFrameVersion` (the high-nibble of `totalLen` per §3.4.1.c) bumps **ONLY on wire-format change** (e.g. v0.3 JSON envelope → v0.4 protobuf = nibble 0x0 → 0x1).
- `daemonProtocolVersion` (semver-major integer) bumps **ONLY on breaking handler-contract changes** (RPC removed, request/response field semantics changed). Adding a new RPC method, adding an optional field, or shipping a new optional capability MUST NOT bump `daemonProtocolVersion` — those go in `protocol.features[]`. This prevents v0.3.x from forcing a panic-bump every time a worker adds a non-breaking RPC.
- `protocol.daemonAcceptedWires[]` lets a future v0.4 daemon accept BOTH legacy v0.3-json-envelope clients and native v0.4-protobuf clients on the same socket during the rolling-upgrade window; v0.3 daemons advertise a single-element array.

**`bootNonce` propagation (round-2 fwdcompat P1-1, round-3 fwdcompat CC-2)**: the hello reply carries the daemon's current `bootNonce` (camelCase — locked across all fragments per round-3 fwdcompat CC-2; frag-6-7 §6.5 healthz uses the same camelCase spelling, NOT `boot_nonce`). Stream `subscribe` RPCs include the last-known `bootNonce` as a header (`headers["x-ccsm-boot-nonce"]`). On nonce mismatch, daemon ignores `fromSeq` and sends a fresh snapshot with `bootChanged: true`. Stream contract details (renderer divider rendering, log lines) are owned by **frag-3.5.1 / frag-3.7**.

**`bootNonce` carriage precedence (round-9 manager lock — r8 envelope P0-3)** `[manager r9 lock: r8 envelope P0-3 — header + RPC-param double-carriage precedence rule]`: `bootNonce` may arrive on a subscribe RPC via either (a) the envelope header `headers["x-ccsm-boot-nonce"]` (this section, allowlisted in §3.4.1.c) OR (b) the canonical RPC param `fromBootNonce` (frag-3.5.1 §3.5.1.4 owns the param shape). The daemon MUST tolerate both forms during the v0.3 lift. Resolution rule: **if BOTH the header AND the RPC param carry a value, the header wins** (envelope-level intent takes precedence over per-method body for transport-layer semantics). **If only the header is present, the header value is used. If only the RPC param is present, the param value is used.** Daemon emits one `pino.debug({ method, headerVal, paramVal }, "boot_nonce_dual_carriage")` line (debug-only — single-source clients should pick ONE form per call site). The `x-ccsm-boot-nonce` header is reserved per §3.4.1.c; the RPC-param shape stays canonical for protobuf migration.

**v0.4 / v0.5 transition**: v0.4 daemon ships with `daemonFrameVersion: 1` (protobuf), advertises `protocol.wire: "v0.4-protobuf"` plus `protocol.daemonAcceptedWires: ["v0.3-json-envelope", "v0.4-protobuf"]`, and registers BOTH `ccsm.v1/...` (legacy bridge for v0.3 clients) and `ccsm.v2/...` (protobuf-native) namespaces. v0.5 web client over CF Tunnel sets larger `headers["x-ccsm-deadline-ms"]` per call (e.g. 30000 for snapshot bootstrap; clamped 120 s per §3.4.1.c). The hello envelope itself stays at frame-version 0 in perpetuity so cross-version negotiation always succeeds.

**RPC namespace evolution (round-2 fwdcompat P0-3)**: RPC method names use `ccsm.<wireMajor>/<service>.<method>`. v0.3 daemon registers ONLY `ccsm.v1/...`. A future v0.4 daemon registers BOTH `ccsm.v1/` (legacy bridge) AND `ccsm.v2/` (protobuf). Removing `ccsm.v1/` happens in v0.5 once all clients have re-handshaken to v2. Workers MUST NOT hard-code `ccsm.v1` checks anywhere outside the dispatch table — the namespace rule is the single source of truth for version-pinned routing.

Cost: ~25 LOC (single new RPC `daemon.hello` + per-connection `clientHelloNonce` validation via `crypto.randomBytes(16)` on client + HMAC compute on daemon + handshake interceptor) + 2 unit tests asserting (a) `compatible: false` path returns `helloNonceHmac` + `reason` cleanly without immediate socket close and (b) bit-flipped `helloNonceHmac` rejected via `timingSafeEqual` on the client side (asserts the constant-time path is wired, not just the equality).

#### 3.4.1.h Healthz transport isolation (round-2 reliability P0-R5, round-3 perf CF-1)

Per §6.5, the supervisor pings `/healthz` every 5 s with 3-miss = restart. If `/healthz` shares the data adapter with a snapshot fan-out, a 1 MiB sub-chunk stream serializing through the same socket can starve the heartbeat → false-positive restart.

**Rule**: the daemon binds **two separate listeners** (round-3 perf CF-1 disambiguates from frag-6-7 §6.5 supervisor transport — the `control-socket` defined here IS the supervisor `ccsm-control` socket per frag-6-7 §6.5; there are exactly TWO sockets per daemon, not three) `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control across both fragments; replaces prior `-sup` alias]`:

| Socket | RPCs served | Consumers | Posix path | Windows path |
|---|---|---|---|---|
| **data-socket** | every RPC except those listed in the control row | Electron renderer (via main-process bridge) | `<runtimeRoot>/ccsm-data.sock` | `\\.\pipe\ccsm-data-<userhash>` |
| **control-socket** (a.k.a. `ccsm-control` socket per frag-6-7 §6.5) | `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown` (frag-6-7 §6.4 step 4 graceful drain), `daemon.shutdownForUpgrade` (frag-6-7 §6.4 upgrade-in-place + marker; consumed by frag-11 §11.6.5) | supervisor process AND Electron main (parallel connections, shared posture) | `<runtimeRoot>/ccsm-control.sock` | `\\.\pipe\ccsm-control-<userhash>` |

**`<runtimeRoot>` definition (round-9 manager lock cross-ref + r11 devx P1-4)** `[manager r11 lock: P1 devx P1-4 — explicit OS-native runtime root replaces hardcoded `~/.ccsm/run/...` paths; cross-references frag-12 r5 lock #2 `<dataRoot>` definition]`: `<runtimeRoot>` is the OS-native runtime/socket directory, distinct from `<dataRoot>` (logs/db/binaries):
- **Linux**: `process.env.XDG_RUNTIME_DIR ?? <dataRoot>/run` (XDG-compliant tmpfs preferred; falls back to data root if `XDG_RUNTIME_DIR` is unset/unwritable, e.g. systemd-less containers).
- **Windows**: named pipes namespace (`\\.\pipe\ccsm-{data,control}-<userhash>`) — no filesystem path; the `<runtimeRoot>` notation in the table cell is a notional anchor for the named-pipe form. Where a filesystem path is unavoidable (e.g. lockfile sibling), use `<dataRoot>\run\`.
- **macOS**: `<dataRoot>/run/` (Apple does not export an `XDG_RUNTIME_DIR` equivalent; the data root sub-directory keeps socket nodes co-located with the rest of the per-user state and inherits the `<dataRoot>` ACL).

`<dataRoot>` itself is defined in frag-12 (r5 lock #2): `%LOCALAPPDATA%\ccsm` (Win), `~/Library/Application Support/ccsm` (mac), `~/.local/share/ccsm` (Linux). The `<runtimeRoot>` derivation above is the single source of truth for socket / pipe paths; fragments referencing socket paths MUST cite `<runtimeRoot>` and not rehydrate `~/.ccsm/run/...` literals.

Both sockets share peer-cred / DACL / accept-rate-cap / hello-handshake posture. The Electron client connects to BOTH (control for supervisor-shaped RPCs + supervisor itself, data for everything else). The supervisor connects only to `control-socket`. There is **no** third socket — `ccsm-control` is the single canonical name for the control plane shared with frag-6-7 §6.5; the prior `-sup` alias is fully retired `[manager r11 lock: P1 devx P1-2 — `-sup` literal removed in favor of `ccsm-control` everywhere; cross-frag merge no longer required]`.

**Control-plane namespace carve-out (round-11 manager lock — P1 reliability daemon.stats → /stats sweep)** `[manager r11 lock: P1 reliability — explicit control-plane namespace exemption from §3.4.1.g `ccsm.<wireMajor>/...` rule]`: `/healthz` and `/stats` are **literal paths** exempt from the `ccsm.<wireMajor>/<service>.<method>` namespace prefix mandated by §3.4.1.g for all data-plane methods. They are control-plane RPCs declared in the canonical `SUPERVISOR_RPCS` constant below and dispatched on the control-socket as wire-literals (the on-wire `method` field equals `/healthz` / `/stats`, NOT `ccsm.v1/daemon.healthz` / `ccsm.v1/daemon.stats`). Consumers (control-socket dispatcher, helloInterceptor allowlist, `migrationGateInterceptor` allowlist, frag-8 §8.5 migration scope) compare these as literal strings and MUST NOT silently namespace-prefix them. Rationale also covered by the §3.4.1.h literal-vs-namespace lock paragraph below; restated here as the control-plane vs data-plane carve-out to give frag-6-7 / frag-8 a single anchor when wiring `SUPERVISOR_RPCS`.

**Allowlist constant (round-3 fwdcompat P1-1)**: the set of "control-plane RPCs" is a single canonical constant `SUPERVISOR_RPCS = ["/healthz", "/stats", "daemon.hello", "daemon.shutdown", "daemon.shutdownForUpgrade"]` declared here and consumed by (a) the control-socket dispatcher (this section), (b) the `migrationGateInterceptor` (§3.4.1.f) as the short-circuit allowlist, and (c) frag-8 §8.5 migration scope. Other fragments reference the constant by name; they MUST NOT enumerate alternative lists. `[manager r7 lock: r6 packaging P0-2 — daemon.shutdownForUpgrade added to allowlist; semantics + marker file owned by frag-6-7 §6.4; consumed by frag-11 §11.6.5 upgrade-in-place flow.]`

**Literal-vs-namespace lock (round-9 manager lock — r8 envelope P1-3)** `[manager r9 lock: r8 envelope P1-3 — /healthz and /stats keep HTTP-style literal method names; explicit exemption from §3.4.1.g ccsm.<wireMajor>/<service>.<method> namespace rule]`: `/healthz` and `/stats` are wire-literal method values (the on-wire `method` field equals the literal string `/healthz` or `/stats`, NOT `ccsm.v1/daemon.healthz` / `ccsm.v1/daemon.stats`). The §3.4.1.g namespace rule applies to all OTHER RPCs; these two HTTP-path-style entries are explicitly exempt because (a) they pre-date the namespace convention as supervisor heartbeat literals, (b) zero-cost dispatch on the control-socket reads the literal once, (c) supervisors / external probes can hit them without round-tripping a wire-version negotiation. The dispatch table MUST register the literal `/healthz` (no `ccsm.v1/daemon.healthz` alias). The helloInterceptor allowlist + `SUPERVISOR_RPCS` consumers compare these literals as strings; consumers MUST NOT silently namespace-prefix them.

Cost: ~10 LOC of duplicated `mountConnectAdapter` call + one extra socket path + integration with the §3.4.1.g hello/HMAC handshake on both listeners. Eliminates the entire class of "slow data path back-pressures heartbeat" races. Round-2 reliability P0-R5 explicitly recommended this over a priority-queue inside one adapter.

---

## Plan delta

Concrete edits to `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`:

### Task 5 (Connect adapter on the local channel) — additions
- **Step 4 add (envelope cap)**: before `JSON.parse(body)`, check **frame-version nibble first** (reject unknown with `UNSUPPORTED_FRAME_VERSION` + destroy), then mask low 28 bits, then check `len > 16 * 1024 * 1024` → emit warn (incl. `peerPid`), write `envelope_too_large` error frame, `socket.destroy()`. Pre-accept rate cap: 50/s with EAGAIN. +0.5 h.
- **Step 4 add (binary frame format, 3.4.1.c)**: refactor `Envelope` into header (`{ id, method?, stream?, payloadType, payloadLen, traceId?, headers? }`) + optional binary trailer. Reserve high 4 bits of `totalLen` as frame-version nibble; reject unknown nibbles. Update `mountConnectAdapter` reader to split header parse from trailer slice. Update `writeEnv` to accept either `{ payload }` (JSON path) or `{ headerExtras, payloadBytes }` (binary path). Implement per-stream header-skeleton caching with **zero-padded 10-digit `seq`** + receiver fast-path + `socket.cork()`/`uncork()` per frame. +5 h (revised from +3 h per round-2 perf §6 budget concern).
- **Step 4 add (schema validation + handler-arg discipline)**: validate header against TypeBox contract before dispatch; reject + close on violation. Validate `traceId` against Crockford ULID regex **only when present** (chunk/heartbeat sub-frames carry no traceId by design — resolved from streamId map). ESLint rule `no-handler-without-check` for handler-arg discipline. +1.5 h.
- **Step 4 add (per-frame chunking, 3.4.1.b)**: for stream emit, split payloads >16 KiB into ≤16 KiB sub-frames sharing `streamId`, with per-stream monotonic `seq` zero-padded to 10 ASCII digits (odd ids client-initiated, even ids server-initiated; v0.3 only emits odd from client). Cache framed buffer once for fan-out (write to N sockets without re-stringify). Replay bound: ≤256 KiB before `gap: true`. Receiver-side reassembly helper in `testHelpers.ts`. +3.5 h (revised from +2.5 h).
- **Step 4 add (interceptor pipeline, 3.4.1.f)**: `mountConnectAdapter({ interceptors: Interceptor[] })`. Ship four built-ins (trace, deadline [clamp 100 ms ≤ x ≤ 120 s + unknown-x-ccsm-* warn], migrationGate [allowlist = `SUPERVISOR_RPCS` constant from §3.4.1.h], metrics). +2 h.
- **Step 4 add (hello HMAC handshake, 3.4.1.g — round-5 manager 2-frame lock)**: single `daemon.hello` RPC (no `helloAck`) + handshake-required interceptor + version compatibility table + `protocol.daemonAcceptedWires[]` + per-connection `clientHelloNonce` (16 random bytes generated client-side) + `crypto.timingSafeEqual` HMAC verify on the CLIENT side. Daemon computes `HMAC-SHA256(daemon.secret, clientHelloNonce)` truncated to 16 bytes and returns in `helloNonceHmac`. **Do NOT include the secret in any wire payload.** +2 h (revised from +2.5 h — one fewer frame, one fewer RPC).
- **Step 4 add (control socket, 3.4.1.h)**: bind second listener for `SUPERVISOR_RPCS`; both sockets share peer-cred / hello-handshake posture. Reconcile naming with frag-6-7 `-sup` alias to single `ccsm-control` path. +1 h.
- **New unit tests** in `daemon/src/transport/__tests__/connectAdapter.test.ts`:
  - oversize envelope rejected + socket destroyed (16 MiB + 1 byte);
  - frame-version nibble: unknown nibble (e.g. `0x1` against v0.3 daemon) rejected with `UNSUPPORTED_FRAME_VERSION` BEFORE length-cap check (asserts parse order);
  - binary frame round-trip (PTY-shaped 64 KiB Buffer, byte-equal);
  - schema-violation rejected (missing `id`; malformed `traceId`);
  - traceId carve-out: `stream.kind === "chunk"` / `"heartbeat"` frames with no `traceId` ACCEPTED; chunk for unknown `streamId` rejected with `RESOURCE_EXHAUSTED`;
  - chunked stream: 1 MiB payload arrives as N ≤16 KiB sub-chunks, in order, reassembled byte-equal; `seq` zero-padded — no fast-path fallback as `seq` crosses `9999 → 10000`;
  - interleave: 1 MiB stream sub-chunks let a unary `ping` round-trip in <50 ms p99;
  - interceptor order asserted (trace → deadline → migrationGate → metrics → handler); deadline clamp bounds asserted at 100 ms / 120 s;
  - unknown `x-ccsm-foo` header → warn line emitted (rate-limited);
  - HMAC handshake: hello-before-other-RPC required; version mismatch returns `compatible: false` + `reason` WITHOUT immediate socket close (client must read `helloNonceHmac` to rule out imposter); bit-flipped `helloNonceHmac` rejected via `crypto.timingSafeEqual` on client (assert constant-time path is wired); replay of `daemon.hello` on same socket rejected with `hello_replay`;
  - **secret never on wire**: hex-dump capture of every byte written by client during handshake — assert the loaded `daemon.secret` byte sequence does NOT appear anywhere in the captured bytes (regression guard against a future worker reintroducing the bearer field);
  - replay bound: client requests `fromSeq` triggering >256 KiB → daemon emits `gap: true` + snapshot;
  - control vs data socket isolation: a saturated data socket does not delay control-socket `/healthz` p99 by >5 ms; only ONE control socket exists (no third `-sup`-suffixed listener).
  +3.5 h (revised from +3 h).

**Task 5 net delta: +19.5 h** (round-2: +18.5 h; round-3 added +0.5 h HMAC handshake + +0.5 h additional unit tests). Original ~6 h → ~25.5 h. Borderline atomic for one worker per `feedback_split_large_worker_tasks`; manager should evaluate splitting into 5a (envelope+chunk+binary) / 5b (interceptor+hello-HMAC+control-socket) phases dispatched serially in the same pool worktree.

### Task 11 (Lift `ptyService` data side to daemon) — additions
- **Step 1 add**: `subscribePty` server-stream uses 3.4.1.c binary frame for `delta` chunks (`payloadBytes = node-pty Buffer`); only `seq` + `kind` go in the JSON header (`traceId` only on `kind: "open"`).
- **Step 1 add**: `getBufferSnapshot` streams as 3.4.1.b sub-frames (≤16 KiB each), aligned to the existing 1000-line async-chunk boundary on the daemon side. Replaces today's "collapse into one envelope" path. +2 h.
- **Step 1 add**: `subscribePty` carries `headers["x-ccsm-boot-nonce"]` (last-known nonce); on mismatch daemon emits `bootChanged: true` + fresh snapshot. Wiring of the renderer divider (`─── daemon restarted ───`) owned by frag-3.5.1 / frag-3.7.
- **New perf-regression test** (vitest, can run in-process via two `Duplex` streams to stand in for the socket): assert that interleaving a 5 MiB simulated snapshot with 100 unary `ping` calls keeps `ping` p99 < 50 ms. +2 h.

**Task 11 net delta: +4 h** (original ~10 h → ~14 h).

### Task 6 (Wire transport into daemon entry) — note only
Add log line on adapter mount: `pino.info({ envelopeCapMib: 16, chunkKib: 16, schemaValidated: true, frameVersion: 0, protocolVersion: 1, controlSocket: true, hmacImposter: true }, "rpc_adapter_mounted")` so dogfood logs prove hardening is live.

### New follow-up tasks (created post-v0.3 freeze)
- **Task 5b (deferred, REVISED per round-2 perf §7)**: micro-benchmark spike per perf review — frame format (~2 h) + head-of-line interleaving (~2 h). **Run pre-Task 11c, in a single pool worktree, BEFORE locking the streaming envelope**. Round-1's "defer to v0.4 unless dogfood shows stutter" was reversed by round-2 perf §7 because dogfood (1-3 users, no concurrent sessions) is a weak signal for p99 wire-format latency.
- **Task 11d (new, REVISED per round-2 perf P1-B)**: backpressure path from `xterm-headless` writes back to `node-pty` (`pause()`/`resume()` once `pendingHeadlessWrites > 500`). +1.5 h. **MUST land with Task 11** — round-2 perf escalated this from SHOULD to P1 because without it the §3.5.1.5 drop-slowest watermark cannot prevent unbounded RSS growth on a slow subscriber. The "unless time-boxed out" qualifier from round-1 is removed.

### Total v0.3 estimate impact
+23.5 h on the critical path (Tasks 5 + 11), revised from +22.5 h after round-3 additions (+1 h HMAC handshake + tests). Original v0.3 = ~125 h → ~148.5 h. Manager should split Task 5 into 5a/5b phases per `feedback_split_large_worker_tasks`.

---

## Cross-frag rationale

Round-2 reviewers raised several items where ownership was unclear between frag-3.4.1 (envelope/wire-format) and another fragment. Decisions taken below; "→ frag-X" means I left the item to that fragment's owner and trust them to handle it.

| Item | Source | Decision | Rationale |
|---|---|---|---|
| `traceId`, `headers`, `interceptors[]` on envelope header | fwdcompat P0-1, observability P0-2, perf P0-A | **TAKE** (§3.4.1.c, §3.4.1.f) | Wire-format / data-layer is the natural owner; this is the seam that v0.4 protobuf swap and v0.5 CF Access JWT will hang off. |
| Hello/version handshake + frame-version nibble + **HMAC challenge-response** | fwdcompat P0-2, lockin P0-1, **round-3 security P0-1**, **round-5 manager 2-frame lock** | **TAKE** (§3.4.1.g) | Handshake lives at the transport boundary; healthz body shape (which carries `bootNonce`) stays with frag-6-7 §6.5. Round-3 switched the imposter check from plaintext bearer to `crypto.timingSafeEqual`-verified HMAC over a client-issued `clientHelloNonce` so the secret never traverses the wire. Round-5 collapsed to 2 frames (was 3) aligned 1:1 with frag-6-7 §7.2: client issues nonce in frame 1, daemon proves possession in frame 2 (no third ack). Saves 1 RT on every reconnect. |
| Frame-header parsing order (nibble → mask → cap) | round-3 security CC-1 | **TAKE** (§3.4.1.a) | Order ambiguity here resurrects either a 256 MiB DoS or a stale-client miscapture; the rule belongs at the byte-decode site. |
| traceId optional-on-chunk/heartbeat carve-out | round-3 security CC-2 | **TAKE** (§3.4.1.c validation paragraph) | The validator regex lives at the adapter; the omission rule was already documented but the validator carve-out wasn't. Single-site fix. |
| `bootNonce` camelCase locking | round-3 fwdcompat CC-2 | **TAKE the spelling** (§3.4.1.g hello reply); cross-frag merge worker reconciles frag-6-7 §6.5 + frag-3.5.1 + frag-3.7 to camelCase | Cosmetic but load-bearing — `boot_nonce` vs `bootNonce` drift would silently break renderer reconnect detection. Aligns with all other JSON envelope fields (`traceId`, `streamId`, `headerLen`, `payloadLen`). |
| `x-ccsm-deadline-ms` clamp (120 s) | round-3 fwdcompat CC-3 | **TAKE** (§3.4.1.c reserved headers + §3.4.1.f deadlineInterceptor) | The clamp must be unified between header-validation and deadline-enforcement; both sites now say `100 ms ≤ x ≤ 120 s` matching frag-3.5.1 §3.5.1.3 and the v0.5 web snapshot-bootstrap headroom. |
| `daemonAcceptedWires[]` in hello reply | round-3 fwdcompat P1-5 | **TAKE** (§3.4.1.g hello reply schema) | Saves a roundtrip during v0.3→v0.4 rolling-upgrade; v0.3 ships a single-element array, v0.4 daemons add `"v0.4-protobuf"`. |
| `seq` zero-padding to 10 ASCII digits | round-3 perf P1-1 | **TAKE** (§3.4.1.c hot-path bullet) | Without padding, the cached header-skeleton fast path silently regresses to full `JSON.parse` after `seq=10000`. 3-LOC fix; eliminates a silent perf cliff. |
| Feature-add vs version-bump rule | round-3 fwdcompat P1-4 | **TAKE** (§3.4.1.g version-bump discipline paragraph) | Without the rule, every new optional capability bumps `daemonProtocolVersion`, defeating semver-major's purpose. New rule: features in `daemonFeatures[]`, breaking changes only bump `daemonProtocolVersion`. |
| Unknown `x-ccsm-*` header warn | round-3 fwdcompat P1-7 | **TAKE** (§3.4.1.c reserved-headers paragraph + §3.4.1.f deadlineInterceptor bullet) | Catches v0.3.x worker squatting on a future-reserved key before it hardens into a wire contract. Optional warn line, rate-limited. |
| `SUPERVISOR_RPCS` allowlist constant | round-3 fwdcompat P1-1 | **TAKE** (§3.4.1.h) | Single canonical constant consumed by control-socket dispatcher, migrationGateInterceptor (§3.4.1.f), and frag-8 §8.5 migration scope. Prevents the three sites drifting on which RPCs are control-plane. |
| Control-socket vs supervisor `-sup` socket disambiguation | round-3 perf CF-1 | **TAKE** (§3.4.1.h table) | frag-6-7 §6.5 and §3.4.1.h were ambiguous about whether they described two sockets or three. Locked to TWO total: data-socket + control-socket (= supervisor `-sup` alias). Cross-frag merge worker reconciles `-sup` literal in frag-6-7 to `ccsm-control` path. |
| RPC namespace `ccsm.vN/...` rule | fwdcompat P0-3 | **TAKE** (§3.4.1.g) | Adapter dispatch table is the only place that enforces the namespace; documenting it elsewhere would split the rule from its enforcer. |
| Reserved `x-ccsm-*` header keys | fwdcompat P1-2 | **TAKE** (§3.4.1.c) | Header schema is a wire-format concern; the actual deadline middleware lives in the §3.4.1.f interceptor pipeline. |
| `streamId` allocation (odd/even) | fwdcompat P2-2 | **TAKE** (§3.4.1.b) | Stream id namespace is part of the wire contract. |
| `traceId` validation regex + injection guard | security P1-S2 | **TAKE** (§3.4.1.c) | Adapter is the trust boundary that turns wire bytes into typed values; per-handler revalidation is wasteful. |
| Handler-arg validation for binary trailer | security P1-S1 | **TAKE the rule** (§3.4.1.d), the per-method schemas live with each handler | Adapter cannot validate opaque bytes, but it CAN mandate the discipline + ESLint rule. |
| Pre-accept rate cap (T15) + peer PID in oversize log | security T15, reliability S-R5 | **TAKE** (§3.4.1.a) | Both attach to the listener boundary I already own. |
| Replay bound on resubscribe (≤256 KiB) | resource P0-1 | **TAKE** (§3.4.1.b) | Chunking semantics + `gap: true` are wire-format; the renderer divider rendering belongs to frag-3.5.1/frag-3.7. |
| Health/data socket isolation | reliability P0-R5 | **TAKE** (§3.4.1.h) | The two-socket topology IS a wire-format change; supervisor wiring stays with frag-6-7. |
| Subscribe RPC contract (`subscribe(sessionId, { fromSeq, fromBootNonce, heartbeatMs })`) | round-3 fwdcompat P1-2 | → **frag-3.5.1 §3.5.1.4** (canonical owner declared in §3.4.1.b) | I own only the wire-level chunking + replay-budget mechanics; field naming, defaults, clamps, protobuf message def live in frag-3.5.1. Cross-ref added so v0.4 worker reads one source. |
| `daemon.secret` lifecycle (creation, rotation, ACL, redact) | security P0-S1 | → **frag-6-7 §7.2** | Lifecycle = installer-time generation + auto-update rotation + redact-list curation, none of which is a wire concern. I only consume the secret value in §3.4.1.g hello compare. **Round-3 update**: redact list keeps `daemonSecret`, `installSecret`, `imposterSecret`, `clientImposterSecret`, `*.clientImposterSecret`, `pingSecret`, `*.secret`, AND adds `helloNonce`, `clientHelloNonce`, `helloNonceHmac` (defense in depth — these fields are useless without the secret but redacting them costs nothing and avoids debug-log noise around handshake correlation). Single source of truth: frag-6-7 §6.6 / §7.2. |
| `statsVersion` field placement | round-3 fwdcompat P1-3 | → **frag-6-7 §6.5** (drop from `/healthz`, keep on `daemon.stats`) | Two version cursors for one schema is a footgun; I only note the decision so frag-6-7 owner removes the duplicate. |
| `bootNonce` field on subscribe + delta + `bootChanged` semantics | fwdcompat P1-1 | → **frag-3.5.1 + frag-3.7** | I expose `bootNonce` in hello (§3.4.1.g) and reserve `headers["x-ccsm-boot-nonce"]`; the renderer-side cache, divider, and resubscribe logic belong to the dev-workflow / stream owner. |
| Subscriber session-token auth | security P1-S3 | → **frag-3.5.1** | `ptySubscribe` is a stream RPC owned by frag-3.5.1; I provide the `headers` carriage but the token policy is theirs. |
| Migration env-var rename / marker schema versioning | lockin P0-3, fwdcompat P1-3 | → **frag-8** | Migration is frag-8's territory; my interceptor (`migrationGateInterceptor`) only consumes the "is migration in flight?" boolean. |
| Modal/toast surface registry, sentence-case copy for `version_mismatch` etc. | UX P0-UX-1, P0-UX-3 | → **frag-6-7 §6.8** | I emit structured error codes; the renderer-side modal copy + stacking rules belong to the UI surface owner. |
| Native `winjob.node` packaging / signing / ABI | packaging P0-2 | → **frag-11** | Pure build/CI concern; my adapter is JS only. |
| pino-roll abstraction layer / `proper-lockfile` swap / `koffi` vs N-API | lockin P1-1, P1-2, P0-2 | → **frag-6-7** | Logging + native-binding ownership lives there. |
| Reconnect-queue cap / dev-mode escalation toast / TS-error escape hatch | UX P1-UX-1, devx P1-3 | → **frag-3.7** | Renderer-side reconnect logic is frag-3.7; my replay-bound rule (§3.4.1.b) is the daemon half of the contract. |

Net (round-3): **27 P0/P1 items applied here** (round-2 baseline 17 + round-3 adds 10), **9 P0/P1 items punted to other fragments**. No item was dropped; every cross-frag handoff is named above so the next reviewer can audit the boundary.

---

## Citations

- Round-3 reviews: `~/spike-reports/v03-r3-{security,fwdcompat,lockin,perf,observability}.md`.
- Round-2 reviews: `~/spike-reports/v03-r2-{fwdcompat,observability,perf,lockin,security,resource,reliability,devx,ux,packaging}.md`.
- Round-1 reviews: `~/spike-reports/v03-review-{perf,security,fwdcompat,observability,lockin}.md`.
- v1 spec already wired: `docs/superpowers/specs/2026-04-30-web-remote-design.md` §3.1.1 line 80 (envelope cap forward-reference), §3.4 (Connect protocol), §3.5 (PTY headless / snapshot path).
- v1 plan touched: `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md` Task 5 (lines 434–620, length-prefixed envelope), Task 11 step 1 (lines 1207–1234, stream extension).
