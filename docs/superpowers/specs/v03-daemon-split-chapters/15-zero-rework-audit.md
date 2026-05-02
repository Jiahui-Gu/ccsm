# 15 — Zero-Rework Audit

This is the gate. For every locked decision in `00-brief.md` and every concrete design choice in chapters 02-14, this chapter answers the question:

> When v0.4 lands web client + iOS client + Cloudflare Tunnel + cloudflared sidecar + CF Access JWT validation on Listener B, what code/proto/schema/installer changes are required?

Acceptable answers: **none** / **purely additive** (specify what is added). Unacceptable: **rename X** / **change message Y shape** / **move file Z** / **split function into two**. Any unacceptable answer below is a hard block on v0.3 ship; the corresponding chapter MUST be re-designed before merge. Reviewers SHOULD treat this chapter as the single document they audit against.

### 1. Audit table — locked decisions from `00-brief.md`

| # | Locked decision (brief) | v0.4 delta | Verdict |
| --- | --- | --- | --- |
| §1 | Listener trait + 2-slot array; Listener B reserved as stub slot | Fill slot 1 by removing `throw` from `makeListenerB` and uncommenting one line in startup. NEW module `jwt-validator.ts` ADDED to authChain. Listener trait, array shape, slot-0 (Listener A) untouched. | **additive** |
| §2 | Listener A protocol = HTTP/2; transport pick is MUST-SPIKE per OS | Same HTTP/2 stack on Listener B (loopback TCP for cloudflared consumer); descriptor file gains `listener-b.json`. Listener A descriptor and transport: unchanged. | **additive** |
| §3 | Electron migration is big-bang; `lint:no-ipc` gate enforced | Web/iOS are net-new packages, not migrations. `lint:no-ipc` gate continues to run in v0.4 unchanged. | **none** |
| §4 | PTY xterm-headless emits snapshot AND delta; delta schema locked | New web/iOS clients call same `PtyService.Attach`; daemon broadcasts to N subscribers (already supported). Snapshot/delta wire formats forever-stable; SnapshotV1 ships zstd-compressed in v0.3 (codec is part of v1, see chapter [06](./06-pty-snapshot-delta.md) §2); v0.4 may add new codec values inside the `codec` byte without bumping `schema_version`. `AckPty` RPC (chapter [04](./04-proto-and-rpc-surface.md) §4) ships in v0.3 so high-latency v0.4 clients get reliable ack-driven flow control with no proto change. | **additive** |
| §5 | Session bound to `Principal` (`owner_id`) from day one; v0.3 only `local-user` from peer-cred | New `cf-access:<sub>` principal kind ADDED as new oneof variant + new middleware on Listener B. `principalKey` format unchanged. `Session.owner_id` column unchanged. `assertOwnership` unchanged (still string compare). | **additive** |
| §6 | Proto scope: forever-stable existing messages; only additive in v0.4 | New RPCs / messages ADDED in new files OR appended to existing services with new field numbers. `buf breaking` gate enforces. | **additive** |
| §7 | Daemon = system service per OS; survives logout (LaunchDaemon, not LaunchAgent) | LaunchDaemon choice already supports v0.4 web/iOS reaching daemon while user logged out. No service shape change. cloudflared subprocess ADDED to daemon supervision. | **additive** |
| §8 | Monorepo `packages/{daemon, electron, proto}`; pnpm + Turborepo | ADD `packages/web`, `packages/ios`, optionally `packages/cloudflared-config`. Existing packages unchanged. Workspace tool unchanged. | **additive** |
| §9 | Node 22 sea single binary per OS; native deps via `native/` sidecar | sea pipeline unchanged; `native/` may grow if v0.4 needs new natives (currently doesn't — JWT validation is pure JS via `jose`). | **none** (or **additive** if cloudflared is bundled in install dir) |
<!-- F1: closes R0 15-P0.1 / R0 15-P0.2 — audit verdicts revised; v0.3 ships scoping baseline so v0.4 add is row-additive, not column-additive. -->
| §10 | Crash collector local-only; SQLite log table; `GetCrashLog` RPC | `CrashEntry.owner_id` field, `crash_log.owner_id NOT NULL` column with `'daemon-self'` sentinel, and `OwnerFilter` enum all SHIPPED in v0.3 (chapter [04](./04-proto-and-rpc-surface.md) §5, chapter [07](./07-data-and-state.md) §3, chapter [09](./09-crash-collector.md) §1). v0.4 ADDS only `crash_log.uploaded_at` column + `CrashService.UploadCrashLog` RPC + upload UI; populates the existing `owner_id` with cf-access principalKeys. No backfill, no semantic flip. | **additive** |
| §11(a) | Ship-gate: zero IPC residue grep | v0.4 still gates on the same grep. | **none** |
| §11(b) | Ship-gate: daemon survives Electron SIGKILL | Same harness; v0.4 also runs analogous "daemon survives web client tab close" harness as ADDITIVE. | **additive** |
| §11(c) | Ship-gate: 1-hour PTY zero-loss | Same harness; v0.4 may add a CF Tunnel variant additively. | **additive** |
| §11(d) | Ship-gate: clean Win 11 25H2 installer round-trip | Same harness; cloudflared install/uninstall added to checklist additively. | **additive** |

**No unacceptable verdicts.** All locked decisions admit purely additive v0.4 deltas.

### 2. Audit table — derived design choices (chapters 02-14)

| Source | Design choice | v0.4 delta | Verdict |
| --- | --- | --- | --- |
| [02 §2.1](./02-process-topology.md) | Win Service runs as LocalService, not LOCAL_SYSTEM | unchanged; v0.4 web/iOS reach via cloudflared bound to loopback (no new privilege need) | **none** |
| [02 §2.2](./02-process-topology.md) | macOS picks LaunchDaemon over LaunchAgent | unchanged | **none** |
| [02 §3](./02-process-topology.md) | Startup order step 5 binds Listener A and instantiates listener slot array | step 5 ADDS slot-1 instantiation (one-line addition); ordering unchanged | **additive** |
| [02 §4](./02-process-topology.md) | Electron quit does NOT terminate sessions | unchanged; same contract for web tab close | **none** |
| [03 §1](./03-listeners-and-transport.md) | Fixed-length 2-slot listener array | filled, not reshaped | **additive** |
| [03 §2](./03-listeners-and-transport.md) | Listener A authChain `[peerCred, jwtBypassMarker]` | Listener B authChain `[jwtValidator]` (different listener; A unchanged) | **additive** |
| [03 §3](./03-listeners-and-transport.md) | `listener-a.json` descriptor file with `version: 1` | new fields (if needed) added; existing fields unchanged | **additive** |
| [03 §4](./03-listeners-and-transport.md) | Per-OS transport pick (h2c-uds / h2c-loopback / etc.) | Listener B picks loopback TCP independently; A unchanged | **additive** |
| [03 §6](./03-listeners-and-transport.md) | v0.3 ships NO `listener-b.ts` file; slot 1 holds the typed `RESERVED_FOR_LISTENER_B` sentinel | v0.4 adds a brand-new `listener-b.ts` file (purely additive new file) plus a one-line edit at the startup site (sentinel write becomes `makeListenerB(env)`) plus a new `jwt-validator.ts` module | **additive** |
| [03 §7](./03-listeners-and-transport.md) | Supervisor UDS: `/healthz`, `hello`, `shutdown` HTTP | unchanged | **none** |
| [04 §2](./04-proto-and-rpc-surface.md) | `Principal` oneof; `LocalUser` shape | ADD `CfAccess` variant; `LocalUser` unchanged | **additive** |
| [04 §2](./04-proto-and-rpc-surface.md) | `RequestMeta`, `ErrorDetail`, `SessionState` enum | unchanged forever | **none** |
| [04 §3-6](./04-proto-and-rpc-surface.md) | every RPC and message | new RPCs / fields ADDED; existing untouched | **additive** |
| [04 §8](./04-proto-and-rpc-surface.md) | additivity contract enforced via `buf breaking` | enforced in v0.4 too | **none** |
| [05 §1](./05-session-and-principal.md) | `principalKey` format `kind:identifier` | new `cf-access:<sub>` keys; format unchanged | **additive** |
| [05 §4](./05-session-and-principal.md) | `assertOwnership` early return | gains optional admin clause; existing logic unchanged | **additive** |
| [05 §5](./05-session-and-principal.md) | Crash log + Settings principal-scoped from v0.3 day one (`crash_log.owner_id NOT NULL` with `'daemon-self'` sentinel; `settings(scope, key, value)` with `scope='global'`; `OwnerFilter` / `SettingsScope` / `WatchScope` enums on the wire) | v0.4 inserts `crash_log` rows with attributable principalKeys, `settings` rows with `scope='principal:<principalKey>'`, and starts honoring `OWNER_FILTER_ALL` / `WATCH_SCOPE_ALL` for admin principals. No column add, no table add (the `principal_aliases` table also already ships empty in v0.3). | **additive** |
| [05 §5](./05-session-and-principal.md) | `claude_binary_path` and other code-execution-controlling keys EXCLUDED from `Settings` proto wire (config-file-only) | v0.4 keeps the same exclusion; if per-user override is ever needed it ships as a separate admin-only `AdminSettingsService` (additive new RPC, not a new field on `Settings`) | **additive / none** |
| [05 §7](./05-session-and-principal.md) | Restored sessions trust recorded `owner_id` | unchanged | **none** |
<!-- F3: closes R0 15-P1.1 / R0 15-P1.2 / R0 06-P0.1 / R0 06-P0.2 — audit rows revised for the F3-locked PTY child-process boundary and SnapshotV1 zstd-compressed-from-day-one position. -->
| [06 §1](./06-pty-snapshot-delta.md) | One **child process** per session (`child_process.fork`), NOT a `worker_threads` Worker; main thread coalesces SQLite | unchanged. v0.4 multi-principal can drop privileges per child (additive uid switch at fork time); the process boundary is forever-stable so the v0.4 helper-process model is a no-op extension, not a reshape. | **none** |
| [06 §2](./06-pty-snapshot-delta.md) | SnapshotV1 binary format with outer `magic="CSS1"`, `codec` byte (1=zstd default, 2=gzip), `schema_version=1` | new codec values added inside `codec` byte (open enum) without bumping `schema_version`; new schemas use `schema_version=2+`; v1 retained forever | **additive** |
| [06 §3](./06-pty-snapshot-delta.md) | Delta payload = raw VT bytes; segment at 16ms/16KiB | unchanged | **none** |
| [06 §4](./06-pty-snapshot-delta.md) | Snapshot cadence parameters K/M/B | unchanged; tunable per-session by future per-principal config (additive) | **additive** |
| [06 §5](./06-pty-snapshot-delta.md) | Reconnect decision tree | unchanged | **none** |
| [06 §6](./06-pty-snapshot-delta.md) | Multi-attach broadcast | already supports N subscribers; v0.4 web/iOS use unchanged | **none** |
| [07 §1](./07-data-and-state.md) | better-sqlite3, WAL, NORMAL synchronous | unchanged | **none** |
| [07 §2](./07-data-and-state.md) | Per-OS state directory paths | unchanged | **none** |
| [07 §3](./07-data-and-state.md) | All v0.3 tables and columns — including `crash_log.owner_id NOT NULL DEFAULT 'daemon-self'`, `settings(scope, key, value)` composite PK, `principal_aliases` table | new tables and new columns ADDED via new migration files; v0.3 columns retained. v0.4 multi-principal lands as **row inserts** into existing tables, NOT as column or table additions. | **additive** |
| [07 §4](./07-data-and-state.md) | Migration files immutable post-ship; SHA256 in `locked.ts` | enforced in v0.4 too | **none** |
| [07 §6](./07-data-and-state.md) | No automated backup in v0.3 | v0.4 adds optional automated backup as additive feature | **additive** |
| [08 §3](./08-electron-client-migration.md) | IPC → Connect 1:1 mapping table | new RPCs added in v0.4 are wired via new mapping rows (additive); existing mappings unchanged | **additive** |
| [08 §4](./08-electron-client-migration.md) | Descriptor injected via `additionalArguments`; no `contextBridge` for callable APIs | unchanged; same `lint:no-ipc` gate | **none** |
| [08 §6](./08-electron-client-migration.md) | Renderer error contract (UNAVAILABLE, FailedPrecondition, etc.) | unchanged | **none** |
| [09 §1](./09-crash-collector.md) | Capture sources list + `source` open string set + `owner_id` attribution rules (sources are an open set; v0.4 may add freely; `daemon-self` sentinel forever-stable) | new sources added freely; existing unchanged | **additive** |
| [09 §2](./09-crash-collector.md) | `crash-raw.ndjson` recovery on boot | unchanged | **none** |
| [09 §3](./09-crash-collector.md) | Rotation caps (10000 / 90 days) | unchanged; user override remains | **none** |
| [09 §6](./09-crash-collector.md) | Linux watchdog via systemd; mac/win deferred | mac/win watchdog ADDED in v0.4 as hardening | **additive** |
| [10 §1](./10-build-package-installer.md) | Node 22 sea + esbuild bundle | unchanged | **none** |
| [10 §2](./10-build-package-installer.md) | Native modules in sibling `native/` dir | unchanged; `native/` may gain more files | **additive** |
| [10 §5](./10-build-package-installer.md) | Per-OS installer (MSI/pkg/deb/rpm) responsibilities | install/uninstall steps gain optional cloudflared registration | **additive** |
| [10 §6](./10-build-package-installer.md) | CI build matrix | new jobs for web/iOS ADDED; existing unchanged | **additive** |
| [11 §1](./11-monorepo-layout.md) | pnpm workspaces + Turborepo | unchanged | **none** |
| [11 §2](./11-monorepo-layout.md) | `packages/{proto,daemon,electron}` directory layout | ADD `packages/{web,ios}`; existing dirs unchanged | **additive** |
| [11 §3](./11-monorepo-layout.md) | Workspace dep graph | new leaves ADDED depending on `@ccsm/proto`; existing edges unchanged | **additive** |
| [11 §4](./11-monorepo-layout.md) | `buf.gen.yaml` outputs TS in v0.3 | ADD go/swift outputs in v0.4 | **additive** |
| [11 §5](./11-monorepo-layout.md) | Per-package responsibility matrix; ESLint forbidden-imports | applies to v0.4 packages too; rules ADD entries for web/ios; existing rules unchanged | **additive** |
| [12 §1-3](./12-testing-strategy.md) | Vitest + Playwright; per-package test layout | unchanged; v0.4 packages get their own equivalents | **additive** |
| [12 §4](./12-testing-strategy.md) | Four ship-gate harnesses | unchanged; v0.4 ADDS ship-gate (e) for tunnel | **additive** |
| [12 §5](./12-testing-strategy.md) | `claude-sim` test build | unchanged | **none** |
| [13 §1-2](./13-release-slicing.md) | Phase ordering 0-12 | v0.4 phases stack on top; v0.3 phases unchanged | **additive** |
| [13 §3](./13-release-slicing.md) | Dependency DAG | extended additively for v0.4 phases | **additive** |
| [13 §4](./13-release-slicing.md) | Trunk-based + per-PR conventions | unchanged | **none** |
| [14 §1](./14-risks-and-spikes.md) | MUST-SPIKE register | v0.4 ADDS new entries; existing entries' outcomes baked into v0.3 chapters | **additive** |
<!-- F2: closes R0 03-P0.1 / R0 03-P0.3 / R0 08-P0.3 / R0 15-P1.3 / R5 P0-03-2 / R5 P0-08-1 — three audit rows for listener slot 1 reservation, descriptor boot_id semantics, and renderer transport bridge decision. -->
| [03 §1](./03-listeners-and-transport.md) | Listener slot 1 reservation pattern (typed `RESERVED_FOR_LISTENER_B` sentinel + ESLint rule + startup assert) | v0.4 instantiates slot 1 with JWT middleware: brand-new `listener-b.ts` module is added (purely additive new file); ESLint rule whitelists that one file as the only writer of `listeners[1]`; the startup-site sentinel write becomes a `makeListenerB(env)` call. Sentinel symbol stays exported (still referenced by tests); slot-1-reservation lint rule stays in force as the v0.4 backstop. | **additive** |
| [03 §3](./03-listeners-and-transport.md) / [07 §2.1](./07-data-and-state.md) | Descriptor file `boot_id` semantics (per-boot UUIDv4; atomic write; `Hello`-echo verification; orphan files between boots are normal) | v0.4 web/iOS clients DO NOT read `listener-a.json` — they reach Listener B via cloudflared with a separate descriptor file (`listener-b.json`, additive new file). Only Electron uses `listener-a.json` and the `boot_id` mechanism. Schema additions go in NEW top-level fields. | **additive** |
| [08 §4.2](./08-electron-client-migration.md) / [14 §1.6](./14-risks-and-spikes.md) | Renderer transport bridge in Electron main (ships unconditionally in v0.3) | unchanged (Electron-only); v0.4 web/iOS use connect-web/connect-swift directly without a bridge. Bridge code is forever Electron-internal; chapter 15 §3 forbidden-pattern (item 15 below) forbids modifying it for web/iOS reasons. | **none** |
| [03 §7](./03-listeners-and-transport.md) | Supervisor UDS-only on every OS (`\\.\pipe\ccsm-supervisor` on Windows; `/var/run/com.ccsm.daemon/supervisor.sock` on macOS; `/run/ccsm/supervisor.sock` on Linux); peer-cred uid/SID is the sole authn | v0.4 cf-access principals MUST NOT reach Supervisor; equivalent functionality for remote callers MUST be a NEW Connect RPC on Listener B with explicit principal authorization. Supervisor surface stays UDS-only forever. | **none** |
| [03 §1a](./03-listeners-and-transport.md) | `BindDescriptor.kind` and `listener-a.json.transport` unified vocabulary (closed 4-value enum) | v0.4 transport variants ship under NEW descriptor file (`listener-b.json`) with their own enum domain; never as new values in the v0.3 enum. | **additive** |

**No unacceptable verdicts.**

### 3. Forbidden patterns (mechanical reviewer checklist)

When auditing a v0.4 PR, the reviewer MUST reject any of:

1. Removing or renaming any `.proto` field, message, enum value, RPC, or service from chapter [04](./04-proto-and-rpc-surface.md).
2. Reusing a `.proto` field number.
3. Changing the meaning of an existing `.proto` field.
4. Modifying any v0.3 SQL migration file (`001_initial.sql`); CI SHA256 lock check enforces.
5. Changing the SnapshotV1 binary layout fields/order; the format is `schema_version == 1` and frozen.
6. Reshaping the Listener trait or the listener slot array length / index meanings.
7. Renaming `principalKey` format or any of its `kind:identifier` strings.
8. Changing `listener-a.json` v1 field meanings (additions only).
9. Changing the Supervisor HTTP endpoint URLs or response shapes.
10. Reshuffling `packages/` directories; only additions allowed.
11. Bypassing the `lint:no-ipc` gate.
12. Changing per-OS state directory paths.
<!-- F1: closes R0 15-P0.3 — items 13/14 lock the behavioral-additivity invariants F1 enforces in chapters 04/05/07/09. -->
13. v0.4 adding a mandatory non-NULL column to a v0.3 table (any new column added in v0.4 MUST be NULL-tolerant or have a literal default that v0.3 rows already satisfy). The intended seam is row-additive — new rows with new `scope` / `owner_id` values, not new columns on existing tables. The v0.3 baseline already ships `crash_log.owner_id NOT NULL DEFAULT 'daemon-self'`, `settings(scope, key, value)` composite PK, and the empty `principal_aliases` table precisely so v0.4 needs zero non-NULL column additions on principal-scoping state.
14. v0.4 reshaping the request semantics of `WatchSessions`, `GetCrashLog`, `WatchCrashLog`, `GetSettings`, or `UpdateSettings`. The `WatchScope`, `OwnerFilter`, and `SettingsScope` enums (chapter [04](./04-proto-and-rpc-surface.md) §3 / §5 / §6) are the only knobs v0.4 may touch; flipping defaults, adding behavior to existing enum values, or reading scope from any source other than the request enum is a hard block. v0.4 multi-principal enforcement happens by daemon-side branch on the existing enum value, not by a request-shape change.
<!-- F2: closes R0 03-P0.1 / R0 03-P0.3 / R0 08-P0.3 / R2 P0-02-2 / R2 P0-03-3 / R5 P0-03-2 — items 15-18 lock the listener+descriptor+transport-bridge boundary. -->
15. Modifying `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons. The bridge is forever Electron-internal; v0.4 web client uses `connect-web` directly and v0.4 iOS uses `connect-swift` directly — neither traverses the bridge. Bug fixes that affect the renderer↔bridge↔daemon path are allowed; cross-client refactors are not.
16. Adding a loopback-TCP fallback for the Supervisor channel (Supervisor is UDS-only on every OS — Windows named pipe, mac/linux UDS — forever). Supervisor endpoints (`/healthz`, `/hello`, `/shutdown`) MUST NOT be exposed via Listener B or any future remote listener; equivalent functionality for remote callers MUST be a NEW Connect RPC on the data-plane listener with explicit principal authorization.
17. Adding a new value to the `BindDescriptor.kind` / `listener-a.json.transport` 4-value enum (`KIND_UDS` / `KIND_NAMED_PIPE` / `KIND_TCP_LOOPBACK_H2C` / `KIND_TCP_LOOPBACK_H2_TLS`). Any v0.4+ transport variant ships under a NEW descriptor file (e.g., `listener-b.json` for Listener B's transport) with its own enum domain.
18. Writing to `listeners[1]` from any source file other than `packages/daemon/src/listeners/listener-b.ts`. Enforced by the ESLint rule `ccsm/no-listener-slot-mutation` (chapter [11](./11-monorepo-layout.md) §5) and by the startup runtime assert (chapter [03](./03-listeners-and-transport.md) §1). Bypassing the rule via `// eslint-disable` or via a `Reflect.set(listeners, 1, ...)` indirection is also forbidden (the assert catches indirection at boot).
<!-- F3: closes R0 03-P0.2 / R0 04-P0.1 / R0 04-P0.4 / R0 06-P0.1 / R0 06-P0.2 / R0 06-P0.3 / R4 P0 ch 04 + ch 12 — items 19-23 lock proto-schema mutation, the PTY child-process boundary, the SnapshotV1 codec wrapper, the AckPty contract, and the buf-breaking + lock.json gate. -->
19. v0.4 (or any v0.3.x patch) MUST NOT remove or renumber any field, message, enum value, RPC, or service present in the v0.3 `.proto` set; only add new fields with new tag numbers, new RPCs as appended methods, new oneof variants on existing oneofs (subject to item 20). Comment-only "reserved-for-future" slots are forbidden in `.proto` files — every reserved slot MUST use the protobuf `reserved <number>;` keyword (chapter [04](./04-proto-and-rpc-surface.md) §2 / §8). CI rejects PRs whose `.proto` diff fails `buf breaking` against the merge-base SHA pre-tag or the v0.3 release tag post-tag.
20. v0.4 (or v0.3.x) MUST NOT add a new value to the `Principal.kind` oneof at any field number other than the explicitly `reserved` slot (currently `reserved 2;` for `cf_access`). Removing the `reserved 2;` line and adding `CfAccess cf_access = 2;` in the same patch is the ONLY sanctioned move; any other oneof-field add MUST use a fresh tag number ≥ 3.
21. v0.4 (or v0.3.x) MUST NOT bump SnapshotV1 `schema_version` to add compression; compression already ships in v1 via the `codec` byte (1=zstd, 2=gzip) — chapter [06](./06-pty-snapshot-delta.md) §2. New codec values are added inside the open enum on the `codec` byte; `schema_version=2` is reserved for genuine inner-layout changes only.
22. v0.4 (or v0.3.x) MUST NOT remove `PtyService.AckPty` or the `AttachRequest.requires_ack` field; both ship in v0.3 specifically so high-latency v0.4 transports (CF Tunnel, mobile) get ack-driven flow control without a proto reshape. Daemon implementations MAY no-op the ack on loopback, but the wire surface is forever-stable.
23. v0.4 (or v0.3.x) MUST NOT touch a `.proto` file without bumping the matching SHA256 entry in `packages/proto/lock.json` in the same PR. CI's `proto-lock-check` step rejects mismatches mechanically (chapter [11](./11-monorepo-layout.md) §6); the bump is regenerated via `pnpm --filter @ccsm/proto run lock`.
24. v0.4 (or v0.3.x) MUST NOT branch daemon behavior on `HelloRequest.client_kind` or `HelloResponse.listener_id` string values. Both are open string sets (chapter [04](./04-proto-and-rpc-surface.md) §3 / §7); they are observability-only on both sides. v0.4 features that need behavior selection per client kind ship as separate RPCs or as request-level fields, never as a switch on `client_kind`.
25. v0.4 (or v0.3.x) MUST NOT pivot the PTY per-session boundary back into a `worker_threads` Worker. The pty-host runs as a `child_process.fork`-spawned process (chapter [06](./06-pty-snapshot-delta.md) §1); the boundary is forever-stable so v0.4 per-principal helper-process drops privileges with `setuid` at fork time additively. Any v0.4 PR that re-introduces `new Worker(...)` for a pty-host is rejected; the change-set would also re-open the daemon-process address-space-corruption vector that v0.3 deliberately closed.

If a v0.4 PR needs to do any of the above, the v0.3 design picked the wrong shape and we go back to spec — **inside v0.3, before v0.3 ships**. Per brief: "these mean the v0.3 design picked the wrong shape and MUST be reworked inside v0.3."

### 4. Sub-decisions made by author (review-attention items)

The brief locked the high-altitude shape; the following sub-decisions were made by this author and SHOULD receive specific reviewer scrutiny:

1. **Child processes (NOT worker_threads) for PTY hosts** ([06](./06-pty-snapshot-delta.md) §1) — **DECIDED** (F3): one `child_process.fork`-spawned pty-host per session. Brief did not mandate; F3 chose the process boundary so a memory-corruption bug in `node-pty` / native deps cannot take down the daemon, and so v0.4 per-principal helper-process gets uid drop additively (no boundary reshape). Risk: IPC overhead vs zero-copy `postMessage`; F3's spike `[child-process-pty-throughput]` (replacing the prior `[worker-thread-pty-throughput]`) validates throughput is acceptable for ship-gate (c)'s 250 MB / 60 min budget. Reviewer audit complete; this is now a forever-stable boundary v0.4 must not flatten back into the daemon process. <!-- F3: closes R0 04-P0.4 / R0 06-P0.1 / R0 15-P1.1 -->
2. **SnapshotV1 custom binary format with zstd from day one** ([06](./06-pty-snapshot-delta.md) §2) — **DECIDED** (F3): outer wrapper carries `codec` byte (`1` = zstd default; `2` = gzip for browser-native `DecompressionStream`); inner layout is the byte-for-byte custom binary previously specified. Brief said "schema for delta is locked" but did not lock the snapshot format. F3 ships compression in v0.3 so v0.4 NEVER needs a `schema_version=2` bump just to add compression. Risk: dual-codec test surface; covered by `pty/snapshot-codec.spec.ts` round-trip cases for both codecs. Reviewer should confirm the byte-equality test plan (spike `[snapshot-roundtrip-fidelity]`) covers compressed encode/decode round-trip. <!-- F3: closes R0 06-P0.2 / R0 15-P1.2 -->
3. **Connection descriptor JSON file** ([03](./03-listeners-and-transport.md) §3) as the Electron-daemon rendezvous. Brief did not specify. Risk: file race on first launch. Mitigation: descriptor written before Supervisor `/healthz` returns 200; Electron polls until both succeed.
4. **Single-PR big-bang Electron migration** ([08](./08-electron-client-migration.md) §1). Brief said "big-bang"; author interpreted as a single PR. Reviewer should confirm — alternative is "big-bang on a feature branch with multiple internal PRs that merge to trunk together"; either reading is consistent with the brief.
5. **Custom WiX project vs electron-builder MSI** ([10](./10-build-package-installer.md) §5.1). Marked MUST-SPIKE; not yet decided. Reviewer should confirm the spike order (do this early — it gates phase 10).
6. **macOS LaunchDaemon dedicated `_ccsm` user** ([02](./02-process-topology.md) §2.2). Brief said "not SYSTEM unless absolutely required" for Windows; author extrapolated to dedicated user on mac/linux. Reviewer should confirm.
7. **`crash-raw.ndjson` recovery file** ([09](./09-crash-collector.md) §2). Brief said SQLite-only storage; author added the raw file as a fatal-event safety net. Reviewer should confirm the file's existence is acceptable (it IS additive — v0.4 can ignore or extend).
8. **Linux daemon NOT XDG-respecting** ([07](./07-data-and-state.md) §2). Author chose `/var/lib/ccsm/` (FHS) over XDG. Reviewer should confirm — brief said "system-level (not `--user`)" which justifies but does not mandate FHS.
9. **Electron renderer transport bridge in main process** ([14 §1.6](./14-risks-and-spikes.md)) — **DECIDED** (F2): bridge ships unconditionally in v0.3 on every OS. See chapter [08](./08-electron-client-migration.md) §4.2 for the locked spec; chapter [14](./14-risks-and-spikes.md) §1.6 marks the spike as resolved. Reviewer audit complete; this is now an additive Electron-internal module v0.4 must not touch (forbidden-pattern 15 above). <!-- F2: closes R0 08-P0.3 / R5 P1-14-2 -->
10. **Phase-10 installer per-OS technology choices** (WiX MSI, pkg, deb+rpm — [10 §5](./10-build-package-installer.md)). Brief didn't lock; author chose enterprise-friendly defaults. Reviewer should confirm.

### 5. Closing rule

If at any point during stage 2 review a chapter's v0.4 delta lands in the "unacceptable" column, the chapter is sent back to author (stage 3 fixer) and the spec MUST NOT proceed to stage 5 merge. The four ship-gates from brief §11 are the ship-quality bar; this audit chapter is the design-quality bar. Both must be green.
