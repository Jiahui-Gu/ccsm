# Stage-3 Dispatch Plan (v0.3 daemon split)

Strictness gradient applied per user 2026-05-03: "有些角度可以不用太严, 重点是能跑通".

- **MUST FIX ALL**: R0 (zero-rework), R1 (feature-preservation), R4 (ship-gate verifiability)
- **PRAGMATIC**: R2 (security) — fix only real-exploitable (DNS rebinding, EoP, descriptor race, code-exec primitives). Demote theoretical PII / defensive stacking to v0.4 backlog.
- **REAL-DEATH ONLY**: R3 (reliability) — fix backpressure, SQLite recovery, daemon-crash recovery. Demote structured logging / metrics / tracing to v0.4 backlog.
- **CROSS-CHAPTER ONLY**: R5 (consistency) — fix cross-chapter contradictions that downstream dev would block on. Demote pure markdown / wording polish to P2.

ESCALATION exceptions applied:
- R2 P0s that *also* trip R0 zero-rework (env scrubbing, claude_binary_path EoP, descriptor boot_id) are upgraded — they bake in security debt v0.4 cannot fix additively.
- R5 P0 naming issues that break R0 additivity at the proto layer (Principal.uid mismatch, capture-source divergence, Hello version field count) are upgraded.

## §0 Demoted-to-v0.4-backlog (P0/P1 NOT fixed in this round)

Per strictness gradient (user 2026-05-03), the following P0/P1 are demoted out of this fixer round into v0.4 backlog. Manager will turn them into follow-up tasks AFTER v0.3 ships.

### From R2 security (theoretical, non-exploitable, or pure hardening)

- **R2 P1-04-3** crash log PII content (stack trace home dirs visible to local-user) — hardening; v0.3 single-tenant trust domain is acceptable.
- **R2 P0-09-1** crash-capture PII scrubbing (home-dir / env / JWT regex scrubber) — defensive; v0.3 local-only no-upload posture neutralizes it. v0.4 uploader must re-scrub anyway.
- **R2 P0-09-2** crash_log not principal-scoped (re-flag of R0/05-P0.1) — covered by F1 below.
- **R2 P1-06-1** raw VT delta passthrough (OSC 52 / OSC 8 / DCS / APC filter policy) — defensive; v0.3 trusts what the user runs.
- **R2 P1-06-2** snapshot scrubbing — defensive; same trust-domain argument.
- **R2 P1-06-3** worker-thread isolation memory model (v8 heap shared) — covered by R0 F1 (PTY process boundary) below.
- **R2 P1-09-1** sql redaction algorithm — wording.
- **R2 P1-09-3** WatchCrashLog rate limiter — minor hardening.
- **R2 P1-10-1** install-time per-user-vs-machine descriptor ACL — covered by R0/03 F2 (descriptor lock) below.
- **R2 P1-10-2/3/4** postinstall ACLs / system user shell pinning / native module ACL — installer hardening; can land later as installer patch.
- **R2 P1-11-1** generated proto code committed-vs-gitignored supply chain — v0.4 supply-chain hardening.
- **R2 P1-11-2** `--frozen-lockfile` for every script — minor process polish.
- **R2 P1-12-1** "no test plan exists for any security control" — meta-finding; superseded by per-control tests added inline under R4 fixers below.
- **R2 P1-12-2** adversarial claude-sim workload — defensive variant; nice-to-have.
- **R2 P1-14-1** add 6 security-shaped MUST-SPIKEs — backlog as v0.4 hardening spikes.
- **R2 P1-14-2** residual risk table additions (CVE rebuilds, parser CVEs) — process polish.
- **R2 P1-15-1/2** audit chapter security checklist + P0-blocks-merge process gate — useful but procedural; manager-handled separately.
- **R2 P0-15-1/2** audit chapter security-relevant locked decisions + security-shaped forbidden patterns — partially folded into F8 (chapter 15 fixer); deeper hardening deferred.
- **R2 P0-08-1** renderer transport bridge DNS-rebinding (Host: header / bearer-token) — covered by F2 (descriptor + bridge) below for the structural bits; per-request `Host:` allowlist deferred.

**Total demoted from R2: ~21 findings.**

### From R3 reliability (observability stack, deferrable)

- **R3 P0-09-01** structured logging spec (ndjson, log levels, per-OS destinations, rotation) — observability stack; defer to v0.4. v0.3 dogfood relies on `crash_log` + per-OS service-manager stdout capture only.
- **R3 P0-09-02** `/metrics` endpoint (Prometheus text format) — observability; defer.
- **R3 P1-03-01** HTTP/2 PING keepalive on Listener A — defer; UNAVAILABLE on broken stream + Electron reconnect already handles dead-detection at human timescale.
- **R3 P1-03-03** Health RPC on data plane — defer; Supervisor /healthz adequate for v0.3.
- **R3 P1-03-04** peer-cred transient-vs-permanent error distinction — minor.
- **R3 P1-04-01** Health RPC on data plane (dup of above).
- **R3 P1-04-02/03** PtyHeartbeat cadence in field / WatchSessions+WatchCrashLog heartbeats — observability polish.
- **R3 P1-08-01** subscription-resume contract on stream errors — implementation detail; React Query default retry covers v0.3 dogfood.
- **R3 P1-08-02** UNAVAILABLE banner UX escalation modal — UX polish. (Covered partly by R1 P1.3 — see F6.)
- **R3 P1-09-03** capture-sources list missing entries — covered by R5 F8 (capture-source unification).
- **R3 P1-10-03** installer log path predictability — installer polish.
- **R3 P1-10-04** systemd `StartLimitBurst` cap — hardening.
- **R3 P2-***  all P2 items.
- **R3 P1-12-01/02** ship-gate (b) PID-unchanged assertion + soak hang/disk-full variants — folded into F4 R4 fixers as smaller test additions only where they intersect ship-gate soundness.
- **R3 P1-13-01/02** phase 6 needs logging milestone updates — N/A once logging is deferred.
- **R3 P1-14-01** disk-full move from residual risk to normative — folded into F5 (data/state fixer).

**Total demoted from R3: ~17 findings.**

### From R5 consistency (markdown / wording polish)

- All R5 "Markdown hygiene" sub-sections across all chapters (heading skip, code-fence tags, table bolding consistency).
- R5 "Vague verbs" P1 entries that are simply "could be more pinned" — P2 demote.
- R5 "Scalability hotspots" entries that recommend session caps / stream caps — backlog.
- R5 P1-02-1 `%PROGRAMDATA%` casing — single replace_all; trivial; manager-handled or absorbed into per-chapter fixer F11.
- R5 P1-02-2 `_ccsm` UID range — installer polish.
- R5 P1-02-5/2-6/2-7 vague verbs / cross-ref additions — wording.
- R5 P1-03-3/3-4/3-5/3-6 wording / clarity additions — wording.
- R5 P1-04-3/4-4/4-6 wording (client_version dup, proto_version semantics, supervisor.proto rationale) — wording. R0 P1.1 already covers client_version dup as a fix.
- R5 P1-05-2/5-3/5-4/5-5/5-6 wording / cross-refs — wording.
- R5 P1-06-2/6-4/6-5/6-8 npm package name / endianness / constants doc — wording.
- R5 P1-07-1/7-2/7-5/7-6/7-7 path quoting / migration lock file location / verb pinning — wording.
- R5 P1-08-3 additionalArguments threat-model documentation — wording.
- R5 P1-10-4/10-5/10-6 vague verbs / NSIS mention / fallback cascade — wording.
- R5 P1-11-1/11-2/11-5/11-6/11-7 cross-refs / opt-in mechanism wording — wording.
- R5 P1-12-2/12-3/12-4/12-5 wording / CI cross-link — wording.
- R5 P1-13-1/13-2 done-criteria measurability wording — wording.
- R5 P1-14-1/14-3/14-4/14-5/14-6/14-7 spike registry phase attribution / wording — wording (the structural decision in P1-14-2 is folded into F2 below).

**Total demoted from R5: ~30 P1 wording/polish findings.**

**TOTAL DEMOTED: ~68 P0/P1 findings deferred to v0.4 backlog or manager-handled-as-wording.**

## §1 Cross-file root-cause clusters (3 fixers)

### F1 (cross-file): Principal-scoping + additivity baseline (touch chapters 04, 05, 07, 09, 15)

- **Underlying decision**: Six R0 P0s all share one root cause: v0.3 omitted `owner_id` / scope discriminators on per-principal-attributable state, then declared the v0.4 add as "additive". The add is mechanically additive but operationally a semantic shift / privacy regression. Lock the scoped shape in v0.3 from day one.
- **Findings rolled up**:
  - R0 04-P0.2 `Settings` global → needs `SettingsScope` enum + `scope` field
  - R0 04-P0.3 `CrashService.GetCrashLog` semantics shift → needs `owner_filter` field + `owner_id` column from day one
  - R0 05-P0.1 crash_log + settings principal-scoping deferred → fix in v0.3 ship `crash_log.owner_id NOT NULL`
  - R0 05-P0.2 `WatchSessions` event-bus filter implicit → add `WatchSessionsRequest.scope` enum (`OWN`/`ALL`)
  - R0 05-P0.3 `local-user` uid identity continuity → add `principal_aliases` table to `001_initial.sql` (empty in v0.3)
  - R0 07-P0.1 `crash_log` schema lacks `owner_id` → ship from day one with `daemon-self` sentinel
  - R0 07-P0.2 `settings` table is global K/V → ship `(scope, key, value)` shape with `scope = "global"` in v0.3
  - R0 07-P0.3 `principals` table missing aliases linkage → covered by 05-P0.3 fix
  - R0 09-P0.1 `crash_log` lacks owner_id (dup) → covered by 07-P0.1
  - R0 09-P0.3 NDJSON shape no owner_id → lock `"owner_id": "daemon-self"` in NDJSON line shape
  - R0 15-P0.1 audit row treats add-with-NULL as additive → revise audit verdict
  - R0 15-P0.2 audit row settings_per_principal precedence → revise audit verdict
  - R0 15-P0.3 forbidden-patterns missing behavioral-additivity items 13, 14 → add to §3
  - R2 P0-04-3 (escalated) `claude_binary_path` is code-execution primitive open to any local-user → admin-gate `UpdateSettings` for security-sensitive fields (or installer-only); inline into Settings fix here.
  - R2 P0-05-2 (escalated) crash_log+settings not principal-scoped baked in for multi-user — same root cause; F1 closes it.
  - R5 P0-09-1 (escalated) capture-source string set divergence between 04 / 09 / 05 — unify the open-set list and add `claude_spawn` / `session_restore` source.
- **Chapters touched**: 04, 05, 07, 09, 15
- **Fix shape**: One coordinated edit across all five chapters: (a) add `scope`/`owner_filter`/`owner_id` fields to relevant proto messages with `OWNER_FILTER_UNSPECIFIED` / `SETTINGS_SCOPE_GLOBAL` defaults; (b) add `crash_log.owner_id NOT NULL` and `(scope, key, value)` shape and `principal_aliases` table to `001_initial.sql`; (c) lock NDJSON line shape with `daemon-self` sentinel; (d) revise audit table rows for §10/§5/§9; (e) gate `UpdateSettings` with admin peer-cred for `claude_binary_path` (or move to installer-only); (f) unify capture-source open-set listing in chapter 09 §1 (drop "exhaustive" claim or add `claude_spawn`).
- **Sequencing**: must run BEFORE F4 (chapter 04) / F5 (chapter 07) / F6 (chapter 09) per-chapter local fixers touch the same files.

### F2 (cross-file): Listener+descriptor+transport-bridge boundary lock (touch chapters 02, 03, 07, 08, 14, 15)

- **Underlying decision**: The Listener-A / descriptor / renderer-bridge surface has six R0 P0s and three R2 P0s all pointing at the same un-locked boundary: descriptor file format + atomicity, slot-1 reservation, named-pipe SID semantics, bridge ship-or-not. Lock the whole surface in one coordinated pass.
- **Findings rolled up**:
  - R0 03-P0.1 listener slot 1 reserved by comment only → typed `RESERVED_FOR_LISTENER_B` sentinel + ESLint rule + startup assert
  - R0 03-P0.2 `Principal.cf_access = 2` reserved by comment, not `reserved` keyword (covered fully under F3 too — see)
  - R0 03-P0.3 Windows descriptor path per-user vs per-machine → lock to `%PROGRAMDATA%\ccsm\listener-a.json` unconditionally (with `BUILTIN\Users` Read ACL)
  - R0 08-P0.2 `additionalArguments` does not inject onto window → lock bootstrap to `app://ccsm/listener-descriptor.json` via `protocol.handle`, OR explicitly whitelist a single SHA-pinned `preload-descriptor.ts` exception in lint
  - R0 08-P0.3 renderer transport bridge MUST-SPIKE / SHOULD-SHIP unresolved → ship the bridge unconditionally in v0.3; add chapter 15 §3 forbidden-pattern "v0.4 MUST NOT modify `transport-bridge.ts` for web/iOS reasons"
  - R2 P0-02-3 / P0-03-4 / P0-07-1 descriptor not atomically written / no boot_id nonce / Electron-side staleness check → add atomic write (temp + rename), `boot_id` and `bind_unix_ms` fields to descriptor; Electron verifies via Supervisor `/healthz` echoing `boot_id` before sending any RPC
  - R2 P0-03-3 Supervisor `/shutdown` peer-cred path unspecified → drop loopback-TCP supervisor entirely (UDS-only) AND define explicit per-OS peer-cred + uid-allowlist for Supervisor
  - R2 P0-08-1 renderer-main bridge DNS-rebinding (structural bits — Host header allowlist deferred to v0.4) → bridge bound to UDS / named pipe (no loopback TCP for bridge↔daemon); descriptor verified via boot_id
  - R5 P0-02-1 macOS UDS path `/var/run/ccsm/daemon.sock` → SIP-safe path; pick `/var/run/com.ccsm.daemon/daemon.sock` (reverse-DNS subdir per Apple convention) or document SIP check in spike kill-criterion
  - R5 P0-03-1 two MUST-SPIKE items pick same letter "A4" / order ambiguous → pin Win attempt order (A4 → A1 → A2 → A3) in §4 table + spike registry
  - R5 P0-03-2 `BindDescriptor.kind` (socket-kind) vs descriptor `transport` (protocol+socket) vocab divergence → unify both to the 4-value `transport` enum
  - R5 P0-08-1 `lint:no-ipc` script in 3 places → canonicalize to `tools/lint-no-ipc.sh`; brief and §5h reference (not duplicate) it
  - R5 P0-08-2 renderer transport over UDS / bridge ambiguity → resolved by "ship bridge unconditionally" decision above
  - R5 P1-14-2 (escalated) renderer-h2-uds spike is accepted-fallback not spike → covered by ship-bridge decision
  - R0 03-P1.1 `makeListenerB` shape change v0.3→v0.4 → `() => null` returning RESERVED sentinel (or ship `listener-b.ts` only in v0.4 as additive new file)
  - R0 03-P1.3 `jwtBypassMarker` dead code → delete; replace with comment on `makeListenerA`'s authChain literal
- **Chapters touched**: 02, 03, 07, 08, 14, 15
- **Fix shape**: (a) Descriptor v1 schema gains `boot_id: string` and `bind_unix_ms: int64`; daemon writes atomically (temp + fsync + rename); Supervisor `/healthz` echoes `boot_id`; Electron rejects descriptor whose `boot_id != /healthz boot_id`. (b) Listener slot 1 = typed `RESERVED_FOR_LISTENER_B` sentinel with ESLint rule + startup assert. (c) Windows descriptor path = `%PROGRAMDATA%\ccsm\listener-a.json` unconditionally with `BUILTIN\Users` Read ACL. (d) macOS UDS path = `/var/run/com.ccsm.daemon/daemon.sock` (or document SIP). (e) Bridge ships unconditionally; add chapter 15 forbidden-pattern. (f) `BindDescriptor.kind` vocabulary unified with `transport` 4-value enum. (g) Supervisor UDS-only (drop loopback-TCP fallback); peer-cred via `SO_PEERCRED` linux/mac, named pipe DACL win. (h) Canonicalize `lint:no-ipc` to single `tools/lint-no-ipc.sh`. (i) Pin Win transport attempt order. (j) Delete `jwtBypassMarker`; ship `listener-b.ts` only in v0.4 (additive).
- **Sequencing**: must run BEFORE F4 (proto chapter 04, for any descriptor-relevant proto fields) and F5 (chapter 07 state) and F7 (chapter 08 electron) and F11 (chapter 14 spike registry).

### F3 (cross-file): Proto additivity mechanical enforcement (touch chapters 04, 11, 13, 15)

- **Underlying decision**: Forever-stability is the central spec promise; the only mechanical enforcer (`buf breaking`) is intentionally disabled until v0.3 tag, AND multiple "reserved-for-future" slots use `// comment` instead of protobuf's `reserved` keyword. Both gaps mean any v0.3.x patch can shift the wire schema without CI noticing. Lock both in one fixer.
- **Findings rolled up**:
  - R0 03-P0.2 `Principal.cf_access = 2` reserved via comment → use protobuf `reserved 2;` everywhere comment-only reservation appears
  - R0 04-P0.1 same as above for `Principal.kind` oneof and any other comment-only slot
  - R0 04-P0.4 PTY workers share daemon address space → take a position: either downgrade to `child_process` per session in v0.3 OR document and enforce per-principal helper-process boundary now (lock the boundary before v0.4 inherits a non-additive reshape)
  - R0 06-P0.1 worker_threads single-tenant assumption → same as 04-P0.4 (one decision)
  - R0 06-P0.2 SnapshotV1 uncompressed 7MB → ship zstd compression (or gzip via DecompressionStream for browser compat) in v0.3 from day one; no `schema_version=2` ever needed
  - R0 06-P0.3 `Attach.since_seq` no per-frame ack → ship `AckPty(session_id, applied_seq)` unary RPC + `bool requires_ack` on `AttachRequest` in v0.3 (Electron no-ops, v0.4 web/iOS use)
  - R0 04-P1.1 `client_version` duplicated in RequestMeta + HelloRequest → keep RequestMeta, remove from HelloRequest
  - R0 04-P1.3 `Hello` doesn't return Listener id → add `string listener_id = 5` to HelloResponse, populated `"A"` always
  - R0 15-P1.1/1.2 audit chapter row inconsistency for [06 §1] worker_threads + [06 §2] SnapshotV1 → revise audit verdicts to reflect the position-taking above
  - R4 P0 ch 04 `buf breaking` disabled until v0.3 tag → enable `buf breaking` against `main` from phase 1 onward (compare against merge-base SHA pre-tag, against tag post-tag); make `lock.json` SHA per `.proto` file mandatory-bumped-with-edit (CI rejects PRs that touch `.proto` without bumping `lock.json`)
  - R4 P0 ch 12 ship-gate (a) grep is unsound + no allowlist → augment grep with ESLint `no-restricted-imports` for `electron`'s `ipcMain`/`ipcRenderer`/`contextBridge` named imports; pin `.no-ipc-allowlist` file format if needed for the descriptor preload exception (if F2 picks the contextBridge whitelist path)
  - R5 P0-04-1 `Hello` field count mismatch (chapter 02 §6 wording vs proto) → fix wording in 02 to match proto (daemon enforces only `proto_min_version` from client; daemon does NOT push `min_compatible_client` back) OR add the missing field. Pick (a) per minimal-surface principle.
  - R5 P0-04-2 `client_kind` open-string-set rule not documented → add same wording as `CrashEntry.source` ("string values are open; daemon and client both tolerate unknown")
  - R5 P0-05-1 `Principal.uid` definition mismatch — chapter 03 §2 has spurious `sid` field → align chapter 03 §2 to single `uid` (Windows SID encoded as string)
- **Chapters touched**: 04, 06, 11, 12, 13, 15, 03 (just 03 §2 wording for Principal mismatch), 02 (just 02 §6 wording)
- **Fix shape**: (a) Replace every "comment-only reservation" in `.proto` files with `reserved <number>;` declarations + sibling comment naming the v0.4 intent; add `buf` lint rule. (b) Take a firm position on PTY process boundary: either `child_process` per session in v0.3 OR per-principal helper-process model, locked in chapter 06 §1. (c) Ship SnapshotV1 with mandatory zstd compression of the cell array from day one; cite browser-friendly codec choice (gzip via DecompressionStream for browser compat). (d) Add `AckPty` unary RPC + `requires_ack` field to `AttachRequest`. (e) Remove duplicate `client_version` from HelloRequest. (f) Add `listener_id` to HelloResponse. (g) Enable `buf breaking` against `main` from phase 1; mandate `lock.json` bumps. (h) Augment `lint:no-ipc` with ESLint `no-restricted-imports` rule. (i) Fix wording in chapter 02 §6 + chapter 03 §2 + chapter 15 §2 audit rows + chapter 04 §3 `client_kind` wording.
- **Sequencing**: parallel-safe with F1 if disjoint (touches chapter 04 only for proto additions / wording, chapter 06 / 11 / 12 / 13 / 15 — F1 also touches 04 but for different fields). Coordinate by F3 owning all `.proto` schema edits, F1 owning only the new `Settings`/`Crash`/`WatchSessions` field additions; F3 reviewer must merge after F1's proto fields land if they conflict — use sequential merge order: F1 merges first, then F3 rebases.

## §2 Per-chapter local fixers (9 fixers, parallel-safe after F1-F3)

### F4 (chapter 02 local) — process topology

- **P0 must-fix** (R0 + R4):
  - R0 02-P0.1 multi-user-on-one-host group `ccsm` posture — take a position in chapter 15 §3 forbidden-patterns ("v0.3 supports exactly one Electron user per host; multi-user requires v0.4 cf-access via Listener B")
  - R0 02-P0.2 daemon RPC accept-policy `UNAVAILABLE` symmetric across listeners — add structured `ErrorDetail` `code = "daemon.starting"` to chapter 04 §2 (coordinate with F3)
  - R0 02-P0.3 `shutdown` RPC asymmetry locked — add chapter 15 §3 forbidden-pattern: "Supervisor UDS is local-only; v0.4 MUST NOT expose Supervisor endpoints via Listener B" (coordinate with F8 chapter 15 fixer)
  - R4 P1 startup-ordering invariant (Listener A binds only after step 5) — add `daemon-startup-ordering.spec.ts`
  - R4 P1 shutdown contract `≤5s budget` for in-flight unary RPCs / `≤3s SIGKILL` for claude — add `daemon-shutdown.spec.ts`
  - R4 P1 `shutdown` RPC admin-only check — add `supervisor/admin-only.spec.ts`
- **P1 must-fix** (R0 escalated):
  - R0 02-P1.2 Win recovery policy after 3 crashes loses fidelity — add `failureResetPeriod` knob; document
  - R0 02-P1.3 startup ordering orphan-uid check — add validation in step 4
  - R5 P0-02-1 macOS UDS path SIP-safety — covered in F2 cross-file fixer
- **Demoted** (already in §0): R3 P1-02-01/02/03 (installer log paths, recovery actions cross-ref, daemon stdout).

### F5 (chapter 06 + 07 local) — PTY + data/state

- **P0 must-fix** (R0 + R3 + R4):
  - R0 06-P0.1/06-P0.2/06-P0.3 — covered in F3 cross-file
  - R0 06-P1.1 delta UTF-8 contract — pin `LANG=C.UTF-8` / `chcp 65001` in spawn env
  - R0 06-P1.2 segmentation cadence per-session not per-subscriber — add chapter 15 §3 forbidden-pattern
  - R0 06-P1.3 Resize-triggered snapshot coalescing — at most one per 500ms
  - R0 07-P1.1 systemd `RuntimeDirectory=ccsm` + `RuntimeDirectoryMode=0750` directives
  - R0 07-P1.2 SQLite `synchronous` configurability — move to Settings field
  - R0 07-P1.3 migration SHA256 external-tag invariant — CI fetches SHA from v0.3 release tag
  - R3 P0-07-01 (escalated, real-death) `PRAGMA integrity_check` recovery surfacing — modal-on-launch alert + `sqlite_corruption_recovered` source + write to `crash-raw.ndjson` BEFORE opening the new DB
  - R3 P1-07-03 (escalated, real-death) disk-full / I/O error in write coalescer — make the failure mode normative (write coalescer wraps in try/catch; failure → `crash_log` entry; session degrades to a `DEGRADED` state if 3 consecutive write failures; daemon process survives)
  - R3 P0-06-01 (escalated, real-death) PTY input backpressure — per-session pending-write byte cap = 1 MiB; SendInput RPC returns `RESOURCE_EXHAUSTED` when exceeded; daemon emits crash_log entry with source `pty_input_overflow`
  - R3 P1-06-02 (escalated, real-death) snapshot write failure handling — emit `crash_log` entry with source `pty_snapshot_write`; session continues to stream; in-memory ring capped at N=4096; if 3 consecutive failures, `DEGRADED` state
  - R3 P1-06-04 (escalated) worker-thread crash — pin: "worker crash → daemon kills the claude CLI for that session, marks state CRASHED, persists; user must explicitly recreate"
  - R4 P0 ch 06 SnapshotV1 encoder non-determinism unspecified — pin palette ordering ("appended in order of first appearance during canonical left-to-right top-to-bottom scan; scrollback oldest→newest then viewport top→bottom"); enumerate `modes_bitmap[8]` bit→mode mapping
  - R4 P0 ch 06 no SnapshotV1 decoder spec — pin which approach (custom decoder mutating xterm.js buffer directly, OR include the raw-VT-bytes-that-paint-the-same-screen alternative). Recommend the custom decoder approach since the chapter explicitly rejected SerializeAddon.
  - R4 P0 ch 06 daemon-restart replay untested — add `pty-daemon-restart-replay.spec.ts` (gate (b) is untestable for daemon-restart without it)
  - R4 P0 ch 07 migration immutability SHA256 lock script doesn't exist — pin the script + add `db/migration-lock.spec.ts`
  - R4 P0 ch 07 corrupt-DB recovery has no test — add `db/integrity-check-recovery.spec.ts`
  - R4 P1 ch 06 multi-attach broadcast no integration test — add `pty-multi-attach.spec.ts`
  - R4 P1 ch 06 snapshot cadence parameters not tested at extremes — add `pty/snapshot-cadence.spec.ts`
  - R4 P1 ch 06 worker-thread crash testability — pin in §1 a test-only crash-on-command branch
  - R4 P1 ch 06 daemon-restart claude-spawn-fail crash_log — add `daemon-restart-claude-spawn-fail.spec.ts`
  - R4 P1 ch 07 WAL checkpoint discipline — add `db/wal-discipline.spec.ts` + `journal_size_limit` PRAGMA
  - R4 P1 ch 07 write coalescer backpressure — pin queue cap + shed-load policy (rejects with `RESOURCE_EXHAUSTED`)
  - R4 P1 ch 07 `PRAGMA integrity_check` non-"ok" treated as failure — pin
  - R4 P1 ch 07 `cwd_state` update path — pin OSC 7 parsing source-of-truth
  - R5 P0-06-1 (escalated) SnapshotV1 grapheme cluster / combining mark loss — extend `Cell` to `{codepoint, combiners[]}` shape now OR document explicit v0.3 ship-blocker (recommend: extend now since ship-gate (c) demands binary-identical with mixed UTF-8/CJK)
  - R5 P0-07-1 (escalated) `should_be_running` column orphan — update chapter 05 §7 to read `WHERE should_be_running = 1`; document semantics
- **Demoted** (already in §0): R3 P1-06-03 multi-attach back-pressure mechanical-detail; R3 P1-06-05 ship-gate (c) byte-equality fallback if spike fails; R3 P1-07-02 WAL checkpoint policy detail; R3 P1-07-04 Electron per-user state cleanup.

### F6 (chapter 08 + 09 local) — Electron client + crash collector

- **P0 must-fix** (R0 + R1 + R4):
  - R0 08-P0.1 `app:open-external` mapping is broken / "Open raw log file" affordance broken — add `CrashService.GetRawCrashLog(stream RawCrashChunk)` to v0.3 proto (coordinate with F3); replace UI affordance with "Download raw log"
  - R0 09-P0.2 same as above — covered above
  - R1 P0.1/P0.2 overview `Goals` missing feature parity — covered by §3 brief amendment
  - R1 P0.1 chapter 04 SessionService missing rename / SDK info / importable scan — add `RenameSession` / `GetSessionTitle` / `ListProjectSessions` / `ListImportableSessions` / `ImportSession` RPCs to chapter 04 (coordinate with F3)
  - R1 P0.2 chapter 04 NotifyService missing — add `NotifyService.WatchNotifyEvents() returns (stream NotifyEvent)` + `MarkUserInput` / `SetActiveSid` / `SetFocused` setters; daemon owns decider state
  - R1 P0.3 PtyService missing CheckClaudeAvailable — add `PtyService.CheckClaudeAvailable() returns (CheckClaudeAvailableResponse)`; document clipboard via `navigator.clipboard.*`
  - R1 P0.4 SettingsService missing per-renderer prefs — extend `Settings` with `map<string, string> ui_prefs` OR add `AppStateService.{Get,Set,List}` RPC; add `Settings.detected_claude_default_model` + `Settings.user_home_path` + `Settings.locale`
  - R1 P0.5 no service for window-control / app-version / open-external — add `Settings.locale`; document Electron version comes from build-time constant
  - R1 P0.1 (chapter 08) IPC inventory in §2 missing ~25+ channels and 4 of 5 preload bridges — replace §2 inventory with actual `grep` enumeration; map every channel to one of (a) Connect RPC, (b) renderer-only, (c) explicitly-cut (acknowledge in 01 §2 non-goals)
  - R1 P0.2 (chapter 08) Settings RPC carries 3 fields; ~10+ persisted prefs dropped — covered by R1 P0.4 above (extend Settings)
  - R1 P0.3 (chapter 08) custom titlebar window controls have no Connect equivalent — add explicit "electron-main-only via additionalArguments callback" disposition; document window:* are kept as ipc handlers but excluded from lint regex (compromise) OR move titlebar to native-frame in v0.3 (UX regression)
  - R1 P0.4 (chapter 08) notify pipeline dropped — covered by R1 P0.2 above (NotifyService)
  - R1 P0.5 (chapter 08) session rename + importable scan have no RPC — covered by R1 P0.1 above
  - R1 P0.6 (chapter 08) `cwd:pick` no replacement — add `cwd:pick` as `electron-main-only` disposition
  - R0 09-P0.3 NDJSON shape `daemon-self` sentinel — covered in F1
  - R4 P0 ch 08 lint:no-ipc allowlist mechanism missing — covered by F3 ESLint augmentation
  - R4 P0 ch 08 grep is substring not aliased-import safe — covered by F3 ESLint augmentation
  - R4 P0 ch 08 verification harness step 6 doesn't test PIDs — pin mechanism: add `Session.runtime_pid` (additive at v0.3 freeze) OR pin test mechanism (`Get-Process -Id <pid>` after capturing pid via debug RPC)
- **P1 must-fix**:
  - R1 P1.1 chapter 07 no migration plan for v0.2 user data — add §4.5 "v0.2 → v0.3 user-data migration" subsection: pick (a) migrate or (b) drop with notice or (c) hybrid. Recommend hybrid (migrate sessions + crash log; drop UI prefs with first-launch banner). (Touches chapter 07 — note F5 owns chapter 07 schema; F6 owns the migration narrative section. Coordinate.)
  - R1 P1.2 daemon system service multi-user data isolation regression — acknowledge in 01 §2 non-goals OR scope settings + crash_log per-principal from day one (covered by F1)
  - R1 P1.3 daemon crash → blank screen UX undefined — §6 specifies cold-start UX when daemon unreachable: timeout → modal "ccsm daemon is not running. Try restarting the service."
  - R1 P1.4 drafts loss-on-restart — recommend `DraftService.GetDraft / UpdateDraft` RPC OR document acceptance of loss + add to 01 §2 non-goals
  - R1 P1.5 in-app updater UI deleted — pick: (a) updater IPC stays as sanctioned electron-main-only channel exempt from lint, OR (b) update prompt moves entirely to OS-level
  - R1 P1.1 chapter 09 — Sentry + SQLite two crash-reporting systems — add `Settings.sentry_enabled` boolean; chapter 09 §5 says "the existing Settings → Crash Reporting → Send to Sentry toggle is preserved and reads `Settings.sentry_enabled`"
  - R1 P1.2 chapter 09 — daemon crashes after Electron exit no signal — Settings → first-page surface "X crashes since you last looked" badge
  - R0 08-P1.1 big-bang single-PR migration — covered by F10 (release-slicing)
  - R0 08-P1.2 React Query renderer state layer — document `rpc/queries.ts` hook layer in `packages/electron/src/renderer/`; abstraction shape forever-stable
  - R0 08-P1.3 no version-skew tests for `client_kind="web"` — covered by F4/F12 R4 test additions
  - R4 P1 ch 08 `app:open-external` URL safety test — add `ui/safe-open-url.spec.ts`
  - R4 P1 ch 08 transport bridge production transport untested — covered by F2 (bridge ships) + add `bridge-roundtrip.spec.ts`
  - R4 P1 ch 08 descriptor immutable test — add `preload/descriptor-immutable.spec.ts`
  - R4 P1 ch 08 big-bang PR rollback story — feature flag in main process selecting between IPC and Connect, retained for one release (cross-ref F10)
  - R4 P1 ch 08 stream error backoff — add `rpc/reconnect-backoff.spec.ts`
  - R4 P1 ch 09 crash-raw.ndjson recovery 5 cases — add `crash-raw-recovery.spec.ts`
  - R4 P1 ch 09 capture sources table-driven — `packages/daemon/src/crash/sources.ts` exports array
  - R4 P1 ch 09 sqlite_op rate-limiting — add `crash/rate-limit.spec.ts`
  - R4 P1 ch 09 Linux watchdog `WATCHDOG=1` keepalive test — add integration test
  - R5 P1-09-4 (escalated) "Open raw log file" button inconsistent with `app:open-external` policy — covered by R0 08-P0.1 / 09-P0.2 fix above (replace with Download raw log)
- **Demoted** (already in §0): R3 P1-08-01/02/03 subscription-resume + UNAVAILABLE banner + bridge as-decision — R1 P1.3 above already covers UNAVAILABLE banner.

### F7 (chapter 04 local — proto additions only after F1+F3 land)

This is a thin fixer that exists to apply per-chapter wording fixes that don't fit F1/F3.
- **P0 must-fix**:
  - R5 P0-04-1 chapter 02 §6 wording vs proto field count for Hello — pick (a) wording fix in 02 (covered by F3) OR add field. Confirm chosen direction in chapter 04 §3.
  - R5 P0-04-2 `client_kind` open-string-set documentation — covered by F3.
- **P1 must-fix**:
  - R0 04-P1.2 `client_kind` daemon switching — add chapter 15 §3 forbidden-pattern (coordinate with F8)
  - R5 P1-04-1 `Settings` Update overwrite-vs-partial semantics — document or use `optional`
  - R5 P1-04-2 `Session.exit_code` conditional validity — use `optional int32 exit_code`
  - R5 P1-04-5 `WatchSessions` per-principal filter location — add comment block above RPC
  - R5 P1-04-7 buf breaking branch wrong (use tag) — covered by F3
  - R4 P1 open-string-tolerance test — add `proto/open-string-tolerance.spec.ts`
  - R4 P1 proto_min_version truth-table tested — add (covers chapter 02 §6 wording too)
  - R4 P1 RequestMeta required validation — pin daemon validates non-empty `request_id`
  - R4 P1 ErrorDetail roundtrip test — add `proto/error-detail-roundtrip.spec.ts`

### F8 (chapter 15 local — audit chapter)

- **P0 must-fix**:
  - R0 15-P0.1/P0.2/P0.3 — covered by F1
  - R5 P0-15-1 verdict on §9 ambiguous "none or additive" — pick: cloudflared downloaded by daemon at runtime in v0.4 → verdict = **none**
  - Re-validate every audit row after F1+F2+F3 land; revise verdicts where the underlying mechanical fix changed the additivity story
- **P1 must-fix**:
  - R0 15-P1.1 audit row [06 §1] worker_threads inconsistency — covered by F3 position-take
  - R0 15-P1.2 audit row [06 §2] SnapshotV1 inconsistency — covered by F3 (compression in v1)
  - R0 15-P1.3 audit row missing for renderer transport bridge — add row "[08 §4 / 14 §1.6] Renderer transport bridge in Electron main | unchanged (Electron-only) | **none**"
  - R0 15-P1.4 §3 forbidden-patterns item 7 update for principalKey colon — update item 7 wording
  - Add chapter 15 §3 forbidden-pattern items 13 and 14 (covered by F1)
  - Add chapter 15 §3 forbidden-pattern "Supervisor UDS local-only" (covered by F4 02-P0.3)
  - Add chapter 15 §3 forbidden-pattern "v0.4 MUST NOT modify transport-bridge.ts" (covered by F2)
  - Add chapter 15 §3 forbidden-pattern "Daemon delta segmentation cadence is per-session, not per-subscriber" (covered by F5 06-P1.2)
  - Add chapter 15 §3 forbidden-pattern "v0.4 sets its own perf budget for Listener B; v0.3 budget is forever-stable for Listener A only" (covered by F12 R4 ch 12 P1.3)
  - Add chapter 15 §3 forbidden-pattern: descriptor `transport` enum closed-set / `client_kind` daemon-MUST-NOT-switch / per-OS state directory paths locked / SnapshotV1 binary layout locked / Listener trait shape locked
  - R4 P0 ch 15 §3 forbidden-pattern list claims mechanical enforcement that doesn't exist — add tests/scripts for each item OR demote language from "mechanical" to "human review checklist". Recommend: add tests for items 1-2 (proto additivity), 4 (migration SHA256 — covered by F5), 5 (SnapshotV1 layout), 6 (listener array length), 7 (principalKey format string), 8 (descriptor v1 schema), 9 (Supervisor URLs), 11 (lint:no-ipc — covered by F3). Demote items 3 (semantic-meaning of fields, can't be mechanical), 10 (packages/ shape — light test), 12 (state dir paths — light test).

### F9 (chapter 10 + 11 local — installer + monorepo)

- **P0 must-fix** (R4):
  - R4 P0 ch 10 native module test plan for per-OS sea bundle — add `tools/sea-smoke/` script run in `e2e-installer-*` jobs (run actual built `ccsm-daemon`, `/healthz` 200, Hello, create session, assert PTY emits "ok", stop daemon)
  - R4 P0 ch 10 code signing has no verification test — add `tools/verify-signing.{sh,ps1}` invoked in `package-*` jobs after signing (Win: `Get-AuthenticodeSignature`; mac: `codesign --verify --deep --strict` + `spctl --assess`; linux: `dpkg-sig --verify`)
  - R4 P0 ch 10 ship-gate (d) Win 11 25H2 VM no provisioning recipe — pin: who provisions, snapshot source, `Invoke-Snapshot-Restore` mechanism, network connectivity. Recommend: descope to "tested on operator-provisioned self-hosted runner; provisioning lives in `infra/win11-runner/` repo; chapter 11 §6 references."
  - R5 P0-10-1 (escalated) macOS notarization fallback path — pre-resolve [macos-notarization-sea] before stage-6 OR ship both code paths and pick at install time. Recommend: pre-resolve in phase 0; if rejected, document fallback impact in chapter 10 §1 / §2 / §6 explicitly
- **P1 must-fix**:
  - R2 P0-10-1 (escalated, real-exploitable) no update flow specified → service-running binary swap undefined — pin update flow: (a) stop service with timeout + SIGKILL fallback, (b) replace binary, (c) restart, (d) rollback on `/healthz` failure. Lock in chapter 10 new §6.
  - R2 P0-10-2 (escalated) installer-time integrity verification — mandate post-extract pre-register signature verification (covered by R4 P0 verify-signing script above)
  - R4 P1 ch 10 installer step 7 `/healthz` failure mode — pin behavior; add test variant
  - R4 P1 ch 10 uninstaller MSI-silent prompt — pin silent default + public property name (`REMOVEUSERDATA=1`); ship-gate (d) tests both variants
  - R4 P1 ch 10 cross-arch arm64 native test runner — pin which arm64 builds get smoke-tested vs cross-built-only
  - R4 P1 ch 10 mac pkg uninstaller test — add `installer-roundtrip.sh` for mac
  - R4 P1 ch 10 MSI service-install fallback test — pin `sc qfailure` / `sc qsidtype` checks
  - R4 P1 ch 11 CI matrix sketch holes — pin: install job artifact share, Turborepo cache key, `cron:` block for nightly schedules, self-hosted runner labels (cross-ref R4 P0 ch 10 above)
  - R4 P1 ch 11 ESLint no-restricted-imports rule body — inline the rule snippet
  - R4 P1 ch 11 Changesets version drift — add CI check `daemon's PROTO_VERSION constant >= last release's PROTO_VERSION`
  - R5 P1-10-1 WiX 4 vs electron-builder MSI builder MUST-SPIKE — pin spike id `[msi-tooling-pick]` (cross-ref F11)
  - R5 P1-10-2 (escalated) `node-windows` vs `sc.exe` vs WiX `<ServiceInstall>` 3-option contradiction across chapter 02 / 10 — pick WiX `<ServiceInstall>` and align both chapters
  - R5 P1-10-3 CI build matrix mac/linux installer e2e — explicitly state "v0.3: only win e2e installer in CI; mac/linux smoke tested manually pre-tag"
  - R5 P1-11-3 generated proto code path local-dev bootstrap — document or wire `gen` as `build` dep
  - R5 P1-11-4 ESLint rule body — inline (covered above)

### F10 (chapter 13 local — release slicing)

- **P0 must-fix**:
  - R5 P0-13-1 phase 8 single PR sub-deliverables sprawl — split into 8a (proto-client wiring + transport bridge + descriptor reader, no behavior change), 8b (big-bang IPC removal cutover), 8c (cleanup + lint gate). Coordinate with R4 P1 ch 08 rollback story.
  - R5 P0-13-2 phase 11(b) DAG deps inconsistent — pin: 11(b) depends on phases 4, 5, 8, 9
  - R5 P0-13-3 phase ordering omits tooling spike pre-phase — add explicit Phase 0.5 (transport spikes), Phase 4.5 (PTY worker spike), Phase 9.5 (build/notarization spikes); OR fold spikes into phase 0 + extend done-criteria
- **P1 must-fix**:
  - R4 P1 phase 0 ">0% cache" meaningless — pin "≥80% cache hit on no-op rebuild"
  - R4 P1 phase 5 ship-gate (c) gap from listed tests — add "10-minute soak smoke" as faster proxy
  - R4 P1 phase 11 procedure for "all four green on the same commit" — add `tools/release-candidate.sh`
  - R4 P1 phase 12 dogfood "no architectural regression PRs" measurability — define labels + auto-check
  - R4 P1 phase 8 merge ordering — pin: 4 → 5 → 6 → 7 sequential, 8 stacks last

### F11 (chapter 14 local — risks + spikes)

- **P0 must-fix**:
  - R4 P0 ch 14 [renderer-h2-uds] is accepted-fallback not spike — covered by F2 (ship bridge unconditionally); update spike registry to mark resolved
  - R4 P0 ch 14 [watchdog-darwin-approach] is accepted-non-feature — mark explicitly as "deferred to v0.4; not a v0.3 must-spike" and remove from register, OR define hang-detection mechanism v0.3 ships on macOS (recommend the former; add to chapter 09 §6 as "macOS hang detection deferred to v0.4 hardening")
- **P1 must-fix**:
  - R4 P1 spike repro recipes incomplete — fix [win-localservice-uds] / [worker-thread-pty-throughput] / [snapshot-roundtrip-fidelity] / [sea-on-22-three-os] / [macos-notarization-sea] with concrete recipes
  - R4 P1 "escalate to user before adopting" pseudo-fallbacks — add real fallback design rework descriptions
  - R4 P1 listener-a transport spike outcomes don't compose — add per-OS decision matrix table at end of §1
  - R4 P1 spike harness reusability — pin `tools/spike-harness/` directory
  - R5 P1-14-2 [renderer-h2-uds] resolution — covered above
  - Add `[msi-tooling-pick]` spike id (cross-ref F9 R5 P1-10-1)

### F12 (chapter 12 local — testing strategy)

- **P0 must-fix**:
  - R4 P0 ch 12 ship-gate (a) grep + allowlist + ESLint backstop — covered by F3 (canonicalize via tools/lint-no-ipc.sh + ESLint `no-restricted-imports`)
  - R4 P0 ch 12 ship-gate (b) doesn't verify "no data loss" — add explicit byte-equality assertion at end (encode daemon-side terminal state via SnapshotV1; encode client-side state via SnapshotV1; `Buffer.compare === 0`)
  - R4 P0 ch 12 ship-gate (c) comparator + workload incomplete — pin SnapshotV1 encoder determinism (covered by F5); pin workload class enumeration including OSC sequences (window title), DECSTBM scroll regions, mouse mode toggles, resize-during-burst
  - R4 P0 ch 12 ship-gate (d) no real residue diff — replace fixed-list checks with file-tree + registry diff (snapshot pre-install / post-uninstall, diff allowing only documented allowlist); state explicitly mac/linux do not have ship-gate (d) equivalent in v0.3
  - R5 P0-12-1 ship-gate (c) test naming/extension inconsistency — pick `.spec.ts` everywhere; canonical test name `pty-soak-1h` at `packages/daemon/test/integration/pty-soak-1h.spec.ts`
  - R5 P0-12-2 ship-gate (b) test file path 08 §7 missing path — add file path
  - R5 P0-12-3 claude-sim language pick — recommend Go (cross-platform-cross-arch ease); pin in §5 + chapter 11 §2
- **P1 must-fix**:
  - R4 P1 ch 12 ship-gate (c) non-blocking-PR procedure — pin release procedure (covered by F10)
  - R4 P1 ch 12 ship-gate (b) per-PR vs nightly process-group — spawn daemon as real subprocess in per-PR variant
  - R4 P1 ch 12 property-based test for delta replay invariant — add `pty/replay-invariant.property.spec.ts`
  - R4 P1 ch 12 claude-sim build path / source language — covered above
  - R4 P1 ch 12 coverage thresholds enforcement — state explicitly
  - R4 P1 ch 12 perf budgets do NOT block PRs — gate `SendInput` p99 budget via gate (c) sampled-during-soak
  - R4 P1 ch 12 peer-cred-rejection test platform requirement — pin runner constraints
  - R4 P1 ch 12 listener B negative-path test — add `bundle/no-jwt-in-v03.spec.ts`
  - R4 P1 ch 12 transport matrix test — add `rpc/clients-transport-matrix.spec.ts`
  - R5 P1-12-1 per-RPC integration coverage gaps — add Resize / GetCrashLog / SettingsService error-path tests
  - R5 P1-12-2 peer-cred-rejection two scenarios — pin both

## §3 Brief amendment (manager-handled, NOT a fixer)

R1 P0.1 / P0.2 want v0.2 feature-parity goal added to brief. Manager edits 00-brief.md adding:

- **Goal §1.8**: "Feature parity with v0.2. Every user-visible feature in v0.2 is preserved or has its loss explicitly enumerated in §2 (non-goals). Acceptance test: the dogfooded user notices nothing different except daemon-survives-Electron-restart and daemon survives logout."
- **Ship-gate §11(e)**: "v0.2 feature-parity check. Tester runs the v0.2-feature-checklist (rename / SDK titles / import / notify pipeline / titlebar controls / cwd picker / drafts / theme persistence / updater UI / clipboard) against v0.3 build; every item passes or is explicitly marked dropped in §2 non-goals."
- **Non-goal §2 second table**: "v0.2 features intentionally dropped in v0.3 (re-added later)" — populated after F6 chapter 08 §3 mapping completes; manager adds rows for each "explicitly-cut" disposition F6 produces.
- **Glossary §6 entry**: "v0.2 baseline = the Electron-only single-process app shipped at tag v0.2.0 (commit X). Reviewers SHOULD treat this commit as the feature reference for v0.3 parity."
- **Brief §11(d) clarification** (R4 P1 brief finding): "v0.3 ship requires gate (d) only on Windows; mac/linux installers are tested manually before release; results posted to release notes."
- **Brief §11(a) clarification** (R4 P1 brief finding): "no allowlist for `lint:no-ipc`; the gate is unconditional after phase 8c cleanup; if a sanctioned non-IPC main↔renderer channel is needed (window controls / updater / file picker), it goes through the descriptor injection mechanism, not `ipcMain.handle` / `contextBridge`."

## §4 Dispatch matrix (final)

| Fixer | Scope | Chapters | P0 closing | P1 closing | Sequencing |
|---|---|---|---|---|---|
| F1 | Principal-scoping + additivity baseline | 04, 05, 07, 09, 15 | ~14 (R0×11 + R2×2 + R5×1) | ~3 | sequential first |
| F2 | Listener+descriptor+transport-bridge boundary | 02, 03, 07, 08, 14, 15 | ~12 (R0×4 + R2×4 + R5×4) | ~5 | parallel with F1 (touches mostly different files; coordinate on chapter 07 + 15) |
| F3 | Proto additivity mechanical enforcement | 04, 06, 11, 12, 13, 15 + wording-only edits in 02, 03 | ~10 (R0×6 + R4×2 + R5×3 — escalated R5 P0-05-1 lives here for the Principal.uid alignment) | ~5 | sequential after F1 (proto field number coordination) |
| F4 | Chapter 02 local | 02 | ~3 R0 + ~3 R4 | ~3 | parallel after F1+F2+F3 |
| F5 | Chapter 06 + 07 local | 06, 07 | ~12 (R0×3 + R3×4 + R4×4 + R5×2 escalated) | ~10 | parallel after F1+F2+F3 |
| F6 | Chapter 08 + 09 local | 08, 09 (and adds RPCs to 04 — coordinate with F3) | ~12 (R0×3 + R1×9) | ~12 (R1×5 + R4×7 + R5×1) | parallel after F1+F2+F3 |
| F7 | Chapter 04 wording + remaining R0 P1 | 04 | ~2 R5 | ~5 | parallel after F1+F3 |
| F8 | Chapter 15 audit chapter | 15 | ~4 (R0×3 already in F1, R5 P0-15-1 + revalidation, R4 P0 mechanical-enforcement gap) | ~5 | sequential AFTER F1+F2+F3+F4+F5+F6 land (audit chapter mirrors all upstream changes) |
| F9 | Chapter 10 + 11 local | 10, 11 | ~5 (R4×3 + R5×1 + R2×2 escalated) | ~10 | parallel after F1+F2+F3 |
| F10 | Chapter 13 release slicing | 13 | ~3 R5 | ~5 R4 | parallel after F1+F2+F3+F6 (phase 8 split needs F6 disposition) |
| F11 | Chapter 14 risks + spikes | 14 | ~2 R4 | ~5 | parallel after F2 (renderer-h2-uds resolution) |
| F12 | Chapter 12 testing strategy | 12 | ~7 (R4×4 + R5×3) | ~10 R4 | parallel after F1+F2+F3+F5+F6 (test surfaces depend on chapter changes) |
| (brief) | Manager-edit | 00-brief.md | (n/a) | (n/a) | manager-handled, parallel with all fixers |

**Total fixers: 12** (F1–F12).
**Total P0 closed in this round: ~85** (R0 P0 × ~30 + R1 P0 × 10 + R4 P0 × 18 + R5 P0 × 10 + R2 P0 escalated × 8 + R3 P0 escalated × 4, with overlap consolidated by F1/F2/F3 cross-file fixers).
**Total P1 closed in this round: ~70**.
**Total demoted: ~68 P0/P1** (R2 × 21 + R3 × 17 + R5 × 30 wording).

## §5 Re-review plan (stage 4 round 2)

Per strictness gradient, round 2 only re-runs:

- **R0 (full)** — every chapter; verify zero-rework holes are closed
- **R1 (full)** — every chapter; verify v0.2 feature parity goal + non-goal table populated; verify SessionService / NotifyService / SettingsService / etc. proto additions present
- **R4 (full)** — every chapter; verify all four ship-gates mechanically sound after F12 + F3 land
- **R2 real-exploitable subset only** — must confirm closed:
  - Descriptor `boot_id` + atomic write (F2)
  - Supervisor UDS-only (F2)
  - `claude_binary_path` admin-gated or installer-only (F1)
  - PTY worker process boundary (F3)
  - Code-signing verification at install time (F9)
  - Update flow specified (F9)
  - DNS-rebinding (bridge UDS-only — F2)
  - PID-recycling (covered by descriptor + UDS choices — F2)
- **DO NOT re-run R3 / R5 detail scans** — only spot-check R5 cross-chapter consistency on the unified vocabularies (`transport` enum, `principalKey`, capture-source list, `lint:no-ipc` script).
