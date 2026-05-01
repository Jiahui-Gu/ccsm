# 02 — Protocol (Connect + Protobuf + buf)

## Context block

v0.3's data socket runs a hand-rolled length-prefixed JSON envelope (`daemon/src/envelope/envelope.ts`, ~200 LOC) with HMAC handshake (`hello-interceptor.ts`, ~420 LOC), deadline + migration-gate interceptors, manual chunking for stream payloads, and binary-trailer carve-out for PTY bytes. It works, but it is a custom protocol with no schema language, no breaking-change detector, no codegen for non-TS clients, and no published wire surface. v0.4 retires it for **Connect over HTTP/2**, with **Protobuf v3** as the schema language and **`buf`** as the build/lint/breaking-change toolchain. The control socket (supervisor RPCs) is **not** changed in v0.4 — it stays on the v0.3 envelope, see §6.

## TOC

- 1. Wire choice: Connect (lock)
- 2. Schema language: Protobuf v3 (lock)
- 3. `proto/` directory layout
- 4. `buf` toolchain + CI
- 5. Codegen pipeline
- 6. What does NOT move to Connect (control socket)
- 7. Versioning + back-compat strategy
- 8. Wire-level inheritances from v0.3 (carried forward)

## 1. Wire choice: Connect

**Decision (lock):** Connect-RPC, server via `@connectrpc/connect-node`, browser client via `@connectrpc/connect-web`, Electron renderer client via `@connectrpc/connect-node` over a custom IPC transport (chapter 03 §3).

**Why:**
1. Browser-friendly without an Envoy proxy (unlike grpc-web) — Connect speaks plain HTTP/2 / HTTP/1.1 + `application/proto` or `application/json`. Critical for the "Cloudflare Tunnel just works" path.
2. Wire-compatible with Connect-Go, Connect-Swift, Connect-Kotlin — opens future native clients without protocol rewrite.
3. Same schema language (Protobuf) as gRPC, so the `proto/` directory is portable to gRPC if we ever need it (we don't expect to).
4. F4 spike (referenced in v0.3 §12) explicitly evaluated and locked Connect+Protobuf+buf over alternatives (gRPC, TypeSpec, tRPC, raw JSON).

**Rejected alternatives:**
- **gRPC-Web:** requires Envoy (or a proxy with gRPC-Web filter) to translate to gRPC. Cloudflare Tunnel doesn't translate. Rejected for v0.4.
- **tRPC:** TS-only. Rules out future Swift / Kotlin / CLI-Go clients. Rejected.
- **TypeSpec → OpenAPI/JSON:** no streaming model, weak for PTY-style server pushes. Rejected.
- **WebSocket + JSON envelope (just keep what we have):** misses every reason to do v0.4 — no schema, no breaking-change detector, no codegen.

**Half-duplex caveat:** Connect-Web in the browser is **half-duplex** over HTTP/2 (server-streaming yes; client-streaming and bidi no). v0.4 does not need bidi; PTY input is a unary message-per-keystroke (or per-keystroke-batch, see chapter 06 §3), and PTY output is server-stream. F4 spike confirmed this works for ccsm. If a future feature needs bidi (collaborative cursor sharing, etc.), revisit then; the daemon can serve full bidi to non-browser clients via Connect-Node without touching Connect-Web.

## 2. Schema language: Protobuf v3

**Decision (lock):** Protobuf syntax 3 (`syntax = "proto3";`).

**Why:**
1. `buf` toolchain is built around proto3.
2. Proto3 default-values + missing-field semantics are well-understood; v0.4 uses explicit `optional` for nullable fields per protobuf 3.15+ to avoid the "is the value missing or zero?" trap.
3. Reserved tags + reserved field names give a clean back-compat story (chapter 07 §4 version-skew).

**Codegen targets:** TypeScript (consumed by renderer + web client) ships in v0.4. Swift + Kotlin codegen MAY be wired into `buf.gen.yaml` but their output is unused until v0.5+. Generating them keeps the schema honest (lint catches Swift-incompatible field names, etc.) without adding runtime dependencies in v0.4.

## 3. `proto/` directory layout

Located at the repo root (sibling of `daemon/`, `electron/`, `web/`).

```
proto/
├── buf.yaml                         # buf module config
├── buf.gen.yaml                     # codegen plugin pipeline
├── buf.lock                         # dependency lock (well-known protos etc.)
└── ccsm/
    └── v1/
        ├── core.proto               # versions, ping, OS info, paths-exist
        ├── session.proto            # session list / state / activate / setName
        ├── session_titles.proto     # SDK-summary get/rename/list
        ├── pty.proto                # spawn / attach / detach / input / resize / kill / stream
        ├── notify.proto             # flash sink, user-input markers
        ├── settings.proto           # i18n, model preference, settings get/set
        ├── updater.proto            # auto-update status / check / download / install
        ├── import.proto             # importable-session scan, recent cwds
        └── service.proto            # the umbrella `service Ccsm { rpc ... }` definition
```

**Why namespace `ccsm.v1`:** standard protobuf convention `<org>.<api-version>`. The `v1` prefix in the package path lets us ship a `v2` namespace later if a hard wire break is ever needed (hopefully never; chapter 07 covers field-level back-compat). `v1` ALSO is used in HTTP path routing per Connect convention: `POST /ccsm.v1.Ccsm/ListSessions`.

**Why one umbrella service rather than one service per domain:** Connect routes per-method, not per-service. Splitting `service Session { rpc ... }` from `service Pty { rpc ... }` adds path noise (`/ccsm.v1.Session/...` vs `/ccsm.v1.Pty/...`) without functional benefit. The renderer's bridge files give us domain grouping at the TS layer; the wire is one service.

**Per-domain `.proto` files (not one mega-file):** keeps blast radius of edits small. `pty.proto` changes don't show up in the diff for a `notify.proto` PR.

## 4. `buf` toolchain + CI

**Tools:** `buf` CLI (https://buf.build), pinned via `package.json` devDep `@bufbuild/buf` for cross-platform install. Plugins: `@bufbuild/protoc-gen-es` (TS code), `@bufbuild/protoc-gen-connect-es` (Connect TS service stubs).

**`buf.yaml`** (key fields):
```yaml
version: v2
modules:
  - path: ccsm
breaking:
  use:
    - FILE
lint:
  use:
    - DEFAULT
  except:
    - PACKAGE_VERSION_SUFFIX  # we use ccsm.v1, not ccsm.v1alpha
```

**`buf.gen.yaml`:**
```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: gen/ts
    opt:
      - target=ts
  - local: protoc-gen-connect-es
    out: gen/ts
    opt:
      - target=ts
```

**CI gates** (GitHub Actions, run on every PR touching `proto/**` or `gen/**`):
1. `buf lint` — MUST pass (zero warnings, zero errors). Budget ≤5s.
2. `buf breaking --against '.git#branch=working,subdir=proto'` — MUST pass against the **merge target** (`working`) branch tip when `proto/**` changes (skip when only `gen/**` changes — a regen with no `.proto` change cannot be wire-breaking). Detects wire-incompatible edits (deleted field, changed tag number, changed type, changed cardinality). Budget ≤15s. Separate **release-tag job** runs `buf breaking --against '.git#tag=v<previous>,subdir=proto'` at every `v*` tag to catch regressions across releases.
3. `buf generate && git diff --exit-code gen/` — verifies vendored codegen matches what `buf generate` would produce. Catches "edited the .proto but forgot to regenerate" PRs. Budget ≤10s. When bumping codegen plugins, regenerate `gen/` in the same PR; CI compares against the bumped baseline.

**Why baseline `working` not `main`:** PRs in this repo target `working`; the merge target IS the breaking-check baseline. A separate tag-time check catches release-to-release breaks. Comparing to `main` while merging to `working` produces drift (changes merged to `working` but not yet promoted to `main` would silently re-baseline the next PR).

**Why fail PR on diff in `gen/`:** if the codegen output drifts from the `.proto`, downstream consumers will get type mismatches at build time. Forcing the diff to be clean keeps `gen/` as a deterministic projection of `proto/`. To prevent codegen-version flake, `@bufbuild/buf` and `@bufbuild/protoc-gen-es` MUST be pinned to **exact** patch versions in `package.json` (no `^`); CI caches the `buf` binary via `actions/cache` keyed on the lockfile.

**Local developer flow:** `npm run proto:gen` (alias for `buf generate`) before committing. Pre-commit hook MAY enforce this; not blocking for v0.4 (CI catches it).

### 4.1 Intentional breaking changes (override mechanism)

The `buf breaking` gate has an explicit override path so the team is never blocked from a needed wire-break (e.g. v0.5 retires a deprecated field, or a hot security fix requires removing a leaky field):

- PR title MUST be prefixed `[proto-break]` to opt out of the standard `buf breaking` gate.
- A `[proto-break]` PR MUST: (a) bump the namespace to `ccsm.v<N+1>`, AND (b) keep the `ccsm.v<N>` package generated alongside for one release cycle (allows old clients during deprecation window).
- Deprecation window: previous namespace stays generated for **1 minor release** after introduction of the new namespace; removal in the release after.
- Without the `[proto-break]` prefix, the standard `buf breaking` gate stays on (i.e. opt-out is explicit and reviewable).

## 5. Codegen pipeline

**Output dir:** `gen/ts/ccsm/v1/`. Vendored (committed). Consumers import from `@ccsm/proto-gen/v1` (a tiny package that just re-exports `gen/ts/`) so the import paths are stable even if the layout changes.

**Why a wrapper package:** raw `gen/` paths are noisy (`gen/ts/ccsm/v1/pty_connect.js`). A package alias like `@ccsm/proto-gen` lets us reorganize internally without touching every consumer. The wrapper has no logic — pure re-export.

**Type-only vs runtime:** the generated TS includes both types (request/response interfaces) and runtime (Connect service stubs, encoders/decoders). Renderer + web both bundle the runtime; daemon binds the same service stubs on the server side.

**Tree-shaking:** `gen/ts/` MUST be ESM (Connect-ES default). Renderer/web bundlers (Vite) tree-shake unused RPC stubs out of the production bundle. Daemon (CJS via `@yao-pkg/pkg`) imports the full surface — pkg handles ESM-to-CJS interop.

**Build sequencing:** `buf generate` runs in `npm run build` BEFORE `tsc` so daemon/renderer/web builds always see fresh stubs. CI also runs `buf generate` independently to catch drift.

**Repo hygiene for vendored codegen:** to keep `gen/` from polluting routine PR review:
- `.gitattributes` MUST mark `gen/** linguist-generated=true -diff` so GitHub collapses generated diffs by default.
- Expected `gen/` size budget: <10 KLOC at v0.4.0. >30 KLOC = revisit the vendoring decision (drop to CI-regenerate-at-install).
- **`pkg` ESM-interop spike (M1 prerequisite):** before M1 freezes the toolchain, run a spike that builds the daemon installer with the actual generated ESM Connect stubs through `@yao-pkg/pkg`. v0.3 packaging notes flag pkg ESM as fragile; if it chokes on the generated surface, fall back to the CI-only "regenerate at install" mode (skip vendoring, regen during `npm run build`). See chapter 09 M1 deliverables.

## 6. What does NOT move to Connect (control socket stays on envelope)

**Decision:** the **control socket** (a.k.a. supervisor transport, `daemon/src/sockets/control-socket.ts`, separate from `data-socket.ts`) keeps the v0.3 hand-rolled envelope. RPC allowlist unchanged: `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown`, `daemon.shutdownForUpgrade`. See `daemon/src/envelope/supervisor-rpcs.ts`.

**Why deferred:** the supervisor surface is small (5 RPCs), used only locally between Electron-supervisor-child and daemon, and is on the critical path for daemon restart / upgrade. Re-platforming it adds risk to the lifecycle code that the user already depends on, with no user-visible benefit. Convert it in a later release (v0.5 housekeeping) if there's reason to.

**Implication for the daemon process:** the daemon binds **two** transports:
1. **Control socket** (`\\.\pipe\ccsm-sup` on Win, `~/.ccsm/daemon-sup.sock` on Mac/Linux): hand-rolled envelope, supervisor RPCs only.
2. **Data socket** (`\\.\pipe\ccsm-daemon` on Win, `~/.ccsm/daemon.sock` on Mac/Linux): **Connect over HTTP/2** in v0.4 (was hand-rolled envelope in v0.3). All ~46 bridge RPCs (per chapter 03 §1 inventory) + future RPCs.

Both transports inherit v0.3 §3.1.1 hardening: peer-cred verification, named-pipe ACL or 0700 socket mode, 16 MiB frame cap (HTTP/2 frame max). The remote ingress (Cloudflare Tunnel) terminates on the **data socket** only — supervisor RPCs are local-only forever.

## 7. Versioning + back-compat strategy

**Wire version negotiation:** Connect-RPC carries no native version handshake (HTTP/2 + content-type negotiation IS the handshake). v0.4 introduces a `Ping` RPC that returns `{ daemonVersion, protoVersion: "ccsm.v1" }`; clients call it on connect and surface a "daemon out of date" banner if `protoVersion` doesn't match expected. Hard version skew (e.g. client expects `v2`, daemon serves `v1`) is rejected at the renderer's boot probe.

**Field-level back-compat:**
- Adding a field to a message: **safe**, MUST get a fresh tag number.
- Removing a field: **breaking**, MUST add `reserved <tag>;` to prevent reuse and bump the namespace if it's a serious break (we don't expect to do this in v0.4).
- Renaming a field: **safe at wire level** (tag-numbered), but the codegen TS output changes — treated as a source-breaking change requiring all consumers to update in the same PR.
- Changing a field type: **breaking**, requires `reserved <tag>;` + new field with new tag.

**`buf breaking` enforces the wire-level rules automatically.** Source-breaking changes are caught by tsc.

**Cross-version client/daemon matrix:**

| Client | Daemon | Outcome |
|---|---|---|
| v0.3.x Electron + envelope | v0.4 daemon (Connect on data socket) | **Blocked.** Single installer for v0.4 ships matched Electron+daemon. Pre-v0.4 Electron probes data socket, gets HTTP/2 frame, fails handshake, surfaces `daemon.unreachable` banner. User must reinstall. |
| v0.4 Electron | v0.3.x daemon | **Blocked.** v0.4 Electron speaks Connect; v0.3 daemon speaks envelope. Connect client times out; renderer surfaces `daemon.unreachable`. |
| v0.4 web client | v0.4 daemon | **Supported.** |
| v0.4 web client | v0.5+ daemon | **Supported via field-level back-compat.** Old web tab in user's browser may lack new fields; daemon defaults them. New web tab on next page load picks up the latest schema. |

**Why no soft-fallback / dual-protocol on data socket:** complexity vs benefit. Single installer (matched versions) plus Cloudflare Pages serving the latest web bundle solves 99% of skew. The remaining 1% (user has a stale browser tab open during a daemon upgrade) is handled by the v1.Ping handshake + `daemon.unreachable` banner with a "reload" button.

## 8. Wire-level inheritances from v0.3 (carried forward into Connect)

The v0.3 hand-rolled envelope carried hardening rules that MUST survive the Connect swap. Connect over HTTP/2 inherits some natively; others MUST be re-implemented as Connect interceptors.

| v0.3 mechanism | v0.4 path |
|---|---|
| 16 MiB frame cap | **Per-message** cap implemented via Connect-Node `readMaxBytes` option on every server route (HTTP/2 frame size is a separate transport setting we leave at Node default). Per-route caps:<br>- Default: 4 MiB.<br>- `SendPtyInput`: 1 MiB.<br>- `Db.save`: 16 MiB.<br>- `Importer.scanRecentCwds`: 4 MiB.<br>An interceptor logs (and rate-limits) requests within 10% of the cap so attack patterns surface in pino. The HTTP/2 server's `SETTINGS_MAX_FRAME_SIZE` is left at Node default 16 KiB; a single large message is reassembled across many DATA frames bounded by `readMaxBytes`. |
| Per-frame deadline (`x-ccsm-deadline-ms`) | Connect interceptor on both client + server reading the same header. Default 30s; clamp at 120s per v0.3 §3.4.1.f. |
| HMAC `daemon.hello` handshake | **Replaced** by Connect TLS-or-local-trust + Cloudflare Access JWT for remote. Local socket peer-cred (v0.3 §3.1.1) is the local trust boundary; HMAC was a same-machine secret check, redundant once peer-cred is enforced. |
| Trace-id ULID per envelope | Connect interceptor generates ULID per request, propagates via `x-ccsm-trace-id` header. Pino logs include it. |
| Migration-gate interceptor (block RPCs while SQLite migration in flight) | Re-implemented as Connect interceptor on the data socket. Same predicate (`isMigrationGated()`), same `MIGRATION_PENDING` error code. **Test seam:** when `process.env.NODE_ENV === 'test'`, the predicate is replaced by a value set via `__setMigrationGateForTest(boolean)` exported from the gate module; never exposed in production builds. Contract test (chapter 08 §3) forces the gate true, calls a gated RPC, asserts `MIGRATION_PENDING`. |
| Stream chunk reassembly + 16 KiB sub-chunk rule | **Obsolete.** HTTP/2 native frame fragmentation handles this. Connect server-streams emit messages; HTTP/2 fragments them. No application-layer chunking needed. |
| Binary-trailer carve-out for PTY bytes | Replaced by Protobuf `bytes` field on `PtyChunk`. No JSON round-trip; raw bytes on the wire. See chapter 06 §2. |
| `streamId` allocation (odd client / even server) | **Obsolete.** HTTP/2 native stream ids on the daemon's HTTP/2 connection serve the same purpose. |
| Pre-accept rate cap (50/sec) | Re-implemented at the daemon's `Http2Server.on('session', ...)` handler. |

**Interceptor observability:** every interceptor that rejects a request (deadline exceeded, migration gate fired, JWT invalid, `readMaxBytes` exceeded) emits `pino.warn({ interceptor, method, traceId, reason })`. Same surface as v0.3 envelope interceptors. Heartbeat events (chapter 06 §4) are logged at debug level only to avoid log spam from the higher v0.4 request rate. Daemon log retention inherits v0.3's pino-roll cap (max 50 MB × 5 files = 250 MB ceiling, weekly rotation; per v0.3 frag-3.7) for both the Connect server log and `~/.ccsm/cloudflared.log`.

**Local-vs-remote tag isolation (security-critical):** the JWT-validation interceptor fires only when the request arrived on the remote ingress (Cloudflare Tunnel-fronted TCP listener). Requests on the local socket carry a `localTransportKey` context value tagged at the listener and bypass JWT (chapter 05 §4 details the implementation). Contract test "JWT bypass tag isolation" (chapter 08 §3) MUST cover three sub-cases: (a) remote request without JWT → reject; (b) local request without JWT → accept; (c) local request that forges a `Cf-Access-Jwt-Assertion` header → header is ignored, JWT validation interceptor is not invoked, request is accepted on the local-tag basis (NOT spuriously validated against a mock JWKS).

**Why drop HMAC for the local socket:** it was always belt-and-suspenders on top of peer-cred. Peer-cred (`SO_PEERCRED` on Unix, `GetNamedPipeClientProcessId` on Win, see v0.3 §3.1.1) cryptographically proves same-user-same-machine via the kernel. An HMAC handshake on top adds boot-nonce shenanigans (boot-nonce-precedence.ts, ~70 LOC) and a rotation story we'd have to carry forever. Dropping it removes ~500 LOC across `hmac.ts` + `hello-interceptor.ts` + `boot-nonce-precedence.ts` and matches the standard local-IPC trust model.

**Threat model accepted by dropping HMAC:** v0.4 trusts every same-user local process. A same-user process (compromised dev tool, malicious VS Code extension, attacker with same-user code-exec) can issue arbitrary RPCs against the data socket: read PTY output streams (potentially containing user-typed credentials), enumerate sessions, issue settings RPCs (which after v0.5+ may surface OS-keychain-stored secrets such as the Cloudflare Tunnel token, GitHub OAuth artifacts, SDK API keys). This matches the ambient trust model of most desktop apps that hold credentials and rely on the OS user boundary, but does NOT match the harder model used by 1Password / SSH agent / GitHub CLI (which assume same-user processes can be hostile). Re-introducing HMAC (or a similar second-factor on the data socket) is on the v0.5 candidate list. Any post-v0.4 RPC that surfaces OS-keychain material MUST either gate on a freshly-prompted user confirmation or wait for the second-factor to land. Tracked in chapter 10 risks.

**Why keep HMAC for the supervisor (control socket):** the supervisor stays on the envelope (per §6 above), so HMAC stays there too. No code deletion until the supervisor moves.

### 8.1 JWT validation policy (data socket remote ingress)

The remote-ingress JWT validation interceptor (chapter 05 §4 implements; this section locks the policy fields) MUST configure `jose.jwtVerify` with these explicit options — library defaults are not acceptable because they shift across jose versions:

- `algorithms: ['RS256']` — pin to the algorithm Cloudflare Access actually uses; reject any token signed with another alg even if the JWKS contains a key for it (defends against alg-confusion attacks).
- `clockTolerance: 30` (seconds) — small skew tolerance between daemon clock and Cloudflare clock; explicit so a future jose default change doesn't silently widen it.
- `requiredClaims: ['exp', 'iat', 'aud', 'iss', 'sub']` — every Access JWT carries these; missing any = reject.
- `audience` MUST be the **per-application AUD** for this Access app (NOT a wildcard, NOT shared across the user's other Cloudflare Access apps). Cross-app AUD reuse would let an attacker who got a JWT for an unrelated Access app on the same team validate against this daemon.
- `issuer` MUST be the team-specific Cloudflare Access issuer URL.
- JWKS fetch timeout: 5s; fail-closed on timeout (do NOT allow the request through under JWKS unavailability).
- JWKS unknown-`kid` policy: refresh JWKS at most once per 30s (jose `cooldownDuration: 30000`); on continued miss, fail-closed (do not retry-storm the JWKS endpoint and do not let the request through).
- `iat` upper-bound check: reject tokens with `iat > now + clockTolerance` (token issued in the future indicates clock-skew attack or compromised CF signer).

Contract test "JWT validation policy" (chapter 08 §3) MUST cover: missing required claim → reject; wrong AUD → reject; alg=HS256 token with key in JWKS → reject; token with `iat` 60s in the future → reject; JWKS endpoint unreachable for new `kid` → reject (NOT pass-through).

## 9. Idempotency model

Connect over HTTP/2 is at-least-once at the application layer when the supervisor respawns the daemon mid-RPC (chapter 07 §1). The client retries; the daemon may have already applied the write. Without an explicit policy, retries duplicate state mutations.

Every RPC defined in `proto/ccsm/v1/` MUST be classified into one of three categories, declared in a `// idempotency:` comment on the RPC definition and reflected in the codegen TS docstring:

1. **`naturally idempotent`** — repeated application produces the same end state. All read RPCs (`ListSessions`, `Ping`, etc.) plus last-write-wins setters (`SetActive`, `SetName`, `SaveSettings`, `Updater.SetChannel`). Client MAY retry freely.
2. **`dedup-via-server-key`** — the request carries an explicit `string idempotency_key = 1;` field (ULID or UUID). Daemon dedups by key within a 60-second window (in-memory LRU sized for ~10k entries). Repeated submission with the same key returns the cached response. Applies to: `EnqueuePending`, `Notify.Flash`, `UserCwds.Push`, `Db.Save`, any RPC that mutates a queue or appends a row.
3. **`non-idempotent — must-not-retry`** — repeated application changes monotonic state in a way the daemon cannot dedup. Client MUST surface error to the user and NOT auto-retry on transport failure. Applies to: `Pty.Spawn` (spawning twice creates two PTYs), any future "advance counter" RPC.

`buf lint` MUST enforce that every RPC declaration carries an `// idempotency:` annotation. CI fails if a new RPC lands without one. Chapter 07 §1 daemon-crash recovery references this classification when deciding which RPCs are auto-retried by the bridge layer vs surfaced to the user.
