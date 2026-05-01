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
1. `buf lint` — must pass (zero warnings, zero errors).
2. `buf breaking --against '.git#branch=main,subdir=proto'` — must pass against the merge target's `main` branch tip. Detects wire-incompatible edits (deleted field, changed tag number, changed type, changed cardinality).
3. `buf generate && git diff --exit-code gen/` — verifies vendored codegen matches what `buf generate` would produce. Catches "edited the .proto but forgot to regenerate" PRs.

**Why `buf breaking` against `main` not against the latest tag:** the latest tag is the most recently shipped version, but contributors merging multiple PRs into `main` between tags would otherwise produce a series of "breaking against the tag" false-positives. Comparing to `main` matches Buf's documented best practice and catches the intended class of error (the developer forgot they removed a field two commits back). Tag-level breaking-check happens at release time as a separate verification.

**Why fail PR on diff in `gen/`:** if the codegen output drifts from the `.proto`, downstream consumers will get type mismatches at build time. Forcing the diff to be clean keeps `gen/` as a deterministic projection of `proto/`.

**Local developer flow:** `npm run proto:gen` (alias for `buf generate`) before committing. Pre-commit hook MAY enforce this; not blocking for v0.4 (CI catches it).

## 5. Codegen pipeline

**Output dir:** `gen/ts/ccsm/v1/`. Vendored (committed). Consumers import from `@ccsm/proto-gen/v1` (a tiny package that just re-exports `gen/ts/`) so the import paths are stable even if the layout changes.

**Why a wrapper package:** raw `gen/` paths are noisy (`gen/ts/ccsm/v1/pty_connect.js`). A package alias like `@ccsm/proto-gen` lets us reorganize internally without touching every consumer. The wrapper has no logic — pure re-export.

**Type-only vs runtime:** the generated TS includes both types (request/response interfaces) and runtime (Connect service stubs, encoders/decoders). Renderer + web both bundle the runtime; daemon binds the same service stubs on the server side.

**Tree-shaking:** `gen/ts/` MUST be ESM (Connect-ES default). Renderer/web bundlers (Vite) tree-shake unused RPC stubs out of the production bundle. Daemon (CJS via `@yao-pkg/pkg`) imports the full surface — pkg handles ESM-to-CJS interop.

**Build sequencing:** `buf generate` runs in `npm run build` BEFORE `tsc` so daemon/renderer/web builds always see fresh stubs. CI also runs `buf generate` independently to catch drift.

## 6. What does NOT move to Connect (control socket stays on envelope)

**Decision:** the **control socket** (a.k.a. supervisor transport, `daemon/src/sockets/control-socket.ts` after T14, separate from `data-socket.ts`) keeps the v0.3 hand-rolled envelope. RPC allowlist unchanged: `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown`, `daemon.shutdownForUpgrade`. See `daemon/src/envelope/supervisor-rpcs.ts`.

**Why deferred:** the supervisor surface is small (5 RPCs), used only locally between Electron-supervisor-child and daemon, and is on the critical path for daemon restart / upgrade. Re-platforming it adds risk to the lifecycle code that the user already depends on, with no user-visible benefit. Convert it in a later release (v0.5 housekeeping) if there's reason to.

**Implication for the daemon process:** the daemon binds **two** transports:
1. **Control socket** (`\\.\pipe\ccsm-sup` on Win, `~/.ccsm/daemon-sup.sock` on Mac/Linux): hand-rolled envelope, supervisor RPCs only.
2. **Data socket** (`\\.\pipe\ccsm-daemon` on Win, `~/.ccsm/daemon.sock` on Mac/Linux): **Connect over HTTP/2** in v0.4 (was hand-rolled envelope in v0.3). All ~22 bridge RPCs + future RPCs.

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
| 16 MiB frame cap | HTTP/2 `SETTINGS_MAX_FRAME_SIZE` capped at 16 MiB on the daemon's `Http2Server`. Connect rejects oversized streams natively. |
| Per-frame deadline (`x-ccsm-deadline-ms`) | Connect interceptor on both client + server reading the same header. Default 30s; clamp at 120s per v0.3 §3.4.1.f. |
| HMAC `daemon.hello` handshake | **Replaced** by Connect TLS-or-local-trust + Cloudflare Access JWT for remote. Local socket peer-cred (v0.3 §3.1.1) is the local trust boundary; HMAC was a same-machine secret check, redundant once peer-cred is enforced. |
| Trace-id ULID per envelope | Connect interceptor generates ULID per request, propagates via `x-ccsm-trace-id` header. Pino logs include it. |
| Migration-gate interceptor (block RPCs while SQLite migration in flight) | Re-implemented as Connect interceptor on the data socket. Same predicate (`isMigrationGated()`), same `MIGRATION_PENDING` error code. |
| Stream chunk reassembly + 16 KiB sub-chunk rule | **Obsolete.** HTTP/2 native frame fragmentation handles this. Connect server-streams emit messages; HTTP/2 fragments them. No application-layer chunking needed. |
| Binary-trailer carve-out for PTY bytes | Replaced by Protobuf `bytes` field on `PtyChunk`. No JSON round-trip; raw bytes on the wire. See chapter 06 §2. |
| `streamId` allocation (odd client / even server) | **Obsolete.** HTTP/2 native stream ids on the daemon's HTTP/2 connection serve the same purpose. |
| Pre-accept rate cap (50/sec) | Re-implemented at the daemon's `Http2Server.on('session', ...)` handler. |

**Why drop HMAC for the local socket:** it was always belt-and-suspenders on top of peer-cred. Peer-cred (`SO_PEERCRED` on Unix, `GetNamedPipeClientProcessId` on Win, see v0.3 §3.1.1) cryptographically proves same-user-same-machine via the kernel. An HMAC handshake on top adds boot-nonce shenanigans (boot-nonce-precedence.ts, ~70 LOC) and a rotation story we'd have to carry forever. Dropping it removes ~500 LOC across `hmac.ts` + `hello-interceptor.ts` + `boot-nonce-precedence.ts` and matches the standard local-IPC trust model.

**Why keep HMAC for the supervisor (control socket):** the supervisor stays on the envelope (per §6 above), so HMAC stays there too. No code deletion until the supervisor moves.
