# 08 — Testing

## Context block

v0.3 ships ~30 e2e probes spanning Electron + daemon. v0.4 adds a wire-protocol surface (Connect+Protobuf), a new client (web), and a Cloudflare layer. Testing must catch wire-protocol regressions, web-vs-Electron divergence, multi-client coherence bugs, and Cloudflare-specific failure modes — without ballooning CI time. This chapter defines the test layers, what each layer covers, and the CI shape.

## TOC

- 1. Test layer overview
- 2. Layer 1 — proto + buf gates (CI)
- 3. Layer 2 — daemon Connect handler unit + contract tests
- 4. Layer 3 — Electron e2e against real daemon (existing v0.3 suite, unchanged surface)
- 5. Layer 4 — Web e2e (Playwright on Cloudflare Pages preview)
- 6. Layer 5 — Multi-client coherence test (Electron + web in parallel)
- 7. Layer 6 — Cloudflare integration smoke (manual + scheduled)
- 8. Reverse-verify discipline (per `feedback_bug_fix_test_workflow`)
- 9. CI matrix + budgets

## 1. Test layer overview

```
┌─────────────────────────────────────────────────────────────┐
│ L1 proto+buf gates    — every PR touching proto/ or gen/    │
│ L2 daemon unit+contract — every PR touching daemon/         │
│ L3 Electron e2e        — every PR touching electron/ or src/│
│ L4 Web e2e             — every PR touching web/ or src/     │
│ L5 Multi-client e2e    — every PR touching daemon/ or proto/│
│ L6 Cloudflare smoke    — nightly + on release tag           │
└─────────────────────────────────────────────────────────────┘
```

**Discipline:** v0.4 inherits the trust-CI mode (`feedback_trust_ci_mode`): reviewers don't local-run e2e for every PR; manager merges based on CI rollup. Workers MUST local-run their PR's e2e (the specific `--only=<case>` per `feedback_local_e2e_only`) and paste output in PR body. Per `feedback_e2e_prefer_harness`: new cases default to extending `harness-agent` / `harness-perm` / `harness-ui`; standalone probes require justification.

## 2. Layer 1 — proto + buf gates

CI workflow `proto.yml`:

```yaml
on:
  pull_request:
    paths: ['proto/**', 'gen/**']
jobs:
  buf:
    steps:
      - run: npx buf lint
      - run: npx buf breaking --against '.git#branch=main,subdir=proto'
      - run: npx buf generate
      - run: git diff --exit-code gen/
```

**What it catches:**
- Style / lint regressions in `.proto`.
- Wire-incompatible edits (deleted fields, changed tags, type changes).
- Stale `gen/` (developer edited proto but didn't regenerate).

**Runtime:** ~30s on GitHub-hosted runner. Cheap.

## 3. Layer 2 — daemon Connect handler unit + contract tests

**Unit tests** (vitest, in `daemon/src/__tests__/connect/`):
- Each handler called in-process with a fake context. Assertions on response shape, error codes, side effects (DB rows, PTY state).
- Inherits v0.3 daemon test infrastructure (in-memory SQLite, fake PTY).

**Contract tests** (in `daemon/src/__tests__/connect-contract/`):
- Spin up the real Connect server on an ephemeral Unix socket / named pipe.
- Use a real Connect client (TS, generated from `proto/`) to call each RPC.
- Assert wire-level behavior: streaming events delivered in order, deadline enforced, JWT bypass on local socket.
- Pinpoints daemon-side regressions independent of the renderer.

**Why both:** unit tests are fast (no IO); contract tests catch interceptor wiring mistakes (e.g. forgot to register the migration-gate interceptor on a new route). Both required.

**One contract test per RPC.** Generated test scaffolding from `proto/` (a small codegen step in `buf.gen.yaml` extension) emits the test stub file; developer fills in assertions. Reduces "forgot to test the new RPC" bugs.

## 4. Layer 3 — Electron e2e against real daemon

**No surface change from v0.3.** The Electron e2e suite (`harness-agent`, `harness-perm`, `harness-ui`) drives the renderer, which talks to a spawned daemon. v0.4 changes the transport (Connect instead of envelope) but the renderer behavior is identical.

**What changes operationally:**
- Tests previously asserting on envelope-frame shape (if any — most don't) get rewritten to assert on Connect response.
- Daemon spawned in-test now serves Connect on the data socket. Test harness has to wait for HTTP/2 readiness on the socket (small change; ~5 LOC in test helper).

**E2E budget:** the v0.3 suite runs in ~6 minutes. v0.4 adds no probes here; budget unchanged.

## 5. Layer 4 — Web e2e (Playwright on Cloudflare Pages preview)

**New in v0.4.** Playwright suite in `web/e2e/`. Mirrors a subset of the Electron e2e cases:

| Case | Scenario | Source |
|---|---|---|
| `web-list-sessions` | Load SPA, sign in (mocked Access JWT), assert session list renders | new |
| `web-open-session` | Click session in list, assert PTY output appears | new |
| `web-type-into-session` | Type a command, assert echo + output | new |
| `web-reconnect` | Disconnect daemon mid-stream, reconnect, assert seq-replay continues | new |
| `web-jwt-expiry` | Force JWT expiry, assert redirect-to-login flow | new |
| `web-auth-bypass-blocked` | Strip JWT header, assert 401 from daemon | new |

**Test daemon:** real daemon binary, spawned by Playwright fixture, listening on a localhost TCP port. **NO real Cloudflare Tunnel in CI** — too flaky, too slow, requires network secrets.

**JWT mocking:** Playwright fixture injects a **test-mode JWT** signed by a local test JWKS (daemon configurable to use a test JWKS via `CCSM_DAEMON_TEST_JWKS_URL` env var). Test JWKS has known keys; test JWTs with arbitrary claims can be minted.

**Why mock JWT vs. real Cloudflare:** real Cloudflare requires a real Cloudflare account, real GitHub OAuth round-trip, and is not deterministic. Mock JWKS gives the same code path on the daemon (jose verifies signature against JWKS) without external dependency.

**Where Playwright runs:** GitHub Actions, headed Chromium. Web build served via `vite preview` on localhost:4173. Daemon on localhost:7878. Test browser navigates `http://localhost:4173/` (which the test fixture configures to talk to localhost:7878 via the dev-mode transport, not via cloudflared).

**Runtime budget:** ~5 minutes for the 6 cases.

**Cloudflare Pages preview e2e (separate, lighter):** for each PR, Cloudflare Pages auto-deploys to a preview URL. A nightly cron runs a 1-case smoke against the latest preview URL ("does the SPA load and show a sign-in prompt?"). Catches "the build deployed but it's blank" failures.

## 6. Layer 5 — Multi-client coherence test

**New in v0.4.** Single Playwright case that:
1. Spawns daemon.
2. Spawns Electron client (using existing harness-agent fixture).
3. Spawns web client (Playwright Chromium, mock JWT).
4. From Electron: spawn a session, type "echo from electron".
5. From web: open the same session.
6. Assert: web sees the prior `echo from electron` line in its initial snapshot.
7. From web: type "echo from web".
8. Assert: Electron sees `echo from web` line within 500ms.
9. Both clients close; daemon shutdown.

**Why this case is its own thing:** it's the headline feature of v0.4 (multi-client). A regression here = product is broken even if individual clients work.

**Runtime budget:** ~2 minutes.

## 7. Layer 6 — Cloudflare integration smoke (manual + scheduled)

**Cannot run on every PR** (requires real CF account, real tunnel, takes ~5 minutes including DNS warmup).

**Schedule:** nightly cron + on every release tag (`v0.4.*`).

**What it does:**
1. Boot daemon on a CI worker with a real `cloudflared` connecting to a CI-only Tunnel (separate from the author's daemon).
2. Boot Playwright Chromium with real CF Access cookie (CI service-token auth bypasses GitHub OAuth — Cloudflare Access supports this).
3. Run the Layer 4 web e2e cases against the real Tunnel hostname.
4. Verify JWT validation works end-to-end (real CF JWKS, real Access JWT).

**Why service-token, not GitHub OAuth:** GitHub OAuth in CI requires either headless interactive login (impossible) or a stored refresh token (annoying to maintain). Cloudflare Access service tokens are designed for CI; daemon's JWT validation is Identity-Provider-agnostic (it just verifies signature and claims).

**Failure handling:** nightly failures open a GitHub issue (or post to author's notification channel); release-tag failures block the release.

**Why not on every PR:** cost (CF builds), latency (5 min adds to PR cycle), and most PRs don't change Cloudflare-relevant code.

## 8. Reverse-verify discipline

Per `feedback_bug_fix_test_workflow`: every bug-fix PR shows the new test FAILING before the fix, PASSING after. Every feature PR shows the new test FAILING before the feature, PASSING after. PR body MUST include the test command + before/after output.

Per `feedback_no_skipped_e2e`: zero hardcoded skips. `E2E_SKIP=` env var (user-overridable) is the only allowed skip mechanism.

Per `feedback_e2e_prefer_harness`: new cases extend an existing harness file by default. New standalone probe = +30s baseline; reviewer requires PR-body justification.

## 9. CI matrix + budgets

| Workflow | Triggers | Runtime | Cost |
|---|---|---|---|
| `proto.yml` | PR touching `proto/`, `gen/` | ~30s | free |
| `daemon-unit.yml` | PR touching `daemon/`, `proto/` | ~2 min | free |
| `daemon-contract.yml` | PR touching `daemon/`, `proto/` | ~2 min | free |
| `electron-e2e.yml` | PR touching `electron/`, `src/`, `proto/` | ~6 min | runner mins |
| `web-e2e.yml` | PR touching `web/`, `src/`, `proto/` | ~5 min | runner mins |
| `multi-client-e2e.yml` | PR touching `daemon/`, `proto/`, `electron/`, `web/`, `src/` | ~2 min | runner mins |
| `cf-smoke.yml` | nightly cron + release tag | ~5 min + setup | runner mins + minimal CF |
| `pages-preview.yml` (Cloudflare-managed) | every PR | external | free Pages tier |

**Total worst-case PR CI: ~17 minutes** (daemon-unit + daemon-contract + electron-e2e + web-e2e + multi-client-e2e). Comparable to v0.3 baseline (~6 min) plus the new web/multi-client surface.

**Migration-window CI tolerance** (per `feedback_migration_window_ci_tolerance`): during M1's bridge swap (chapter 09), parallel PRs across multiple bridges may produce CI rebase storms. If this happens, manager temporarily disables specific workflows for the bridge-swap PRs and relies on local e2e + reviewer + final integration test on M1 close. Window opens at M1 start, closes at M2 start.

**Lock:** `npm run e2e:web` runs the web suite locally (matches `web-e2e.yml`); `npm run e2e:multi` runs the multi-client case. Worker self-test commands.
