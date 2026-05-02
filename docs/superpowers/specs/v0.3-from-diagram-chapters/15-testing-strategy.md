# 15 — Testing strategy

## Tiers

| Tier        | Scope                                                       | Run on                  |
| ----------- | ----------------------------------------------------------- | ----------------------- |
| UT          | Single module / handler / interceptor                       | Every PR                |
| IT          | Daemon + simulated clients (no Electron)                    | Every PR (except heavy) |
| E2E         | Daemon + real Electron + harness (`scripts/harness-*.mjs`)  | Every PR (heavy IT)     |
| Dogfood     | Released installer on each OS, 4 metrics                    | Pre-tag + nightly        |

## UT MUSTs

### Per-listener interceptors

- [04 §UT matrix](./04-listener-B-jwt.md) — full 17-row JWT interceptor matrix.
- [03 §peer-cred test matrix](./03-listener-A-peer-cred.md) — same-UID accept passes; different-UID rejects (POSIX); different-SID rejects (Windows).

### Connect handlers

- Each handler tested with fake dependencies (PtyHost / SessionManager / SqliteDb fakes). Verified contracts:
  - PtyService: spawn returns sessionId, input forwarded, kill closes session, subscribe emits snapshot then deltas in order.
  - SessionsService: list / get / update / close round-trip metadata.
  - DbService: get/set/list/delete on isolated in-memory SQLite.
  - CrashService: report inserts row; uploader picks it up.
  - DaemonService: Info returns version + bootNonce; SetRemoteEnabled throws Unimplemented; GetRemoteStatus returns disabled.

### Session model (chapter 08 test matrix)

- All 10 rows from [08 §test matrix](./08-session-model.md).
- N≥3 fan-out is mandatory (anti-pattern: skipping the multi-subscriber rows).

### PTY host

- Spawn / kill / write / resize against a fake PTY (node-pty with a no-op shell binary).
- Orphan prevention is IT-tier (see IT-4 below) since it requires real subprocess kill.

### Supervisor envelope (KEPT files)

- daemon.hello returns version + bootNonce + addresses; HMAC fields absent in payload (asserts deletion).
- daemon.shutdown closes listeners in correct order.
- daemon.shutdownForUpgrade writes marker atomically with correct fields.
- /healthz returns listenersBound flags accurately.
- Migration-gate interceptor allows hello/shutdown* during MIGRATION_PENDING; rejects others.

### Proto contract

- `buf lint` clean.
- `buf breaking --against working` clean for any PR not intentionally bumping schema major.
- `npm run proto:gen && git diff --exit-code` clean (committed gen matches source).

### Deletion verification (chapter 14)

- CI script checks every file in chapter 14 §"to DELETE" is absent and every file in §"KEPT" is present.

## IT MUSTs

### IT-1 — Two listeners physically bound

- Boot daemon, read discovery file, assert both addresses bind.
- `nc` / netcat to Listener B port should accept TCP, then HTTP/2 preface should succeed, then any RPC returns `Unauthenticated`.

### IT-2 — Connect over Listener A end-to-end

- Boot daemon, create a Connect-Node client over the UDS, call `pty.Spawn`, send input, subscribe, observe echoed output.
- Same test with **3 concurrent clients** subscribing to the same session.

### IT-3 — Daemon survives Electron exit (the v0.3 dogfood proof)

- Spawn daemon detached. Spawn fake-Electron client. Establish a session.
- SIGKILL the fake-Electron PID.
- Assert daemon `/healthz` continues to respond.
- Assert PTY child of the session is still alive.
- Reconnect a new fake-Electron client. Resubscribe with `from_seq = lastKnown`. Assert it gets the deltas it missed.

### IT-4 — Daemon kill takes PTY children with it

- Spawn daemon, create session, capture PTY child PID.
- SIGKILL daemon.
- Assert PTY child PID is gone within 2 s.
- POSIX: verifies PR_SET_PDEATHSIG / kqueue parent-watcher.
- Windows: verifies JobObject `KILL_ON_JOB_CLOSE`.

### IT-5 — JWKS pre-warm bind-gate

- Boot daemon with a configured (test) team URL pointing at a fake JWKS server.
- Assert one JWKS fetch occurred at boot before listener B is reported as "remote-ready".
- (v0.3 has no consumer of "remote-ready" but the fetch-at-boot behavior is the seam.)

### IT-6 — Migration gate

- Stage a v0.2 DB at the legacy location.
- Boot daemon; while migration runs, attempt a Connect data-plane RPC → expect `FailedPrecondition`.
- After migration completes, retry → expect success.

### IT-7 — Discovery file lifecycle

- Boot daemon → discovery file present with both listener addresses + supervisor address.
- `daemon.shutdown` → discovery file removed.
- Crash daemon (SIGKILL) → discovery file remains stale; next daemon boot atomically overwrites it.

## E2E MUSTs (real Electron via existing harness)

The existing `scripts/harness-*.mjs` test harness is reused. Reconciliation #52 KEEP (replace 70× hard sleep with condition wait) is integrated.

### E2E-1 — Renderer reload preserves session

- Launch app, create session, type input, observe output.
- Cmd-R the renderer.
- Assert renderer comes back to same session with full scrollback (snapshot served from main cache + deltas resumed).

### E2E-2 — Main process kill, daemon survives

- Launch app, create session.
- SIGKILL Electron main pid.
- Relaunch Electron app. Assert session is still listed (in DB), but PTY may show as exited (since v0.3 does not persist scrollback / live PTY across daemon restart — daemon was not killed here, only Electron main, so PTY actually IS still alive; assert resubscribe yields the deltas it missed during disconnect).

### E2E-3 — Stacked-dialog regression (#54 KEEP)

- Existing renderer-only regression test for CrashConsentModal / SettingsDialog stacking.

### E2E-4 — close-session, crash-recovery, user-journey (#71 KEEP)

- Existing harness cases preserved, ported to the new IPC bridge contract.

## Dogfood smoke (4 metrics — #14 MODIFIED)

The four dogfood metrics survive the architecture transition. They are re-baselined against the Connect-RPC stack:

| Metric                                 | v0.3 target                                       |
| -------------------------------------- | ------------------------------------------------- |
| Idle RAM (no sessions, daemon + Electron) | < v0.2 baseline + 30%                          |
| 5-session RAM                          | < v0.2 baseline + 30%                             |
| RPC bridge p95 (input → echo on screen) | < 50 ms                                          |
| Daemon survives Electron quit          | TRUE (binary; assert via post-quit `/healthz`)    |

The smoke harness runs against the actual installer post-pkg.

## Test infra changes

- Harness flakiness fix (#52) reused: condition-wait helper (`waitFor(predicate, timeout)`) replaces hard sleeps.
- Connect-Node test client factory at `tests/helpers/connectClient.ts` with `over-uds` and `over-tcp+jwt` factories.
- Fake JWKS server at `tests/helpers/fakeJwks.ts` for JWT UT + IT.
- Fake PTY shell binary (echoes input) at `tests/helpers/fakeShell.ts`.

## What is NOT in v0.3 testing scope

- Web client E2E (no web client).
- iOS client E2E (no iOS client).
- cloudflared sidecar IT (no sidecar).
- Real CF-Access JWT against real CF (only fake JWKS in CI).

These come in v0.4 with the corresponding components.

## Cross-refs

- [01 — Goals + anti-patterns](./01-goals-and-non-goals.md)
- [03 — Listener A peer-cred matrix](./03-listener-A-peer-cred.md)
- [04 — Listener B JWT 17-row matrix](./04-listener-B-jwt.md)
- [08 — Session model 10-row matrix](./08-session-model.md)
- [12 — Electron thin client (kill-renderer / kill-main IT)](./12-electron-thin-client.md)
- [13 — Packaging + dogfood baseline location](./13-packaging-and-release.md)
- [14 — Deletion verification CI step](./14-deletion-list.md)
