# ch15 §3 forbidden-pattern enforcement audit

Audited: 2026-05-03 by Task #230 (research-only; no enforcement code added in this PR).

Source of truth: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
chapter 15 §3 "Forbidden patterns (mechanical reviewer checklist)" — items 1-29 inclusive.

## Summary

- **Total forbidden patterns**: 29 (P1-P29)
- **COVERED** (enforcement file/rule exists on disk): 21
- **PARTIAL** (some enforcement exists; spec-cited backstop missing): 4
- **GAP** (no enforcement on disk): 4
- **Sub-tasks proposed**: 8 (§4 below)

### tl;dr table

| # | Pattern (1-line) | Status |
| --- | --- | --- |
| P1  | Remove/rename .proto field/message/enum/RPC | PARTIAL |
| P2  | Reuse .proto field number | PARTIAL |
| P3  | Change meaning of existing .proto field | COVERED (human review + smoke) |
| P4  | Modify v0.3 SQL migration file | PARTIAL |
| P5  | Change SnapshotV1 binary layout | COVERED |
| P6  | Reshape Listener trait / slot array length / index meaning | COVERED |
| P7  | Rename principalKey format / colon-split rule | GAP |
| P8  | Change listener-a.json v1 field meanings | COVERED |
| P9  | Change Supervisor HTTP endpoint URLs / response shapes | COVERED |
| P10 | Reshuffle packages/ directories | COVERED |
| P11 | Bypass lint:no-ipc gate | COVERED |
| P12 | Change per-OS state directory paths | COVERED |
| P13 | v0.4 add mandatory non-NULL column to v0.3 table | GAP |
| P14 | v0.4 reshape WatchSessions/GetCrashLog/etc. request semantics | PARTIAL |
| P15 | Modify electron transport-bridge.ts for web/iOS reasons | GAP |
| P16 | Add loopback-TCP fallback for Supervisor | COVERED |
| P17 | Add new value to BindDescriptor.kind / listener-a.json.transport enum | COVERED |
| P18 | Write to listeners[1] from non-listener-b.ts source | COVERED |
| P19 | Remove/renumber .proto fields; comment-only reserved slots | COVERED (proto-side) |
| P20 | Add new Principal.kind oneof at non-reserved slot | COVERED |
| P21 | Bump SnapshotV1 schema_version to add compression | COVERED |
| P22 | Remove PtyService.AckPty or AttachRequest.requires_ack | COVERED |
| P23 | Touch .proto without bumping packages/proto/lock.json SHA256 | COVERED (in-repo); CI gate missing |
| P24 | Branch daemon behavior on HelloRequest.client_kind / HelloResponse.listener_id | GAP |
| P25 | Pivot PTY per-session boundary back into worker_threads | GAP |
| P26 | Per-subscriber delta segmentation knobs | COVERED |
| P27 | Re-tune Listener-A perf budget for v0.4 reasons | COVERED |
| P28 | Rename ship-gate (c) test file path | COVERED (path used by integration test) |
| P29 | Mutate v0.3 tools/.no-ipc-allowlist contents | COVERED |

### Meta-finding (cross-cutting, raised separately)

The enforcement files for items P1, P2, P4, P5, P6, P8, P9, P12, P19, P21,
P22, P23, P26, P28 live under `packages/{proto,daemon}/test/` but the
**root `.github/workflows/ci.yml` does not invoke `turbo run test`,
`pnpm -r test`, or `npx vitest run --config tools/vitest.config.ts`** —
only `npm run test:app` (root vitest) which scopes to `tests/**` and
`electron/**/__tests__/**`. Likewise `pnpm --filter @ccsm/proto run breaking`
(buf-breaking) and `tools/check-migration-locks.sh` are not present in
any workflow file. Spec ch12 §2 explicitly requires the buf-breaking job
"active from phase 1 onward, not deferred until ship."

This means the on-disk specs are correct (so each item below is technically
COVERED in source), but **none of them actually run on PRs today**. This is a
single root-cause fix (one CI workflow edit) that closes 14 items at once,
and is proposed as **P-META** in §4.

## Detail

### P1 — Removing or renaming .proto field/message/enum/RPC
- Forbidden: ch15 §3 item 1.
- Status: PARTIAL.
- Enforcement: `packages/proto/lock.json` SHA256 lock + `packages/proto/test/lock.spec.ts` catch any byte change. `protoc-gen-buf-breaking` is in `package-lock.json` (line 438) but no CI step runs it.
- Gap: spec-cited mechanism `buf breaking against the merge-base SHA pre-tag and against the v0.3 release tag post-tag` has no `.github/workflows/*` invocation. Renames that don't change SHA still slip past lock.spec.ts (the SHA changes when bytes change, but lock-bump is a one-PR operation).

### P2 — Reusing a .proto field number
- Forbidden: ch15 §3 item 2.
- Status: PARTIAL.
- Enforcement: `reserved <number>;` keyword used in `packages/proto/src/ccsm/v1/{common,session,settings}.proto` (`protoc` rejects re-use at parse time, executed by `pnpm --filter @ccsm/proto run gen`). `packages/proto/test/lock.spec.ts` catches accidental edits.
- Gap: same as P1 — `buf breaking` not in CI.

### P3 — Changing the meaning of an existing .proto field
- Forbidden: ch15 §3 item 3.
- Status: COVERED (per spec — explicitly "human review with reference test as smoke check"; mechanical detection is not possible).
- Enforcement: `packages/proto/test/contract/error-detail-roundtrip.spec.ts`, `packages/proto/test/contract/open-string-tolerance.spec.ts`. Spec acknowledges these catch wire-shape regressions but not semantic reinterpretation.

### P4 — Modifying any v0.3 SQL migration file (001_initial.sql)
- Forbidden: ch15 §3 item 4.
- Status: PARTIAL.
- Enforcement: `packages/daemon/src/db/locked.ts` (SHA256 constants), `packages/daemon/test/db/migration-lock.spec.ts` (in-vitest spec), `tools/check-migration-locks.sh` (CI-side script).
- Gap: `tools/check-migration-locks.sh` is not invoked from any `.github/workflows/*` file. The vitest spec lives under `packages/daemon/test/` which CI does not run today. The runtime self-check in `locked.ts` only fires on daemon boot, not in CI.

### P5 — Changing SnapshotV1 binary layout
- Forbidden: ch15 §3 item 5.
- Status: COVERED.
- Enforcement: `packages/daemon/test/pty/snapshot-codec.spec.ts` + `packages/daemon/test/fixtures/` golden binaries (per spec; verify test exists — file is present).

### P6 — Reshaping Listener trait or slot array length / index meaning
- Forbidden: ch15 §3 item 6.
- Status: COVERED.
- Enforcement: `packages/daemon/src/listeners/__tests__/array-shape.spec.ts`; `packages/daemon/src/listeners/types.ts` `as const` tuple type; ESLint rule `ccsm/no-listener-slot-mutation` at `packages/daemon/eslint-plugins/ccsm-no-listener-slot-mutation.js` + tests at `packages/daemon/eslint-plugins/__tests__/no-listener-slot-mutation.spec.ts`.

### P7 — Rename principalKey format / change colon-split rule
- Forbidden: ch15 §3 item 7. Spec requires the parser to use `principalKey.indexOf(':')` not `split(':')[0/1]`, and to round-trip `cf-access:auth0|abc:def`.
- Status: GAP.
- Enforcement: only formatter-side test exists (`packages/daemon/src/auth/__tests__/principal.spec.ts`). No `parsePrincipalKey` function exists in `packages/daemon/src/auth/principal.ts`, and no test asserts the first-colon-only split rule on values containing colons.
- Note: v0.3 ships only `local-user:<uid>` (no embedded colons in practice except Windows SIDs which contain `-`, not `:`), but the spec requires the parser+test to ship in v0.3 so v0.4 can add `cf-access:<sub-with-colons>` purely additively.

### P8 — Changing listener-a.json v1 field meanings
- Forbidden: ch15 §3 item 8.
- Status: COVERED.
- Enforcement: `packages/daemon/test/descriptor/schema.spec.ts` validates against the v1 JSON Schema at `packages/daemon/schemas/listener-a.schema.json` (per ch03 §3.2 / spec).

### P9 — Changing Supervisor HTTP endpoint URLs or response shapes
- Forbidden: ch15 §3 item 9.
- Status: COVERED.
- Enforcement: `packages/daemon/test/supervisor/contract.spec.ts` + `packages/daemon/test/supervisor/golden/` checked-in JSON bodies. The spec file's header explicitly references item #9.

### P10 — Reshuffling packages/ directories (only additions allowed)
- Forbidden: ch15 §3 item 10.
- Status: COVERED.
- Enforcement: `tools/packages-shape.spec.ts` (header explicitly cites ch15 §3 #10).

### P11 — Bypassing lint:no-ipc gate
- Forbidden: ch15 §3 item 11.
- Status: COVERED.
- Enforcement: `tools/lint-no-ipc.sh` invoked via `npm run lint:no-ipc` from `.github/workflows/ci.yml:108`. ESLint backstop in `packages/electron/eslint.config.js` + `packages/electron/test/eslint-backstop/eslint-backstop.spec.ts` + violation fixtures.

### P12 — Changing per-OS state directory paths
- Forbidden: ch15 §3 item 12.
- Status: COVERED.
- Enforcement: `packages/daemon/src/state-dir/__tests__/paths.spec.ts` + `packages/daemon/test/state-dir/paths.spec.ts` + `packages/daemon/test/state-dir/env-consistency.spec.ts`.

### P13 — v0.4 adding a mandatory non-NULL column to a v0.3 table
- Forbidden: ch15 §3 item 13.
- Status: GAP.
- Enforcement: spec relies on the v0.3 baseline already shipping `crash_log.owner_id NOT NULL DEFAULT 'daemon-self'`, `settings(scope, key, value)` composite PK, empty `principal_aliases` table — but the prohibition is on v0.4 future migrations. There is no test or lint that scans new migration files (002_*.sql onward) for NOT NULL columns without DEFAULT. The `migration-lock.spec.ts` only locks existing files; it does not constrain new files.

### P14 — v0.4 reshaping request semantics of WatchSessions/GetCrashLog/WatchCrashLog/GetSettings/UpdateSettings
- Forbidden: ch15 §3 item 14. The three enums (OwnerFilter, SettingsScope, WatchScope) MUST reject `ALL`/`PRINCIPAL` in v0.3 with `PermissionDenied`.
- Status: PARTIAL.
- Enforcement: `packages/daemon/test/sessions/watch-sessions.spec.ts:100` asserts `WATCH_SCOPE_ALL` → `reject_permission_denied`. `packages/daemon/test/integration/settings-error.spec.ts` asserts `SETTINGS_SCOPE_PRINCIPAL` → `InvalidArgument` (note: spec says `PermissionDenied`; the test pins `InvalidArgument` — spec/test divergence flagged in test header comment). No equivalent test for `OWNER_FILTER_ALL` on `GetCrashLog`/`WatchCrashLog`.
- Gap: missing `OWNER_FILTER_ALL → PermissionDenied` assertion on crash RPCs; spec-vs-test mismatch on settings (PermissionDenied vs InvalidArgument).

### P15 — Modifying packages/electron/src/main/transport-bridge.ts for web/iOS reasons
- Forbidden: ch15 §3 item 15. Bug fixes affecting renderer↔bridge↔daemon path are allowed; cross-client refactors are not.
- Status: GAP.
- Enforcement: none. `tools/audit-table-revalidate.sh` parses ch15 audit tables and flags touched forever-stable file paths, but the script is not invoked from any `.github/workflows/*.yml`. Even when wired, the script cannot detect "modified for web/iOS reasons" — that's intent, not file-set.
- Note: this is intrinsically a "human review" pattern; the proposed sub-task is wiring `audit-table-revalidate.sh` into CI as the touched-file flagging backstop.

### P16 — Adding loopback-TCP fallback for Supervisor
- Forbidden: ch15 §3 item 16. Supervisor is UDS-only on every OS.
- Status: COVERED.
- Enforcement: `packages/daemon/test/supervisor/contract.spec.ts` (URL constants pinned `as const` per ch03 §7); `packages/daemon/src/supervisor/__tests__/server.spec.ts`. Item-16-specific assertion: any TCP fallback would change the contract spec's URL strings, breaking the table-test.

### P17 — Adding a new value to BindDescriptor.kind / listener-a.json.transport 4-value enum
- Forbidden: ch15 §3 item 17.
- Status: COVERED.
- Enforcement: `packages/daemon/src/listeners/__tests__/transport-pick.spec.ts` + `packages/daemon/src/listeners/transport-pick.ts` (closed enum); `packages/proto/test/lock.spec.ts` (proto SHA freeze); enum is at proto level so adding a value requires proto edit which `buf breaking` (when wired) and lock.spec.ts catch.

### P18 — Writing to listeners[1] from non-listener-b.ts source
- Forbidden: ch15 §3 item 18.
- Status: COVERED.
- Enforcement: ESLint rule `ccsm/no-listener-slot-mutation` at `packages/daemon/eslint-plugins/ccsm-no-listener-slot-mutation.js` + tests; runtime startup assert per ch03 §1; `packages/daemon/src/listeners/__tests__/array-shape.spec.ts`.

### P19 — v0.4 MUST NOT remove/renumber proto fields; reserved-via-comment forbidden
- Forbidden: ch15 §3 item 19.
- Status: COVERED on the proto side.
- Enforcement: `reserved <number>;` keyword used in `common.proto:20`, `session.proto:53`, `settings.proto:76`. Lock spec catches edits. Buf-breaking is the cited mechanism; CI invocation gap is captured under P-META.

### P20 — v0.4 MUST NOT add Principal.kind oneof at non-reserved slot
- Forbidden: ch15 §3 item 20.
- Status: COVERED.
- Enforcement: `packages/proto/src/ccsm/v1/common.proto:20` ships `reserved 2; // v0.4: CfAccess cf_access = 2;`. Any other slot for cf_access is rejected by `buf breaking` (when wired) and by `protoc` if a tag clash occurs.

### P21 — v0.4 MUST NOT bump SnapshotV1 schema_version to add compression
- Forbidden: ch15 §3 item 21. Compression already ships via `codec` byte (1=zstd, 2=gzip).
- Status: COVERED.
- Enforcement: `packages/daemon/test/pty/snapshot-codec.spec.ts` round-trips both codecs at `schema_version=1`. `packages/daemon/test/fixtures/snapshot-v1-golden.bin` is the byte-for-byte witness.

### P22 — v0.4 MUST NOT remove PtyService.AckPty or AttachRequest.requires_ack
- Forbidden: ch15 §3 item 22.
- Status: COVERED.
- Enforcement: `packages/proto/src/ccsm/v1/pty.proto` ships `AckPty` RPC + `requires_ack` field; `packages/proto/test/lock.spec.ts` SHA-locks the file; `buf breaking` catches removal (when wired); usage in `packages/electron/src/rpc/queries.ts` is a live caller that breaks build on removal.

### P23 — v0.4 MUST NOT touch .proto without bumping packages/proto/lock.json SHA256
- Forbidden: ch15 §3 item 23.
- Status: COVERED in repo.
- Enforcement: `packages/proto/scripts/lock-check.mjs` (CLI), `packages/proto/test/lock.spec.ts`, `packages/proto/test/lock-script.spec.ts`. Run via `pnpm --filter @ccsm/proto run lock-check`.
- CI invocation gap: not directly invoked from `.github/workflows/ci.yml` — captured under P-META.

### P24 — v0.4 MUST NOT branch daemon behavior on HelloRequest.client_kind / HelloResponse.listener_id
- Forbidden: ch15 §3 item 24. Both are open string sets, observability-only.
- Status: GAP.
- Enforcement: `packages/proto/test/contract/open-string-tolerance.spec.ts` asserts wire-level tolerance to unknown values, but does NOT assert the daemon doesn't `switch (client_kind)`. No grep-based or AST-based rule prohibits `client_kind` / `listener_id` appearing in a switch/if-condition in `packages/daemon/src/`.

### P25 — v0.4 MUST NOT pivot PTY per-session boundary back into worker_threads
- Forbidden: ch15 §3 item 25. Pty-host is `child_process.fork`-spawned forever.
- Status: GAP.
- Enforcement: none. `packages/daemon/src/pty-host/host.ts` and `packages/daemon/test/pty-host/host.spec.ts` exist but no test/lint asserts `new Worker(...)` is absent from `packages/daemon/src/pty-host/`. A grep for `worker_threads` in `packages/daemon/src/` would suffice.

### P26 — Per-subscriber delta segmentation knobs
- Forbidden: ch15 §3 item 26. Cadence (16ms / 16KiB) is per-session.
- Status: COVERED.
- Enforcement: `packages/daemon/test/lock/segmentation-cadence.spec.ts` (per spec — asserts cadence constants live in one source file with no per-subscriber parameter). Verify file exists — yes.

### P27 — Re-tuning the Listener-A perf budget for v0.4 reasons
- Forbidden: ch15 §3 item 27.
- Status: COVERED.
- Enforcement: `tools/perf-budgets-locked.spec.ts` parses the ch12 §7 markdown table and asserts Listener-A rows are byte-identical to a frozen reference. File header explicitly cites ch15 §3 #27.

### P28 — Ship-gate (c) test file path frozen at packages/daemon/test/integration/pty-soak-1h.spec.ts
- Forbidden: ch15 §3 item 28. Renaming requires R4 sign-off.
- Status: COVERED.
- Enforcement: `packages/daemon/test/integration/pty-soak-1h.spec.ts` exists at the cited path. `tools/audit-table-revalidate.sh` parses ch15 §3 for forever-stable paths and would flag a rename touch (when wired into CI — see P-META).

### P29 — v0.3 tools/.no-ipc-allowlist contents are forever-stable
- Forbidden: ch15 §3 item 29.
- Status: COVERED.
- Enforcement: `tools/.no-ipc-allowlist` header documents the freeze and cites ch15 §3 #29 + Task #126 (audit-table-revalidate). `tools/audit-table-revalidate.sh` would flag mutation (when wired into CI — see P-META).

## Sub-task proposals

(Listed for manager TaskCreate; not created here.)

### P-META — Wire packages/* tests + buf-breaking + lock-checks into CI
- Subject: `[T10.X] CI: invoke turbo run test + proto buf-breaking + tools vitest + audit scripts`
- Description: Edit `.github/workflows/ci.yml` to add steps that run `pnpm --filter @ccsm/proto run test`, `pnpm --filter @ccsm/daemon run test`, `pnpm --filter @ccsm/proto run lock-check`, `pnpm --filter @ccsm/proto run breaking` (against merge-base SHA pre-tag / v0.3 tag post-tag), `bash tools/check-migration-locks.sh`, `npx vitest run --config tools/vitest.config.ts` (covers packages-shape + perf-budgets-locked + installer-roundtrip-allowlist), and `bash tools/audit-table-revalidate.sh --pr ${{ github.event.pull_request.number }}`.
- Tier: CI workflow edit.
- Estimated LOC: ~80 yaml lines (single file).
- Closes coverage gap on items: P1, P2, P4, P15, P19, P22, P23, P26, P27, P28, P29 (raises them from "tests on disk but unrun" to genuinely COVERED). High leverage — single PR.

### Sub-task for P7 — principalKey colon-split parser + round-trip test
- Subject: `[T1.X] add parsePrincipalKey + colon-split round-trip test`
- Description: Add a `parsePrincipalKey(key: string): { kind, value }` function in `packages/daemon/src/auth/principal.ts` using `key.indexOf(':')`; add `packages/daemon/src/auth/__tests__/parse-principal-key.spec.ts` asserting (a) `local-user:1000` → `{kind:'local-user', value:'1000'}`, (b) `local-user:S-1-5-21-...` round-trips, (c) future `cf-access:auth0|abc:def` round-trips with `value` containing `:` (test the parser, not yet the kind).
- Tier: unit test + ~20 LOC source.
- Estimated LOC: 80 (source ~20, test ~60).

### Sub-task for P13 — lint rule against new NOT-NULL columns without DEFAULT
- Subject: `[T10.X] add SQL migration scanner: forbid NOT NULL without DEFAULT in 002+_*.sql`
- Description: Add `tools/check-migration-additivity.sh` (or a `packages/daemon/test/db/migration-additivity.spec.ts`) that parses every `packages/daemon/src/db/migrations/00[2-9]_*.sql` (and onward), finds `ADD COLUMN` and `CREATE TABLE` statements, and asserts every `NOT NULL` column either has a `DEFAULT` clause or sits in a brand-new table (no existing rows). Use a SQL parser dep (e.g. `node-sql-parser`) or a simple regex + test fixtures.
- Tier: shell script OR unit test.
- Estimated LOC: ~120 (with test fixtures).

### Sub-task for P14a — OWNER_FILTER_ALL rejection on crash RPCs
- Subject: `[T8.X] integration test: GetCrashLog/WatchCrashLog reject OWNER_FILTER_ALL with PermissionDenied`
- Description: Add cases to `packages/daemon/test/integration/crash-getlog.spec.ts` and `packages/daemon/test/integration/crash-stream.spec.ts` asserting that `OWNER_FILTER_ALL` is rejected with `PermissionDenied` per ch15 §3 #14.
- Tier: integration test.
- Estimated LOC: ~50.

### Sub-task for P14b — reconcile spec vs test (PermissionDenied vs InvalidArgument) for SettingsScope
- Subject: `[T8.X] reconcile SETTINGS_SCOPE_PRINCIPAL rejection: PermissionDenied vs InvalidArgument`
- Description: `packages/daemon/test/integration/settings-error.spec.ts` pins `InvalidArgument`; ch15 §3 #14 says `PermissionDenied`. Either fix the test (preferred — semantic correctness: scope is denied because v0.3 has no principal-scoped settings, not because the wire shape is malformed) or amend the spec via R4 audit row. Pick one in the sub-task.
- Tier: spec/test reconciliation (no new file, ~10 LOC change either side).
- Estimated LOC: 10.

### Sub-task for P15 — wire audit-table-revalidate into CI (subsumed by P-META)
- Already covered by P-META above; no separate sub-task needed unless P-META is split.

### Sub-task for P24 — lint rule: no daemon switch on client_kind / listener_id
- Subject: `[T10.X] ESLint rule ccsm/no-client-kind-branch + test`
- Description: Add an ESLint rule in `packages/daemon/eslint-plugins/` that flags `switch` / `if` conditions whose discriminant is a member access ending in `client_kind` or `listener_id`. Add positive + negative fixtures under `packages/daemon/eslint-plugins/__tests__/`.
- Tier: ESLint rule.
- Estimated LOC: ~150 (rule + tests).

### Sub-task for P25 — guard against worker_threads in pty-host
- Subject: `[T8.X] tools/lint-no-worker-threads.sh + spec`
- Description: Tiny shell script (`tools/lint-no-worker-threads.sh`) that greps `packages/daemon/src/pty-host/` for `worker_threads` / `new Worker(` and exits non-zero on any match. Wire into `npm run lint:no-ipc` companion `lint:no-worker-threads`. Alternative: add an ESLint `no-restricted-imports` entry for `worker_threads` scoped to `packages/daemon/src/pty-host/**`.
- Tier: shell script (or ESLint config edit).
- Estimated LOC: ~40 (script ~25, package.json wiring ~5, integration test ~10).
