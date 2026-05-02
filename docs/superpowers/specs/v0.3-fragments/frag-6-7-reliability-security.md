# Fragment: §6 reliability + §7 security expansion

**Owner**: Task #936 (worker, pool-2). Round-3 fixes applied per `~/spike-reports/v03-r3-*.md`.
**Target spec sections**: §6 (reliability) and §7 (security) of the v0.3 design (see `v0.3-design.md` index).
**P0 review items addressed**: rel-M1..M5, rel-S1/S2/S3/S5/S7, sec-M1..M3, sec-S1..S6, obs-MUST 2/3/4, res-MUST 1, round-2: rel P0-R1..R5, sec P0-S1..S3, obs P0-1..P0-4, fwdcompat P0-2, ux P0-UX-1/UX-3, pkg P0-1 (uninstall hygiene — TAKEN here, see §6.8). **Round-3**: rel R1..R5 (drain order, crash-loop reset, paused/abandoned terminal, daemon.crashing best-effort), sec P0-1/P0-2 (HMAC-of-nonce hello, fromSeq ACCEPTED), ux P0-A/P0-B/P0-C (surface registry canonical, migration priority callout, frag-12 PUNT), obs P1-1/P1-2 (canonical log key names), devx CF-1 (pino-roll symlink), devx CF-3 (BridgeTimeout policy), fwdcompat (boot_nonce → bootNonce, daemonProtocolVersion mirror), lockin CF-2/CF-3 (clientImposterSecret redact + protocolVersion mirror), resource X1/X3/X4 (~/.ccsm aggregate cap, uninstall double-claim, close_to_tray key), perf CF-1/CF-2 (-sup vs control-socket clarification, traceId hot-path carve-out).
**OS-native install + data root paths (LOCKED v0.3)**:
- Win: `%LOCALAPPDATA%\ccsm\` (per-user; binaries in `bin\`, data + lock + secret + logs at root)
- macOS: `~/Library/Application Support/ccsm/`
- Linux: `~/.local/share/ccsm/`
- Legacy `~/.ccsm/` references in this fragment are historical aliases for the OS-native data root above. All NEW spec text uses `<dataRoot>` notation; concrete paths in tables resolve to OS-native.
**Inputs cited**:
- `~/spike-reports/v03-review-reliability.md`, `~/spike-reports/v03-r2-reliability.md`, `~/spike-reports/v03-r3-reliability.md`
- `~/spike-reports/v03-review-security.md`, `~/spike-reports/v03-r2-security.md`, `~/spike-reports/v03-r3-security.md`
- `~/spike-reports/v03-review-observability.md`, `~/spike-reports/v03-r2-observability.md`, `~/spike-reports/v03-r3-observability.md`
- `~/spike-reports/v03-review-resource.md`, `~/spike-reports/v03-r3-resource.md`
- `~/spike-reports/v03-r2-fwdcompat.md`, `~/spike-reports/v03-r3-fwdcompat.md`
- `~/spike-reports/v03-r2-ux.md`, `~/spike-reports/v03-r3-ux.md`
- `~/spike-reports/v03-r2-packaging.md`
- `~/spike-reports/v03-r3-devx.md`, `~/spike-reports/v03-r3-lockin.md`, `~/spike-reports/v03-r3-perf.md`

---

## 6. Reliability

v1 §6 ("Error handling and edge cases") is replaced wholesale. The bullet list below is the contract; failure-modes table F1..F12 from rel-review §2 is the canonical enumeration and is appended as §6.7. §6.8 owns user-visible surfaces (modal/toast/banner registry) and uninstall hygiene (relocated from frag-11 packaging — see Cross-frag rationale).

### 6.1 Daemon supervision (Electron-side)

Electron-main owns daemon lifecycle. Single `daemonSupervisor` module runs in main; never in renderer.

- **Spawn-or-attach** at boot via `daemonSupervisor.start()` (Task 7). Probe `<dataRoot>/daemon.lock` (see §6.4) → if held + reachable → attach; else spawn.
- **Heartbeat (prod)**: supervisor pings `/healthz` (see §6.5) every 5s on the **dedicated supervisor transport** (separate from the data-path adapter — see §6.5). Three consecutive misses (15s) → mark daemon dead, trigger restart cycle. Renderer shows yellow banner on first miss, red on third (copy table §6.1.1).
- **Heartbeat (dev)** (resolves r3-devx CF-3 contradiction with frag-3.7 §3.7.6.a): when `process.env.CCSM_DAEMON_DEV === '1'` (frag-3.7 §3.7.6), the supervisor lifecycle logic (spawn / restart / crash-loop / rollback) is DISABLED in full — nodemon owns the lifecycle, frag-3.7's auto-reconnect queue is the dev liveness signal. **The dedicated supervisor transport (§6.5 `ccsm-control` socket) is still bound** so the renderer's diagnostic UI can poll `/healthz` (read-only, no decisions). Polling cadence: 30s interval / 5-miss threshold / 60s grace; never enters crash-loop or restart logic. Concretely: in dev, the supervisor module behaves as a passive `/healthz` reader for UI, NOT a lifecycle owner. (Sources: r2-rel P0-R1, r3-devx CF-3, frag-3.7 §3.7.6.a "Supervisor active? NO" reconciled.) `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control per frag-3.4.1 §3.4.1.h table; was `-sup`]`
- **Backoff on respawn**: `1s → 2s → 4s → 8s → 16s → cap 30s`. Counter resets to 1s after the daemon stays up ≥60s. State stored in supervisor RAM only; survives renderer reload, not Electron quit. (Source: spec stub Task #936.)
- **Crash-loop detection**: ≥5 respawns within a sliding 2-minute window → enter `crash-loop-detected` state. Supervisor STOPS auto-restart, surfaces a modal banner per §6.1.1 copy table, and emits one `daemon.crashLoop` IPC to the renderer (camelCase i18n key per ux CC-3 lock; see §6.8 i18n note). The user must explicitly retry; auto-rollback to `.bak` (§6.4) is offered as one of the modal buttons. No silent restart loops.
- **Crash-loop counter reset rule (r3-rel R2 — REVISED)**: on a "successful rollback" (defined below), the **backoff counter** resets to 1s, but the **crash-loop sliding window does NOT fully clear** — instead it decays so that the rolled-back crash counts as `3 of 5` (i.e. only 2 more crashes within the 2-minute window trigger crash-loop state again, not 5). Rationale: rollback is "limp mode" — the `.bak` binary may itself have a latent crash that takes >60s to surface (e.g. periodic poll, lazy SDK init); without partial-counter retention, supervisor would silently re-enter fresh state and let 5 MORE crashes happen before user surfaces. Documented explicitly: rollback is not "all clear." **Marker-aware skip (round-7 manager lock — fixer G verify; round-9 manager lock — r8 reliability marker-unlink ownership)** `[manager r7 lock: G verify — marker-aware crash-loop skip]` `[manager r9 lock: r8 reliability — marker unlink ownership reconciled with §6.4: if marker present, supervisor skips crash-loop counter; daemon will unlink after §6.4 self-test passes — supervisor MUST NOT unlink (preserves marker across new-bundle crash-during-boot)]`: on every supervisor cold-start before applying R2 accounting, the supervisor checks for the presence of `<dataRoot>/daemon.shutdown` marker file (written by `daemon.shutdownForUpgrade` per §6.4 Marker semantics). If the marker is present, the previous shutdown was a clean upgrade — supervisor MUST NOT increment the crash-loop counter for this boot, MUST NOT trip the rollback path, and MUST NOT unlink the marker. The new daemon will unlink the marker after §6.4 self-test passes (60 s up + 5×/healthz pass) per §6.4 Marker semantics. If absent, normal R2 accounting applies. Marker-corruption / partial-write handling is treated as PRESENT (conservative — see §6.4 Marker semantics). (Source: r3-rel R2 + r7 packaging P0-2 cross-frag + r8 reliability marker-unlink ownership.)
- **Crash-loop log signature** (r2-obs P1-1): on entering crash-loop state the supervisor writes one structured pino line `{ event: "crashloop_entered", respawnCount, windowMs, lastExitCodes: [...], lastTraceIds: [...], lastBootNonces: [...] }` BEFORE emitting the IPC. Single grepable forensic anchor.
- **Cold-start failure**: if the FIRST spawn after Electron boot dies within 30s of accept-loop ready, supervisor auto-rolls back to `daemon.exe.bak` exactly once before entering crash-loop state. **"Successful rollback"** = the swapped-back binary survives 60s AND answers `/healthz` 5 consecutive times; on success, supervisor (a) clears the backoff counter, (b) **decays** the crash-loop sliding window per the R2-revised rule above (rolled-back crash = 3/5), (c) emits `daemon.rolledback` IPC. If the swapped-back binary itself fails the 60s/5-ping test, supervisor enters crash-loop state with the no-bak modal copy (§6.1.1 row "rollback-also-failed"). (Source: rel-M5 + r2-rel P0-R2 + r3-rel R2.)
- **Cold-start splash** (r2-ux P1-UX-6): renderer's HTML shell shows a `Starting ccsm…` pre-mount loader (CSS-only, no JS deps) until supervisor reports daemon ready. Cheap; eliminates blank-white-window first impression on cold installs / SmartScreen scan.

#### 6.1.1 Supervisor-state user-facing copy (drafted; sentence-case; future-i18n keys named)

Mirror of frag-8 §8.6 format. All strings are placeholders pending i18n bundle; reviewer enforces sentence case (no SCREAMING) and no developer-speak (no "DEADLINE_EXCEEDED", no "ECONNREFUSED" leaking to users — those are log-only per §6.6 and r2-ux §4 last bullet).

| State | Surface | i18n key | Title | Body | Buttons |
|---|---|---|---|---|---|
| Daemon unreachable (heartbeat-miss / reconnect-attempts-failing / reconnect-exhausted — single unified surface) | Banner (red) | `daemon.unreachable` | ccsm lost contact with the background service | Trying to restart it. If this persists, ccsm may need to be reinstalled. | (none) |
| Crash-loop (with bak) | Modal (blocking) | `daemon.crashLoop` | The background service is failing to start | We've kept your previous version available as a backup. | Restore from backup / Quit |
| Crash-loop (no bak) | Modal (blocking) | `daemon.crashLoop` | The background service is failing to start | This is a clean install with no previous version to roll back to. Please download a fresh installer from the GitHub Releases page and reinstall ccsm — sessions can't start until then. | Quit |
| Migration failed (frag-8 §8.6 fatal-error) | Modal (blocking) | `migration.modal.failed.*` | (frag-8 §8.6 owns copy) | (frag-8 §8.6 owns body) | Quit ccsm |
| Installer corrupt (carry-forward from working) | Modal (blocking) | `installerCorrupt` | (preserved unchanged from working `installerCorrupt.title`) | (preserved unchanged from working `installerCorrupt.body` — prose only, "please reinstall CCSM to repair the install") | (none — prose only per r5 lock #8) |
| Reconnected (recovery confirmation, debounced 5s) | Toast (info, 3s) | `daemon.reconnected` | Reconnected to the background service | (none) | (none) |

[manager r7 lock: cut as polish — N6# from r6 feature-parity. §6.1.1 row count trimmed from 9 → 6. The single `daemon.unreachable` row collapses the former `daemon.healthDegraded` (yellow miss-1/3) + `daemon.healthUnreachable` (red miss-3/3) + `daemon.reconnectExhausted` modal + `daemon.bridgeTimeouts` banner — daemon-split brings new failure modes that user MUST see, but degraded-but-functional middle states (yellow banner, bridge-timeout spike) are diagnostic / log-only. The two `daemon.crashLoop` rows share one i18n key; the variant column survives only because the with-bak case adds a "Restore from backup" affordance. `daemon.rollingBack` / `daemon.rolledBack` (banner + toast) cut as polish — rollback completes silently from the user's perspective; if it fails, the noBak `daemon.crashLoop` row fires. `daemon.rollbackFailed` modal collapsed into the noBak `daemon.crashLoop` row (same user remediation: reinstall).]

[manager r7 lock: C3# from r6 feature-parity — Quit button kept on `daemon.crashLoop` (both variants). Distinct from `installerCorrupt` prose pattern (r5 lock #8); user needs explicit exit affordance when daemon won't start (no other way out beyond OS window controls). r5 lock #8 specifically targeted the `installerCorrupt` "Reinstall" button, not exit-affordances. The `installerCorrupt` row remains prose-only with no button per r5 lock #8.]

[manager r7 lock: M1# from r6 feature-parity — every existing renderer Settings panel toggle (`closeBehavior`, `theme`, `fontSize`, `language`, `crashReporting`, `notifications.enable`, `notifications.sound`, `updates.automaticChecks`) survives the daemon-split unchanged. The split moves data + lifecycle + IPC, NOT the renderer's preferences UI. Implementers MUST NOT "modernize" or silently drop options as part of the v0.3 lift.]

[manager r7 lock: M2# from r6 feature-parity — `installerCorrupt` modal (working `src/components/InstallerCorruptBanner.tsx`) is preserved unchanged across the daemon-split. Title + body strings copy verbatim from working `installerCorrupt.title` / `installerCorrupt.body`; no buttons (prose-only per r5 lock #8). Surface fires when CCSM cannot find the bundled `claude` binary — distinct from `daemon.crashLoop` which fires when the daemon process fails to start.]

**i18n key casing** (ux CC-3 lock): all daemon-health keys are dot-camelCase (`daemon.<event>` or `daemon.<event>.<variant>`). Frag-3.7 already uses this convention; frag-6-7 r3 fix aligns. PUNT: frag-3.7 to align any remaining drift; PUNT: frag-8 to align migration keys (`migration.<event>` camelCase).

**zh.ts parity acceptance criterion (round-7 manager lock — r6 ux P0-4)** `[manager r7 lock: r6 ux P0-4 — zh.ts parity acceptance criterion]`: every new `en.ts` string added by v0.3 (this §6.1.1 copy table, the §6.8 surface registry rows, and any frag-3.7 / frag-8 i18n key referenced from those tables) MUST have a corresponding `zh.ts` entry shipped in the same PR. PR fails CI if `src/i18n/locales/en.ts` and `src/i18n/locales/zh.ts` keysets diverge — enforcement landed via a vitest hook (`tests/i18n/parity.test.ts`) that asserts `Object.keys(en).sort() === Object.keys(zh).sort()` for the daemon / migration / tray namespaces. Reviewer checks this mechanically before approval; no separate carve-out for "translate later".

**BridgeTimeout policy (locked, devx CF-3 + ux CC-4; r7 update for §6.1.1 trim)**: `BridgeTimeoutError` (frag-3.5.1 §3.5.1.3) is **NEVER user-surfaced as a per-call toast**. The bridge wrapper logs `DEADLINE_EXCEEDED` at warn level (with `traceId`, `method`, `durationMs`) and returns a rejected Promise to the caller; renderer-side caller code MUST NOT surface raw `BridgeTimeoutError` to a toast. Surfacing flows through TWO paths only: (a) **internal retry-once**: bridge wrapper transparently retries the call once (single retry, 1s backoff) before rejecting; if the retry succeeds, no surface fires. (b) If the retry also fails, the timeout is LOG-ONLY at the per-call level. **Continuous unreachability** (supervisor heartbeat-miss / reconnect-exhausted) is the only user-visible path and it surfaces as the unified `daemon.unreachable` red banner per the §6.1.1 row above. The standalone `daemon.bridgeTimeouts` "service may be busy" banner was **cut as polish** in r7 per N6# from r6 feature-parity (degraded-but-functional state, log-only). PUNT: frag-3.5.1 §3.5.1.3 must add a one-sentence carve-out matching this rule. (Sources: r3-devx CF-3 + r3-ux CC-4 + r7 N6# trim.)

**Handshake-failure classification (round-7 manager lock — r6 reliability P0-R1; r7 update for §6.1.1 trim)** `[manager r7 lock: r6 reliability P0-R1 — handshake failure is a distinct pre-RPC failure class; with the §6.1.1 r7 trim there is no separate "service may be busy" banner to falsely trip, so the original detector concern is moot. Tagging is still mandated for future metrics interceptor split.]`: per frag-3.4.1 §3.4.1.g (handshake-timeout paragraph), client-side handshake failures (2 s timeout, `hello_required`, `hello_replay`, `schema_violation` on `daemon.hello`, HMAC mismatch via `crypto.timingSafeEqual`, `compatible: false` reasons) surface through the existing supervisor heartbeat / reconnect ladder: each handshake-fail is one reconnect attempt under frag-3.7 §3.7.4 backoff, escalating to the unified `daemon.unreachable` red banner (whose body reads "Trying to restart it. If this persists, ccsm may need to be reinstalled." per the row above). **No new surface row is added**; the reinstall guidance lives in the body copy of `daemon.unreachable`. Implementer note: bridge wrapper MUST tag handshake errors with `class: 'handshake'` so the §3.7.4 retry path and any future metrics interceptor can split them from post-handshake `class: 'bridge-timeout'` failures cleanly (telemetry / log discriminator only — no user-surface fork).

### 6.2 PTY child reaping

Daemon owns PTY children, but the OS owns the orphan story. Without explicit reaping, every daemon crash leaks a `claude` CLI process (rel-M1).

- **Windows**: each `pty.spawn()` is wrapped in a `JobObject` with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the daemon process handle closes (clean or crash), Win SCM kills every child in the job atomically. Implemented via small N-API helper or `koffi`; same dependency as §7.M1 pipe-ACL helper, so cost is shared.
- **POSIX**: each `pty.spawn()` calls `setpgid(0, 0)` to get its own PG, plus `prctl(PR_SET_PDEATHSIG, SIGTERM)` on Linux / kqueue parent-watch on macOS. On daemon death, kernel signals the children.
- **Plan delta**: Task 11a acceptance gains "no orphaned `claude.exe` after `taskkill /F` of daemon (Win) or `kill -9` (POSIX), verified by spawning, killing daemon, then asserting `Process32First` / `pgrep` returns 0".

### 6.3 Session resurrection contract (F2)

When daemon restarts cleanly (auto-update, supervisor respawn), running PTY sessions are gone. Spec was silent; now explicit:

- Session rows in SQLite are marked `state = 'paused'` (i18n key `session.state.paused`) on daemon boot if their `pid_pgid` no longer maps to a live process. (`pid_pgid` written at spawn, cleared in the same DB transaction that writes any terminal state per §6.6.1 step 5 / r3-rel P1-R1.) **Wording change** (r2-ux P1-UX-5): the user did not abandon the session — the system did. Internal state value remains `paused`; legacy log fields may still say `abandoned` for back-compat one release.
- **Terminal-state lock (r3-rel R3)**: the canonical terminal state is `paused` for any session whose pid no longer maps. `abandoned` as a separate terminal state is REJECTED — frag-3.5.1 §3.5.1.2 step 8 is wrong if it still emits `abandoned` after SIGKILL; the SIGKILL'd row should also land at `paused` (the user-visible affordance is identical: "system restarted, [Resume]"). PUNT to frag-3.5.1: §3.5.1.2 step 8 must drop `state='abandoned'` and use `state='paused'`. The two fragments must agree on a single terminal-name. (Source: r3-rel R3.)
- Renderer shows paused sessions with a **`Paused — daemon was restarted [Resume]`** affordance. Resuming creates a fresh CLI subprocess with the same `cwd`, `model`, env subset, working directory, and seed prompt; new session id is linked back to the parent via a `parent_session_id` column. **Affordance copy explicitly notes**: `Resume creates a fresh CLI process. The previous turn (any work the model was doing when ccsm restarted) is not recovered.` (r2-rel P1-R4: in-flight CLI state is NOT magically restored.)
- No silent auto-respawn. User intent required, because the prior CLI may have been mid-write.
- (Source: rel-S3 + r2-rel P1-R4 + r2-ux P1-UX-5.)

### 6.4 Single-instance + last-known-good rollback

- **Lockfile (NOT pipe-probe)**: daemon boot acquires `<dataRoot>/daemon.lock` (Win: `%LOCALAPPDATA%\ccsm\daemon.lock`; macOS: `~/Library/Application Support/ccsm/daemon.lock`; Linux: `~/.local/share/ccsm/daemon.lock`) via `proper-lockfile` with `O_EXCL` create + PID write. The named-pipe / unix-socket bind is the secondary signal, not the gate. This closes rel-M4 (Win named pipes silently allow multi-instance via `PIPE_UNLIMITED_INSTANCES`). **Lockfile MUST be acquired BEFORE `ensureDataDir()` / migration runs** (r3-rel P0-R4 ordering — frag-8 §8.3 depends on this). Boot order: 1. acquire lockfile, 2. ensureDataDir + migration, 3. open SQLite, 4. start adapter.
- **Stale lock recovery**: if lockfile exists but PID is dead (Win: `OpenProcess` returns `INVALID_HANDLE_VALUE`; POSIX: `kill(pid, 0)` returns ESRCH), supervisor steals the lock with a single warn log line.
- **Lockfile create-fail policy** (rel-S-R4): if `proper-lockfile` create fails for any reason other than `EEXIST` (e.g. `noexec` mount, ENOSPC, EROFS), daemon refuses to start with a clear error written to stderr (pre-pino, since pino isn't initialized until after lockfile per r3-rel P1-R4) AND, when pino is up, a final fatal log line; **no silent fall-back to no-lock mode** ever.
- **Daemon binary layout** (post-pkg, Task 20): installed under `%LOCALAPPDATA%\ccsm\bin\` on Win, `~/Library/Application Support/ccsm/bin/` on macOS, `~/.local/share/ccsm/bin/` on Linux. **Per-user** path with user-only ACL — never `Program Files` (sec-S1).
- **Win Service vs user-mode** (rel-OPEN Q1): v0.3 ships **user-mode background process** only. Win Service mode is deferred to v0.4+ (no concrete demand from dogfood; user-mode is sufficient for single-user laptop scope).
- **WAL pragma at every db open** (rel-OPEN Q5): daemon explicitly sets `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` on every `Database()` open path; verified at first boot and asserted in unit test.
- **Auto-update swap is atomic** (Task 23):
  1. Download `daemon.exe.new.partial`, retry 3× with exponential backoff on net error.
  2. SHA256 verify against release manifest. **AND** verify SLSA-3 provenance attestation `provenance.intoto.jsonl` against GitHub's public OIDC root (see §7.3 v0.3 row). On either mismatch: delete `.partial`, abort, schedule retry on next 6h poll.
  3. (Linux additionally verifies a minisign signature attached to the release; see §7.3.) (v0.4+) sigstore signature verify supersedes SLSA. v0.3 ships SLSA-attested with auto-update **DEFAULT OFF** (`CCSM_DAEMON_AUTOUPDATE` opt-in); manual update prompt only. (sec-S5 + sec-OPEN-3 + r2-sec P0-S3.)
  4. **Rotate `daemon.secret`** (r2-sec P0-S1): generate fresh 32-byte random; write to `daemon.secret.new` with O_EXCL+0600/user-DACL atomically; rename over `daemon.secret`. **Pause supervisor `/healthz` polling for the swap window** (r3-sec P1-6): supervisor sets `swap_in_progress = true` so the old daemon's `/healthz` reply also carries `{ swapInProgress: true }` and the supervisor does not interpret old-secret HMAC mismatch as imposter-impersonation. Done BEFORE step 5 so the new daemon launches with the new secret AND the old binary's leaked secret loses authority on next supervisor poll.
  5. Rename current `daemon.exe → daemon.exe.bak` (atomic on NTFS via `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`).
  6. Rename `daemon.exe.new → daemon.exe`.
  7. Restart. If new daemon fails cold-start §6.1 self-test, supervisor swaps `.bak` back exactly once and surfaces a modal. **On successful rollback (60s up + 5×/healthz)** supervisor clears the backoff counter AND decays the crash-loop window per §6.1 R2 rule (rolled-back crash counts as 3/5, NOT a full clear) AND emits `daemon.rolledBack` IPC; subsequent crashes start counting from a non-zero floor. (r2-rel P0-R2 + r3-rel R2.)
- **Swap-lock (r3-rel P1-R5)**: rollback step 7 is gated by the SAME `daemon.lock` (single supervisor instance per user since lockfile gate); concurrent supervisors (double-launch, MDM relaunch, debugger spawn) are prevented from racing the swap because only the lockholder is allowed to perform binary swap operations. The swap acquires + holds the lock through verify; if a competing supervisor cannot acquire the lock, it exits cleanly.
- **Updater-script crash safety**: the rename step is a single OS call, not a "spawn batch script that waits 1s" pattern (rel-M5). The legacy batch-shim approach is explicitly rejected.
- **`daemon.shutdownForUpgrade` RPC + shutdown marker** `[manager r7 lock: r6 packaging P0-2 cross-frag — daemon.shutdownForUpgrade RPC + marker semantics; consumed by frag-11 §11.6.5 upgrade flow]`:
  - **Caller**: Electron-main, on receipt of the `electron-updater` `update-downloaded` event (BEFORE calling `autoUpdater.quitAndInstall()`). Distinct from the existing `daemon.shutdown` RPC (uninstall path, §6.8 / frag-11 §11.6.4) because upgrade flushes in-flight session writes (5 s ack window) where uninstall is destructive (2 s + kill).
  - **Daemon behavior** on receiving `daemon.shutdownForUpgrade`:
    1. Atomically write `<dataRoot>/daemon.shutdown` marker file (`O_CREAT | O_EXCL | O_WRONLY` + `rename()` from `daemon.shutdown.tmp` to `daemon.shutdown`, user-only DACL/0600). Marker payload is a single line `{ "reason": "upgrade", "version": "<current>", "ts": <epoch_ms> }` — small JSON for forensics, but presence/absence is the load-bearing signal.
    2. Run the §6.6.1 ordered shutdown sequence (drain ordering: subscribers → SIGCHLD wind-down → DB checkpoint → `pino.final`).
    3. Release the `<dataRoot>/daemon.lock` (`proper-lockfile` `unlock()`).
    4. `process.exit(0)` within **5 s** of receiving the RPC. If the daemon cannot exit cleanly within 5 s, Electron-main force-kills (frag-11 §11.6.5 step 4 fallback: `taskkill /F /PID` on Win, `process.kill(pid, 'SIGKILL')` on POSIX, then explicit `unlink(<dataRoot>/daemon.lock)` to clear the proper-lockfile stale lock dir).
  - **Marker semantics** (consumed at next daemon boot, §6.4 lockfile + §6.1 supervisor crash-loop counter):
    - Marker file present at boot time = "the previous daemon shutdown was for upgrade, expected and clean — do NOT increment the crash-loop counter (§6.1 R2 rule), do NOT trip the rollback path (§6.4 step 7 .bak swap), do NOT surface `daemon.crashLoop` modal."
    - Marker is **consumed** (`unlink()`) on the next successful daemon start — specifically, after the new daemon completes the §6.4 boot order steps 1-4 (acquire lock, ensureDataDir, open SQLite, start adapter) AND its §6.1 self-test (60 s up + 5×/healthz pass). Consuming on self-test pass not on boot-start guarantees the marker survives a crash *during* the new boot (if the new bundle is itself broken, the marker stays present and the next-next boot still treats the prior shutdown as upgrade-clean — no false crash-loop trigger from the upgrade window).
    - Marker file absent at boot = "previous shutdown was either crash, OS reboot, user-Quit, or first-ever boot — apply normal supervisor crash-loop accounting per §6.1 R2."
    - **Marker corruption / partial write** (rel-S-R8): if the marker file exists but is unreadable / malformed JSON, treat as PRESENT (conservative — prefer false-negative on crash-loop accounting over false-positive that bricks legitimate post-upgrade boots). Log `marker_corrupt` warn and unlink as part of consumption.
  - **Cross-fragment contract**: this RPC and marker are the daemon-side half of frag-11 §11.6.5's upgrade-in-place flow. The Electron-main orchestration (5 s ack timeout, force-kill fallback, explicit lock unlink, post-upgrade `spawnOrAttach` flow) lives in frag-11 §11.6.5. The supervisor crash-loop counter consumption rule lives in §6.1 (PUNT to fixer G to verify §6.1 R2 paragraph mentions the marker-skip).
  - **Allowlist registration**: `daemon.shutdownForUpgrade` is a **control-plane RPC** and MUST be added to the `SUPERVISOR_RPCS` allowlist constant declared in frag-3.4.1 §3.4.1.h. After this edit the allowlist becomes `SUPERVISOR_RPCS = ["/healthz", "/stats", "daemon.hello", "daemon.shutdown", "daemon.shutdownForUpgrade"]`. PUNT to fixer G: cross-frag merge worker MUST update the literal in frag-3.4.1 §3.4.1.h to match (also update the §3.4.1.h table's control-socket "RPCs served" cell + the §3.4.1.f migrationGate interceptor allowlist consumer cross-ref).

### 6.5 Health probe + dedicated supervisor transport

- **Dedicated transport** (r2-rel P0-R5 + r3-perf CF-1 unification + r11 devx P1-2 socket-name lock): the supervisor uses a **separate** local socket / named pipe — `\\.\pipe\ccsm-control-<userhash>` (Win) or `<runtimeRoot>/ccsm-control.sock` (POSIX) — exclusively for the canonical `SUPERVISOR_RPCS` set declared in frag-3.4.1 §3.4.1.h (currently: `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown`, `daemon.shutdownForUpgrade`) plus the `daemon.crashing` best-effort daemon→client IPC. `[manager r9 lock: r8 envelope P0-1 + r8 devx P0-1 — local enumeration removed; reference canonical SUPERVISOR_RPCS by name per §3.4.1.h "MUST NOT enumerate alternative lists" rule. Renamed prior `daemon.stats` to `/stats` to match canonical literal.]` `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control per frag-3.4.1 §3.4.1.h table; was `-sup` suffix on `ccsm-daemon-<userSid>` (Win) and `daemon-sup.sock` (POSIX); paths now mirror §3.4.1.h table exactly]` **This `ccsm-control` socket IS the same channel that frag-3.4.1 §3.4.1.h calls "control-socket"** (r3-perf CF-1 disambiguation: ONE control plane, single canonical name). Total daemon listeners: 2 — one data-path adapter, one supervisor/control transport. This eliminates the entire class of "snapshot back-pressures heartbeat" race: a 20-snapshot storm on the data-path adapter cannot delay the supervisor's heartbeat poll. Cost: ~kB RAM, one extra accept loop, same ACL/peer-cred discipline as the data path (§7.1). The supervisor transport is the SINGLE channel that ignores `MIGRATION_PENDING` short-circuit (r2-rel P1-R3) — it always returns liveness with a `migrationState` field, never a sentinel error.
- `ccsm.v1/daemon.healthz` RPC, no auth (local-only, see §7), returns:
  ```json
  { "uptimeMs": number, "pid": number, "version": string,
    "bootNonce": string, "sessionCount": number,
    "subscriberCount": number,
    "migrationState": "absent" | "pending" | "in-progress" | "done",
    "swapInProgress": boolean,
    "protocol": {
      "wire": "v0.3-json-envelope",
      "minClient": "v0.3",
      "daemonProtocolVersion": 1,
      "daemonAcceptedWires": ["v0.3-json-envelope"],
      "features": ["binary-frames", "stream-heartbeat", "interceptors", "traceId", "bootNonce", "hello"]
    },
    "healthzVersion": 1
  }
  ```
  - `bootNonce` is **camelCase** (r3-fwdcompat CF-2 lock — was `boot_nonce` snake; aligned with rest of envelope: `traceId`, `streamId`, `headerLen`, `payloadLen`). PUNT to frag-3.7 §3.7.5: any `response.boot_nonce` reads must become `response.bootNonce` to avoid silent `undefined` reads. Value is a ULID (not `Date.now()`) so two crashes within 1 ms still produce distinct ids (r2-obs OPEN-4).
  - `daemonProtocolVersion` (r3-lockin CF-2 fix): integer semver-major mirrored 1:1 from `daemon.hello` reply (frag-3.4.1 §3.4.1.g). Bumps ONLY on breaking handler-contract changes; additive features go in `features` array. Supervisor uses this to detect post-update protocol-version mismatch on a long-lived attach.
  - `daemonAcceptedWires` (r3-fwdcompat P1-5): array of wire formats this daemon accepts; v0.3 = `["v0.3-json-envelope"]`, v0.4 = `["v0.3-json-envelope", "v0.4-protobuf"]` during transition. Saves a roundtrip during v0.3→v0.4 rolling upgrade.
  - `swapInProgress` (r3-sec P1-6): true during the auto-update swap window §6.4 step 4-7; supervisor pauses imposter-secret HMAC verification while true to avoid spurious crash-loop trigger from old-daemon-with-old-secret.
  - `healthzVersion` replaces the round-2 `statsVersion` field on `/healthz` (r3-fwdcompat P1-3): two cursors confused additivity. `statsVersion` lives only on `/stats`; `healthzVersion` lives only on `/healthz`. `[manager r11 lock: P1 reliability daemon.stats → /stats sweep — literal renamed to match canonical SUPERVISOR_RPCS path per §3.4.1.h]`
  - The `protocol` block is the **canonical version-negotiation payload**, mirrored 1:1 in the `daemon.hello` handshake response (see §6.5.1). Fwdcompat P0-2.
- **`ccsm.v1/daemon.hello` handshake** (r2-fwdcompat P0-2): the FIRST envelope on every newly-accepted data-path connection MUST be `daemon.hello { clientWire: "v0.3-json-envelope", clientFeatures: [...], clientHelloNonce: "<base64-16>" }`. Daemon answers with the `protocol` block above plus `compatible: boolean` + `reason?: string` + `helloNonceHmac: "<base64-22>"`. **HMAC truncated to 16 bytes daemon-side, base64-encoded on wire (~22 chars). Client compares the full 22-char string via `crypto.timingSafeEqual` (equal-length buffers required, otherwise `RangeError`). Source of truth: §3.4.1.g (and §7.2 generator).** [manager r7 lock: r6 security P2-10 — HMAC wire format unified across §3.4.1.g + §6.5 + §7.2 to base64-22 (16-byte daemon-truncated). Prevents RangeError on first connection.] **Daemon refuses to dispatch any other RPC on this connection until hello completes**; on `compatible: false`, daemon closes the connection with a clean error code (NOT cryptic `not_found`). v0.4 protobuf swap declares `wire: "v0.4-protobuf"` and the v0.3 daemon refuses with `compatible: false, reason: "wire-mismatch"`. **(Hello-handshake posture is unified across both sockets per §3.4.1.h canonical: data-socket and `ccsm-control` socket share peer-cred / DACL / accept-rate-cap / hello-handshake posture. `[manager r9 lock: hello-handshake unified — both sockets share posture per §3.4.1.h canonical; supersedes prior r2 "supervisor transport skips hello" wording which contradicted the helloInterceptor #0 contract and would have triggered a destroy-loop on every supervisor heartbeat. r8 envelope P0-2.]` `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control per frag-3.4.1 §3.4.1.h table; was `-sup`]`)
- Supervisor polls every 5s prod, 30s dev (§6.1). Cheap (~50µs).
- v0.4 adds `/readyz` returning `{ migration: 'pending'|'in-progress'|'done' }` for SQLite migration gating; v0.3 ships `/healthz` only with embedded `migrationState` field.
- A separate `/stats` (obs-S6) returns `{ statsVersion: 1, rss, heapUsed, ptyBufferBytes, openSockets }` — diagnostic-grade RPC, not part of the supervisor liveness contract. `statsVersion` enables additive evolution without renderer breakage (r2-obs P1-4). `[manager r11 lock: P1 reliability daemon.stats → /stats sweep — literal RPC name renamed to match canonical SUPERVISOR_RPCS literal per §3.4.1.h; control-plane namespace exempt from ccsm.v1/... per §3.4.1.h literal-vs-namespace lock]` [manager r7 lock: cut as polish — N8# from r6 feature-parity. The internal RPC stays (useful for healthz/diagnostic IPC + future v0.4 inspector tooling), but the tray-menu "Daemon stats…" entry is DELETED — v0.2 tray menu is `[Show CCSM | Quit]` only and v0.3 is refactor scope, no new tray entries.]

#### 6.5.1 Server-side stream-dead detector (round-7 manager lock — r6 reliability P0-R2)

`[manager r7 lock: r6 reliability P0-R2 — daemon-side symmetric dead-stream detector at 2 × heartbeatMs + 5 s; v0.3 local pipe / unix socket = no-op (kernel close fires first), but byte-compatible with the v0.5 CF Tunnel TCP swap reserved at frag-3.4.1 §3.4.1.c x-ccsm-deadline-ms 120 s clamp + x-ccsm-trace-parent header. Without this, the v0.5 TCP path has no half-open recovery short of OS TCP-keepalive (default 2 hours).]`

Frag-3.5.1 §3.5.1.4 owns CLIENT-side dead-stream detection at `2 × heartbeatMs + 5 s` (default 65 s) and notes that on a stuck-reader-but-healthy-network case the server side falls back to heartbeat-write-failure tripping drop-slowest at the 1 MiB watermark (§3.5.1.5). On v0.3 local pipe / unix socket this is reliable — kernel close arrives in milliseconds and `writable === false` fires within one OS scheduler tick. **It is NOT reliable on a future v0.5 TCP transport.** A half-open TCP socket (client device sleeps, NAT entry expires, WiFi drops) leaves the daemon's send buffer slowly filling because PTY traffic is keystroke-sized; on a low-traffic stream (idle PTY + 30 s heartbeat) the buffer fill takes ~30 minutes to reach the 1 MiB drop-slowest trip, during which the slow-subscriber LRU cap `min(N × 1 MB, 4 MB)` holds memory hostage. The OS-default TCP keepalive does not fire until 2 hours.

**Rule**: the daemon maintains a per-stream `lastClientActivityAt` timestamp updated on (a) any inbound unary RPC dispatched on the same connection, (b) any client-issued frame on the same connection (future v0.5 ACK frame, reserved). The shared heartbeat scheduler (§3.5.1.4) — already iterating `Map<streamId, { lastWriteAt, heartbeatMs }>` once per second — additionally checks `now - lastClientActivityAt > 2 × heartbeatMs + 5_000`. If exceeded, the daemon:

1. Treats the stream as dead and the underlying CONNECTION as dead (one half-open socket means the whole connection is suspect).
2. Closes the stream with `RESOURCE_EXHAUSTED, reason: 'server-stream-dead'` and `socket.destroy()` on the underlying connection.
3. Emits one structured log line `{ event: 'server_stream_dead', sid, streamId, lastClientActivityMsAgo, heartbeatMs, peerPid }` (single line, NOT per-stream-on-connection — the connection close cascades to all dependent streams; aggregate one log line per close).
4. The fan-out registry (frag-3.5.1 §3.5.1.5) removes the dropped subscriber the same way drop-slowest already does — no separate accounting path; the slow-subscriber drop log line and `subscribers-closed` aggregator both stay valid.

**v0.3 expected behaviour**: on local pipe / unix socket, this detector is a NO-OP — the kernel `'close'` event arrives long before `2 × heartbeatMs + 5 s` elapses, the existing socket-level `'error'` / `'close'` path runs first, and the stream is gone before the scheduler tick examines `lastClientActivityAt`. Spec it now so the v0.5 TCP swap is byte-compatible with no contract change. The v0.5 wire-format swap (frag-3.4.1 §3.4.1.c reserves `x-ccsm-trace-parent` and the 120 s deadline clamp for this transition) inherits this detector unchanged.

**Symmetry with client side**: client uses `2 × heartbeatMs + 5_000` (§3.5.1.4); server now uses the same window. Both sides agree the connection is dead at the same moment, eliminating a window where the client retries but the daemon still holds the registry slot.

**Heartbeat scheduler cost impact**: the existing 1 s scheduler tick already walks the per-stream Map; adding a `lastClientActivityAt` comparison is one extra integer subtraction per stream per tick. At v0.5 100-session × 10 streams scale this is 1000 extra subtractions per second — negligible.

**Cross-frag handoff**: frag-3.5.1 §3.5.1.4 "Server-side dead-client detection" paragraph should add a sentence "Symmetric server-side detector at `2 × heartbeatMs + 5 s` is owned by frag-6-7 §6.5.1 — covers the v0.5 half-open TCP case where heartbeat-write-failure may not fire for hours." Cross-frag merge worker reconciles. (No edit applied here — this fragment cannot edit frag-3.5.1; flagged for fixer G traceability.)

### 6.6 Logging shutdown safety + rotation + correlation

Observability is a reliability concern in v0.3 because the bug surface is split across two processes. The four obs-MUST items are first-class spec contracts.

#### 6.6.1 Daemon-side logger

- **`pino.final()` on every exit path** (obs-MUST-2, addressing P0 #11): daemon installs `pino.final(logger, (err, finalLogger) => { finalLogger.fatal(err); process.exit(1); })` plus `process.on('SIGTERM' | 'SIGINT' | 'beforeExit' | 'uncaughtException' | 'unhandledRejection')` handlers that call `logger.flush()` synchronously. The default async destination stays for hot path; `pino.final` is the shutdown valve.
- **Drain ordering for log producers** (r2-obs P0-3 + r3-rel P0-R1 reorder): `pino.final` only flushes pino's destination buffer, NOT producer-side timers/callbacks that are still emitting lines. On SIGTERM/SIGINT, daemon executes the following ordered sequence BEFORE invoking `pino.final`. **Critical R1 fix**: SIGCHLD wind-down + DB terminal-state writes happen BEFORE subscriber close, so PTY-exit events generated during shutdown still reach in-RAM consumers (notify producer, telemetry counter, future audit interceptor). Subscriber-close is the LAST runtime act before pino.final.
  1. Set `state = 'draining'` (module-level flag visible to all log producers).
  2. `clearInterval` every per-stream heartbeat timer (frag-3.5.1 §3.5.1.4 — list maintained as `streamHeartbeats: Set<NodeJS.Timer>`).
  3. Reject all pending reconnect-queue / in-flight bridge calls with a single aggregated log line `{ event: "daemon-shutdown", droppedCalls: N }` (NOT N lines).
  4. **(SIGCHLD wind-down BEFORE subscriber close, r3-rel R1)** Mark all `state='running'` sessions to `state='shutting_down'` in one transaction. Issue `SIGTERM` to each PG; wait up to 200ms per child; `waitpid(pid, WNOHANG)` per known PID (NOT `waitpid(-1)`) to avoid stealing reaps from logger/telemetry deps; survivors get `SIGKILL` to the pgroup. Mark surviving 'shutting_down' rows to `state='paused'` (per §6.3, NOT `abandoned` per r3-rel R3) in one transaction, AND clear `pid_pgid` in the same transaction (r3-rel P1-R1). **The `paused` write MUST be `UPDATE sessions SET state='paused', pid_pgid=NULL WHERE state='shutting_down'`** `[manager r7 lock: r6 reliability P1-R4 — explicit WHERE state='shutting_down' clause prevents the SIGCHLD-clean-exit vs SIGKILL-deadline race from double-writing a row that already transitioned to 'exited'. Without the WHERE clause, a child that clean-exits between the 200 ms cap and the SIGKILL deadline could land BOTH 'exited' (from SIGCHLD handler step 6 in frag-3.5.1 §3.5.1.2) AND 'paused' (from the sweep here / step 8 there); the WHERE-state guard makes the sweep idempotent and order-independent. PUNT to fixer G: cross-frag merge worker MUST verify frag-3.5.1 §3.5.1.2 step 8 mirrors this exact WHERE clause.]` `PRAGMA wal_checkpoint(TRUNCATE)`. `db.close()`. Throughout this step, the in-RAM fan-out registry is still live and any `ptyExit` event reaches subscribers + in-process consumers.
  5. Iterate fan-out subscriber registry once; close each subscriber stream with `RESOURCE_EXHAUSTED, reason: 'daemon-shutdown'`; emit ONE aggregated `{ event: "subscribers-closed", count: N }` line (NOT N drop lines). This is the LAST runtime act (was step 4 in r2; moved to step 5 per r3-rel R1).
  6. THEN `pino.final` runs.
  7. THEN `process.exit(0)`.
- **Crash-imminent IPC (best-effort, NOT guaranteed)** (r2-rel S-R1 + r3-rel R5): in the fatal handler, BEFORE `pino.final` runs, daemon emits a single best-effort `daemon.crashing` envelope on the supervisor transport so renderer can fail in-flight bridge calls immediately rather than waiting 5s for `BridgeTimeoutError`. **CRITICAL: this IPC is OPPORTUNISTIC.** It fires only when the daemon dies via a Node-observable path (`uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGINT`). On SIGKILL (OOM killer, `taskkill /F`, kernel panic, supervisor's own forced restart, segfault in native binding), no fatal handler runs and no `daemon.crashing` IPC ships. The renderer MUST NOT gate fast-fail on this IPC alone — the **authoritative liveness path** is supervisor `/healthz` 3-miss + bridge 5s timeout (a "we got crashing IPC OR healthz pings within 15s" gate is correct; "we got crashing IPC OR healthz pings" — without timeout — would hang on SIGKILL). Renderer code that observes neither MUST fall back to BridgeTimeoutError after 5s. (Source: r3-rel R5.)
- **Log rotation** (obs-MUST-3 + res-MUST-1, addressing P0 #12 + r3-devx CF-1): `pino-roll` with `{ frequency: 'daily', size: '50M', limit: { count: 7 }, mkdir: true, symlink: true }`. Files at `<dataRoot>/logs/daemon-YYYY-MM-DD.log`; `symlink: true` (r3-devx CF-1 + r3-resource X2 punt pickup) maintains a stable `daemon.log` symlink → current rotated file so POSIX `tail -F` AND tray "Open daemon log" survive daily rotation. (Win `Get-Content -Wait` follows the symlink target by inode at start; r3-devx P1-4 documents this Windows caveat — tray entry on Win opens the current rotated file directly, not the symlink.) Rationale for `pino-roll` over `pino-rotating-file`: maintained inside the pino org (`pinojs/pino-roll`), supports daily AND size-based rotation in a single transport with file-count cap, native `symlink: true` support, is the option pino's own docs link to first; `pino-rotating-file` is a third-party fork with no recent releases. **Decision: pino-roll.**
- **Aggregate `<dataRoot>` disk cap (r3-resource X1)**: per-side pino-roll caps `7 × 50 MB = 350 MB` per side, so daemon + electron logs ≤ 700 MB. Add explicit aggregate watchdog: **logs aggregate cap = 500 MB** (warn at 400 MB log line, hard prune oldest rotated files when total `<dataRoot>/logs/*` exceeds 500 MB regardless of pino-roll's per-file count); **crash-dump aggregate cap = 200 MB** (in addition to 30-day retention §6.6.3 — pruned oldest first when exceeded; covers the daemon-crash-loop-pre-supervisor-detection storm case). Watchdog runs at supervisor.start() AND once per pino-roll rotation tick (per r3-sec P1-3). Total `<dataRoot>/` floor for v0.3 ~1 GB (logs 500 MB + crashes 200 MB + corrupt-backups 100 MB × few + data + WAL).
- **Correlation ID** (obs-MUST-1 + r3-perf CF-2 carve-out): every IPC envelope (§3.4 / §3.4.1) carries a `traceId: ULID` generated renderer-side and propagated through bridge → Connect adapter → handler → log. **`traceId` MUST appear in the binary frame header schema, not just JSON envelopes** (r2-obs P0-2; coordinate edit with frag-3.4.1 §3.4.1.c). Every `logger.info/warn/error` call inside a handler MUST include `{ traceId }`. Daemon-originated events (e.g. `ptyExit` from SIGCHLD, fan-out drop logs, heartbeat ticks) carry the **session's `spawnTraceId`** (set at session create, persisted on session row) so spawn → exit lines correlate (r2-obs OPEN-3). `subscriber-dropped-slow` log line MUST include `{ traceId, sessionId, subscriberId, droppedBytes, ageMs }`. **Hot-path carve-out (r3-perf CF-2)**: per-chunk fan-out write logs are **debug-level only** (suppressed at default `info` level) AND when emitted MUST source `traceId` from the cached `streamId → spawnTraceId` map established at `kind:'open'` (NOT generate or stringify a fresh ULID per chunk). Per-frame info-level logging on PTY hot path is FORBIDDEN — would burn ~1000 ULID-stringifications/s on a noisy session. The 1000+/s budget belongs to per-chunk byte-counters (no traceId).
- **TraceId validation** (r2-sec P1-S2 + r3-sec CC-2): every accepted envelope's `traceId` is validated server-side against `^[0-7][0-9A-HJKMNP-TV-Z]{25}$` (Crockford ULID alphabet, fixed length); reject + drop on mismatch with `{ event: "traceid-malformed", offenderPid, raw: <first-32-bytes> }` log line. **Validation runs only when `traceId` is present in the header.** For inheriting sub-frames (`stream.kind === 'chunk' | 'heartbeat'`), the traceId is resolved from the `streamId → traceId` map established at `kind: 'open'`; missing inherited mapping is itself a protocol error and closes the stream with `RESOURCE_EXHAUSTED`. Daemon-emitted log lines include both `traceId` (caller-supplied, untrusted, for correlation) and `daemonTraceId` (daemon-generated ULID, authoritative). pino formatter strips `\n\r` from any string field destined for non-JSON destinations to prevent log injection.
- **Daemon identity in every line** (obs-MUST-4): pino base config = `{ side: 'daemon', v: DAEMON_VERSION, pid: process.pid, boot: bootNonce }` so post-update logs are unambiguous. `boot` is a ULID (r2-obs OPEN-4); field name in the log is `boot` (the camelCase distinction applies to wire field `bootNonce` per r3-fwdcompat CF-2; the pino base log key is `boot` for compactness, with the value being the same ULID).
- **Secret redaction** (sec-S4 + r2-sec P0-S1 #4 + r3-lockin CF-3): pino `redact` paths ship from day one — `["*.apiKey", "*.token", "Authorization", "Cookie", "ANTHROPIC_API_KEY", "*.payload.value", "env.ANTHROPIC*", "daemonSecret", "installSecret", "pingSecret", "helloNonce", "clientHelloNonce", "helloNonceHmac", "*.secret"]`. The `helloNonce` + `clientHelloNonce` + `helloNonceHmac` paths added per r3-lockin CF-3 + r3-sec P0-1 (HMAC-of-nonce wire shape lock — see §7.2; the legacy `imposterSecret` / `clientImposterSecret` cleartext fields were eliminated by the HMAC-of-nonce handshake and are no longer present anywhere in the wire schema). PTY chunk bodies are NEVER passed to logger; only `{seq, len}`. Vitest hook asserts no `chunk.toString()` appears in any logger call inside `ptyService` (obs-OPEN PII). Lint hook asserts no logger call site ever passes the resolved value of `daemon.secret`.
- **Dev redact superset** (r2-sec SH1): when `CCSM_DAEMON_LOG_LEVEL === 'debug'`, redact list extends with `["*.value", "*.body", "*.input", "*.req", "*.params"]` to cover broader debug-payload shapes. Documented in frag-3.7 §3.7.6 dev-vs-prod table cross-ref.
- **Network-FS rejection**: on boot, daemon refuses to start if `<dataRoot>` resolves to a OneDrive / SMB / network mount (rel-OPEN 6). Surface a clear error — pino + WAL on a network FS is data-loss territory.
- **Canonical reconnect / bridge log key names** (r3-obs P1-2 — explicit list, PUNT to frag-3.7 §3.7.4 for cross-ref): the bridge call lifecycle log lines have FIXED string keys, not free-form. Implementers MUST use these exact strings (no `reconnect-attempted`-style improvisation):
  - `bridge_call_complete` (every bridge call, success or error)
  - `daemon_socket_closed`
  - `daemon_reconnect_attempt` (with `{n, delayMs}`)
  - `daemon_reconnect_success` (with `{durationMs, queueDrained}`)
  - `daemon_queue_overflow` (with `{droppedMethod, queueAge}`)
  - `stream_resubscribe` (with `{sid, fromSeq, fromBootNonce, gap}`)
  - `crashloop_entered`, `subscribers-closed`, `daemon-shutdown`, `traceid-malformed`, `slsa_verify_failed`, `swap_in_progress` (already named above; listed here for one-stop reference)

#### 6.6.2 Electron-side logger (r2-obs P0-1, P0-4)

The Electron-main logger is a first-class peer of the daemon logger so cross-process trace correlation works without a third tool.

- **Module location**: `electron/log.ts` runs in main only. Renderer `console.error/warn` is forwarded via preload bridge to main when `CCSM_RENDERER_LOG_FORWARD=1` (default ON in dev, OFF in prod for perf — r2-obs OPEN-1). Renderer never writes files directly.
- **Same `pino-roll` config** as daemon (`{ frequency: 'daily', size: '50M', limit: { count: 7 }, mkdir: true, symlink: true }`) writing to `<dataRoot>/logs/electron-YYYY-MM-DD.log` (with stable symlink `electron.log`).
- **Base fields**: `{ side: 'electron', v: APP_VERSION, pid: process.pid, boot: electronBootNonce }`. The `side` discriminator is REQUIRED so log aggregation does not collide daemon and electron lines that share `{v, pid, boot}` keys (r2-obs P0-1 explicit fix).
- **Same redact list** as daemon §6.6.1, PLUS renderer-leaning paths: `["*.url", "*.searchParams", "*.headers", "*.formData"]`.
- **`pino.final` analog on every Electron-main exit path** (r2-obs P0-4): registered against `app.before-quit`, `app.will-quit`, `process.on('uncaughtException')`, `process.on('unhandledRejection')`, AND the supervisor crash-loop modal "Quit" / "Restart ccsm" button handlers. Without this, the most diagnostic moment (the crash) is lost from the Electron side.
- **Bridge call lifecycle log lines** (r2-obs P1-3, contract enumeration): every bridge call wrapper emits `logger.info({ traceId, method, durationMs, status }, "bridge_call_complete")` on completion (success or error). Reconnect path emits the canonical set: `daemon_socket_closed`, `daemon_reconnect_attempt {n, delayMs}`, `daemon_reconnect_success {durationMs, queueDrained}`, `daemon_queue_overflow {droppedMethod, queueAge}`, `stream_resubscribe {sid, fromSeq, fromBootNonce, gap}`. Audited via vitest hook (`no-bridge-call-without-completion-log`).
- **Frag-12 matrix amendment**: row `obs-M2` should be re-rated GREEN as "addressed in §6 (daemon + electron)" rather than the current PARTIAL "addressed in §6". Row `obs-M4` similarly: GREEN with explicit `side: 'electron'` discriminator.

#### 6.6.3 Crash-dump file (r2-obs P1-5, expanded from plan delta line)

- Path: `<dataRoot>/crashes/crash-<isoTs>-<bootNonce>.json` (daemon) and `<dataRoot>/crashes/electron-crash-<isoTs>-<bootNonce>.json` (Electron-main). User-only ACL (0600 / equivalent Win DACL). **Filename components are sanitized via `path.basename(s).replace(/[^A-Za-z0-9._-]/g, '_')` before path concatenation** (r3-sec P1-5 — defense in depth against future ULID-impl swap that emits non-Crockford characters).
- Schema: `{ side, v, pid, boot, errMessage, errStack, lastTraceIds: [...8], lastSessions: [...20], stats: { rss, heapUsed }, ts }`. Fields are REDACTED via same pino redact list before write — crash dumps must never contain secrets.
- Retention: 30 days AND aggregate per-side cap 200 MB (r3-resource P1 — see §6.6.1 aggregate cap rule). Pruning runs (a) at `daemonSupervisor.start()` AND (b) once per pino-roll rotation tick (r3-sec P1-3 — covers the case where daemon never restarts because auto-update is OFF default).
- **NEVER auto-uploaded.** User-driven attach to issue only. (r2-sec T13 row.)

### 6.7 Failure modes (canonical table)

| # | Failure | What user sees | State left valid? | Recovery |
|---|---|---|---|---|
| F1 | Daemon crash mid-PTY | xterm freezes; banner | PTY children reaped via §6.2 | Supervisor auto-respawn §6.1; sessions become "paused" §6.3 |
| F2 | Daemon restart with running sessions | Sessions appear as "Paused — daemon was restarted [Resume]" | SQLite session rows survive; runtime state lost | User-triggered resume with prior `cwd`+`model`+env (§6.3) |
| F3 | Electron crash mid-PTY | Tray gone; v0.5 web client unaffected | Daemon + PTY survive; replay buffer in daemon RAM | Reopen Electron → `spawnOrAttach` → `ptySubscribe(fromSeq, fromBootNonce)` resumes |
| F4 | SQLite write interrupted (kill -9) | Next boot opens DB | better-sqlite3 + WAL crash-safe at statement granularity; multi-statement ops MUST be wrapped in `db.transaction()` | WAL replay; explicit transaction wrappers per Task 8/12/13 audit (rel-M3) |
| F5 | Two-daemon race | N/A (lockfile rejects 2nd) | Lockfile §6.4 is gate; pipe bind is secondary | 2nd daemon exits cleanly with non-zero code |
| F6 | Local socket hijack | N/A (peer-cred rejects) | §7.M1 ACL + §7.M2 peer-cred enforce same-user boundary | Rejected at adapter; logged with offender PID/SID |
| F7 | Updater swap mid-rename | Daemon may be unbootable from new binary | `.bak` always present; auto-rollback once | §6.4 step 7 (rollback + modal); crash-loop counter cleared on success (r2-rel P0-R2) |
| F8 | Update download interrupted | Silent retry next 6h poll | Old binary intact; SHA + SLSA mismatch caught | 3× exponential backoff retry within current poll window |
| F9 | Bridge call to dead daemon | Banner + error toast (not infinite hang) | `rpcCall` 30s deadline + AbortSignal (rel-M2) | Supervisor heartbeat already firing on dedicated transport (§6.5); `daemon.crashing` IPC fails in-flight calls fast |
| F10 | Two clients writing same PTY (v0.5 only) | "Another client is typing" banner | v0.3: single-writer lease; v0.5: explicit handoff | Handled at `ptyWrite` lease layer (rel-S6); not a v0.3 ship-blocker |
| F11 | xterm-headless RAM growth | Daemon RSS climbs with N idle sessions | 10k scrollback hardcoded (`entryFactory.ts:43`); v0.3 hard cap: total headless-buffer RSS ≤ 400 MB → new spawns blocked with clean error (rel S-R7) | Tag idle eviction as v0.4 prereq (res-S3) |
| F12 | Pino crash-loss | N/A (covered by `pino.final` + drain-ordering §6.6.1) | §6.6 | obs-MUST-2 + r2-obs P0-3 |

### 6.8 User-visible surface registry + uninstall hygiene

**Surface registry (CANONICAL — r3-ux P0-A lock)**: §6.8 is the **single canonical** registry of every modal/toast/banner that v0.3 surfaces, with priority and mutual-exclusion rules. Each fragment that introduces a surface MUST register a row here rather than inventing copy in isolation. Round-2 left two parallel registries (frag-3.7 used tier 1-6 numbering, this fragment uses numeric priority 30/50/70/85/90/100); the dual registries had different rules and overlapping copy. Manager lock: §6.8 wins because (a) richer numeric-priority numbering, (b) explicit stacking rules, (c) owns the supervisor surfaces which are the dominant set. The registry below now includes ALL surfaces (dev-mode reconnect, BridgeTimeout policy, stream-gap, queue-overflow) so frag-3.7 reduces to a cross-ref to §6.8.

| Priority | Surface | Type | Source | Owner i18n key prefix | Suppresses |
|---|---|---|---|---|---|
| 100 (top) | Migration in progress | Modal (blocking, non-dismissable*) | frag-8 §8.6 | `migration.*` | All lower |
| 90 | Installer corrupt (carry-forward from working) | Modal (blocking, prose-only) | §6.1.1 (M2#) | `installerCorrupt` | All lower |
| 85 | Crash-loop (with/no bak) | Modal (blocking) | §6.1.1 | `daemon.crashLoop` | All lower |
| 85 | Migration failed (frag-8 §8.6 fatal-error) | Modal (blocking) | frag-8 §8.6 | `migration.modal.failed.*` | All lower |
| 70 | Daemon unreachable (red banner) | Banner | §6.1.1 | `daemon.unreachable` | Reconnect toast |
| 30 | Daemon reconnected (recovery confirmation, debounced 5s) | Toast (info, 3s) | §6.1.1 | `daemon.reconnected` | (none) |
| 30 | Paused-session affordance (carry-forward from working) | Inline UI | §6.3 | `session.state.paused` | (none) |

[manager r7 lock: cut as polish — N6# from r6 feature-parity. §6.8 row count trimmed from 16 → 7 (5 daemon-split-driven rows + 1 migration-in-progress + 1 paused-session inline UI from working). Cut rows: `daemon.healthDegraded` (P=70 yellow miss-1/3), `daemon.healthUnreachable` (collapsed into `daemon.unreachable`), `daemon.rollingBack` (P=70 banner), `daemon.rolledBack` (P=30 toast), `daemon.rollbackFailed` (P=85 modal — collapsed into noBak `daemon.crashLoop`), `daemon.reconnectExhausted` (P=85 modal — collapsed into `daemon.unreachable` banner), `daemon.bridgeTimeouts` (P=70 banner), `daemon.devReconnecting` (P=70 dev-mode banner), `daemon.reconnecting` (P=50 250 ms hold-off toast — log-only at the per-attempt level; user sees `daemon.unreachable` only when reconnects keep failing), `daemon.queueOverflow` (P=50 toast), `daemon.streamGap` (P=30 toast — xterm divider may still render as a renderer-side affordance, but no toast/IPC), `daemon.devBuildError` (P=30 dev toast). The migration "Migration failure (4 variants)" row at P=90 collapsed into a single P=85 `migration.modal.failed.*` row matching frag-8 §8.6 r7 trim canonical i18n key prefix (one fatal-error modal, not 4 copy variants). `[manager r9 lock: r8 devx P0-3 + r8 reliability P1-2 — annotation key updated from stale `daemon.migrationFailed` to canonical `migration.modal.failed.*` matching frag-8 §8.6 owner declaration; prevents tests/i18n/parity.test.ts divergence between implementers reading the row vs the lock annotation]`. One `installerCorrupt` row added at P=90 per M2# (carry-forward from working).]

[manager r7 lock: cut as polish — N4# from r6 feature-parity. The "Close-to-tray onboarding hint (one-shot)" row at P=30 (i18n `tray.closeHint`) is DELETED. Working's existing `closeBehaviorOptions.ask` first-close prompt covers the discoverability concern unchanged; no parallel onboarding moment. The `app_state.close_to_tray_shown_at` SQLite key (formerly mandated by §6.8 + r3 manager arch decision #2 + Task 21 wiring) is also DELETED — no SQLite migration row for it; existing renderer close-prompt logic preserved as-is.]

[manager r7 lock: cut as polish — N8# from r6 feature-parity. The "Daemon stats…" tray menu entry referenced in §6.5 is DELETED as a user-visible surface. Internal `/stats` RPC remains (wire concern, useful for healthz/diagnostic IPC + future v0.4 inspector tooling), but no tray menu growth in v0.3.] `[manager r11 lock: P1 reliability daemon.stats → /stats sweep — internal RPC literal renamed to match canonical SUPERVISOR_RPCS path per §3.4.1.h]`

[manager r7 lock: cut as polish — N1# from r6 feature-parity. The macOS tray menu "Reset CCSM…" / "Reset ccsm…" entry is DELETED entirely from the in-app surface contract below. macOS uninstall = "drag CCSM.app to Trash" + release-notes documentation; no in-app tray entry. PUNT to fixer addressing frag-11 §11.6.2: drop the corresponding "Reset CCSM…" tray-menu item from the macOS uninstall bullet. If a "Reset" entry exists elsewhere as a Settings panel button in working, that's preserved unchanged (M1# settings preserved); only the NEW tray menu entry is cut.]

\* **Migration "non-dismissable" callout (r3-ux P0-B)**: priority 100 is the top of the registry, so the auto-dismiss-on-higher rule (stacking rule 1) NEVER applies to migration — there is no priority >100 surface in v0.3. frag-8 §8.6's "dismissable: false" wording is consistent with §6.8 (priority dominance + no higher priority exists ⇒ effectively non-dismissable). Implementer note: the migration modal has no close button; the only exit is migration completion or one of the failure variants (priority 90, which IS dismissable). No code-level "non-dismissable" flag required — priority is the sole gating mechanism.

**Stacking rules**:
1. At most ONE blocking modal visible at a time. If a higher-priority modal arrives while a lower one is showing, the lower one is dismissed (and its IPC re-fires when the higher one closes). Migration (priority 100) is the apex and is never dismissed by any other surface.
2. A blocking modal suppresses all toasts of priority <50.
3. A banner of priority ≥70 suppresses any toast that targets the same daemon-health event class. Concretely: `daemon.healthDegraded` banner suppresses `daemon.reconnecting` toast.
4. Toasts of equal priority stack vertically up to 3; oldest is dismissed when a 4th arrives.
5. Reconnect toast escalates to `daemon.unreachable` red banner once handshake / reconnect attempts pass the supervisor's miss threshold; per the §6.1.1 r7 trim there is no separate `reconnectExhausted` modal (collapsed into the `daemon.unreachable` body copy "If this persists, ccsm may need to be reinstalled.").
6. **Equal-priority deterministic tie-break (round-7 manager lock — r6 ux P0-2)** `[manager r7 lock: r6 ux P0-2 — equal-priority tie-break = registry insertion order]`: if two surfaces share the same numeric priority, the one registered FIRST in the boot-time registry wins (`Map` insertion order is the deterministic tiebreaker — same-tick later same-priority IPCs are dropped, not queued, and re-fire only if the winning surface is closed AND the underlying state is still active). Insertion order across the v0.3 priority bands matches the row order shown in the §6.8 table above (top-to-bottom = first-to-last). After the r7 row trim the only same-priority bands are P=85 (`daemon.crashLoop` → `daemon.migrationFailed`) and P=30 (`daemon.reconnected` → `session.state.paused`). No per-event sort key is required; the renderer's `useDaemonHealthBridge` consults the registry `Map` directly.

**Single-source IPC** (r2-ux P0-UX-1 architectural fix): all daemon-health events (reconnect, supervisor heartbeat, crash-loop) are emitted on ONE `daemonHealth` IPC channel with a discriminated-union payload `{ kind, severity, ... }`. The renderer has ONE `useDaemonHealthBridge` hook that owns the surface registry lookup and stacking rules. Per-fragment bridges (`useDaemonReconnectBridge`, `usePersistErrorBridge`) are deprecated in v0.3.1 in favor of this consolidation.

**v0.2 → v0.3 close-to-tray onboarding — DELETED in r7** [manager r7 lock: cut as polish — N4# from r6 feature-parity. The one-shot close-to-tray onboarding toast (formerly `tray.closeHint` at P=30) AND the SQLite `app_state.close_to_tray_shown_at` row are DELETED entirely. Working's existing `closeBehaviorOptions.ask` first-close prompt with `dontAskAgain` checkbox already covers the discoverability concern unchanged; no parallel onboarding moment. Renderer-side close-prompt logic preserved as-is — the cut is the NEW onboarding toast, not the existing close-prompt. No Task 21 wiring required for this surface; no app_state migration row required for the SQLite key.]

**Uninstall hygiene** (pkg P0-1 — r3-resource X3 ownership split):

The uninstall path is split between two fragments. **§6.8 owns the in-app daemon-shutdown contract** (the IPC contract used by the NSIS macro to gracefully ask the running daemon to drain). **frag-11 §11.6 owns the on-disk paths and OS installer mechanics** (NSIS macro contents, `.deb postrm`, `.rpm preun`, `nsis.include` wiring, `customUnInstall` macro shape). The two fragments must agree on the daemon-shutdown sequence (kill before lockfile delete) but the canonical implementation lives in frag-11.

In-app surface contract (owned here):

- **macOS tray menu Reset entry — DELETED in r7** [manager r7 lock: cut as polish — N1# from r6 feature-parity. The "Reset CCSM…" / "Reset ccsm…" tray menu entry is DELETED entirely from the in-app surface contract. macOS uninstall is "drag CCSM.app to Trash" + release-notes documentation for `~/Library/Application Support/ccsm/` cleanup; no in-app tray menu growth in v0.3 (tray menu stays at working's `[Show CCSM | Quit]`). PUNT to fixer addressing frag-11 §11.6.2: drop the corresponding "Reset CCSM…" tray-menu item from the macOS uninstall bullet.]
- **NSIS macro daemon-shutdown sequence (Windows; macro lives in frag-11 §11.6)**: the macro MUST `taskkill /IM ccsm-daemon.exe /F` BLOCKING (wait for exit code) BEFORE removing `<dataRoot>/daemon.lock`; the kill-before-unlock ordering is the contract owned here, the script that implements it lives in frag-11.
- **Linux postrm/preun**: same kill-before-unlock contract; `systemctl --user stop ccsm-daemon` (if launched as systemd-user-service in v0.3.1) OR `pkill -TERM ccsm-daemon`. Implementation in frag-11 §11.6.
- **Order matters** (r2-pkg P1-5): kill daemon BEFORE removing lockfile. If the order inverts, a slow daemon shutdown holds the lock past `RMDir`, causing a partial-clean state that confuses the next install. (Contract is canonical here; enforcement lives in frag-11.)

---

## 7. Security

Replaces v1 §7 (which moves to §8 Testing). v1 §7 was 4 lines on testing. New §7 is dedicated security spec.

### 7.1 Trust boundary (v0.3)

**Same machine, same user.** That is the ENTIRE in-scope authentication story for v0.3. Any code path that assumes more (network exposure, multi-user separation beyond the OS) is out of scope until v0.5.

Boundary is enforced by THREE redundant layers (defense in depth, §7.2):
1. **Transport**: local channel only — Win named pipe `\\.\pipe\ccsm-daemon-<userSid>` or POSIX unix socket `<dataRoot>/daemon.sock`, plus the dedicated supervisor transport (§6.5). **No TCP listener of any kind in v0.3.** Spec §3.1 line "daemon binds 127.0.0.1:7878" is OBSOLETE; the v0.3 daemon never opens an INET socket.
2. **OS ACL**: pipe / socket / data dir / log dir / lockfile / `.bak` binary / `daemon.secret` all have user-only permissions, set explicitly at create time. Defaults are NOT trusted (sec-M1: Win default pipe DACL grants Everyone in many configs).
3. **Sender peer credential check**: every accepted connection's peer UID/SID is verified at adapter accept; mismatch → log `{offender_pid, offender_sid}` and immediately drop. (sec-M2.)

### 7.2 Defense in depth

Even after §7.1, the daemon distrusts every byte:
- **Envelope schema validation** (§3.4.1): every decoded envelope is run through TypeBox `Check()` at the adapter boundary BEFORE any handler dispatch. Schema mismatch → drop + log; never propagate to handlers.
- **Per-handler arg validation** (r2-sec P1-S1): for `payloadType: 'binary'` frames the trailer is opaque to the adapter; every RPC handler's first statement MUST be `Check(MethodArgsSchema, decoded)` against a per-method byte schema (length cap from header `payloadLen`, optional content sniff like UTF-8 well-formedness for PTY input). ESLint rule `no-handler-without-check` enforces. Coordinate spec edit with frag-3.4.1 §3.4.1.d.
- **Frame size cap**: `MAX_FRAME = 16 MiB` enforced at the `readUInt32BE` length read (sec-M3). Refusal of oversize frames is logged (`offender_pid`, requested length) for forensic value. Closes the 4 GiB DoS.
- **Accept-rate cap** (r2-sec T15): `MAX_ACCEPT_PER_SEC = 50` per transport (data + supervisor counted separately). Exceed → drop new accepts with `EAGAIN` for the next 1s; log once per minute aggregate. Eliminates pre-accept connect-flood DoS.
- **JSON.parse hardening**: no reviver tricks needed (modern V8 is `__proto__`-safe), but every decoded object is shape-validated against TypeBox before being spread into Maps / option bags downstream. Recursion depth implicitly bounded by schema (no unbounded `additionalProperties`).
- **No shell concatenation**: handler code that spawns CLI subprocesses uses `spawn(cmd, [...args])` — never `exec(template)` with user-provided strings. Lint rule (`no-restricted-syntax` for `child_process.exec` / `execSync`) enforces.
- **`daemon.secret` lifecycle** (r2-sec P0-S1, comprehensive; r3-sec P0-1 wire shape lock):
  - **Format**: JSON `{ v: 1, secret: "<base64-32-bytes>" }`, NOT bare bytes (r2-fwdcompat P2-1). v0.4 may ship `{ v: 2, sigstoreBundle: "..." }` or `{ v: 3, derivedSubkeys: ... }` (per r3-fwdcompat P1-6 zero-cost reservation: `v` is a dispatch tag and future values may carry arbitrary additional fields); verifier dispatches on `v`.
  - **Path** (locked OS-native, all triple-rooted references re-anchored): `%LOCALAPPDATA%\ccsm\daemon.secret` (Win), `~/Library/Application Support/ccsm/daemon.secret` (macOS), `~/.local/share/ccsm/daemon.secret` (Linux). Same `<dataRoot>` as everything else.
  - **Generator**: Electron-main, NOT daemon, NOT installer. On `spawnOrAttach`, if file is missing or unreadable, Electron generates a fresh 32-byte random, writes via `fs.writeFile(path, JSON.stringify({v:1,secret}), { flag: 'wx', mode: 0o600 })` (POSIX) or Win equivalent CreateFile with `CREATE_NEW` + immediate `SetSecurityInfo` to user-only DACL, then spawns daemon with the secret as `CCSM_DAEMON_SECRET` env var. **Atomic create-with-ACL is required** — the file must NEVER exist with a wider ACL even momentarily (Win `CreateFile` + `SECURITY_DESCRIPTOR` parameter, NOT `CreateFile` then `SetSecurityInfo`).
  - **Headless / CLI launch carve-out (r3-sec CC-3)**: if env var unset AND file absent AND `process.env.CCSM_DAEMON_HEADLESS === '1'`, daemon may self-generate (one-shot, atomic CREATE_NEW with the same ACL discipline as Electron). Headless mode is dev-only and MUST NOT be set by production Electron; documented as "for debugging tools that want to run the daemon directly without an Electron host." In production, daemon refuses to start if neither env nor file is available — single source of truth = Electron.
  - **First-boot race**: the lockfile (§6.4) is the gate. Two concurrent Electron-spawned daemons cannot race because only the lock-holder proceeds; the loser exits cleanly.
  - **Daemon-side**: daemon reads `CCSM_DAEMON_SECRET` env var on boot; if unset, falls back to reading the file. Hardening (r3-sec P1-1 — defense in depth): immediately after read, daemon `delete process.env.CCSM_DAEMON_SECRET` to narrow the `OpenProcess`/`/proc/self/environ` window from "daemon lifetime" to "first ~5ms of boot." Documented as TODO not blocking.
  - **Rotation**: rotated on every successful auto-update swap (§6.4 step 4) AND on every supervisor-initiated cold restart following crash-loop recovery. Rotation = generate, write `daemon.secret.new`, atomic rename. A known-bad daemon binary that leaked the secret loses authority on the next restart cycle. During rotation window, supervisor pauses `/healthz` HMAC check (`swapInProgress: true` flag, see §6.5 + r3-sec P1-6).
  - **Env-var caveat** (r2-sec T12): `CCSM_DAEMON_SECRET` lives in the daemon's environment block, readable by any same-user process via `OpenProcess`. This is acceptable because (a) same-user process is OUT OF SCOPE per §7.4 T3 anyway, and (b) the file on disk has the same user-readable property. **Future secrets MUST NOT be passed via env** — the precedent is documented as a one-off for this bootstrap-only secret.
  - **Imposter check — HMAC-of-nonce challenge-response (r3-sec P0-1 LOCK; supersedes r2 bearer-token form)**: the wire shape is HMAC challenge-response, NOT bearer-token. On every newly-accepted data-path connection:
    1. Client (Electron's `spawnOrAttach`, after probe-connecting) sends `daemon.hello { clientWire, clientFeatures, clientHelloNonce: "<base64-16>" }`. `clientHelloNonce` is freshly generated per connection (16 random bytes, base64-encoded; ~22 chars on the wire).
    2. Daemon computes `HMAC-SHA256(daemon.secret, clientHelloNonce)`, **truncates to 16 bytes**, base64-encodes, and replies `{ helloNonceHmac: "<base64-22>", protocol: {...}, compatible }`.
    3. Client computes the same HMAC with its loaded secret and compares **using `crypto.timingSafeEqual`** (NOT `Buffer.compare` — the `Buffer.compare` form is byte-by-byte and timing-leaks the secret to a co-tenant probing with crafted prefixes).
    4. Mismatch or absent echo → client treats the listener as imposter, log with `{ offenderPid }`, refuse to talk, fall back to spawning the real daemon under a fresh socket name (Win named-pipe collision: append `-rescue-<ulid>`). Reverse-direction proof (client proves to daemon) is unnecessary because peer-cred + ACL already authenticate the client.
    5. Bearer-token alternative (where client sends the secret in cleartext on every connect) is **EXPLICITLY REJECTED** (per r3-sec P0-1) — it lands the secret in every TLS-pcap (v0.5 web), every crash dump (despite redact), every `strace` log. HMAC-of-nonce keeps the secret entirely off the wire.
    Lockfile (§6.4) prevents the imposter scenario from being viable in steady state; this HMAC is belt-and-suspenders for first-boot race + the case where an attacker spawned a malicious binder before Electron started.
  - **Redaction**: pino redact list (§6.6) includes `daemonSecret`, `installSecret`, `pingSecret`, `helloNonce`, `clientHelloNonce`, `helloNonceHmac`, `*.secret`. Lint hook asserts no logger call site ever passes the resolved secret value. PUNT to frag-3.4.1 §3.4.1.g: align hello payload field names to `clientHelloNonce` + `helloNonceHmac` (NOT a cleartext bearer-secret field, which the redact-glob does not actually catch since pino redact is path-based, NOT substring; r3-lockin CF-3 fix). The legacy `imposterSecret` / `clientImposterSecret` fields were removed entirely by the HMAC-of-nonce handshake.

### 7.3 Supply chain

Phased hardening, locked to release version:

| When | Mechanism | Notes |
|---|---|---|
| **v0.3** | (1) SHA256 manifest fetched from same GitHub release; verified before atomic swap. (2) **SLSA-3 build provenance** `provenance.intoto.jsonl` generated by `actions/attest-build-provenance@v1` attached to every release; updater verifies attestation against GitHub's public OIDC root before swap (free, GitHub-native, no sigstore key infra). (3) **Linux** additionally publishes a minisign signature `SHA256SUMS.txt.minisig` (one-time keypair generation, ~30 LOC verifier). (4) Auto-update **DEFAULT OFF** (`CCSM_DAEMON_AUTOUPDATE=1` to opt in). Manual update prompt is the default UX; the manual prompt also runs the SLSA + (Linux: minisign) verification chain. | r2-sec P0-S3. SHA256 alone gives integrity vs network corruption only; SLSA closes the "compromised pipeline forges binary + SHA together" gap because the OIDC token is bound to the workflow file at the moment of signing. v0.3 residual T6 risk drops from HIGH to MEDIUM. |
| **v0.4** | sigstore / cosign signing in GitHub Actions. Daemon embeds public key at build, verifies signature offline before swap. Auto-update flips DEFAULT ON. SLSA stays on as defense-in-depth. | Eliminates "compromised release pipeline forges both binary and SHA". v0.4 T6 residual: LOW. |
| **v0.5** | Cloudflare Access JWT validator middleware on the (new) network listener. Seam already present from v0.3 §3.1 (handler chain), wired only when `CCSM_DAEMON_REMOTE=1`. | Out-of-scope threats (algorithm confusion, JWKS rotation, audience pinning, Host-header validation, DNS rebinding) all tracked in `v0.5-security-followups.md`. |

**SLSA verifier (r3-sec P1-4)**: the verifier specified at §6.4 step 2 is `@sigstore/verify` v1.x (MIT, ~2 MB, supported), pinned in daemon dependencies. Trust root = GitHub OIDC public key bundled in daemon binary at build time. Verification call: `verifyBundle(bundle, { trustMaterial, signingPolicy: { workflowFilePath: '.github/workflows/release.yml', repository: 'Jiahui-Gu/ccsm' } })`. Failed verification → abort swap, log `slsa_verify_failed`, schedule retry on next 6h poll. Alternatives rejected: shipping `cosign verify-blob-attestation` binary (~30 MB + license issues); custom OIDC-root verifier (~200 LOC, audit risk).

**Initial-install integrity** (r2-sec P0-S3 second seam): the user's first download of v0.3 is from a GitHub release as a `.exe` / `.dmg` / `.deb`. Win + macOS authenticity comes from signtool + codesign + notarization (frag-11 §11.3). Linux installer authenticity is **explicitly via the same SLSA-3 attestation + minisign** as the auto-update path; the minisign public key is published in the README and pinned in installation docs. This eliminates the "Linux user has no authenticity check on either the installer or the daemon" gap.

**npm dep posture (v0.3)**:
- Pin exact versions in `package-lock.json` for `@connectrpc/connect*`, `pino`, `pino-roll`, `@sinclair/typebox`, `@yao-pkg/pkg`, `@octokit/rest`, `proper-lockfile`, `better-sqlite3`, `node-pty`. **All daemon runtime deps MUST appear in `daemon/package.json` `dependencies`**, NOT just root (r2-pkg C6 — pkg bundles from daemon's resolved tree, not workspace root).
- CI step `npm audit --audit-level=high` blocks merge. Explicitly mention `better-sqlite3` family CVEs (r2-sec T16 follow-on to migration `quick_check`).
- `@yao-pkg/pkg` pinned + reproducible-build CI step (rebuild from source, **SHA-only diff** stored as build artifact — NOT byte-diff between runs, since `pkg --compress GZip` is non-deterministic; r2-pkg P1-4). True reproducibility deferred to v0.4 native SEA, which produces deterministic single-static-link binaries by Node design.
- New native helper for Win pipe ACL + JobObject + `ccsm_native.node` (§6.2, §7.M1; r3-lockin P0-A: canonical artifact name is `ccsm_native.node`, single .node carrying three exports `winjob` / `pdeathsig` / `pipeAcl` per frag-3.5.1 §3.5.1.1.a NativeBinding swap interface — supersedes the round-2 `winjob.node` filename) is in-tree, code-reviewed, no transitive deps. **Packaging contract** (r2-pkg P0-2 — TAKE coordination): frag-11 §11.1 must rebuild + ship + sign `ccsm_native.node`; this fragment owns the `realpath` + per-`.node`-codesign acceptance criteria. PUNT to frag-11: rename all `winjob.node` references to `ccsm_native.node` (§11.1, §11.2, §11.3, §11.6, before-pack.cjs).

### 7.4 Threat model (post-hardening)

Real markdown table. Rows = attacker capability; columns = mitigation layer + residual risk.

| # | Attacker capability | OS ACL (§7.1.2) | Peer-cred (§7.1.3) | Schema + frame cap (§7.2) | Supply-chain (§7.3) | Residual risk |
|---|---|---|---|---|---|---|
| T1 | Other local user, non-admin, same Win/macOS box | DENY (pipe DACL = current SID; socket 0600) | Would also DENY (UID/SID mismatch) | n/a | n/a | None for v0.3 IPC. Still readable: `~/.ccsm` if user accidentally `chmod 755`'d it — explicit `chmod 700` on every create (sec-S3). |
| T2 | Local admin / root on same box | ALLOW (admin can override ACL) | ALLOW (admin can spoof creds) | Schema still enforced | Could replace daemon binary | OUT OF SCOPE. Admin == game over per OS trust model. Documented. |
| T3 | Malicious local process running AS the user | ALLOW (same SID/UID) | ALLOW (same UID/SID) | Schema + 16 MiB cap blunt DoS; can still issue legitimate RPCs | n/a | Net-equivalent to v0.2 in-process ipcMain. Documented as accepted: same-user processes can already read user files; daemon RPC adds no new privilege. |
| T4 | Remote attacker on same LAN / coffee shop Wi-Fi | DENY (no INET listener) | n/a | n/a | Updater hits GitHub over TLS; cert pinning to GitHub roots | Updater MITM only viable with full TLS break + valid GitHub cert. v0.3 SLSA closes pipeline-forge residual. |
| T5 | Remote attacker, no local foothold | DENY | n/a | n/a | n/a | OUT OF SCOPE for v0.3. v0.5 reopens with CF Access. |
| T6 | Compromised auto-updater channel (CI key, GitHub Actions, replaced binary + matching SHA) | n/a | n/a | n/a | v0.3: SLSA-3 attestation bound to workflow file via OIDC; (Linux) minisign offline verify; auto-update OFF default. v0.4: sigstore signature verification offline. | v0.3 residual: MEDIUM (was HIGH pre-SLSA). v0.4 residual: LOW. |
| T7 | Compromised npm transitive dep (typo-squat, takeover) | n/a | n/a | Schema validation can't catch malicious code in deps | npm audit gate, exact pins, reproducible pkg build (SHA-record) | Residual: MEDIUM. Same posture as Electron app today. Add Snyk / OSV-Scanner CI in a v0.4 follow-up. |
| T8 | Co-tenant process tries pipe DoS (oversize frame, spam connect) | DENY at accept (peer-cred); accept-rate cap pre-accept | DENY post-accept | 16 MiB cap stops memory DoS; 50 acc/s cap stops pre-accept flood (§7.2) | n/a | Residual: LOW. Worst case: daemon spends CPU rejecting at 50/s. |
| T9 | Local process plants binary at daemon path before Electron spawn | Per-user `%LOCALAPPDATA%\ccsm\bin\` with user-only ACL; `realpath` check at spawn | Imposter-secret check via `daemon.secret` HMAC echo (sec-S2 + §7.2) | n/a | n/a | Residual: NONE if §6.4 path layout honored. Refuses `Program Files` install path explicitly. See T14 for TOCTOU caveat. |
| T10 | Renderer is XSS'd (e.g. via malicious markdown in a transcript) | n/a (renderer is local) | n/a | Renderer cannot bypass schema; daemon trusts no renderer claim | n/a | Residual: same as v0.2. CSP + no `eval` + sanitized markdown stack unchanged. Tracked separately. |
| T11 | Secret leakage through logs | n/a | n/a | pino `redact` config (§6.6); PTY chunks never logged | n/a | Residual: LOW. Lint hook asserts no `chunk.toString()` in logger call sites; redact list reviewed each release. |
| T12 | Process-list / handle-table observer (same-user) | n/a (env block readable by same-user via OpenProcess) | n/a | n/a | n/a | Residual: ACCEPTED. `CCSM_DAEMON_SECRET` env-passing is a one-off bootstrap; documented as not-acceptable for any future secret. Net-equivalent to T3. |
| T13 | Crash-dump exfiltration | n/a (file ACL 0600 + redact at write time) | n/a | redact list applied to dump fields | n/a | Residual: LOW. Dumps never auto-uploaded; user-driven attach only. Path `<dataRoot>/crashes/`, retention 30 days + 200 MB aggregate cap. (§6.6.3) |
| T14 | TOCTOU on `realpath` daemon-binary verify | Per-user ACL on `%LOCALAPPDATA%\ccsm\bin\` is the real defense; same-user attacker already controls the path | n/a | n/a | n/a | Residual: ACCEPTED. Same-user attacker = game over for daemon binary, identical posture to v0.2 unsigned scripts. `realpath` check is best-effort, not the gate. |
| T15 | Co-tenant connect-rate flood pre-accept | DENY at 50 acc/s cap (§7.2) | n/a | n/a | n/a | Residual: LOW. Logged once per minute aggregate. |
| T16 | Migration `quick_check` parser DoS via attacker-controlled SQLite file | n/a | n/a | n/a (SQLite parser lives below schema layer) | SQLite version pin + npm audit gate covers `better-sqlite3` family CVEs; frag-8 §8.3 path validation (see frag-8 r2 P0-S2 fix) prevents arbitrary-source attack | Residual: LOW once frag-8 enforces canonical-userData-path validation on `legacyDir`. |
| T17 | Same-user process subscribes with `fromSeq: 0` and pulls full scrollback (incl. pasted secrets in transcript) | ALLOW (same SID/UID — peer-cred passes) | ALLOW (same UID/SID) | n/a | n/a | Residual: **ACCEPTED for v0.3** (r3-sec P0-2). Rationale: single-user single-machine v0.3, the same-user attacker who could mount this attack can also read SQLite directly via `sqlite3 <dataRoot>/ccsm.db` and dump the same data — a per-stream auth token is theatre when the underlying file is user-readable. **Deferred to v0.5 multi-tenant**: subscribe gains a per-session 128-bit `subscribe_token` (random at `createSession`, persisted on session row, required as `headers["x-ccsm-session-token"]`, validated with `crypto.timingSafeEqual`, never logged). v0.5 reopens because CF Tunnel + multi-tenant changes the threat surface; v0.3 single-user keeps token-less for scope. PUNT-CLOSED: not deferred to frag-3.5.1 — explicitly ACCEPTED here. |

### 7.5 Out-of-scope for v0.3 (tracked, not addressed)

Captured in `docs/superpowers/specs/v0.5-security-followups.md`:
- CF Access JWT correctness (algorithm confusion, JWKS rotation, audience pinning, leeway).
- CF Tunnel hostname enumeration; drive-by GitHub-OAuth phishing on Pages domain.
- DNS rebinding against any future loopback INET listener; `Host` header validation.
- Multi-client conflict resolution beyond single-writer lease (rel-S6).
- iOS App Store framing (v0.6+, deferred per F3 spike).
- Stream heartbeat traffic-analysis surface (r2-sec SH5): the 30s heartbeat reveals user-online status to a passive CF Tunnel observer; tunable in v0.5.
- GPG / minisign signing of `SHA256SUMS.txt` (currently SLSA-attested only).
- macOS keychain unlock CI hardening (r2-sec SH2): move `KC` password to `secrets.MACOS_KEYCHAIN_PW` rather than fixed `actions` literal.
- `signtool verify /pa /v` post-sign assertion in CI (r2-sec SH3).

---

## Plan delta

Specific edits to `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`:

- **Task 1** (daemon workspace skeleton, +5h): add `pino.final` registration, `pino-roll` transport config (daily / 50MB / 7-file limit), `redact` paths (including secret keys), base config (v + pid + boot ULID + side='daemon'). Acceptance: smoke test crashes daemon with `process.exit(1)` after a buffered log write and asserts the line is on disk.
- **Task 4** (local channel listener, +6h): native helper (N-API or `koffi`) for Win `CreateNamedPipeW` with explicit DACL = current SID + `PIPE_REJECT_REMOTE_CLIENTS`; POSIX `umask(0077)` + `chmod 0600` on socket node; lockfile via `proper-lockfile`. Acceptance: cross-user access denied test (manual repro doc + scripted same-user negative test). **Plus:** dedicated supervisor transport (`ccsm-control` socket per §3.4.1.h table), separate accept loop, same ACL discipline. `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control; was `-sup` suffix]`
- **Task 5** (Connect adapter, +3h): MAX_FRAME = 16 MiB enforcement at length read; TypeBox `Check()` at adapter boundary before handler dispatch; `traceId` field added to envelope schema (JSON + binary header) and validated against ULID regex; propagated through.
- **Task 5** (also, +2h): `rpcCall` 30s default deadline + AbortSignal support; `daemon-unhealthy` event surface; 50 acc/s rate cap.
- **Task 5** (also, +1h, r2-sec P1-S1): per-handler `Check(MethodArgsSchema, decoded)` boilerplate + ESLint rule `no-handler-without-check`.
- **Task 5** (also, +1h, r2-fwdcompat P0-2): `daemon.hello` handshake RPC; daemon refuses other RPCs until hello completes; `compatible: false` with clean error code.
- **Task 6** (daemon entry, +2h): peer-cred check on accept (`SO_PEERCRED` / `getpeereid` / `GetNamedPipeClientProcessId`); imposter-secret HMAC echo verify on hello; reads `CCSM_DAEMON_SECRET` env first, file fallback, refuse if neither.
- **NEW Task 6a** (supervisor, +8h was +6h): backoff state machine (1s→30s cap, reset @60s stable, reset on rollback success), crash-loop detection (5/2min, reset on rollback success, dev-mode disabled), heartbeat poller (5s prod / 30s dev, 3-miss prod / 5-miss dev), dedicated supervisor transport client, banner IPC events on consolidated `daemonHealth` channel, single `useDaemonHealthBridge` hook, surface registry stacking enforcement, 250ms reconnect-toast hold-off, N=15 escalate-to-modal. Owns the `daemonSupervisor` module in Electron-main.
- **NEW Task 6b** (last-known-good rollback, +4h was +3h): `daemon.exe.bak` retention, atomic `MoveFileExW` swap, single-shot auto-rollback on cold-start failure within 30s, "successful rollback" 60s+5×ping verification, crash-loop window decay + backoff counter clear on success per r3-rel R2, `daemon.rolledBack` IPC + toast.
- **NEW Task 6c** (Electron-side logger + crash-imminent IPC, +3h, r2-obs P0-1, P0-3, P0-4, S-R1): `electron/log.ts` mirroring daemon pino-roll/redact/base config (with `side: 'electron'`), `pino.final` on `app.before-quit` / `uncaughtException` / `unhandledRejection` / supervisor "Quit" handlers, bridge call-completion log lines with vitest hook, optional renderer-console forward gated by `CCSM_RENDERER_LOG_FORWARD`, daemon-side drain ordering (state='draining' → clear timers → aggregate-shutdown lines → wal_checkpoint → close → pino.final), `daemon.crashing` IPC emission before pino.final.
- **NEW Task 6d** (cold-start splash + UX copy + paused affordance, +3h, r2-ux P0-UX-3, P1-UX-5, P1-UX-6): `Starting ccsm…` HTML pre-mount loader; supervisor-state copy table from §6.1.1 wired in; "Paused — daemon was restarted [Resume]" affordance with explicit "previous turn discarded" copy; `app_state.close_to_tray_shown_at` first-close toast.
- **Task 8/12/13** (lifted services, +2h each): audit every multi-row write, wrap in `db.transaction(() => …)`. Reviewer must check all compound-write call sites. Add explicit `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` at every db open path.
- **Task 11** (lift ptyService, +5h was +4h): JobObject (Win) + `setpgid`/`PR_SET_PDEATHSIG` (POSIX) for orphan reaping; SIGCHLD handler scoped to PIDs in our `pid → sessionId` map (r2-rel P1-R5 — `waitpid(pid, WNOHANG)` per known PID, NOT `waitpid(-1)`); single-writer `ptyWrite` lease; explicit fan-out subscriber model documented (shared registry, drop-slowest under backpressure ≥1 MB); 400 MB total headless-RSS cap with new-spawn block (rel S-R7); shutdown sequence per §6.6.1 step 5.
- **Task 11c** (ptySubscribe, +1h): `traceId` propagation; per-subscriber state == OS socket buffer only (no per-client backlog); `bootNonce` in subscribe + delta envelopes; `bootChanged: true` response on nonce mismatch.
- **Task 7** (Electron handshake e2e, +3h was +2h): adds `/healthz` ping + 1000-ping latency benchmark (target p95 < 5ms) on dedicated supervisor transport; imposter-secret negative test; `daemon.hello` handshake test; `bootNonce` mismatch resubscribe test.
- **NEW Task 23a** (updater hardening, +6h was +4h): download-to-`.partial` + 3× exponential backoff; SHA256 verify; **SLSA-3 provenance verify against GitHub OIDC root**; **Linux: minisign verify**; atomic rename; **`daemon.secret` rotation step BEFORE binary swap**; auto-update DEFAULT OFF (env-gated); manual update prompt UX runs same verification chain.
- **Task 23** (updater core, ±0h): rejection of legacy "spawn batch script" pattern; documented rationale.
- **NEW Task 23b** (release-side SLSA + minisign, +4h, r2-sec P0-S3): GitHub Actions step `actions/attest-build-provenance@v1`; minisign keypair generation + signature step (Linux release matrix); publish `provenance.intoto.jsonl` + `SHA256SUMS.txt.minisig` as release assets; document minisign public key in README + install docs.
- **Task 25** (dogfood gate, +2h): RAM target restated as "daemon RSS excluding child processes <120 MB with 5 sessions; daemon + all children <500 MB" (res-MUST-3); benchmark suite added (obs-S9); crash-dump file written on `process.exit(1)` paths per §6.6.3 schema.
- **NEW Task 26** (security verification, +4h): cross-user access denial repro (manual + scripted); secret-redaction lint hook; `npm audit --audit-level=high` CI gate; reproducible pkg-build SHA-record CI step (NOT byte-diff); `daemon.secret` lifecycle e2e (atomic create-with-ACL, rotation on update, env-var precedence).
- **NEW Task 27** (threat-model + followups doc, +3h was +2h): commit `docs/superpowers/specs/v0.5-security-followups.md` with §7.5 contents pre-populated.
- **NEW Task 28** (uninstall hygiene, +5h, pkg P0-1 TAKE — coordinate with frag-11 implementation): `build/installer.nsh` `customUnInstall` macro per §6.8 contract; `nsis.include` wiring in `package.json`; `.deb postrm` + `.rpm %preun` scripts; macOS tray `Reset ccsm…` action (typed-confirm); release notes section. Order-of-operations enforcement: kill daemon → delete lockfile → checkbox dialog → conditional RMDir.

**Total estimated delta**: +71h on top of v1 plan (~125h → ~196h, was +44h before round-2). Round-2 added ~27h (see prior round entries). **Round-3 adds ~6h** of pure spec/contract clarifications (no new task budget):
- §6.1 dev-mode supervisor wording reconciliation, crash-loop counter decay rule (R2 revised) — 0h, prose only.
- §6.6.1 drain order R1 reorder (subscriber close moves AFTER SIGCHLD wind-down + DB writes) — Task 6c +1h re-test.
- §6.6.1 hot-path traceId carve-out + canonical reconnect log key list — 0h, lint-rule update only.
- §6.6.1 + §6.6.2 pino-roll `symlink: true` (devx CF-1 + resource X2) — 0h config.
- §6.6.1 aggregate `<dataRoot>` disk caps (logs 500 MB, crashes 200 MB) — Task 25 +1h watchdog.
- §6.4 boot order lockfile-before-ensureDataDir + swap-lock (P0-R4 + P1-R5) — Task 6b +1h.
- §6.5 `bootNonce` camelCase + `daemonProtocolVersion` mirror + `daemonAcceptedWires` + `swapInProgress` + `healthzVersion` — Task 7 +1h e2e for new fields.
- §7.2 HMAC-of-nonce wire-shape lock (sec P0-1, supersedes bearer-token) + `crypto.timingSafeEqual` + headless carve-out + env-var clear hardening — Task 6 +2h (replaces bearer-token plumbing with HMAC + nonce gen + redact additions).
- §7.3 SLSA verifier `@sigstore/verify` pin (sec P1-4) — Task 23a +0.5h dep add.
- §7.4 T17 fromSeq ACCEPTED row — 0h, prose.
- §6.8 surface registry canonicalization + camelCase i18n keys + close_to_tray timestamp lock + uninstall ownership split — 0h prose.
- §7.3 `winjob.node` → `ccsm_native.node` rename (lockin P0-A) — Task 11 +0h here, but coordinate frag-11 + frag-3.5.1.

Round-3 net spec-edit: +6.5h budget growth, all on existing tasks. All additions are blocking for v0.3 freeze per the cited round-3 reviews.

---

## Cross-frag rationale

This is the highest-load fragment in round-2. Many cross-fragment P0s land here because the §6/§7 owner is the natural place for daemon-lifecycle + secret-lifecycle + user-visible-failure-surface contracts. Decisions on what to TAKE vs PUNT:

**TAKEN (this fragment is the right owner):**

1. **Uninstall hygiene** (pkg P0-1) — `build/installer.nsh` lives in `frag-11` mechanically (NSIS is electron-builder territory) but the *contract* (which paths to remove, daemon shutdown sequence, lockfile cleanup, kill-before-unlock ordering) is a daemon-lifecycle + lockfile concern owned by §6.4 / §6.8. Frag-11 implements; this fragment specifies. See §6.8 "Uninstall hygiene" + Plan delta NEW Task 28.

2. **Cross-fragment surface registry** (ux P0-UX-1) — every modal/toast/banner emitted by v0.3 is registered in §6.8 with priority + mutual-exclusion rules. Lives here because the dominant surfaces (crash-loop, rollback, heartbeat, paused, BridgeTimeout) all originate from supervisor / reliability paths. Frag-3.7 and frag-8 reference back instead of inventing copy in isolation.

3. **`daemon.hello` + protocol block** (fwdcompat P0-2) — version handshake payload lives in §6.5 alongside `/healthz` because both are version-negotiation surfaces emitted by the same daemon module. Frag-3.4.1 owns the wire shape + the handshake-as-first-envelope rule; this fragment owns the payload schema + behavioral rule (refuse other RPCs until hello).

4. **Electron-side logger** (obs P0-1, P0-4) — pino mirroring is conceptually two-process logging which spans the boundary owned by §6.6. Frag-6-7 already owned daemon-side `pino.final` so the Electron-side complement belongs here for spec cohesion. Plan delta Task 6c implements.

5. **`daemon.secret` lifecycle** (sec P0-S1) — secret generation/rotation/redact is a security concern owned by §7.2; lockfile coordination is owned by §6.4; both interact at first-boot race. Single source-of-truth in §7.2 with §6.4 step 4 cross-referencing the rotation step.

6. **SLSA + Linux minisign** (sec P0-S3) — supply-chain integrity is owned by §7.3. Frag-11 implements the GitHub Actions release steps (NEW Task 23b coordinates); this fragment owns the verifier contract.

7. **Drain ordering for log producers** (obs P0-3) — extends `pino.final` semantics owned by §6.6 with producer-side timer/queue lifecycle. Lives in §6.6.1.

8. **Crash-loop counter reset, dev-mode supervisor, dedicated /healthz transport, shutdown SIGCHLD ordering** — all daemon-lifecycle concerns naturally owned by §6.1/§6.4/§6.5/§6.6.

**PUNTED (other fragments are the right owner):**

1. **`traceId` in binary frame header** (obs P0-2) — wire shape owned by frag-3.4.1 §3.4.1.c. This fragment §6.6 specifies the validation rule + ULID regex but the field-list edit is frag-3.4.1's. Cross-referenced.

2. **`bootNonce` in stream subscribe + `bootChanged: true`** (fwdcompat P1-1) — stream RPC contract owned by frag-3.5.1 §3.5.1.4 + frag-3.7 §3.7.5. This fragment §6.5 defines `boot_nonce` as ULID + advertises it via `/healthz` + Plan delta Task 11c notes propagation, but the schema edit lives in those fragments.

3. **`fromSeq` session-token authentication** (sec P1-S3) — subscribe authorization owned by frag-3.5.1. Mentioned in Plan delta Task 11c contract but not specified here.

4. **Migration env-var trust validation** (sec P0-S2) — migration logic owned by frag-8 §8.3. Threat-model row T16 in §7.4 cross-references the dependency.

5. **Migration partial-write recovery + `.migrating` cleanup** (rel P0-R4) — owned by frag-8 §8.3 startup logic. T16 row notes the dependency.

6. **Per-handler arg validation rule** (sec P1-S1) — wire-level contract owned by frag-3.4.1 §3.4.1.d. §7.2 names the rule + ESLint rule name; the spec edit happens in frag-3.4.1.

7. **CI Node 22 bump, winjob.node packaging, `--compress GZip` reproducibility** — packaging concerns owned by frag-11. §7.3 names the SHA-record approach (P1-4 resolution); frag-11 implements.

8. **Renderer XSS hardening, CSP, sanitized markdown** — UI-layer concerns. T10 row in §7.4 cross-references but does not own.

9. **Reconnect queue retry-forever escalation** (ux P1-UX-1) — frag-3.7 §3.7.4 owns the queue. §6.1.1 supplies the modal copy; frag-3.7 wires the N=15 trigger.

10. **dev-mode reconnect toast vs supervisor banner duplication** (ux P1-UX-4) — surface registry §6.8 resolves at the contract level (banner suppresses toast); frag-3.7 implements the suppression check.

---

## Cross-frag rationale — Round 3 additions

**TAKEN in r3 (this fragment is right owner):**

R3-T1. **Surface registry canonicalization** (r3-ux P0-A) — §6.8 is now the SINGLE canonical registry; every surface formerly proposed in frag-3.7 (dev-mode reconnect surface, dev build error toast, all stacking rules consolidated) has been merged in. frag-3.7's parallel registry is collapsed into a one-paragraph cross-ref to §6.8.

R3-T2. **Drain order R1 reorder** (r3-rel R1) — SIGCHLD wind-down + DB terminal-state writes happen BEFORE subscriber close in §6.6.1 step list; subscriber-close is the LAST runtime act before pino.final. Lives here because §6.6.1 is the canonical shutdown sequence.

R3-T3. **Crash-loop counter decay rule** (r3-rel R2) — rollback success clears backoff counter but DECAYS crash-loop window (rolled-back crash counts as 3/5, not full clear). §6.1 + §6.4 step 7. "Limp mode" rationale.

R3-T4. **`daemon.crashing` IPC explicitly best-effort** (r3-rel R5) — §6.6.1 spells out that the IPC fires only on Node-observable death paths (uncaughtException etc.); on SIGKILL no IPC. Renderer must use socket-close + healthz-fail as primary signal.

R3-T5. **HMAC-of-nonce hello wire shape locked** (r3-sec P0-1) — §7.2 mandates HMAC-SHA256(secret, clientHelloNonce) truncated to 16 bytes, `crypto.timingSafeEqual` compare. Bearer-token form REJECTED. PUNT to frag-3.4.1 §3.4.1.g hello payload to align field names (`clientHelloNonce` + `helloNonceHmac`, drop `clientImposterSecret`).

R3-T6. **fromSeq subscribe-token ACCEPTED for v0.3** (r3-sec P0-2) — §7.4 T17 row added; deferred to v0.5 multi-tenant. NOT punted to frag-3.5.1 — explicitly accepted here as v0.3 single-user-single-machine residual. Rationale: same-user attacker can `sqlite3` the file directly anyway.

R3-T7. **Aggregate `<dataRoot>` disk caps** (r3-resource X1) — §6.6.1 specifies logs aggregate 500 MB + crashes aggregate 200 MB watchdogs. Was punted by frag-3.5.1 to "frag-8 + frag-6-7 §6.6"; frag-6-7 picks it up (frag-8 owns corrupt-backups separately).

R3-T8. **`bootNonce` camelCase lock** (r3-fwdcompat CF-2) — §6.5 healthz emits `bootNonce` (was `boot_nonce`); aligned with rest of envelope. PUNT to frag-3.7 to align any `response.boot_nonce` reads to `response.bootNonce`.

R3-T9. **`daemonProtocolVersion` mirrored in /healthz protocol block** (r3-lockin CF-2) — was only in frag-3.4.1 §3.4.1.g hello reply; supervisor `/healthz` protocol block now also carries the integer so post-update protocol-version mismatch is detectable on long-lived attach.

R3-T10. **`clientImposterSecret` + `helloNonce` redact paths** (r3-lockin CF-3) — §6.6 redact list extended; pino redact is path-based (not substring) so explicit paths required.

R3-T11. **Uninstall ownership split** (r3-resource X3) — §6.8 owns in-app surface (tray "Reset ccsm…", IPC contract); frag-11 §11.6 owns disk paths + NSIS macro / postrm / preun script bodies. Was double-claimed; r3 splits cleanly.

R3-T12. **close_to_tray timestamp key lock** (r3-resource X4 + r3-ux CC-1) — §6.8 locks `app_state.close_to_tray_shown_at` (timestamp); rejects frag-3.7's boolean `close_to_tray_hint_shown`. Timestamp is more useful for "shown N days ago" hint.

R3-T13. **i18n key casing camelCase lock** (r3-ux CC-3) — `daemon.crashLoop`, `daemon.healthDegraded`, `daemon.bridgeTimeouts`, `daemon.reconnectExhausted`, etc. Aligns with frag-3.7's existing camelCase. PUNT to frag-3.7 to verify; PUNT to frag-8 to align `migration.*` keys.

R3-T14. **BridgeTimeout policy locked** (r3-devx CF-3 + r3-ux CC-4) — §6.1.1 last paragraph: never user-surfaced as per-call toast; bridge wrapper retries once internally; aggregates into `daemon.bridgeTimeouts` banner at ≥3/10s; "reconnecting…" toast is the only continuous user signal. PUNT to frag-3.5.1 §3.5.1.3 to add carve-out sentence.

R3-T15. **Dev-mode supervisor wording reconciliation** (r3-devx CF-3) — §6.1 second bullet now explicitly: lifecycle DISABLED in full, but `ccsm-control` transport STILL BOUND for diagnostic UI poll. Resolves apparent contradiction with frag-3.7 §3.7.6.a "Supervisor active? NO" — both are now consistent: lifecycle off, read-only poll on. `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control; was `-sup`]`

R3-T16. **Supervisor transport = control-socket clarification** (r3-perf CF-1) — §6.5 explicitly states the `ccsm-control` socket IS the same channel as frag-3.4.1 §3.4.1.h's "control-socket". ONE control plane, single canonical name. `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control across both fragments; was `-sup` alias]`

R3-T17. **Hot-path traceId carve-out** (r3-perf CF-2) — §6.6.1 explicit rule: per-chunk fan-out logs at debug level only; when emitted, source `traceId` from cached `streamId → spawnTraceId` map (NOT generate fresh ULID per chunk). Per-frame info-level logging on PTY hot path is FORBIDDEN.

R3-T18. **OS-native paths re-anchored everywhere** (manager arch lock) — all `~/.ccsm/` references in §6.4, §6.5, §6.6, §6.6.3, §7.1, §7.2 replaced with `<dataRoot>` notation; concrete OS-native paths in tables. Daemon binary path triple-rooted (`%LOCALAPPDATA%\ccsm\bin\` Win, `~/Library/Application Support/ccsm/bin/` mac, `~/.local/share/ccsm/bin/` Linux) explicitly re-stated in §6.4 and §7.2.

R3-T19. **SLSA verifier pinned to `@sigstore/verify`** (r3-sec P1-4) — §7.3 specifies the verifier library + trust root + verify call shape. Cosign-binary alternative explicitly rejected.

**PUNTED in r3 (other fragments must align):**

R3-P1. **frag-3.7 surface registry collapsed** (r3-ux P0-A) — §6.8 now canonical. frag-3.7's former parallel registry is replaced with `see frag-6-7 §6.8` cross-ref; do not maintain a parallel registry.

R3-P2. **frag-3.5.1 §3.5.1.2 step 8 terminal state** (r3-rel R3) — drop `state='abandoned'`; use `state='paused'` for SIGKILL'd survivors. Single canonical terminal-name across both fragments.

R3-P3. **frag-3.5.1 §3.5.1.3 BridgeTimeout carve-out** (r3-devx CF-3) — add the sentence "BridgeTimeoutError is logged with `DEADLINE_EXCEEDED` but NEVER surfaced to the user; surfacing owned by §6.8 / §6.1.1 banner aggregation."

R3-P4. **frag-3.4.1 §3.4.1.g hello payload field names** (r3-sec P0-1 + r3-lockin CF-3) — rename `clientImposterSecret` → `clientHelloNonce` (16-byte nonce, not the secret); add `helloNonceHmac` reply field; document HMAC-of-nonce challenge-response per §7.2 wire shape lock.

R3-P5. **frag-3.4.1 §3.4.1.h control-socket name unification** (r3-perf CF-1) — single canonical name `ccsm-control` across both fragments; ONE control plane shared with §6.5. `[manager r11 lock: P1 devx P1-2 socket name canonical = ccsm-control; was `-sup` alias on frag-6-7 side]`

R3-P6. **frag-3.7 §3.7.5 `boot_nonce` reads → `bootNonce`** (r3-fwdcompat CF-2) — silent `undefined`-read bug if not aligned.

R3-P7. **frag-3.7 §3.7.4 reconnect log key names** (r3-obs P1-2) — implementer must use the canonical strings listed in §6.6.1; one-line cross-ref to §6.6.1 in §3.7.4.

R3-P8. **frag-3.7 close_to_tray key** (r3-resource X4) — align to `close_to_tray_shown_at` timestamp.

R3-P9. **frag-12 stale OPEN rows** (r3-ux P0-C) — re-grade fwdcompat 3.1 / 3.3, packaging M4, ux M2, obs-M2 / obs-M4, and add 3 new rows for r2-obs P0-1/P0-3/P0-4. Frag-12 owns this re-audit; this fragment cannot edit it.

R3-P10. **frag-11 native artifact rename** (r3-lockin P0-A) — `winjob.node` → `ccsm_native.node` across §11.1 / §11.2 / §11.3 / §11.6 / before-pack.cjs.

R3-P11. **frag-11 §11.6.2 macOS Reset CCSM**: use `shell.trashItem` (gentle, undoable) — not unlinkSync nor typed-confirm word-gate. Aligned with §6.8 in-app contract.

R3-P12. **frag-3.4.1 daemonHelloHmac sec edit + traceId on chunk inheritance** (r3-sec CC-2 + r3-perf P1-1 fixed-width seq) — frag-3.4.1 owns the wire schema edits; §6.6 here owns the validation + redact.

R3-P13. **frag-8 migration i18n keys camelCase** (r3-ux CC-3) — `migration.modal.*` etc. align to camelCase.
