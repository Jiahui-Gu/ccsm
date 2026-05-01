# 11 — References

## Context block

This spec stands on top of v0.3's daemon-split work and the predecessor all-in-one design doc. This chapter lists every external document, source file, spike report, and convention this spec depends on, with a one-line note on what each reference contributes.

## TOC

- 1. Predecessor design documents
- 2. v0.3 source code (current daemon)
- 3. v0.3 source code (current Electron / preload bridges)
- 4. Renderer (shared between Electron and web)
- 5. Spike reports
- 6. External documentation (Cloudflare, Connect, buf)
- 7. Memory / convention references (manager-level)
- 8. Tool / dependency versions

## 1. Predecessor design documents

- **`docs/superpowers/specs/2026-04-30-web-remote-design.md`** — all-in-one v0.3+ daemon-split + web design. Authoritative for v0.3 architectural decisions; v0.4 lifts §3.4 (protocol), §3.6 (Cloudflare layer), §3.5 (PTY display strategy) and expands them.
- **`docs/superpowers/specs/v0.3-daemon-split.md`** — v0.3-only consolidated spec. Source for socket addressing, peer-cred ACL, control-vs-data socket split (§3.1.1, §3.4.1.h).
- **`docs/superpowers/specs/v0.3-design.md`** — earlier draft of v0.3.
- **`docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md`** — envelope hardening rules (frame cap, chunking, binary trailer). v0.4 inherits the security/perf intent and re-implements as Connect interceptors / native HTTP/2 features.
- **`docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md`** — PTY subscribe contract, drop-slowest, snapshot semaphore. v0.4 inherits unchanged.
- **`docs/superpowers/specs/v0.3-fragments/frag-3.7-dev-workflow.md`** — daemon-unreachable surface, reconnect canonical log names. v0.4 reuses surface registry.
- **`docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md`** — surface registry (§6.8), supervisor transport split. v0.4 cross-refs for the daemon-status banner.
- **`docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md`** — migration-gate semantics. v0.4 re-implements as Connect interceptor (chapter 02 §8).
- **`docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md`** — single-installer model, `@yao-pkg/pkg` lock, Win/Mac/Linux artifacts. v0.4 extends with `cloudflared` binary bundling (chapter 09 M4).

## 2. v0.3 source code (daemon)

| Path | What it provides | v0.4 impact |
|---|---|---|
| `daemon/src/index.ts` | Daemon entry point | M1: bind Connect HTTP/2 server alongside envelope on data socket |
| `daemon/src/sockets/data-socket.ts` | Data-socket transport (hosts the round-2 security pre-accept rate cap labelled "T15" in `v0.3-design.md` §3.4.1.a) | M1-M2: Connect server replaces envelope handlers; pre-accept rate cap stays on the listener boundary |
| `daemon/src/sockets/runtime-root.ts` | Listener selection / transport tagging | M4: tag local vs. remote requests for JWT bypass |
| `daemon/src/dispatcher.ts` | RPC method router (control socket) | Unchanged in v0.4 (control socket stays envelope) |
| `daemon/src/handlers/healthz.ts` | `/healthz` handler | Unchanged (control socket) |
| `daemon/src/handlers/daemon-hello.ts` | HMAC handshake handler | Unchanged on control socket; HMAC dropped from data socket per chapter 02 §8 |
| `daemon/src/envelope/envelope.ts` | Length-prefixed JSON envelope | Deleted from data socket in M2; kept on control socket |
| `daemon/src/envelope/hello-interceptor.ts` | HMAC handshake interceptor | Same — control socket only after M2 |
| `daemon/src/envelope/deadline-interceptor.ts` | `x-ccsm-deadline-ms` enforcement | Re-implemented as Connect interceptor (chapter 02 §8) |
| `daemon/src/envelope/migration-gate-interceptor.ts` | Block RPCs during SQLite migration | Re-implemented as Connect interceptor |
| `daemon/src/envelope/trace-id-map.ts` | ULID per-request | Re-implemented as Connect interceptor on data socket |
| `daemon/src/envelope/chunk-reassembly.ts` | 16 KiB sub-chunk reassembly | Obsolete on data socket (HTTP/2 native frame fragmentation) |
| `daemon/src/envelope/protocol-version.ts` | Frame version nibble validation | Obsolete on data socket |
| `daemon/src/envelope/supervisor-rpcs.ts` | Allowlist for control socket RPCs | Unchanged |
| `daemon/src/db/` | SQLite schema, migrations, boot orchestrator | Unchanged in v0.4 |
| `daemon/src/pty/lifecycle.ts` | Per-session PTY spawn / exit | Unchanged |
| `daemon/src/pty/fanout-registry.ts` | Per-session subscriber set + seq tracking | Carries forward; new subscribers from web client |
| `daemon/src/pty/snapshot-semaphore.ts` | Serialize-buffer concurrency control | Unchanged |
| `daemon/src/pty/drop-slowest.ts` | Per-subscriber 1 MiB watermark | Unchanged |
| `daemon/src/pty/sigchld-reaper.ts` | Unix process reap | Unchanged |
| `daemon/src/marker/` | Boot nonce / pid file | Unchanged; `boot_nonce` now also flows into Connect events (chapter 06 §2) |

## 3. v0.3 source code (Electron / preload bridges)

| Path | What it provides | v0.4 impact |
|---|---|---|
| `electron/preload/bridges/ccsmCore.ts` | `window.ccsm` (db, version, importable, settings, updater, window) | Bridge-swap M2 (Batches A + B); daemon-domain calls move to Connect |
| `electron/preload/bridges/ccsmSession.ts` | `window.ccsmSession` (state, title, activate signals) | Bridge-swap M2 (Batches B + C streams) |
| `electron/preload/bridges/ccsmPty.ts` | `window.ccsmPty` (spawn, attach, input, snapshot, data stream) | Bridge-swap M2 (Batches A + B + C); clipboard surface stays Electron |
| `electron/preload/bridges/ccsmNotify.ts` | `window.ccsmNotify` (flash, user-input markers) | Bridge-swap M2 (Batch B + C) |
| `electron/preload/bridges/ccsmSessionTitles.ts` | `window.ccsmSessionTitles` (SDK summary get/rename/list) | Bridge-swap M2 (Batches A + B) |
| `electron/ipc/sessionIpc.ts` | Main-process handlers for session signals + sessionTitles | Removed in M2 cleanup PR (handlers move to daemon Connect) |
| `electron/ipc/dbIpc.ts` | Main-process db:load/save handlers | Removed in M2 cleanup |
| `electron/ipc/systemIpc.ts` | Main-process system info handlers | Mostly removed; clipboard/window subset stays |
| `electron/ipc/utilityIpc.ts` | Misc | Audit per-handler in M2 cleanup |
| `electron/ipc/windowIpc.ts` | Window-only IPCs (minimize/maximize/etc.) | Stays on `ipcRenderer` (chapter 03 §2) |
| `electron/main.ts` | Main process entry | Reduced further: Connect transport setup; no per-bridge handler wiring |
| `electron/sessionTitles/` | SDK wrapper logic | Lives on daemon now (already migrated in v0.3); v0.4 just ensures Connect handler delegates here |
| `electron/notify/` | Notification pipeline | Same — daemon-side; Connect handler delegates |
| `electron/security/ipcGuards.ts` | `fromMainFrame`, `isSafePath` | Still applies to remaining `ipcRenderer` handlers |

## 4. Renderer (shared)

| Path | What it provides | v0.4 impact |
|---|---|---|
| `src/App.tsx` | Top-level React component | Unchanged |
| `src/index.tsx` | Renderer entry | Unchanged for Electron; shared by web entry `web/src/main.tsx` |
| `src/stores/*` | Zustand stores | Unchanged |
| `src/shared/sessionState.ts` | Canonical 3-state session vocabulary | Imported by proto-generated types in v0.4 (chapter 02 §7) |
| `src/components/TerminalPane.tsx` (representative) | xterm.js host | Unchanged surface; consumes `window.ccsmPty` bridge unchanged |
| `src/i18n/*` | Translation bundles | New keys for `cloudflare.unreachable`, setup wizard text |

## 5. Spike reports

- **F1 — Tauri vs Electron desktop:** `~/spike-reports/F1-tauri-desktop.md`. Decided against Tauri.
- **F2 — Flutter all-platform:** `~/spike-reports/F2-flutter-all.md`. Decided against Flutter.
- **F3 — iOS native vs cross-platform:** `~/spike-reports/F3-ios-stack.md`. Locked SwiftUI for v0.5+; v0.4 emits Swift codegen but doesn't use it.
- **F4 — shared protocol layer:** `~/spike-reports/F4-shared-protocol.md`. Locked Connect+Protobuf+buf over gRPC, tRPC, TypeSpec.
- v0.3 round-1 spikes A1-A4, B1-B4, C5, D6-D7: `~/spike-reports/`.
- v0.3 review reports (security/perf/reliability): `~/spike-reports/v03-review-{security,perf,reliability,observability,devx,resource,ux,fwdcompat}.md` and round-2/round-3 variants.

## 6. External documentation

### Cloudflare
- Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Access (Zero Trust): https://developers.cloudflare.com/cloudflare-one/identity/
- GitHub IdP: https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/github/
- JWT validation (programmatic): https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- Pages: https://developers.cloudflare.com/pages/
- Pages GitHub integration: https://developers.cloudflare.com/pages/configuration/git-integration/
- Service tokens (for CI): https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Free tier limits: https://www.cloudflare.com/plans/zero-trust-services/

### Connect / Protobuf / buf
- Connect-RPC docs: https://connectrpc.com/
- Connect-ES (TypeScript): https://github.com/connectrpc/connect-es
- Connect-Web: https://connectrpc.com/docs/web/getting-started
- Connect-Node: https://connectrpc.com/docs/node/getting-started
- Protobuf v3 language guide: https://protobuf.dev/programming-guides/proto3/
- buf docs: https://buf.build/docs/
- buf breaking-change rules: https://buf.build/docs/breaking/rules/
- @bufbuild/protoc-gen-es: https://github.com/bufbuild/protobuf-es

### Other tooling
- `@yao-pkg/pkg`: https://github.com/yao-pkg/pkg (locked daemon packager per `feedback_*` and frag-11)
- `jose` (JWT verification): https://github.com/panva/jose
- xterm.js + xterm-headless: https://xtermjs.org/
- Vite: https://vite.dev/
- Playwright: https://playwright.dev/

## 7. Memory / convention references (manager-level)

These are referenced by manager-level processes; cited here so a worker reading the spec knows the convention exists.

- `feedback_dispatch_discipline.md`
- `feedback_one_bug_one_worker.md`
- `feedback_e2e_prefer_harness.md`
- `feedback_local_e2e_only.md`
- `feedback_trust_ci_mode.md`
- `feedback_bug_fix_test_workflow.md`
- `feedback_dogfood_protocol.md`
- `feedback_correctness_over_cost.md`
- `feedback_no_skipped_e2e.md`
- `feedback_migration_window_ci_tolerance.md`
- `project_direction_locked.md`
- `feedback_taskcreate_no_id_prefix.md` (relevant during DAG seed in pipeline stage 7)

## 8. Tool / dependency versions (locked at v0.4 spec time)

| Dependency | Version | Reason |
|---|---|---|
| `@connectrpc/connect` | ^2.x (latest stable as of 2026-04) | Connect runtime |
| `@connectrpc/connect-node` | ^2.x | Daemon Connect server |
| `@connectrpc/connect-web` | ^2.x | Web client transport |
| `@bufbuild/buf` | ^2.x | buf CLI as devDep |
| `@bufbuild/protoc-gen-es` | ^2.x | TS message codegen |
| `@bufbuild/protoc-gen-connect-es` | ^2.x | TS Connect service stubs |
| `jose` | ^5.x | JWT validation |
| `cloudflared` | bundled binary, version pinned in `daemon/scripts/cloudflared-version.txt` (latest stable as of release tag) | Cloudflare Tunnel sidecar |
| Node | 22 LTS (matches v0.3) | Daemon + Electron main + build tools |
| Vite | ^6.x | Web build |
| Playwright | matches v0.3 | E2E |

**Lock review at M4 close:** verify each version still latest stable; bump if needed before tagging `v0.4.0`.
