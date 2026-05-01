## 12. Review traceability

This section maps every MUST-FIX item from the ten round-1 angle reviews
(`~/spike-reports/v03-review-*.md`), the round-2 P0/P1 escalations
(`~/spike-reports/v03-r2-*.md`), and the round-3 residuals
(`~/spike-reports/v03-r3-*.md`) to the spec-v2 section that addresses it.

This file is a **round-3 re-audit** (2026-04-30, post-r3 fixers in flight).
Status of every row is recomputed against the current fragment bodies AND
the round-3 reviewer verdicts. Pure SHOULD/OPEN questions live in the
source reports and are not tracked here.

Section numbers refer to spec v2 post-merge:

- §3.1.1 Local socket hardening (already in v2 wip)
- §3.4.1 Envelope hardening (frag-3.4.1)
- §3.5.1 PTY child lifecycle hardening (frag-3.5.1)
- §3.7 Dev workflow (frag-3.7)
- §6 Reliability (rewrite, frag-6-7)
- §7 Security (rewrite, frag-6-7)
- §8 Data migration v0.2 → v0.3 (frag-8)
- §11 Packaging (rewrite, frag-11)
- §12 Review traceability (this fragment)

### 12.0 Manager arch decisions (locked pre-merge)

These decisions resolve r3 contradictions whose only blocker was the
manager picking between the equally-valid options the fragments fielded.
They are CLOSED below as "manager r3 lock" rather than punted to the
fragment authors.

1. **Install path = per-machine `%ProgramFiles%\ccsm\` (Win) and OS-equivalents
   elsewhere** (`/Applications/CCSM.app` mac, `/opt/ccsm/` Linux). Per
   `[manager r12 lock 2026-05-01]` (frag-11 §11.6) electron-builder ships
   `nsis: { perMachine: true, oneClick: false }` — superseding the original
   r3 P0-1 `perMachine: false` lock; PR #682 (T51) flipped to per-machine for
   the daemon-at-boot story (HKLM Run / Task Scheduler require per-machine
   install). Per-user *data* still lives under `%LOCALAPPDATA%\ccsm\` (item 2
   below) so multi-user boxes get one install but separate per-user state.
   T9 / T14 security claims in §7.4 are downgraded: install-root inherits
   `%ProgramFiles%`'s default ACL (Authenticated-Users read+execute,
   Administrators write); the "user-only ACL" claim applies only to the
   per-user data paths in item 2. frag-11 §11.2 + §11.6 NSIS macro rooted
   at `$INSTDIR` under `$PROGRAMFILES64\ccsm`.
2. **Data root = OS-native (`%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application Support/ccsm/` mac, `~/.local/share/ccsm/` Linux)** — single root for **everything daemon-owned**: daemon binary, `daemon.lock`, `daemon.secret`, `<dataRoot>/data/` (SQLite), `<dataRoot>/logs/` (pino-roll), `<dataRoot>/crashes/` (crash dumps). frag-11 §11.6 is the **single source of truth** for the paths table; `<dataRoot>` is OS-native per frag-11 §11.6 and v0.2 → v0.3 migration moves data from legacy `~/.ccsm/` to `<dataRoot>` (frag-8 §8.3 step 1). [manager r5 lock: install path locked to `%LOCALAPPDATA%` in r3 to avoid UAC; all sibling paths (data/logs/crashes/lockfile/secret) follow per frag-11 §11.6 — eliminates the three-way `<dataRoot>` permutation that r4 packaging + multiple reviewers flagged.] [manager r11 lock: r10 traceability P1 — lockfile basename swept `ccsm-daemon.lock` → `daemon.lock` to match frag-11 §11.6 paths table.] Resolves r3-packaging P0-2 (three-way secret-path contradiction) AND r4-packaging dataRoot reconciliation.
3. **Surface registry = frag-6-7 §6.8 numeric priority table (100/90/85/70/50/30)
   is the sole authoritative registry.** frag-3.7 §3.7.8's tier 1-6 table
   becomes a renderer-implementation guide that registers INTO §6.8;
   conflicting entries (e.g. `daemon.crashLoop` camelCase vs
   `daemon.crashloop.with_bak` dot+snake) resolve to §6.8 spelling.
   Resolves r3-ux P0-UX-A (two-registry coexistence).

### 12.1 Matrix

[manager r5 lock: matrix rebuilt off current frag bodies post r4 reviews; IN-FLUX now means actually still under fixer, not stale lag.]

Status legend: ✅ CLOSED · 🟡 IN-FLUX (fix dispatched / pending r5 fixer) · ❌ OPEN (genuinely punted to v0.4+).

#### ✅ CLOSED

| Round | Item | Cite |
|---|---|---|
| r1 resource M1 | pino log rotation | frag-6-7 §6.6.1 (`pino-roll` daily/50M/7) |
| r1 resource M2 | subscriber multiplexing model | frag-3.5.1 §3.5.1.5 (single fan-out registry, drop-slowest) |
| r1 resource M3 | RAM target wording (plan delta) | frag-6-7 Plan delta Task 25 (`<120 MB daemon RSS, <500 MB incl. children`) |
| r1 reliability M1 | PTY orphan reaping | frag-6-7 §6.2 + frag-3.5.1 §3.5.1.1/.2 (JobObject + setpgid + PDEATHSIG) |
| r1 reliability M2 | bridge call timeout + cancel | frag-3.5.1 §3.5.1.3 (5s default, AbortSignal.any, BridgeTimeoutError) |
| r1 reliability M3 | SQLite tx boundaries (audit) | frag-6-7 §6 + Plan delta Task 8/12/13 (`db.transaction` audit) |
| r1 reliability M4 | single-instance lock on Win | frag-6-7 §6.4 (proper-lockfile primary, pipe bind secondary) |
| r1 reliability M5 | updater rollback / atomic swap | frag-6-7 §6.4 step 5-7 (`MoveFileExW`, single-shot rollback) |
| r1 security M1 | Win named-pipe ACL | frag-6-7 §7.1.2 + §7.M1 helper (explicit DACL = current SID) |
| r1 security M2 | sender peer-cred check | frag-6-7 §7.1.3 + §3.1.1 (`SO_PEERCRED` / `GetNamedPipeClientProcessId`) |
| r1 security M3 | envelope cap + schema validation | frag-3.4.1 §3.4.1.a (16 MiB cap) + §3.4.1.d (TypeBox check) |
| r1 perf M1 | binary frame format (no base64) | frag-3.4.1 §3.4.1.c (header-JSON + raw-bytes-trailer) |
| r1 perf M2 | head-of-line blocking | frag-3.4.1 §3.4.1.b (≤16 KiB sub-chunks) |
| r1 perf M3 | snapshot wire micro-benchmark | frag-3.4.1 Plan delta Task 5b (un-deferred per r2 perf §7) |
| r1 lockin top-2 | DaemonClient AbortController cancel | frag-3.5.1 §3.5.1.3 (`AbortSignal.any`) |
| r1 lockin top-4 | versioned handshake | frag-3.4.1 §3.4.1.g (`daemon.hello`) + frag-6-7 §6.5 (`protocol` block) |
| r1 obs M1 | end-to-end traceId in envelope | frag-3.4.1 §3.4.1.c + frag-6-7 §6.6.1 (`traceId` ULID required) |
| r1 obs M2 | `pino.final` on fatal | frag-6-7 §6.6.1 (daemon) + §6.6.2 (electron, `side: 'electron'`) |
| r1 obs M3 | log rotation | frag-6-7 §6.6.1/.2 (same pino-roll on both sides) |
| r1 obs M4 | daemon version + pid + boot in every line | frag-6-7 §6.6.1/.2 (pino base = `{ side, v, pid, boot }`) |
| r1 devx M1 | `npm run dev` daemon restart-on-rebuild | frag-3.7 §3.7.2/.3 (concurrently 3-lane + nodemon) |
| r1 devx M2 | dev-mode daemon stderr in terminal | frag-3.7 §3.7.3/.6 (`stdout/stderr: true` + dev-vs-prod table) |
| r1 devx M3 | TS Project References (plan delta) | frag-3.7 Plan delta Task 1 (`composite: true`, `references: [{path: "daemon"}]`) |
| r1 devx M4 | orphan-daemon footgun | frag-3.7 §3.7.4 (auto-reconnect) + frag-6-7 §6.4 (stale-lock recovery via PID probe) |
| r1 devx M5 | README + `npm run setup` | frag-3.7 Plan delta Task 1 (`scripts/setup.cjs` + CONTRIBUTING) |
| r1 ux M1 | v0.2 → v0.3 SQLite migration | frag-8 §8 (full migration spec) |
| r1 ux M2 | close-to-tray discoverability | frag-3.7 §3.7.8.b + frag-6-7 §6.8 — owner = frag-6-7 §6.8 (timestamp `app_state.close_to_tray_shown_at` — manager r5 lock supersedes the boolean `close_to_tray_hint_shown` previously proposed; verified in frag-6-7 §6.8 + §6.6.1 R3-T12). |
| r1 ux M3 | daemon-spawn failure modal | frag-6-7 §6.1.1 copy table + §6.1 cold-start logic + frag-3.7 §3.7.4 reconnect waiting toast |
| r1 packaging M1 | electron-builder `extraResources` | frag-11 §11.2 (`extraResources` + `before-pack.cjs` + `after-pack.cjs`) |
| r1 packaging M2 | daemon binary code-signing | frag-11 §11.3.1/.2 (signed before EB packaging; SH3 verify) |
| r1 packaging M3 | macOS notarization of nested daemon | frag-11 §11.3.2 (hardened runtime + JIT entitlement + standalone notarytool) |
| r1 packaging M4 | NSIS uninstall hygiene | frag-11 §11.6.1 (`customUnInstall` macro + `nsis.include` wiring) + frag-6-7 §6.8 (paths contract). r3-perf/lockin/sec/pkg all confirm stale OPEN flag from r2 |
| r1 fwdcompat 3.1 | interceptor seam | frag-3.4.1 §3.4.1.f (`Interceptor`, `ReqCtx`, `mountConnectAdapter({interceptors})`) — r3-fwdcompat/lockin/sec confirm landed |
| r1 fwdcompat 3.2 | PTY fanout multi-subscriber + test | frag-3.5.1 §3.5.1.5 + §3.5.1.6 |
| r1 fwdcompat 3.3 | versioned handshake (`clientProtocolVersion` etc.) | frag-3.4.1 §3.4.1.g (`daemonProtocolVersion`, `compatible`) + frag-6-7 §6.5 (`protocol` block in `/healthz`) — r3-fwdcompat/lockin/sec confirm landed |
| r2 resource P0-1 | replay-burst exempt from drop-slowest | frag-3.4.1 §3.4.1.b + frag-3.5.1 §3.5.1.5 + frag-3.7 §3.7.4.a (single contract, ≤256 KiB replay then `gap: true`) |
| r2 resource P1-3 | snapshot semaphore deadline starts after admission | frag-3.5.1 §3.5.1.5 (`snapshot.semaphore.waitMs` counter) |
| r2 resource P1-4 | aggregate per-session subscriber cap | frag-3.5.1 §3.5.1.5 (`min(N×1MB, 4MB)` LRU oldest-slowest) |
| r2 reliability P0-R3 | SIGCHLD shutdown ordering + DB rows | frag-3.5.1 §3.5.1.2 + frag-6-7 §6.6.1 (`running → shutting_down → exited`) |
| r2 reliability P0-R5 | dedicated supervisor transport | frag-6-7 §6.5 + frag-3.4.1 §3.4.1.h (separate `-sup` socket/pipe) |
| r2 reliability P1-R5 | per-PID `waitpid(pid, WNOHANG)` | frag-3.5.1 §3.5.1.2 |
| r2 reliability P1-R6 | heartbeat-vs-supervisor inversion | frag-3.5.1 §3.5.1.4 (documented invariant `streamDeadMs > supervisorDeadMs`) |
| r2 security P0-S1 | `daemon.secret` lifecycle | frag-6-7 §7.2 (Electron generator + atomic CREATE_NEW + rotation on update + redact list) |
| r2 security P0-S2 | migration env-var trust | frag-8 §8.4 `resolveLegacyDir()` (canonical-path allowlist + double realpath + UNC reject) |
| r2 security P0-S3 | SLSA-3 + Linux minisign | frag-11 §11.4.1 (producer) + frag-6-7 §6.4 step 2 (verifier contract) + §7.3 v0.3 row |
| r2 security P1-S1 | per-handler arg validation | frag-3.4.1 §3.4.1.d + ESLint `no-handler-without-check` |
| r2 security P1-S2 | traceId regex + log injection guard | frag-3.4.1 §3.4.1.c + frag-6-7 §6.6.1 (Crockford ULID regex + `\n\r` strip + dual `traceId`/`daemonTraceId`) |
| r2 security T15 | pre-accept rate cap | frag-3.4.1 §3.4.1.a (`MAX_ACCEPT_PER_SEC = 50`) |
| r2 security T12-T14 | threat-model rows | frag-6-7 §7.4 (rated + rationale) |
| r2 obs P0-1 | Electron-side logger as peer | frag-6-7 §6.6.2 (`side: 'electron'` + same pino-roll + redact superset) |
| r2 obs P0-2 | traceId on binary frame header | frag-3.4.1 §3.4.1.c (header schema includes `traceId?`) |
| r2 obs P0-3 | drain ordering for log producers | frag-6-7 §6.6.1 step list (1-7) + frag-3.5.1 §3.5.1.2 mirror |
| r2 obs P0-4 | `pino.final` analog on every Electron exit | frag-6-7 §6.6.2 (registered against `app.before-quit` + `uncaughtException` + supervisor "Quit" handlers) |
| r2 obs P1-1 | `daemon.crashloop` log signature | frag-6-7 §6.1 (structured `crashloop_entered` line) |
| r2 obs P1-2 | migration phase log lines | frag-8 §8.5 (8 phase strings sharing `traceId`, asserted in §8.8 step 7) |
| r2 obs P1-3 | bridge-call lifecycle log set | frag-6-7 §6.6.2 (`bridge_call_complete`, `daemon_socket_closed`, `daemon_reconnect_*`, `stream_resubscribe`) |
| r2 obs P1-4 | `statsVersion: 1` | frag-6-7 §6.5 (`daemon.stats` + `/healthz` carry version cursor) |
| r2 obs P1-5 | crash-dump file spec | frag-6-7 §6.6.3 (path + schema + 0600 ACL + 30-day retention + never auto-uploaded) |
| r2 obs OPEN-3 | `spawnTraceId` for daemon-originated events | frag-3.5.1 §3.5.1.2 (allocated per `pty.spawn()`, on session row) |
| r2 obs OPEN-4 | `boot_nonce` is ULID not Date.now | frag-6-7 §6.5 |
| r2 fwdcompat P0-1 | interceptor + headers + traceId on header | frag-3.4.1 §3.4.1.c/.f |
| r2 fwdcompat P0-2 | hello/version handshake wired | frag-3.4.1 §3.4.1.g + frag-6-7 §6.5 |
| r2 fwdcompat P0-3 | RPC namespace `ccsm.vN/...` rule | frag-3.4.1 §3.4.1.g |
| r2 fwdcompat P1-1 | `bootNonce` propagation | frag-3.5.1 §3.5.1.4 + frag-3.7 §3.7.5 + frag-6-7 §6.5 |
| r2 fwdcompat P1-2 | reserved `x-ccsm-*` headers | frag-3.4.1 §3.4.1.c (4 reserved keys + spec amendment rule) |
| r2 fwdcompat P1-3 | marker schema version | frag-8 §8.5 S8 (`marker.version: 1` + e2e `999` test) |
| r2 fwdcompat P2-2 | `streamId` odd/even allocation | frag-3.4.1 §3.4.1.b |
| r2 lockin P0-1 | frame-version nibble | frag-3.4.1 §3.4.1.c (high 4 bits of `totalLen` reserved) |
| r2 lockin P0-2 | `NativeBinding` swap interface | frag-3.5.1 §3.5.1.1.a + lint `no-direct-native-import` |
| r2 lockin P0-3 | env-var + marker rename | frag-8 §8.4 (`CCSM_LEGACY_USERDATA_DIR`) + §8.5 S8 (`migration-state.json`) |
| r2 lockin P1-4 | negotiable heartbeat per subscribe | frag-3.5.1 §3.5.1.4 (`{heartbeatMs}` clamped 5s..120s) |
| r2 ux P0-UX-1 | surface registry concept | frag-6-7 §6.8 [manager r3 lock = canonical] + frag-3.7 §3.7.8 (registers INTO §6.8) |
| r2 ux P0-UX-2 | close-to-tray un-deferred | frag-3.7 §3.7.8.b + frag-6-7 §6.8 — see r1 ux M2 row |
| r2 ux P0-UX-3 | daemon-spawn failure copy | frag-6-7 §6.1.1 copy table (9 rows) |
| r2 ux P1-UX-1 | reconnect retries forever → modal at N=15 | frag-3.7 §3.7.4 + frag-6-7 §6.1.1 reconnect-exhausted row |
| r2 ux P1-UX-2 | "start fresh" typed-confirm | frag-8 §8.6 (exact phrase + accessibility live region) |
| r2 ux P1-UX-3 | BridgeTimeoutError NOT surfaced per-call | frag-6-7 §6.1.1 (suppressed when banner showing); see r3 CF-1 IN-FLUX for the §3.5.1.3 carve-out edit |
| r2 ux P1-UX-4 | reconnect-toast vs supervisor banner mutex | frag-3.7 §3.7.8.a rule 3 + frag-6-7 §6.8 stacking rule |
| r2 ux P1-UX-5 | "Paused" not "Abandoned" copy | frag-6-7 §6.3 |
| r2 ux P1-UX-6 | pre-mount loader | frag-6-7 §6.1 + frag-3.7 §3.7.8.d |
| r2 devx P0-1 | workspaces in root `package.json` | frag-3.7 Plan delta Task 1 |
| r2 devx P0-2 | `wait-on tcp:127.0.0.1:0` no-op fixed | frag-3.7 §3.7.2 + `scripts/wait-daemon.cjs` (`wait-on file:` against lockfile) |
| r2 devx P0-3 | dev mode skips pkg-binary path | frag-3.7 §3.7.2.b + Task 7 (spawnOrAttach side); see r3 CF-2 IN-FLUX for frag-11 fence |
| r2 devx P0-4 | toolchain prerequisites + `npm run setup` | frag-3.7 §3.7.2.c + `scripts/setup.cjs` |
| r2 devx P1-3 | dev-build error toast | frag-3.7 §3.7.8.c row j |
| r2 devx P1-6 | stream handle `.cancel()` before resubscribe | frag-3.7 §3.7.5 step 1 |
| r2 devx P1-7 | E2E folded into harness-agent | frag-3.7 §3.7.7 (`harness-agent.daemonReconnect`) |
| r2 reliability P1-R1 | dev queue cap = 1000 | frag-3.7 §3.7.4 (`MAX_QUEUED_DEV = 1000`) |
| r2 packaging P0-1 | NSIS uninstall hygiene reclaimed | frag-11 §11.6 (full macro + paths table); same as r1 packaging M4 |
| r2 packaging P0-2 | every native `.node` signed | frag-11 §11.3.1/.2 per-`.node` loops + r3-lockin P0-A name unification → see IN-FLUX |
| r2 packaging P1-3 | CI Node 22 bump | frag-11 §11.5(0)(0a) |
| r2 packaging P1-4 | drop `--compress GZip` | frag-11 §11.1 (note + `package.json` script change) |
| r2 packaging P1-6 | signtool path discovery | frag-11 §11.3.1 (PATH-first + Win SDK fallback) |
| r2 packaging S1 | SHA256SUMS in merge job | frag-11 §11.4 (single source of truth) |
| r2 packaging S3 | `extraResources` `${platform}` token | frag-11 §11.2 (staged-dir pattern + `before-pack.cjs`) |
| r2 packaging SH2 | `MACOS_KEYCHAIN_PW` secret | frag-11 §11.3.2 |
| r2 packaging SH3 | `signtool verify /pa /v` post-sign | frag-11 §11.3.1 |
| r2 packaging C6 | daemon dependencies discipline | frag-11 §11.1 prose |
| r3 packaging P0-1 | install path Program-Files vs per-user | [manager r3 lock] §12.0 (1) — originally picked (a) `nsis: { perMachine: false }`. **Superseded by [manager r12 lock 2026-05-01]** (frag-11 §11.6): PR #682 (T51) flipped `perMachine: true` for the daemon-at-boot story; install root is now `%ProgramFiles%\ccsm\`. Per-user data remains under `%LOCALAPPDATA%\ccsm\`. |
| r3 packaging P0-2 | secret/lock path three-way contradiction | [manager r3 lock] §12.0 (2) — daemon binary + `daemon.lock` + `daemon.secret` at OS-native root; SQLite/logs/crashes stay at `~/.ccsm/`. r3 fixer applies. |
| r3 ux P0-UX-A | two surface registries | [manager r3 lock] §12.0 (3) — frag-6-7 §6.8 canonical; frag-3.7 §3.7.8 registers INTO §6.8 |
| r3 perf CF-3 / lockin CF-1 / fwdcompat #1 / sec P1-3 / resource X3 / ux P0-UX-C | "frag-12 stale OPEN rows" meta-issue | this re-audit (round-3) — ALL six angles confirm packaging M4 / fwdcompat 3.1 / fwdcompat 3.3 are landed; matrix updated above |
| r3 ux M2 owner pick | close-to-tray double ownership | [manager r5 lock] frag-6-7 §6.8 owns toast wiring; SQLite key = `close_to_tray_shown_at` (timestamp, NOT boolean — verified in frag-6-7 §6.8 + R3-T12). Supersedes earlier r3 boolean lock. |
| r3 fwdcompat CC-2 | `bootNonce` camelCase across 4 sites | frag-3.4.1 §3.4.1.g + frag-3.5.1 §3.5.1.4 + frag-3.7 §3.7.5 + frag-6-7 §6.5 — all four cite `bootNonce` (camelCase). r5 verified. |
| r3 fwdcompat CC-3 | `x-ccsm-deadline-ms` clamp 120s | frag-3.4.1 §3.4.1.c (`clamp 100 ms ≤ x ≤ 120 s`, unified with frag-3.5.1 §3.5.1.3). r5 verified. |
| r3 fwdcompat P1-5 | `daemonAcceptedWires[]` advertised in hello reply | frag-3.4.1 §3.4.1.g (hello reply features array) + frag-6-7 §6.5 (`daemonAcceptedWires` in healthz protocol block). r5 verified. |
| r3 lockin CF-2 | `daemonProtocolVersion` mirror in hello + healthz | frag-3.4.1 §3.4.1.g + frag-6-7 §6.5 (`daemonProtocolVersion` field on healthz protocol block). r5 verified. |
| r3 fwdcompat P1-3 | `statsVersion` split → `healthzVersion` | frag-6-7 §6.5 (`healthzVersion` on `/healthz`; `statsVersion` lives only on `daemon.stats`). r5 verified. |
| r3 fwdcompat P1-4 | feature-add-vs-version-bump rule | frag-3.4.1 §3.4.1.g feature-add rule documented; round-3 P1-4 closed. r5 verified. |
| r3 security CC-1 | frame-version nibble parsed BEFORE 16 MiB length cap | frag-3.4.1 §3.4.1.a step 0-2 spells out: read 4 bytes → extract nibble → reject UNSUPPORTED_FRAME_VERSION → mask + length-cap. r5 verified. |
| r3 fwdcompat P1-1 | `SUPERVISOR_RPCS` canonical allowlist constant | frag-3.4.1 §3.4.1.h (`SUPERVISOR_RPCS = ["/healthz", "/stats", "daemon.hello", "daemon.shutdown", "daemon.shutdownForUpgrade"]` declared canonical, consumed by control-socket dispatcher + migrationGateInterceptor + frag-8 §8.5). r5 verified; `[manager r9 lock: r8 envelope P0-1 + r8 devx P0-1 — row form updated from 4-element to canonical 5-element to match §3.4.1.h post-r7 + frag-6-7 §6.5 sweep]` |
| r3 perf P1-1 | `seq` zero-padded to 10 ASCII digits | frag-3.4.1 §3.4.1.c hot-path bullet ("zero-padded 10-digit ASCII covers full uint32 range"). r5 verified. |
| r3 fwdcompat P1-7 | unknown `x-ccsm-*` warn rule | frag-3.4.1 §3.4.1.c + §3.4.1.f deadlineInterceptor (`pino.warn { unknown_xccsm_header }` rate-limited 1/key/min). r5 verified. |
| r3 security P0-1 | imposter-secret HMAC-of-nonce + `crypto.timingSafeEqual` | frag-3.4.1 §3.4.1.g (HMAC-SHA256 + `helloNonceHmac` + `clientHelloNonce` + 2-frame handshake post-fixer-A) + frag-6-7 §7.2 (HMAC-of-nonce LOCK; bearer-token EXPLICITLY REJECTED). r5 verified post-fixer-A. |
| r3 lockin P0-A / r3 packaging P0-3 | native artifact `ccsm_native.node` 9-site rename | frag-11 §11.1/§11.2/§11.3/§11.6 + frag-3.5.1 §3.5.1.1 + frag-6-7 §7.M1 — all sites use `ccsm_native.node`; legacy `winjob.node` retired. r5 verified. |
| r3 packaging P0-2 | `daemon.secret` OS-native path | frag-6-7 §7.2 (`%LOCALAPPDATA%\ccsm\daemon.secret` Win, `~/Library/Application Support/ccsm/daemon.secret` mac, `~/.local/share/ccsm/daemon.secret` Linux) + frag-11 §11.6 paths table. r5 verified. |
| r3 packaging P0-4 | Linux postrm `SUDO_USER` + `getent passwd` correctness | frag-11 §11.6.3 (`SUDO_USER` gate + `getent passwd "$SUDO_USER" \| cut -d: -f6` + `~/.local/share/ccsm` cleanup; documented manual fallback). r5 verified. |
| r3 packaging P0-1 | install root + `nsis.perMachine` | frag-11 §11.1 + §11.6. **Current truth per `[manager r12 lock 2026-05-01]`**: `perMachine: true`, `oneClick: false`, `allowElevation: true`, `allowToChangeInstallationDirectory: true`, install root `%ProgramFiles%\ccsm\` (or user-redirected). Supersedes the r3 `perMachine: false` / `$LOCALAPPDATA\ccsm` lock and the r11 `oneClick`-only reconcile; PR #682 (T51) flipped per-machine for the daemon-at-boot story (HKLM Run / Task Scheduler). Per-user data paths still under `%LOCALAPPDATA%\ccsm\`. Follow-up #1058a tracks UAC-on-update story. |
| r3 ux surface registry | numeric priority 30/50/70/85/90/100 | frag-6-7 §6.8 (CANONICAL — six priority tiers explicit) + frag-3.7 §3.7.8 cross-refs into §6.8. r5 verified. |
| r3 perf CF-2 | `traceId` hot-path carve-out | frag-6-7 §6.6.1 (per-chunk fan-out logs at debug-level only; `streamId → spawnTraceId` cache; per-frame info-level forbidden on PTY hot path). r5 verified. |
| r3 lockin CF-3 | `clientImposterSecret` eliminated by HMAC handshake | frag-3.4.1 §3.4.1.g (no `clientImposterSecret` field; only `clientHelloNonce` + `helloNonceHmac`) + frag-6-7 §7.2 + §6.6 redact list ("legacy `imposterSecret` / `clientImposterSecret` cleartext fields were eliminated"). r5 verified. |
| r2 ux P0-UX-2 close-to-tray timestamp | `close_to_tray_shown_at` owned by frag-6-7 §6.8 | frag-6-7 §6.8 (timestamp lock, NOT boolean `close_to_tray_hint_shown`; R3-T12). r5 verified. |
| r3 ux P0-UX-A §3.7.8 deletion | §3.7.8 collapsed to one-paragraph cross-ref redirect | frag-3.7 §3.7.8 explicitly marked `**DELETED in round-3**` with all surfaces redirected to frag-6-7 §6.8 canonical. Stub header retained as discoverability redirect; no real registry content remains. r5 verified. |
| r5 dataRoot reconciliation | `~/.ccsm/data\|logs\|crashes\|daemon.lock` retired across frag-8 + frag-12 | [manager r5 lock] §12.0 (2) — frag-11 §11.6 single source of truth; frag-8 §8.2-§8.8 swept (`<dataRoot>/data/`, `<dataRoot>/logs/`, `<dataRoot>/crashes/`, `<dataRoot>/daemon.lock`); frag-12 §12.0 (2) updated. Eliminates the three-way `<dataRoot>` permutation flagged by r4 packaging + multiple reviewers. `[manager r11 lock: r10 traceability P1 — lockfile basename swept ccsm-daemon.lock → daemon.lock]` |
| r3 reliability P0-R4 | migration partial-write lockfile-before-ensureDataDir | frag-8 §8.3 step 0 (`acquireLockfile(<dataRoot>/daemon.lock)` BEFORE `ensureDataDir()`; step 1a unconditional unlink is provably orphan post-lockfile) + frag-6-7 §6.4 boot-order note. r5 verified. `[manager r11 lock: r10 traceability P1 — lockfile basename swept ccsm-daemon.lock → daemon.lock]` |
| r3 resource X4 | close-to-tray SQLite key locked to timestamp | [manager r5 lock] supersedes earlier r3 boolean lock; locked to `close_to_tray_shown_at` (timestamp) per frag-6-7 §6.8 + R3-T12. Same row as r3 ux M2 owner pick + r2 ux P0-UX-2 above. |

##### r7 batch (round-7 manager-lock cross-frag closures, post fixers A/B/C/D/E/H + G verify; r9 added 2 orphan-lock rows)

[manager r7 lock: §12 rebuilt with 21 new rows from r7 batch (fixers A/B/C/D/E/H/G + r9 orphan-lock additions); ratio CLOSED=147 / IN-FLUX=25 / OPEN=7 — see §12.2 below] `[manager r9 lock: r8 traceability P1-1 + P1-2 — arithmetic corrected (was 18/144/176; r7 sub-table actually had 19 rows then +2 orphan rows added in r9 → 21/147/179) and 2 orphan locks added as own rows]` `[manager r11 lock: r10 traceability P1 — r9 batch broken out as 12 explicit rows in new r9-batch sub-table; ratio CLOSED=159 / IN-FLUX=25 / OPEN=7 / total=191 — see §12.2 below.]`

| Concern | Owner frag/§ | Consumer frag(s)/§(s) | r7 lock string | Status |
|---|---|---|---|---|
| `daemon.shutdownForUpgrade` RPC + `<dataRoot>/daemon.shutdown` marker (3-frag chain) | frag-6-7 §6.4 (RPC + marker semantics owner) | frag-3.4.1 §3.4.1.h (`SUPERVISOR_RPCS` allowlist consumer); frag-11 §11.6.5 (upgrade-in-place orchestration consumer) | `[manager r7 lock: r6 packaging P0-2 cross-frag — daemon.shutdownForUpgrade RPC + marker semantics; consumed by frag-11 §11.6.5 upgrade flow]` (frag-6-7 §6.4) + `[manager r7 lock: r6 packaging P0-2 — upgrade-in-place daemon-shutdown contract]` (frag-11 §11.6.5) | CLOSED |
| §6.1 R2 marker-aware crash-loop skip (G verify) | frag-6-7 §6.1 R2 paragraph (supervisor counter rule) | frag-6-7 §6.4 (marker semantics producer); frag-11 §11.6.5 (marker writer at upgrade) | `[manager r7 lock: G verify — marker-aware crash-loop skip]` (frag-6-7 §6.1, added by fixer G) | CLOSED |
| i18n key namespace `migration.modal.failed.*` | frag-8 §8.6 (canonical key prefix owner) | frag-6-7 §6.1.1 copy table (`migration.modal.failed.*` row) + §6.8 surface registry (P=85 row) | `[manager r7 lock: r6 ux P0-3 — i18n key namespace migration.modal.failed.*]` (frag-8 §8.6) | CLOSED |
| §6.8 r7 surface-registry trim cascade (16→7 rows) | frag-6-7 §6.8 (canonical registry, 5 daemon-split rows + migration + paused-session) | frag-6-7 §6.1.1 (copy table trimmed 9→6 rows); frag-3.7 §3.7.4/§3.7.5/§3.7.8 (dispatched-surface set reduced to 3 surviving keys: `daemon.unreachable`, `daemon.reconnected`, `daemon.crashLoop`); frag-3.7 §3.7.8 surface-registry bridge plan-delta sub-task | `[manager r7 lock: cut as polish — N6# from r6 feature-parity. §6.8 row count trimmed from 16 → 7]` (frag-6-7 §6.8) + `[manager r7 lock: surfaces trimmed per N6# from r6 feature-parity]` (frag-3.7 §3.7.8 bridge sub-task) | CLOSED |
| §3.5.1.2 step 8 ↔ §6.6.1 step 4 SQL mirror lock (`UPDATE sessions SET state='paused', pid_pgid=NULL WHERE state='shutting_down'`) | frag-3.5.1 §3.5.1.2 step 8 (PTY-side terminal sweep) | frag-6-7 §6.6.1 step 4 (DB-side mirror) | `[manager r7 lock: r6 reliability P1-R4 mirror — explicit WHERE state='shutting_down' clause mirrors frag-6-7 §6.6.1 step 4]` (frag-3.5.1 §3.5.1.2) | CLOSED |
| HMAC `base64-22` wire-shape cross-frag unification (truncated 16-byte HMAC-SHA256, base64 ~22 chars) | frag-3.4.1 §3.4.1.g (handshake wire format owner — `helloNonceHmac: "<base64-22>"`) | frag-6-7 §6.5 + §7.2 (canonical secret lifecycle + HMAC contract; mirrored 1:1) | `[manager r7 lock: r6 P2-10 — HMAC base64-22 cross-frag wire-shape unification]` (E's fix per frag-3.4.1 §3.4.1.g + frag-6-7 §7.2) | CLOSED |
| `helloInterceptor` as interceptor #0 (handshake required BEFORE migrationGate) | frag-3.4.1 §3.4.1.f (interceptor pipeline owner — slot 0) + §3.4.1.g (handshake semantics) | frag-6-7 §6.4 supervisor (handshake rejection ladder); frag-3.7 §3.7.4 reconnect counting | `[manager r7 lock: r6 reliability P1-R6 — explicit ordering #0 so handshake-required check fires BEFORE migrationGateInterceptor]` (frag-3.4.1 §3.4.1.f) | CLOSED |
| 2 s handshake timeout + dedicated `HANDSHAKE_TIMEOUT` failure class | frag-3.4.1 §3.4.1.g (timeout + failure-class owner) | frag-6-7 §6.1.1 (`daemon.unreachable` body copy "reinstall ccsm" remediation); frag-3.7 §3.7.4 reconnect backoff (handshake fail counts as one reconnect attempt) | `[manager r7 lock: r6 reliability P0-R1 — explicit 2 s handshake deadline + dedicated failure class]` (frag-3.4.1 §3.4.1.g) + `[manager r7 lock: r6 reliability P0-R1 — handshake failure is a distinct pre-RPC failure class]` (frag-6-7 §6.1.1) | CLOSED |
| Server-side stream-dead detector `2 × heartbeatMs + 5 s` (symmetric) | frag-6-7 §6.5.1 (canonical detector spec, B add) | frag-3.5.1 §3.5.1.4 (cross-ref handoff, H lock) | `[manager r7 lock: r6 reliability P0-R2 — daemon-side symmetric dead-stream detector at 2 × heartbeatMs + 5 s]` (frag-6-7 §6.5.1) + `[manager r7 lock: r6 reliability P0-R2 cross-frag handoff]` (frag-3.5.1 §3.5.1.4) | CLOSED |
| Surface registry equal-priority deterministic tie-break (registry insertion order) | frag-6-7 §6.8 stacking rule 6 (C add) | frag-6-7 §6.1.1 (banner/modal stacking); frag-3.7 §3.7.8 bridge consumer; renderer `useDaemonHealthBridge` | `[manager r7 lock: r6 ux P0-2 — equal-priority tie-break = registry insertion order]` (frag-6-7 §6.8 stacking rule 6) | CLOSED |
| Devx P0-1 debugger contract (`--inspect=9229` Electron-main / `--inspect=9230` daemon, env-gated, dev-only) | frag-3.7 §3.7.7.a (A add — daemon-split contributor debugger flow) | frag-3.7 §3.7.3 nodemon `exec` line; frag-11 §11.2 packaging (prod strips `CCSM_DAEMON_INSPECT`); `.vscode/launch.json` consumers | `[manager r7 lock: r6 devx P0-1 — debugger contract for daemon-split contributors]` (frag-3.7 §3.7.7.a) | CLOSED |
| Devx P0-2 SDK ownership lock (daemon owns `claude-agent-sdk` direct ESM; Electron-main `loadSdk()` shim retained ONLY for residual session-title) | frag-3.7 §3.7.7.b (canonical ownership lock) | frag-11 §11.2.1 (SDK packaging contract consumer); frag-6-7 §6 daemon SDK consumers (must not use shim); Electron-main `electron/sessionTitles/loadSdk()` (residual only) | `[manager r7 lock: r6 devx P0-2 — daemon owns SDK directly (own Node 22 ESM); Electron-main loadSdk shim retained ONLY for any residual session-title/non-daemon SDK calls. New daemon code MUST NOT use the shim.]` (frag-3.7 §3.7.7.b) | CLOSED |
| `claude-agent-sdk` packaging contract (`extraResources` + `asarUnpack` + before-pack copy) | frag-11 §11.2.1 (D add — packaging mechanics owner) | frag-3.7 §3.7.7.b (SDK ownership consumer); Electron-main `loadSdk()` shim resolution path | `[manager r7 lock: r6 packaging P0-1 — claude-agent-sdk explicit packaging contract]` (frag-11 §11.2.1) | CLOSED |
| `ccsm-uninstall-helper.exe` signing as first-class artifact (signtool `$targets` array + before-pack staging) | frag-11 §11.3.1 (sign step) + frag-11 §11.6.4 (helper Task 20e) | frag-6-7 §6.8 NSIS uninstall hygiene (in-app daemon-shutdown contract consumer); release CI signing pipeline | `[manager r7 lock: r6 packaging P1-F — ccsm-uninstall-helper.exe is a first-class signed packaging artifact]` (frag-11 §11.6.4) | CLOSED |
| macOS notarize `teamId` + stapler validate (DMG explicitly stapled; standalone Mach-O notarized but not stapled) | frag-11 §11.3.2 (D add — codesign/notarize/stapler owner) | release CI macOS leg (`xcrun stapler validate` post-build); §11.7 5-submission count | `[manager r7 lock: r6 packaging P1-C — DMG stapling explicitly asserted]` (frag-11 §11.3.2) | CLOSED |
| Per-OS installer size ceilings + CI guard (Win NSIS ≤145 MB / mac DMG ≤160 MB / Linux AppImage ≤140 MB / .deb/.rpm ≤125 MB / standalone daemon ≤60 MB per arch) | frag-11 §11.5(6) (D add — release-publish job CI assertion) | frag-11 §11.2.1 SDK budget contribution (~6 MB); frag-11 §11.6.4 uninstall-helper (~5 MB); frag-11 §11.5(0) Electron 41 size baseline (~95 MB) | `[manager r7 lock: r6 packaging P1-B — installer size ceiling + CI assertion]` (frag-11 §11.5(6)) | CLOSED |
| Electron `^41.3.0` pin (caret allows patch-level autoupdate within 41.x; Electron 42+ deferred post-v0.3) | frag-11 §11.5(0) (E add — toolchain pin owner) | frag-11 §11.2.1 SDK packaging (Electron 41 main = CJS, SDK = ESM); frag-3.7 §3.7.7.b SDK ownership lock; frag-3.5.1 `loadSdk()` shim contract; per-`.node` ABI rebuild matrix | `[manager r7 lock: r6 lockin P0 — Electron version pinned to ^41.3.0 per pool-1/package.json check on 2026-05-01.]` (frag-11 §11.5(0)) | CLOSED |
| 6-step upgrade-in-place sequence (Electron-main owns orchestration: trigger → graceful shutdown RPC → 5 s ack → race fallback (force-kill + lock unlink) → quitAndInstall → spawn fresh daemon) | frag-11 §11.6.5 (D add — orchestration owner) | frag-6-7 §6.4 (`daemon.shutdownForUpgrade` RPC producer + marker writer); frag-6-7 §6.1 (marker-aware crash-loop skip on next boot, see G verify row above) | `[manager r7 lock: r6 packaging P0-2 — upgrade-in-place daemon-shutdown contract]` (frag-11 §11.6.5) | CLOSED |
| SmartScreen reputation reset risk on path / scope change (per-machine `Program Files` → per-user `%LOCALAPPDATA%`) | frag-11 §11.7 (D add — out-of-scope risk note) | frag-11 §11.3.x EV cert mitigation (pre-trusted SmartScreen reputation); release notes copy for non-EV cert builds | `[manager r7 lock: r6 packaging P1-D — SmartScreen reputation reset documented]` (frag-11 §11.7) | CLOSED |
| zh.ts parity acceptance criterion (i18n bundle keyset CI gate covering all v0.3 i18n keys) | frag-6-7 §6.1.1 line 64 (zh.ts parity owner) | frag-3.7 §3.7.8 i18n keys (daemon-health surfaces); frag-8 §8.6 `migration.modal.failed.*`; renderer i18n bundle (`src/i18n/locales/en.ts` ↔ `zh.ts`) | `[manager r7 lock: r6 ux P0-4 — zh.ts parity acceptance criterion]` (frag-6-7 §6.1.1) `[manager r9 lock: r8 traceability P1-2 — orphan lock added as own row]` | CLOSED |
| Surface key spelling alignment to §6.8 canonical (renames `daemon.reconnectStuck` / `daemon.reconnectExhausted` / `tray.closeHint` to OBSOLETE per §6.8 r7 trim) | frag-3.7 line 37 (key spelling alignment lock) | frag-6-7 §6.8 (canonical surface key prefix owner); frag-3.7 §3.7.8 dispatched-surface set | `[manager r7 lock: r6 ux P0-1 — key spelling aligned to §6.8 canonical]` (frag-3.7 line 37) `[manager r9 lock: r8 traceability P1-2 — orphan lock added as own row, distinct from §6.8 trim cascade row 4 which doesn't enumerate the renamed keys]` | CLOSED |

##### r9 batch (after r8 verify)

[manager r11 lock: r10 traceability P1 — 12 r9-batch cross-frag closures broken out as their own rows for §12 traceability discipline; prior r9 audit had folded these into prose only.]

| Concern | Owner frag/§ | Consumer frag(s)/§(s) | r9 lock string | Status |
|---|---|---|---|---|
| `SUPERVISOR_RPCS` canonical sweep | frag-3.4.1 §3.4.1.h | frag-3.4.1 §3.4.1.f, frag-6-7 §6.5, frag-12 row 166 | `[manager r9 lock: r8 envelope P0-1 + r8 devx P0-1 — SUPERVISOR_RPCS 5-element canonical allowlist swept across frag-3.4.1/frag-6-7/frag-12]` | CLOSED |
| hello-handshake unified posture | frag-3.4.1 §3.4.1.h | frag-6-7 §6.5 | `[manager r9 lock: r8 envelope P0-1 — hello handshake posture unified across §3.4.1.h owner and §6.5 healthz consumer]` | CLOSED |
| `x-ccsm-boot-nonce` header in reserved-keys allowlist + precedence rule | frag-3.4.1 §3.4.1.c + §3.4.1.g | frag-3.5.1 §3.5.1.4 (`fromBootNonce` param) | `[manager r9 lock: r8 envelope P1 — x-ccsm-boot-nonce added to reserved-keys allowlist with explicit precedence over body-level bootNonce]` | CLOSED |
| base64url no-pad nonces | frag-3.4.1 §3.4.1.g | frag-6-7 §6.5 (HMAC verify) | `[manager r9 lock: r8 envelope P1 — nonces locked to base64url no-pad on the wire; HMAC verify path mirrors]` | CLOSED |
| close-frame traceId carriage rule | frag-3.4.1 §3.4.1.c | (envelope-internal) | `[manager r9 lock: r8 envelope P1 — close-frame carries last-known traceId for log correlation]` | CLOSED |
| `/healthz` + `/stats` literal exemption from `ccsm.<wireMajor>/` namespace | frag-3.4.1 §3.4.1.h | frag-6-7 §6.5 | `[manager r9 lock: r8 envelope P1 — /healthz + /stats literal paths exempted from versioned ccsm.<wireMajor>/ RPC namespace]` | CLOSED |
| `daemonProtocolVersion` INTEGER pin | frag-3.4.1 schema | (handshake consumers) | `[manager r9 lock: r8 envelope P1 — daemonProtocolVersion typed INTEGER not string in TypeBox schema]` | CLOSED |
| Marker unlink ownership = daemon | frag-6-7 §6.4 | frag-6-7 §6.1 R2 | `[manager r9 lock: r8 reliability P1 — daemon owns daemon.shutdown marker unlink (not Electron-main); §6.1 R2 marker-aware skip consumes]` | CLOSED |
| SDK ownership inversion daemon-primary direct ESM | frag-11 §11.2.1 | frag-3.7 §3.7.7.b (already aligned) | `[manager r9 lock: r8 packaging P1 — claude-agent-sdk packaging contract inverted: daemon-primary direct ESM consumer; Electron-main loadSdk shim residual only]` | CLOSED |
| NSIS `oneClick: false` reconciliation | frag-11 §11.6 | §11 head, plan-delta 8c, frag-12 row 173 | `[manager r9 lock: r8 packaging P0-2 — NSIS oneClick:false / allowElevation:true / allowToChangeInstallationDirectory:true reconciled with working tip; assisted-mode installer preserved]` | CLOSED |
| §8.7 rollback rewrite + plan-delta 8c trim 18h→16h | frag-8 §8.6/§8.7 | (plan-delta consumer) | `[manager r9 lock: r8 migration P0 — §8.7 rollback rewritten; plan-delta 8c trimmed 18h→16h]` | CLOSED |
| daemon.migrationFailed annotation cleanup → `migration.modal.failed.*` | frag-6-7 §6.8 ann | (i18n consumers) | `[manager r9 lock: r8 ux P0 — daemon.migrationFailed annotation cleaned up; canonical key prefix is migration.modal.failed.* per §8.6]` | CLOSED |

#### 🟡 IN-FLUX (r5 fixers will land — cite owning frag)

| Round | Item | Owning frag + section | Fixer ask |
|---|---|---|---|
| r3 resource X1 | `<dataRoot>` aggregate disk cap dropped | frag-6-7 §6.6 | add aggregate watchdog (e.g. 2 GB warn / 4 GB hard prune-oldest) |
| r3 resource X2 / r3 devx CF-1 | `pino-roll symlink: true` punt not picked up | frag-6-7 §6.6.1/.2 | add `symlink: true` to both daemon + electron pino-roll config |
| r3 reliability P0-R1 | drain ordering loses SIGCHLD `ptyExit` into closed sinks | frag-3.5.1 §3.5.1.2 + frag-6-7 §6.6.1 | re-order: fan-out close moves AFTER step 8 (final waitpid + DB tx) |
| r3 reliability P0-R2 | crash-loop counter reset on rollback masks 2nd-bug loops | frag-6-7 §6.1 + §6.4 step 7 | rollback clears backoff but KEEPS crash-loop window decayed (e.g. counts as 3 of 5) |
| r3 reliability P0-R3 | `state='abandoned'` unreachable + name conflict | frag-3.5.1 §3.5.1.2 step 8 + frag-6-7 §6.6.1 step 5 | unify on `paused`; drop `abandoned` OR define semantic distinction |
| r3 reliability P0-R5 | `daemon.crashing` IPC is best-effort but renderer relies on it | frag-6-7 §6.6.1 | state explicitly: opportunistic; supervisor `/healthz` 3-miss + bridge 5s timeout = authoritative path |
| r3 reliability CF-1 / r2 ux P1-UX-3 carve-out | "BridgeTimeoutError NEVER surfaced to user" sentence missing | frag-3.5.1 §3.5.1.3 | append the sentence per frag-3.7 §3.7.8.c punt; remove "renderer-side caller decides retry policy" wording |
| r3 reliability CF-2 | replay-burst vs 1MB watermark language conflict | frag-3.5.1 §3.5.1.5 | add: "subscriber buffer accounting RESETS to 0 immediately after replay landed" OR "drop subscriber if buffered >X KB at resubscribe BEFORE replay write" |
| r3 reliability CF-3 / r3 devx CF-3 | "supervisor disabled in dev" — frag-6-7 says transport still binds | frag-6-7 §6.1 + §6.5 | clarify whether supervisor transport binds in dev; align with frag-3.7 §3.7.6 "Supervisor active? NO" table |
| r3 reliability P1-R1..R5 | various P1 polish | frag-6-7 §6.3/§6.6.3/§6.4 + frag-3.5.1 §3.5.1.2 | scheduled crash-dump prune, lockfile-create-fail uses `console.error` pre-pino, swap-lock vs daemon-lock race, `pid_pgid` cleared on graceful close, PR_SET_PDEATHSIG fork/execve race acknowledgement |
| r3 security P0-2 | r2 P1-S3 (subscribe `fromSeq` token) silently dropped, not punted | frag-3.5.1 §3.5.1.5 | add `subscribe_token` paragraph OR add explicit "ACCEPTED — same-user T3" row to §7.4 (frag-6-7 §7.4 T17 ACCEPTED row exists; verify consistency with frag-3.5.1) |
| r3 security CC-2 | `traceId` optional on wire vs mandatory in §6.6 validation | frag-6-7 §6.6.1 | add: validation runs only when `traceId` present; inheriting sub-frames resolve via `streamId → traceId` map |
| r3 security CC-3 | `daemon.secret` Electron-as-generator bypasses CLI launch path | frag-6-7 §7.2 | add `CCSM_DAEMON_HEADLESS=1` self-generate clause OR explicit "v0.3 refuses CLI launch without `--secret-file=`" |
| r3 security P1-1..P1-6 | P1 polish | frag-6-7 §7.2/§6.6.3/§6.4 + frag-8 §8.6 + frag-11 §11.4.1 | clear `CCSM_DAEMON_SECRET` from `process.env` post-read, sanitize migration `supplied`/`realpath` for renderer, name SLSA verifier (`@sigstore/verify`), `path.basename`+regex on crash-dump filename, `daemon.shutdown` BEFORE secret rotate |
| r3 perf CF-1 | healthz transport split — `control-socket` (3.4.1.h) vs `-sup` (6.5) ambiguous | frag-3.4.1 §3.4.1.h + frag-6-7 §6.5 | reconcile to ONE control plane (recommend rename §3.4.1.h `control-socket` to BE the §6.5 supervisor transport) |
| r3 perf P1-2..P1-5 | P1 polish | frag-3.5.1 §3.5.1.5 + frag-3.7 §3.7.4 + frag-3.4.1 §3.4.1.g | LRU fairness note for v0.5, hello-on-every-connect cold-start RT note, semaphore vs RAM-cap budget cross-ref |
| r3 lockin P1-1..P1-4 | r2 P1 lockin items still residual | frag-6-7 §6.4/§6.6 + frag-3.7 §3.7.4 + frag-11 §11.1 | `loggerTransport` factory, replace `proper-lockfile` with 15-LOC `fs.openSync`, `connectClient.configure({maxQueued, scheduling})` + `E_RECONNECT_QUEUE_OVERFLOW` code, `daemon/.nvmrc` single-source for Node target |
| r3 obs P1-2 | reconnect canonical log names not echoed in emitter | frag-3.7 §3.7.4 | add cross-ref: "Log line names per frag-6-7 §6.6.2 contract" |
| r3 ux P0-UX-B | migration modal "dismissable: false" prose vs §6.8 implicit-dismiss | frag-8 §8.6 OR frag-6-7 §6.8 | delete prose claim OR codify in §6.8 stacking rule 1 |
| r3 ux CC-1..CC-4 | onboarding key-name conflict / paused copy drift / camelCase vs dot.case / BridgeTimeout 3-place statement | frag-6-7 §6.3/§6.8 + frag-3.7 §3.7.8 + frag-3.5.1 §3.5.1.3 | locked per [manager r3 lock] §12.0 (3); r5 fixer normalizes copy + key spellings (residual: BridgeTimeout 3-place statement still pending in §3.5.1.3 — same as r3 reliability CF-1 above) |
| r3 ux P1-1..P1-6 | P1 polish | frag-6-7 §6.1 + frag-11 §11.6.2 + frag-3.7 §3.7.8.d | cold-start splash dev-mode hide trigger, "View log" target, "Reinstall ccsm" button behavior, reconnect-stuck modal copy normalization, mac "Reset CCSM…" tray UX pick, BrowserWindow backgroundColor companion fix |
| r3 packaging CF-2 | `customInstall` for `daemon.secret` split-ownership | frag-11 §11 cross-frag rationale + frag-6-7 §7.2 | pick Electron-side generation (already locked); remove dead frag-11 cross-frag rationale lines 500-501 |
| r3 packaging CF-4 | SLSA verifier coupling (which library?) | frag-6-7 §7.3 + frag-11 plan delta Task 20d | pick `@sigstore/verify` v1.x + bundle (~2 MB) |
| r3 packaging CF-5 | initial-install SLSA chicken-and-egg | frag-6-7 §7.3 | reword: "Linux via documented `slsa-verifier` manual step + minisign" |
| r3 packaging P1-1..P1-9 | P1 polish | frag-11 §11.1/§11.2/§11.3.2/§11.6.4/§11.4.1/§11.7 | arch-map fix (armv7l/universal), per-leg `pkg --targets`, `node-gyp` ABI pinning, notarytool 5-submission count update, NSIS helper file-lock window, `pkg.assets` per-platform glob, `SHA256SUMS.txt` in SLSA subject-path, minisign keypair-gen documentation |

#### ❌ OPEN (genuinely punted to v0.4+)

| Round | Item | Decision | Cite |
|---|---|---|---|
| r1 security S5 | sigstore signing | deferred to v0.4 | frag-6-7 §7.3 v0.4 row |
| r1 sec / fwdcompat | full CF Access JWT model | deferred to v0.5 | frag-6-7 §7.3 v0.5 row + §7.5 + `v0.5-security-followups.md` |
| r1 reliability OPEN | Win Service mode | deferred to v0.4+ | frag-6-7 §6.4 ("user-mode background process only" + rationale) |
| r2 perf P2-1 / r3 lockin P1-5 | OTLP `traceparent` carriage | tracked for v0.4 | frag-3.4.1 §3.4.1.c reserves `x-ccsm-trace-parent` header |
| r3 resource P1-1..P1-6 | per-session aggregate-cap formula clarity, crash-dump aggregate cap, xterm-headless idle eviction (res-S3), socket.cork amortization, reconnect queue closure-pin accounting, supervisor transport accept-loop cost | all P1 / not blocking v0.3 | frag-6-7 §6.6.3 + §6.7 F11 + frag-3.5.1 §3.5.1.5 + frag-3.4.1 §3.4.1.c — release-notes call-outs OR v0.4 prereqs |
| r3 ux out-of-scope | iOS App Store framing | deferred per F3 spike | frag-6-7 §7.5 |
| r3 ux out-of-scope | stream-heartbeat traffic-analysis surface | deferred to v0.5 | frag-6-7 §7.5 + r2 sec SH5 |

### 12.2 Summary

Total tracked rows: **191** (matrix rebuilt off current frag bodies in r5 + 21 r7-batch cross-frag rows + 12 r9-batch cross-frag rows broken out as own rows in r11 per r10 traceability P1).

- ✅ CLOSED: **159** (126 r5-baseline + 21 r7-batch cross-frag closures + 12 r9-batch cross-frag closures: SUPERVISOR_RPCS canonical sweep, hello-handshake unified posture, x-ccsm-boot-nonce reserved-keys + precedence, base64url no-pad nonces, close-frame traceId carriage, /healthz+/stats namespace exemption, daemonProtocolVersion INTEGER pin, marker unlink ownership = daemon, SDK ownership inversion daemon-primary direct ESM, NSIS oneClick:false reconciliation, §8.7 rollback rewrite + plan-delta 8c trim, daemon.migrationFailed → migration.modal.failed.*).
- 🟡 IN-FLUX: **25** (unchanged from r5 — those fixers were dispatched per-fragment in r5; r7/r9 batches added different axes (round-6 / round-8 review locks) without re-opening the r5 IN-FLUX set).
- ❌ OPEN: **7** (sigstore + CF Access + Win Service + OTLP carriage + resource P1 polish + iOS + heartbeat traffic analysis).

Math: 159 + 25 + 7 = **191**. Net delta from r9 audit: +12 explicit CLOSED rows (r9 batch cross-frag closures broken out as own rows per r10 traceability P1 — prior r9 audit had folded these into prose only). `[manager r11 lock: r10 traceability P1 — arithmetic recomputed (was 147/25/7=179; r9-batch broken out adds 12 → 159/25/7=191)]`

[manager r7 lock: §12 rebuilt with 21 new rows from r7 batch (fixers A/B/C/D/E/H + G verify + r9 orphan additions); ratio CLOSED=147 / IN-FLUX=25 / OPEN=7] `[manager r11 lock: r10 traceability P1 — superseded; current ratio CLOSED=159 / IN-FLUX=25 / OPEN=7 after r9 batch broken out.]`

Manager merge gate: the 25 IN-FLUX rows are dispatched as r5 fixers in their owning fragments (one fixer per fragment, parallel where non-overlapping). Once those land, this matrix re-promotes them to CLOSED and the spec is mergeable. The r7 batch did not change the IN-FLUX set — r7 was an orthogonal round-6 review-lock pass.

## Plan delta

None — pure doc section. Out-of-scope items above are accounted for in their originating fragments' Plan delta sections; manager r3/r5 locks have no per-fragment plan-delta change beyond the wording edit in the affected fragment body.
