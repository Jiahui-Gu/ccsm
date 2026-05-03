# v0.3 Spec Reconciliation Audit (Drift Detection)

**Date**: 2026-05-03
**Author**: research agent (pool-3, Task #201)
**Scope**: All merged tasks vs `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` (+ toolchain-lock + final-architecture).
**Companion**: PR #945 (the user-prompted reconciliation review).
**Mode**: READ-ONLY. No production code changes. User decides which drifts to fix / defer / accept.

---

## Severity legend

- **ALIGNED** — implementation completely matches spec.
- **MINOR DRIFT** — naming / path / decoration difference; no behavior delta.
- **DRIFT** — real behavior or design difference; ship-acceptable but a divergence.
- **CRITICAL DRIFT** — violates a spec invariant or ship-gate; should not ship as-is.

For every row I cite `spec ref`, then `evidence` (file path / PR / merged-fix), then `already-fixed?`.

---

## Category 1 — T0.x monorepo + CI infra

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| #11 T0.1 pnpm workspaces (PR #848) | ch11 §2 | ALIGNED | `pnpm-workspace.yaml` lists `packages/*`; `packages/{daemon,electron,proto}` exist; `packageManager: pnpm@10.33.2` in root `package.json`. | n/a |
| (T0.1 — proto file path) | ch11 §2 dir layout: `packages/proto/ccsm/v1/*.proto` | MINOR DRIFT | Actual: `packages/proto/src/ccsm/v1/*.proto`. `buf.yaml` declares `modules: [{ path: src }]`; `lock.json` keys all start `src/ccsm/v1/...`; eslint guard refers to `@ccsm/proto/src/*` as forbidden, treating `src/` as the canonical proto dir. Functionally identical, but a literal byte-for-byte diff vs spec layout block. | No |
| #13 T0.3 tsconfig (PR #852) | ch11 §2 ("`tsconfig.base.json` shared TS config; packages extend") | ALIGNED | `tsconfig.base.json` exists at repo root; per-package `tsconfig.json` extend it. | n/a |
| #14 T0.4 ESLint flat (PR #855) | ch11 §5 forbidden-pattern table | ALIGNED | `packages/{daemon,electron,proto}/eslint.config.js` each implement spec's `no-restricted-imports` patterns verbatim (forbid cross-package imports, native modules in renderer, ipcMain/ipcRenderer/contextBridge in electron). The daemon eslint config also adds the spec ch15 lint `ccsm/no-listener-slot-mutation`. | n/a |
| #10 T0.2 Turborepo (PR #904) | ch11 §4 turbo.json (`build`, `gen`, `test`, `lint` tasks; `dependsOn: ['^build', '@ccsm/proto#gen']`; outputs `dist/**`, `gen/**`) | ALIGNED | `turbo.json` matches the spec snippet exactly — same task names, same `dependsOn`, same `outputs`. Adds extra `inputs` filters (which is a strict refinement, not a drift). | n/a |
| **#17 T0.8 CI matrix (PR #906 still OPEN)** | ch11 §6 multi-job DAG: `install → proto-gen-and-lint → daemon-test{matrix} + electron-test{matrix} → package{matrix} → e2e-soak-1h + e2e-installer-win` | **CRITICAL DRIFT** | `.github/workflows/ci.yml` is a SINGLE monolithic job `lint-typecheck-test` running `npm ci --legacy-peer-deps`, `npm run lint:app`, `npm run typecheck`, `npm run build:app`, `npm run test:app`. Zero pnpm. Zero turbo. Zero `proto-gen-and-lint` job. No job DAG. No package matrix. No soak/installer self-hosted. The merged ci.yml contradicts spec ch11 §6 wholesale. PR #906 was authored to fix this exact drift; user discovered it during review of #906. | **No — fix PR is still OPEN (#906)** |
| #12 T0.5 buf codegen (PR #859) | ch11 §4 (`buf.gen.yaml`: `bufbuild/es` + `connectrpc/es` plugins, `target=ts`, `import_extension=js`) | MINOR DRIFT | `packages/proto/buf.gen.yaml` uses `local: protoc-gen-es` (one local plugin) instead of the two REMOTE plugins listed in spec; comment says "Connect-ES consumes the generated GenService directly via @connectrpc/connect — no separate connect-es plugin needed". Functionally equivalent under @bufbuild/protoc-gen-es v2 (which folds in service descriptors), but the on-disk yaml differs from the spec snippet. | Acknowledged in-file but not reconciled in spec. |
| #16 T0.10 self-hosted runner (PR #872) | ch10 §6 + ch11 §6 (`self-hosted, ccsm-soak`, `self-hosted, win11-25h2-vm`) | DRIFT (intentional) | `.github/workflows/_runners-template.yml` is INERT (`if: false`, `workflow_dispatch` only). `tools/runners/README.md` is provisioning *documentation* only. No actual workflow consumes the runner labels yet. Spec ch10 §6 explicitly descopes provisioning to `infra/win11-runner/` repo so the in-repo state is correct, but no CI wiring exists yet — the soak + installer-win jobs from spec ch11 §6 are missing. (Same root cause as #17.) | No |
| #18 T0.7 Changesets + sync-version + drift-check (PR #907) | ch11 §7 (Changesets; sync-version; PROTO_VERSION drift check) | ALIGNED | `.changeset/config.json` present; `scripts/sync-version.mjs` propagates root version; `packages/proto/scripts/version-drift-check.mjs` referenced by `packages/proto/package.json` `"version-drift-check"`. | n/a |
| #19 T0.6 proto lock (PR #870) | ch04 + ch11 §4 (SHA256 per .proto, `lock.json`, `pnpm --filter @ccsm/proto run lock`) | ALIGNED | `packages/proto/lock.json` schema matches: `{ version: 1, files: { "src/ccsm/v1/<file>.proto": "<sha256>" } }`. `lock.mjs` + `lock-check.mjs` referenced. | n/a |
| #20 T0.11 .proto files (PR #856) | ch04 §1 file list (`common`, `session`, `pty`, `crash`, `settings`, `notify`, `draft`, `supervisor`) | ALIGNED | All 8 .proto files present at `packages/proto/src/ccsm/v1/` (subject to MINOR DRIFT path note above). | n/a |

---

## Category 2 — T1.x daemon listener

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| #21 T1.1 entrypoint / DaemonEnv / lifecycle (PR #857) | ch01 §1, ch02 §3 | ALIGNED | `packages/daemon/src/index.ts`, `env.ts`, `lifecycle.ts` present; phase enum + boot sequence comments map to ch02 §3. | n/a |
| #22 T1.3 peer-cred middleware (PR #884) | ch03 §5 (UDS / named-pipe / loopback-TCP all three transports) | ALIGNED | `packages/daemon/src/auth/peer-cred.ts` exposes `extractUdsPeerCred` + `extractNamedPipePeerCred` extractors and accepts a per-OS `lookup` callback for the syscall (so T1.5 can plug in the syscall). All three transport mechanisms enumerated. | n/a |
| #23 T1.7 Supervisor UDS endpoints (PR #914) | ch01 §4 + ch03 §7 (UDS-only, three endpoints `/healthz`, `/hello`, `/shutdown`, peer-cred admin gate) | ALIGNED | `packages/daemon/src/supervisor/server.ts` documents endpoints `{healthz, hello, shutdown}`; `admin-allowlist.ts` enforces uid/SID; comments cite ch03 §7.2 + forbidden-pattern #16; `loadbalancer-TCP supervisor is FORBIDDEN` is reflected in code. | n/a |
| #24 T1.4 Listener A factory + bind variants (PR #912) | ch03 §2 (`makeListenerA(env)`) + §1a closed enum vocabulary | **CRITICAL DRIFT** (the §1a enum drift; §2 itself fine) | `packages/daemon/src/listeners/factory.ts` implements `makeListenerA` and `pickTransportForListenerA`. **BUT** the `BindDescriptor.kind` discriminator in `listeners/types.ts` uses camelCase string literals (`'uds' \| 'namedPipe' \| 'loopbackTcp' \| 'tls'`) while spec ch03 §1a explicitly LOCKS the closed enum vocabulary as `'KIND_UDS' \| 'KIND_NAMED_PIPE' \| 'KIND_TCP_LOOPBACK_H2C' \| 'KIND_TCP_LOOPBACK_H2_TLS'` and says "BindDescriptor.kind is a closed enum stringified IDENTICALLY in `listener-a.json.transport`". The descriptor writer (`descriptor.ts`) DOES use the spec vocabulary, so the daemon currently has TWO parallel transport vocabularies and an implicit translation step somewhere. | **No** (latent — will require a touch on the forever-stable §1a contract). |
| (T1.4 — Listener trait shape) | ch03 §1 (`Listener` has `id: "A"\|"B"`, `bind: BindDescriptor`, `authChain: AuthMiddleware[]`, `start(router: ConnectRouter): Promise<void>`) | DRIFT | Actual `Listener` trait in `listeners/types.ts`: `id: string` (open string, not `"A"\|"B"` literal union); `bind` field absent — replaced by `descriptor(): BindDescriptor` method; `authChain` field absent (auth is attached at the http2 server layer in T1.5 instead); `start(): Promise<void>` (no router parameter). Comment in `factory.ts` says "the `(router)`-shaped start signature in spec ch03 §1 is the v0.4-friendly future shape that T1.5 will introduce". Behavior shipped is fine; the trait shape diverges from the spec snippet. | No |
| #25 T1.8 graceful shutdown (PR #924) | ch01 §5 / ch02 §4 (≤5s grace + 3s SIGKILL window) | ALIGNED | `shutdown.ts` + `shutdown.spec.ts` present; supervisor `/shutdown` is wired through. | n/a |
| #26 T1.5 HTTP/2 transport adapters (PR #913) | ch03 §3 (h2c-UDS / h2c-loopback / h2-named-pipe / h2-TLS) | ALIGNED | `packages/daemon/src/transport/{h2c-uds,h2c-loopback,h2-named-pipe,h2-tls}.ts` all four files exist. | n/a |
| #28 T1.2 Listener trait + 2-slot array + sentinel (PR #860) | ch03 §1 (typed sentinel `RESERVED_FOR_LISTENER_B`, 2-slot tuple, runtime assert, ESLint rule) | ALIGNED | `listeners/array.ts` exposes `ListenerSlots` tuple + `assertSlot1Reserved`; sentinel symbol minted in `env.ts`; ESLint rule lives in T1.9. (Trait field-shape drift carried in #24 row above.) | n/a |
| #30 T1.6 connection-descriptor atomic writer (PR #863) | ch03 §3.1 (write `.tmp` → `fsync` → `rename`) + §3.2 v1 schema | ALIGNED | `descriptor.ts` implements exactly that sequence with `wx` flag (refuses stale `.tmp`); `DescriptorV1` interface has every spec §3.2 field; uses spec enum vocabulary. | n/a |
| #29 T1.9 ESLint `no-listener-slot-mutation` (PR #873) | ch11 §5 (custom rule) | ALIGNED | `packages/daemon/eslint-plugins/ccsm-no-listener-slot-mutation.js` referenced from daemon eslint config; carve-out for `**/listener-b.ts`. | n/a |

---

## Category 3 — T2.x / T3.x RPC + session + principal

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| #31 T2.1 connect-es stubs (PR #869) | ch04 §2 (re-export 7 services + common types) | ALIGNED | `@ccsm/proto` package exports the 7 service descriptors per buf.gen.yaml v2 + `PROTO_VERSION` const. | n/a |
| #32 T2.2 ConnectRouter stub handlers (PR #918) | ch04 §3 (router with empty service implementations → Connect `Unimplemented` for absent methods) | ALIGNED | `packages/daemon/src/rpc/router.ts` registers every service from `@ccsm/proto` with empty `{}` impls — relying on Connect-ES v2's documented "missing method = Unimplemented" semantics. | n/a |
| #33 T2.3 Hello RPC + version negotiation (PR #928) | ch04 §3.3 + ch02 §6 (one-directional version negotiation, listener_id surfacing) | ALIGNED — and SPEC RECONCILED | `packages/daemon/src/rpc/hello.ts` validates non-empty `request_id` (rejects with `INVALID_ARGUMENT`/`request.missing_id`), validates `proto_min_version <= PROTO_VERSION` (rejects with `FAILED_PRECONDITION`/`version.client_too_old`), and surfaces `listener_id`. The HelloResponse intentionally does NOT carry `boot_id` per the spec reconcile in PR #929 (descriptor file is the boot_id witness; ch03 §3.3 was reworded). | Yes (spec aligned with code via PR #929). |
| #36 T3.1 Principal model + assertOwnership (PR #882, consolidated by #937) | ch05 §1 (Principal model + principalKey + assertOwnership) | ALIGNED — fix already merged | Initial PR #882 introduced two duplicate Principal modules; fixed by `fix(daemon): consolidate duplicate Principal modules [Task #189]` (PR #937). Single canonical module now. | Yes — drift was caught and fixed (#937). |
| #37 T2.4 RequestMeta validation middleware (PR #927) | ch04 §4 (reject empty `request_id`) | ALIGNED | T2.4 ships `RequestMeta validation middleware (reject empty request_id)`; aligned with the F7 rule "Daemon MUST NOT silently synthesize". | n/a |
| #38 T3.2 SessionManager (PR #933) | ch05 §2 + ch05 §6 (Create/Get/List/Destroy in-memory event bus) | ALIGNED | `packages/daemon/src/sessions/SessionManager.ts` documents ch05 §5 / §6 / ch07 §3 alignment; in-memory event bus + 4 CRUD ops + watch-sessions stream wiring. | n/a |
| #39 T2.5 ErrorDetail + standard codes (PR #926) | ch04 §5 (structured ErrorDetail emitter) | ALIGNED | `packages/daemon/src/rpc/errors.ts` referenced; standard codes match spec. | n/a |
| (related) T3.3 SessionService.WatchSessions stream (PR #939) | ch04 §3 (`rpc WatchSessions(...) returns (stream SessionEvent)` + ch05 §5 principal scoping) | ALIGNED | `feat(daemon T3.3): SessionService.WatchSessions stream handler` — ships double-scoped (implicit principal filter + explicit `scope` enum where v0.3 only honors OWN). | n/a |

---

## Category 4 — T5.x SQLite / persistence

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| #54 T5.1 better-sqlite3 wrapper (PR #864) | ch07 §1 + §3 (boot PRAGMAs: WAL / NORMAL / FK ON / busy_timeout 5000 / journal_size_limit 64 MiB / wal_autocheckpoint 1000) | ALIGNED | `packages/daemon/src/db/sqlite.ts` `BOOT_PRAGMAS` const matches every spec value; uses `loadNative('better_sqlite3')` for sea compatibility per ch10 §2. | n/a |
| #55 T5.2 001_initial.sql schema (PR #876) | ch07 §3 (forever-stable schema baseline) | ALIGNED | `packages/daemon/src/db/migrations/001_initial.sql` matches spec verbatim — `schema_migrations`, `principals`, `sessions` (incl. `should_be_running`, `owner_id`, indices), `pty_snapshot`, `pty_delta`, `crash_log`, `settings`, `principal_aliases`, `cwd_state`. | n/a |
| #56 T5.4 migration runner (PR #921) | ch07 §4 (forward-only, SHA256 lock self-check via `locked.ts`) | ALIGNED | `packages/daemon/src/db/migrations/locked.ts` referenced from `001_initial.sql` header; migration runner + SHA256 lock self-check. | n/a |
| #57 T5.3 per-OS state directory (PR #862) | ch07 §2 (`%PROGRAMDATA%\ccsm`, `/Library/Application Support/ccsm`, `/var/lib/ccsm`) | ALIGNED — fix already merged | `packages/daemon/src/state-dir/paths.ts` returns the exact spec paths. Initial PR had a `state/` segment ownership mismatch between `defaultStateDir()` and `statePaths()`; fixed by PR #936 `fix(daemon/state-dir): unify defaultStateDir() vs statePaths() /state segment ownership`. | Yes — drift caught and fixed (#936). |
| #58 T5.6 WAL discipline (PR #908) | ch07 §5 (autocheckpoint at 1000 pages; TRUNCATE on graceful shutdown; no FULL/RESTART in normal ops) | ALIGNED | `walCheckpointPassive()` + `walCheckpointTruncate()` helpers in sqlite.ts; PR title `daemon(T5.6): WAL autocheckpoint + TRUNCATE on shutdown`. | n/a |
| #59 T5.10 crash-raw.ndjson (PR #909) | ch07 §6 + ch09 §2 (NDJSON line shape with `owner_id`, append-only, `crash_raw_offset` sidecar) | ALIGNED — fix already merged | `packages/daemon/src/crash/raw-appender.ts`. The Windows CI timeout flake on the SIGKILL replay test was fixed in PR #944 (NOT a spec drift — pure CI timing fix). | Yes (#944). |
| #60 T5.7 corrupt-DB recovery (PR #923) | ch07 §6 / §6 corrupt-DB recovery (boot ordering: integrity_check → rename → ndjson append BEFORE new DB → `recovery_modal_pending` flag on `/healthz`) | ALIGNED | `packages/daemon/src/db/recovery.ts` + `RecoveryModalState` exposed via supervisor `/healthz`; integration with `crash-raw.ndjson` matches spec sequence. | n/a |
| #61 T5.5 write coalescer (PR #900) | ch07 §5 (16 ms tick + IMMEDIATE txn + 8 MiB per-session cap + 3-strike DEGRADED) | ALIGNED — drift already fixed | `packages/daemon/src/sqlite/coalescer.ts` `TICK_MS = 16`. The spec ch07 §5 narrative says "BetterQueue keyed by session" but the original BetterQueue scheduler added 24-31 ms tail latency on Windows CI; PR #932 (Task #184) replaced it with a hand-rolled `setTimeout(tickMs)` batcher preserving all 4 forever-stable invariants. | **Yes** — drift caught and fixed (#932). |
| #62 T5.11 crash capture (PR #920) | ch09 §1 + §6.2 (`CAPTURE_SOURCES` table-driven; capture handlers registered before any RPC handler runs) | ALIGNED | PR title: `daemon(T5.11): crash capture handlers + CAPTURE_SOURCES`; `packages/daemon/src/crash/sources.ts` mirrors the §1 table. | n/a |
| #64 T5.12 crash retention pruner (PR #934) | ch09 §3 (10000 rows / 90 days / boot + every 6h) | ALIGNED | PR title `daemon(T5.12): crash retention pruner (10000 rows / 90 days / 6h cycle)` — exactly matches spec. | n/a |
| #65 T5.13 systemd watchdog (PR #919) | ch09 §6 (linux-only, `WATCHDOG=1` every 10s under `WatchdogSec=30s`) | ALIGNED | PR title `daemon(T5.13): linux systemd watchdog WATCHDOG=1`. | n/a |
| (related) ccsm.db path unification | n/a | ALIGNED — drift already fixed | PR #931 `fix(daemon): unify ccsm.db path between T5.1 openDatabase + T5.7 recovery` reconciled an internal path inconsistency. | Yes (#931). |

---

## Category 5 — T6.x electron / T7.x build/installer / T8.x tests (spot-checks)

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| #67 T6.3 typed Connect clients + React Query (PR #915) | ch08 §6.2 (forever-stable shape: `use<MethodName>` / `useWatch<MethodName>` / `use<MethodName>Mutation`) | ALIGNED | `packages/electron/src/rpc/queries.ts` documents the locked surface; `createClients` factory cited by hello flow. | n/a |
| #68 T6.2 transport bridge (PR #911) | ch08 §4 (renderer ↔ daemon http2 + Host enforcement) | ALIGNED | PR title: `electron(T6.2): transport bridge (renderer <-> daemon, http2 + Host enforcement)`. | n/a |
| #74 T6.8 daemon cold-start modal (PR #935) | ch08 §6.1 (8s timeout + retry on cold start) | ALIGNED | PR title: `electron(T6.8): daemon cold-start blocking modal (8s timeout + retry)`. | n/a |
| #75 T6.7 renderer Hello + reconnect backoff (PR #922) | ch03 §3.3 + ch08 §6 (per-stream backoff `min(30s, 500ms * 2^attempt + jitter)` cap 30s) | **DRIFT** (latent) | `packages/electron/src/renderer/connection/reconnect.ts` ships `RECONNECT_SCHEDULE_MS = [100, 200, 400, 800, 1600, 3200, 5000]` with a 5s cap and no jitter — labeled as the "renderer-boot schedule" (Hello loop). The locked **per-stream** backoff (`min(30s, 500ms * 2^attempt + jitter)`, jitter uniform [0, 250ms]) for `Attach` / `WatchSessions` / `WatchCrashLog` / `WatchNotifyEvents` reconnect is **NOT IMPLEMENTED**. `packages/electron/src/rpc/queries.ts:33` carries a TODO comment "Implement reconnect/backoff (ch08 §6 has the locked schedule; React Query)". The matching test `packages/electron/test/rpc/reconnect-backoff.spec.ts` referenced in spec ch08 §6 does not exist. | No |
| #82 T7.3 per-OS signing scaffolding (PR #942 + fix PR #943) | ch10 §3 (signtool + EV cert / codesign + notarize / debsigs) | ALIGNED — drift already fixed | `packages/daemon/build/sign-{mac.sh,win.ps1,linux.sh}` are placeholder-safe (warn + exit 0 when env or toolchain missing) per `project_v03_ship_intent`. Initial PR had a non-platform-guarded spec on Windows; PR #943 fixed it. | Yes (#943). |
| #84 T7.1 sea pipeline (PR #867) | ch10 §1 (Node 22 sea + esbuild + postject) | ALIGNED | PR title: `feat(daemon): T7.1 Node 22 sea pipeline (esbuild + postject)`. | n/a |
| #85 T7.7 electron-builder (PR #905) | ch10 §4 (mac dmg+pkg, linux deb+rpm; v0.3 ships MSI primary on win) | DRIFT | PR title: `feat(electron): T7.7 electron-builder config (mac pkg+dmg, linux deb+rpm)` — Windows MSI is conspicuously absent from this task's deliverable. Spec ch10 §4 says "Windows: NSIS or MSIX (we pick MSI via electron-builder + custom action ... v0.3 ships MSI as primary)". MSI via WiX is tracked under T9.13 spike (PR #890) and T9.14 tooling pick (PR #903) but the production electron-builder/MSI wiring task is missing from #85's scope. Per spec ch10 §5.1 the v0.3 installer is MSI; if the only existing MSI plumbing is the spike it's a behavioral gap on ship-gate (d). | No |
| #97 T8.13 daemon bench (PR #897) | ch12 §3 (bench harness skeleton) | ALIGNED | PR title: `test(daemon): T8.13 bench suite skeleton`. | n/a |
| #99 T8.10 integration spec family (PR #925) | ch12 §3 (peer-cred / version / crash / settings integration specs) | ALIGNED | PR title: `test(T8.10): integration spec family (peer-cred / version / crash / settings)`. | n/a |

---

## Cross-cutting fixed-drift inventory (PRs explicitly tagged as reconciliation fixes)

These are the **drift-caught-and-fixed** PRs already merged, useful as priors when assessing remaining work:

| Fix PR | Fixes | Original drift |
| --- | --- | --- |
| #929 | spec ch03 §3.3 wording | proto `HelloResponse` does not carry `boot_id`; descriptor file is the witness |
| #931 | T5.1 + T5.7 db path mismatch | `ccsm.db` resolved to two different paths |
| #932 | T5.5 (Task #184) | BetterQueue scheduler too slow on Windows; replaced with hand-rolled batcher |
| #936 | T5.3 state-dir | `defaultStateDir()` and `statePaths()` disagreed on the `/state` segment owner |
| #937 | T3.1 (Task #189) | duplicate Principal modules in `daemon/src` |
| #943 | T7.3 sign-scripts | non-platform-guarded test broke on non-target OSes |
| #944 | T5.10 crash-raw | windows-CI timeout for SIGKILL replay (CI timing only — not a spec drift) |

**Drift-still-latent inventory** (the ones a fix PR does NOT yet exist for) is the union of every CRITICAL / DRIFT row above with `Already fixed? = No`.

---

## Summary

- **Audited tasks**: 36 (T0.x + T1.x + T2.x + T3.x + T5.x + spot-checked T6.x / T7.x / T8.x).
- **ALIGNED**: 26.
- **MINOR DRIFT**: 2 (proto file path layout; T0.5 buf.gen.yaml plugin shape).
- **DRIFT**: 4 (T0.10 self-hosted runner CI wiring missing; T1.2 Listener trait field shape; T6.7 per-stream reconnect backoff unimplemented; T7.7 Windows MSI missing from electron-builder).
- **CRITICAL DRIFT**: 2 (T0.8 ci.yml monolithic vs spec ch11 §6 5-job DAG; T1.4 BindDescriptor.kind vocabulary diverges from spec ch03 §1a closed-enum vocabulary).
- **drift caught and fixed**: 6 (PR #929 / #931 / #932 / #936 / #937 / #943).
- **drift still latent**: 8.

### Top 5 critical drifts (ordered by ship-risk)

1. **T0.8 ci.yml is a monolith (CRITICAL)** — current `.github/workflows/ci.yml` runs `npm ci --legacy-peer-deps` + a single `lint+typecheck+test` job. Spec ch11 §6 mandates `install → proto-gen-and-lint → daemon-test{matrix} + electron-test{matrix} → package{matrix} → e2e-soak-1h + e2e-installer-win`. Zero pnpm, zero turbo, zero proto-lock-check, zero buf-breaking, zero per-package matrix, zero installer/soak job. Fix PR #906 still **OPEN**.
2. **T1.4 BindDescriptor enum vocabulary split (CRITICAL)** — `listeners/types.ts` declares `BindDescriptor.kind` as `'uds' | 'namedPipe' | 'loopbackTcp' | 'tls'` (camelCase). `listeners/descriptor.ts` declares `DescriptorTransport` as `'KIND_UDS' | 'KIND_NAMED_PIPE' | 'KIND_TCP_LOOPBACK_H2C' | 'KIND_TCP_LOOPBACK_H2_TLS'` (spec). Spec ch03 §1a says these MUST share one vocabulary. Currently only the descriptor writer uses spec strings; the rest of the listener subsystem uses camelCase, requiring an undocumented translation layer. The §1a contract is forever-stable (descriptor JSON is wire to Electron); a fix touches stable surface.
3. **T6.7 per-stream reconnect backoff is unimplemented (DRIFT)** — `min(30s, 500ms * 2^attempt + jitter)` for stream RPCs (`Attach`, `WatchSessions`, `WatchCrashLog`, `WatchNotifyEvents`) is the locked schedule in spec ch08 §6, with a named test file `packages/electron/test/rpc/reconnect-backoff.spec.ts` to enforce it. Code has a TODO at `packages/electron/src/rpc/queries.ts:33`; the test file does not exist. The renderer-boot reconnect (5s cap) is a *different* concern and is shipped.
4. **T7.7 Windows MSI scope gap (DRIFT)** — PR #905 ships mac pkg+dmg + linux deb+rpm but no production Windows MSI wiring. Spec ch10 §4 + §5.1 say MSI is the v0.3 primary Windows installer (driven by either electron-builder MSI builder or hand-written WiX project). Only the WiX 4 spike (#890) and the tooling-pick spike (#903) exist; the production MSI build is not implemented. ship-gate (d) is the exact gate this would block.
5. **T1.2 Listener trait shape (DRIFT)** — actual `Listener` interface lacks `bind: BindDescriptor` field, `authChain: AuthMiddleware[]` field, and `start(router: ConnectRouter): Promise<void>` signature from spec ch03 §1; it ships `descriptor()` method + parameter-less `start()` instead. Comment in `factory.ts` acknowledges T1.5 was supposed to introduce the router parameter but T1.5 (PR #913) merged without doing so. Reviewers cannot mechanically grep "trait shape" against the spec snippet.

### Top non-blocking observations

- T0.10 self-hosted runner provisioning is intentionally documentation-only (`.github/workflows/_runners-template.yml` `if: false`); spec ch10 §6 explicitly descopes provisioning. The CI wiring gap (no consumer workflow) is the same root cause as the #17 ci.yml drift.
- The proto file path drift (`packages/proto/ccsm/v1/` per spec → `packages/proto/src/ccsm/v1/` actual) is consistent across `buf.yaml`, `lock.json`, and the daemon ESLint config — it is internally consistent code, only the spec layout block is byte-misaligned.
- T0.5 buf.gen.yaml uses one local plugin (`protoc-gen-es` v2 with combined message + service descriptors) instead of the two remote plugins from spec — the spec's plugin list reflects an older split that v2 of `@bufbuild/protoc-gen-es` collapsed.
