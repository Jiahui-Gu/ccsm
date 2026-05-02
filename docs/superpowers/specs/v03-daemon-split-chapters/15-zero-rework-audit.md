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
| §4 | PTY xterm-headless emits snapshot AND delta; delta schema locked | New web/iOS clients call same `PtyService.Attach`; daemon broadcasts to N subscribers (already supported). Snapshot/delta wire formats forever-stable; SnapshotV1 retained; v0.4 may add `schema_version=2` (e.g., zstd) additively. | **additive** |
| §5 | Session bound to `Principal` (`owner_id`) from day one; v0.3 only `local-user` from peer-cred | New `cf-access:<sub>` principal kind ADDED as new oneof variant + new middleware on Listener B. `principalKey` format unchanged. `Session.owner_id` column unchanged. `assertOwnership` unchanged (still string compare). | **additive** |
| §6 | Proto scope: forever-stable existing messages; only additive in v0.4 | New RPCs / messages ADDED in new files OR appended to existing services with new field numbers. `buf breaking` gate enforces. | **additive** |
| §7 | Daemon = system service per OS; survives logout (LaunchDaemon, not LaunchAgent) | LaunchDaemon choice already supports v0.4 web/iOS reaching daemon while user logged out. No service shape change. cloudflared subprocess ADDED to daemon supervision. | **additive** |
| §8 | Monorepo `packages/{daemon, electron, proto}`; pnpm + Turborepo | ADD `packages/web`, `packages/ios`, optionally `packages/cloudflared-config`. Existing packages unchanged. Workspace tool unchanged. | **additive** |
| §9 | Node 22 sea single binary per OS; native deps via `native/` sidecar | sea pipeline unchanged; `native/` may grow if v0.4 needs new natives (currently doesn't — JWT validation is pure JS via `jose`). | **none** (or **additive** if cloudflared is bundled in install dir) |
| §10 | Crash collector local-only; SQLite log table; `GetCrashLog` RPC | ADD `crash_log.owner_id`, `crash_log.uploaded_at` columns (NULL-tolerant). ADD `CrashService.UploadCrashLog` RPC. ADD upload UI in Settings. Capture path unchanged. | **additive** |
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
| [03 §6](./03-listeners-and-transport.md) | `makeListenerB` throws in v0.3; comment marks the slot | v0.4 removes `throw`, uncomments line, adds JWT validator module | **additive** |
| [03 §7](./03-listeners-and-transport.md) | Supervisor UDS: `/healthz`, `hello`, `shutdown` HTTP | unchanged | **none** |
| [04 §2](./04-proto-and-rpc-surface.md) | `Principal` oneof; `LocalUser` shape | ADD `CfAccess` variant; `LocalUser` unchanged | **additive** |
| [04 §2](./04-proto-and-rpc-surface.md) | `RequestMeta`, `ErrorDetail`, `SessionState` enum | unchanged forever | **none** |
| [04 §3-6](./04-proto-and-rpc-surface.md) | every RPC and message | new RPCs / fields ADDED; existing untouched | **additive** |
| [04 §8](./04-proto-and-rpc-surface.md) | additivity contract enforced via `buf breaking` | enforced in v0.4 too | **none** |
| [05 §1](./05-session-and-principal.md) | `principalKey` format `kind:identifier` | new `cf-access:<sub>` keys; format unchanged | **additive** |
| [05 §4](./05-session-and-principal.md) | `assertOwnership` early return | gains optional admin clause; existing logic unchanged | **additive** |
| [05 §5](./05-session-and-principal.md) | Crash log + Settings open to any local-user in v0.3 | crash_log gains `owner_id`; settings gains per-principal table — existing rows valid as global | **additive** |
| [05 §7](./05-session-and-principal.md) | Restored sessions trust recorded `owner_id` | unchanged | **none** |
| [06 §1](./06-pty-snapshot-delta.md) | One worker_threads worker per session; main thread coalesces SQLite | unchanged | **none** |
| [06 §2](./06-pty-snapshot-delta.md) | SnapshotV1 binary format with `magic="CSS1"`, `schema_version=1` | new schemas use `schema_version=2+`; v1 retained forever | **additive** |
| [06 §3](./06-pty-snapshot-delta.md) | Delta payload = raw VT bytes; segment at 16ms/16KiB | unchanged | **none** |
| [06 §4](./06-pty-snapshot-delta.md) | Snapshot cadence parameters K/M/B | unchanged; tunable per-session by future per-principal config (additive) | **additive** |
| [06 §5](./06-pty-snapshot-delta.md) | Reconnect decision tree | unchanged | **none** |
| [06 §6](./06-pty-snapshot-delta.md) | Multi-attach broadcast | already supports N subscribers; v0.4 web/iOS use unchanged | **none** |
| [07 §1](./07-data-and-state.md) | better-sqlite3, WAL, NORMAL synchronous | unchanged | **none** |
| [07 §2](./07-data-and-state.md) | Per-OS state directory paths | unchanged | **none** |
| [07 §3](./07-data-and-state.md) | All v0.3 tables and columns | new tables and new columns ADDED via new migration files; v0.3 columns retained | **additive** |
| [07 §4](./07-data-and-state.md) | Migration files immutable post-ship; SHA256 in `locked.ts` | enforced in v0.4 too | **none** |
| [07 §6](./07-data-and-state.md) | No automated backup in v0.3 | v0.4 adds optional automated backup as additive feature | **additive** |
| [08 §3](./08-electron-client-migration.md) | IPC → Connect 1:1 mapping table | new RPCs added in v0.4 are wired via new mapping rows (additive); existing mappings unchanged | **additive** |
| [08 §4](./08-electron-client-migration.md) | Descriptor injected via `additionalArguments`; no `contextBridge` for callable APIs | unchanged; same `lint:no-ipc` gate | **none** |
| [08 §6](./08-electron-client-migration.md) | Renderer error contract (UNAVAILABLE, FailedPrecondition, etc.) | unchanged | **none** |
| [09 §1](./09-crash-collector.md) | Capture sources list + `source` open string set | new sources added freely; existing unchanged | **additive** |
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

If a v0.4 PR needs to do any of the above, the v0.3 design picked the wrong shape and we go back to spec — **inside v0.3, before v0.3 ships**. Per brief: "these mean the v0.3 design picked the wrong shape and MUST be reworked inside v0.3."

### 4. Sub-decisions made by author (review-attention items)

The brief locked the high-altitude shape; the following sub-decisions were made by this author and SHOULD receive specific reviewer scrutiny:

1. **Worker threads (not child processes) for PTY hosts** ([06](./06-pty-snapshot-delta.md) §1). Brief did not mandate; chosen for zero-copy buffer transfer. Risk: a worker crash is contained but workers share the daemon process address space — a memory corruption is fatal. Spike [worker-thread-pty-throughput] validates throughput; does NOT validate isolation. Reviewer should consider mandating `child_process` per session if isolation outweighs perf.
2. **SnapshotV1 custom binary format** ([06](./06-pty-snapshot-delta.md) §2). Brief said "schema for delta is locked" but did not lock the snapshot format. Author chose a custom binary over xterm SerializeAddon. Risk: custom format = more code to test. Reviewer should confirm the byte-equality test plan (spike [snapshot-roundtrip-fidelity]) is sufficient.
3. **Connection descriptor JSON file** ([03](./03-listeners-and-transport.md) §3) as the Electron-daemon rendezvous. Brief did not specify. Risk: file race on first launch. Mitigation: descriptor written before Supervisor `/healthz` returns 200; Electron polls until both succeed.
4. **Single-PR big-bang Electron migration** ([08](./08-electron-client-migration.md) §1). Brief said "big-bang"; author interpreted as a single PR. Reviewer should confirm — alternative is "big-bang on a feature branch with multiple internal PRs that merge to trunk together"; either reading is consistent with the brief.
5. **Custom WiX project vs electron-builder MSI** ([10](./10-build-package-installer.md) §5.1). Marked MUST-SPIKE; not yet decided. Reviewer should confirm the spike order (do this early — it gates phase 10).
6. **macOS LaunchDaemon dedicated `_ccsm` user** ([02](./02-process-topology.md) §2.2). Brief said "not SYSTEM unless absolutely required" for Windows; author extrapolated to dedicated user on mac/linux. Reviewer should confirm.
7. **`crash-raw.ndjson` recovery file** ([09](./09-crash-collector.md) §2). Brief said SQLite-only storage; author added the raw file as a fatal-event safety net. Reviewer should confirm the file's existence is acceptable (it IS additive — v0.4 can ignore or extend).
8. **Linux daemon NOT XDG-respecting** ([07](./07-data-and-state.md) §2). Author chose `/var/lib/ccsm/` (FHS) over XDG. Reviewer should confirm — brief said "system-level (not `--user`)" which justifies but does not mandate FHS.
9. **Electron renderer transport bridge in main process** ([14 §1.6](./14-risks-and-spikes.md)) is recommended for predictability across all OSes. Reviewer should decide whether to ship the bridge unconditionally (ship as part of phase 8).
10. **Phase-10 installer per-OS technology choices** (WiX MSI, pkg, deb+rpm — [10 §5](./10-build-package-installer.md)). Brief didn't lock; author chose enterprise-friendly defaults. Reviewer should confirm.

### 5. Closing rule

If at any point during stage 2 review a chapter's v0.4 delta lands in the "unacceptable" column, the chapter is sent back to author (stage 3 fixer) and the spec MUST NOT proceed to stage 5 merge. The four ship-gates from brief §11 are the ship-quality bar; this audit chapter is the design-quality bar. Both must be green.
