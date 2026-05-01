# 08 — Testing

## Context block

v0.3 ships ~30 e2e probes spanning Electron + daemon. v0.4 adds a wire-protocol surface (Connect+Protobuf), a new client (web), and a Cloudflare layer. Testing must catch wire-protocol regressions, web-vs-Electron divergence, multi-client coherence bugs, and Cloudflare-specific failure modes — without ballooning CI time. This chapter defines the test layers, what each layer covers, the CI shape, the test-data discipline, and the security gates around test-mode toggles.

## TOC

- 1. Test layer overview
- 2. Layer 1 — proto + buf gates (CI)
- 3. Layer 2 — daemon Connect handler unit + contract tests
- 4. Layer 3 — Electron e2e against real daemon (existing v0.3 suite, unchanged surface)
- 5. Layer 4 — Web e2e (Playwright on Cloudflare Pages preview)
- 6. Layer 5 — Multi-client coherence test (Electron + web in parallel)
- 7. Layer 6 — Cloudflare integration smoke (manual + scheduled + path-triggered)
- 8. Reverse-verify discipline (per `feedback_bug_fix_test_workflow`) + test data discipline
- 9. CI matrix + budgets + `--only` taxonomy + migration-window disable rule

## 1. Test layer overview

```
┌─────────────────────────────────────────────────────────────┐
│ L1 proto+buf gates    — every PR touching proto/ or gen/    │
│ L2 daemon unit+contract — every PR touching daemon/         │
│ L3 Electron e2e        — every PR touching electron/ or src/│
│ L4 Web e2e             — every PR touching web/ or src/     │
│ L5 Multi-client e2e    — every PR touching daemon/ or proto/│
│ L6 Cloudflare smoke    — nightly + release tag + path-trig  │
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
      - run: npx buf breaking --against '.git#branch=working,subdir=proto'
      - run: npx buf generate
      - run: git diff --exit-code gen/
```

**What it catches:**
- Style / lint regressions in `.proto`.
- Wire-incompatible edits (deleted fields, changed tags, type changes).
- Stale `gen/` (developer edited proto but didn't regenerate).

**Runtime:** ~30s on GitHub-hosted runner. Cheap.

**Skip-cascade:** if `proto.yml` fails, downstream `daemon-contract.yml` and `web-e2e.yml` are short-circuited via GitHub Actions `needs:` chains. No point running contract tests against a broken proto.

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

**One contract test per RPC — enforced by lint, not codegen.** Per R5 P0-1: `buf` has no stock plugin to emit per-RPC test stubs, and committing to a custom protoc plugin is out of scope for v0.4. Instead a small Node script `scripts/check-contract-tests.ts` runs in `proto.yml` after `buf generate`:

1. Walks `gen/ts/**/*_connect.ts` and extracts each `service { rpc Foo (...) }` symbol.
2. For each `<service>.<rpc>` pair, asserts a matching `daemon/src/__tests__/connect-contract/<service>__<rpc>.test.ts` file exists.
3. Missing file → exits non-zero with the list of unmapped RPCs and a one-line stub template the developer can paste.

This gives the same "every RPC has a contract test" guarantee that codegen would, with no custom plugin to maintain. The script is ~50 LOC and is itself unit-tested.

**cloudflared lifecycle unit test** (per R3 P1-2): `daemon/src/__tests__/cloudflared/lifecycle.test.ts` mocks `child_process.spawn` and asserts:
- Initial spawn + handshake.
- Process exit at handshake → restart with backoff schedule (1s, 2s, 4s, 8s, 16s) per chapter 05 §1.
- Repeated exit → exhaustion banner surfaces (per chapter 07 P0-1 fix).
- Network-up event (mocked) after exhaustion → retry resumes from backoff slot 0.

This covers the novel-in-v0.4 cloudflared supervisor without paying real-CF cost in CI.

**Log-spam guard** (carry-forward concern from R3 P2-2 — folded as a fixture target inside the existing hot-session unit test rather than a separate L2 case): the `daemon/src/__tests__/connect/pty-input-stream.test.ts` already replays a 10s burst; it asserts `pino` line count stays below 100 lines for 10s of normal traffic. Catches accidental `debug→info` promotions on hot paths. (P2 originally; folded here because the guard is one assertion on an existing test.)

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

**HTTP/2 in the test stack** (per R4 P1-2): `vite preview` serves HTTP/1.1 by default and would mask HTTP/2-specific behaviors (server-streaming framing, header compression, flow control) that v0.4 depends on end-to-end (chapter 02 §1, chapter 05 §8 forces `--protocol http2`). The web e2e harness therefore does NOT use `vite preview`; instead `web/e2e/serve-http2.ts` is a ~30 LOC Node `http2.createSecureServer` static-asset server using a self-signed dev cert (`@vitejs/plugin-basic-ssl` reused for the cert material). Playwright launches Chromium with `--ignore-certificate-errors` and navigates `https://localhost:4173/`. The daemon-side socket continues to speak HTTP/2 cleartext on the loopback TCP port; the browser↔static-server hop is now HTTP/2 over TLS, matching prod's browser↔CF-edge hop.

**JWT mocking** (per R2 P1-1 — production-gated, scheme-restricted, log-warned):
- Playwright fixture injects a **test-mode JWT** signed by a local test JWKS. Daemon reads `CCSM_DAEMON_TEST_JWKS_URL` to know where to fetch keys.
- **Production-build gate (compile-time):** the env-var read is wrapped in `if (process.env.NODE_ENV !== 'production' && !IS_PACKAGED_BUILD)`. In a packaged release binary, the read returns `undefined` regardless of what the user sets. Even paranoid: if a packaged binary observes the env var set, it logs `pino.error({ test_mode: 'jwks_override', refused: true })` and refuses to start. Mirrors the chapter 04 §5 production-gate mechanism for the dev TCP listener.
- **Scheme allow-list:** the URL MUST match `file://` or `http://127.0.0.1:*` / `http://localhost:*`. Any other scheme → daemon refuses to start with a clear error. Prevents attacker-hosted JWKS from being swapped in remotely.
- **Startup banner:** when test-mode is active, daemon emits `pino.warn({ test_mode: 'jwks_override', jwks_url: <url> })` at startup and shows a banner on the dev console. Attacker can't silently flip it.
- **Per-test fixture lifetime:** Playwright fixture sets the env var when spawning the daemon for a test, unsets it on teardown. Never set globally.

**Why mock JWT vs. real Cloudflare:** real Cloudflare requires a real Cloudflare account, real GitHub OAuth round-trip, and is not deterministic. Mock JWKS gives the same code path on the daemon (jose verifies signature against JWKS) without external dependency.

**Where Playwright runs:** GitHub Actions, headed Chromium. Web build served via the HTTP/2 server above on localhost:4173. Daemon on localhost:7878. Test browser navigates `https://localhost:4173/` (which the test fixture configures to talk to localhost:7878 via the dev-mode transport, not via cloudflared).

**Runtime budget:** ~5 minutes for the 6 cases.

**Cloudflare Pages preview e2e (separate, lighter)** (per R5 P1-2 — expanded from 1-case smoke to 4 cases): for each PR, Cloudflare Pages auto-deploys to a preview URL. A nightly cron runs against the latest preview URL:

| Pages-smoke case | What it catches |
|---|---|
| `pages-loads` | SPA root returns 200 + JS bundle parses |
| `pages-deeplink` | `/sessions/abc123` deep-link returns SPA shell (catches `_redirects` / SPA fallback breakage) |
| `pages-signin-prompt` | Unauthenticated visitor sees sign-in prompt (catches blank-page deploys) |
| `pages-version-banner` | Footer version string matches the commit SHA in the deploy metadata (catches stale-cache / wrong-build deploys) |

The 4 cases share one Playwright context; runtime ~90s. Pages preview build itself (Cloudflare-managed, ~4-7 min cold) runs in addition and is documented as such in the CI budget below.

## 6. Layer 5 — Multi-client coherence test

**New in v0.4.** Single Playwright case `multi-client-pair` that:
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

**Daemon-crash variant** `multi-client-daemon-crash` (per R3 P1-3): exercises the chapter 06 §6 force-snapshot path:
1. Spawn daemon, attach two clients (one Electron, one web), send PTY output through both.
2. `kill -9` daemon PID.
3. Supervisor (existing v0.3 mechanism) respawns daemon with new `boot_nonce`.
4. Assert: both clients detect boot_nonce change, request fresh snapshot, and reconcile cleanly with no duplicated or dropped bytes in the rendered transcript.

This validates chapter 06 §6 + chapter 07 §1 + chapter 05 §1 in one shot. (Cross-validation noted in R3 cross-file finding.)

**Runtime budget:** ~2 minutes for the pair, +90s for the crash variant = ~3.5 min for L5 total.

## 7. Layer 6 — Cloudflare integration smoke (manual + scheduled + path-triggered)

**Cannot run on every PR** (requires real CF account, real tunnel, takes ~5 minutes including DNS warmup).

**Schedule (per R3 P1-1 — adds path-triggered runs):**
- Nightly cron.
- Every release tag (`v0.4.*`).
- **PR-time path-triggered:** any PR touching `daemon/src/connect/jwt-interceptor.ts`, `daemon/src/cloudflared/**`, or `daemon/src/sockets/runtime-root.ts`. The trigger is documented in `cf-smoke.yml`'s `paths:` filter. These are the only files where real-CF behavior diverges from mock-JWKS behavior; trading ~5 min on those PRs for tight feedback is the right call.

**What it does:**
1. Boot daemon on a CI worker with a real `cloudflared` connecting to a CI-only Tunnel (separate from the author's daemon).
2. Boot Playwright Chromium with real CF Access cookie (CI service-token auth bypasses GitHub OAuth — Cloudflare Access supports this).
3. Run the Layer 4 web e2e cases against the real Tunnel hostname.
4. Verify JWT validation works end-to-end (real CF JWKS, real Access JWT).

**Why service-token, not GitHub OAuth:** GitHub OAuth in CI requires either headless interactive login (impossible) or a stored refresh token (annoying to maintain). Cloudflare Access service tokens are designed for CI; daemon's JWT validation is Identity-Provider-agnostic (it just verifies signature and claims).

**Service token security discipline** (per R2 P1-2):
- **Scoping:** the CI service token is bound to a **separate Cloudflare Access application** protecting ONLY the CI tunnel. It has a different `AUD` claim from the author's production tunnel. A leaked CI token cannot reach the author's daemon — the daemon validates `AUD` and rejects mismatches.
- **Storage:** `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` live in GitHub Secrets, masked in workflow logs (`::add-mask::`). Never echoed, never written to test artifacts. The `cf-smoke.yml` workflow declares `permissions: read-all` and uses a fine-grained PAT for any repo access it needs.
- **Rotation:** every 90 days. A calendar reminder is recorded in chapter 11 references `[cross-file: see chapter 11]`. Rotation procedure: issue new token in CF Access dashboard, update GitHub Secret, retire old token within 24h.
- **Audit:** failed-auth events on the CI tunnel surface in Cloudflare Access logs; nightly failures open a GitHub issue (existing failure-handling channel below).

**Failure handling:** nightly failures open a GitHub issue (or post to author's notification channel); release-tag failures block the release; PR-time path-triggered failures block the PR.

**Why not on every PR:** cost (CF builds), latency (5 min adds to PR cycle), and most PRs don't change Cloudflare-relevant code. The path trigger above narrows this to the small surface where the cost is justified.

## 8. Reverse-verify discipline + test data discipline

**Reverse-verify** (per `feedback_bug_fix_test_workflow`): every bug-fix PR shows the new test FAILING before the fix, PASSING after. Every feature PR shows the new test FAILING before the feature, PASSING after. PR body MUST include the test command + before/after output.

Per `feedback_no_skipped_e2e`: zero hardcoded skips. `E2E_SKIP=` env var (user-overridable) is the only allowed skip mechanism.

Per `feedback_e2e_prefer_harness`: new cases extend an existing harness file by default. New standalone probe = +30s baseline; reviewer requires PR-body justification.

**Test data discipline** (per R5 P1-4):
- **Fixture location:** all binary or large textual fixtures live under `<package>/__fixtures__/` (one per package). No fixtures committed under `__tests__/` directly.
- **Golden-file update mechanism:** any test that compares against a golden file MUST support `UPDATE_FIXTURES=1 npm test` to regenerate. The diff is reviewed by the human reviewer in the PR; auto-regenerated fixtures are not auto-approved.
- **Max fixture size:** 1 MB per file. Larger artifacts (e.g. PTY recordings) are checked in compressed and lazily decompressed in the test, OR kept out of git and fetched at test time from a known immutable URL.
- **Anonymization rule:** fixtures MUST NOT contain real user paths (`C:\Users\<name>\...`, `/Users/<name>/...`, `/home/<name>/...`), real session UUIDs from the author's local store, real Cloudflare account IDs, or any token fragments. A pre-commit lint rule (`scripts/lint-fixtures.ts`) scans `__fixtures__/` against a deny-list of regexes and fails commit on hit.
- **Wire-fixture provenance:** Connect/protobuf wire fixtures used by L2 contract tests are generated by `npm run gen:wire-fixtures` against a deterministic seed; provenance commit-message is required when refreshing them. Avoids the `project_dogfood_probe_store_schema` class of bug where tests baked in stale shape assumptions.

## 9. CI matrix + budgets + `--only` taxonomy + migration-window disable rule

### 9.1 Workflow matrix

| Workflow | Triggers | Runtime | Cost |
|---|---|---|---|
| `proto.yml` | PR touching `proto/`, `gen/` | ~30s | free |
| `daemon-unit.yml` | PR touching `daemon/`, `proto/` | ~2 min | free |
| `daemon-contract.yml` | PR touching `daemon/`, `proto/` (skipped if `proto.yml` failed) | ~2 min | free |
| `electron-e2e.yml` | PR touching `electron/`, `src/`, `proto/` | ~6 min | runner mins |
| `web-e2e.yml` | PR touching `web/`, `src/`, `proto/` | ~5 min | runner mins |
| `multi-client-e2e.yml` | PR touching `daemon/`, `proto/`, `electron/`, `web/`, `src/` | ~3.5 min | runner mins |
| `cf-smoke.yml` | nightly cron + release tag + path-triggered (jwt-interceptor / cloudflared / runtime-root) | ~5 min + setup | runner mins + minimal CF |
| `pages-preview.yml` (Cloudflare-managed) | every PR | external (Pages build ~4-7 min cold) | free Pages tier; failure surfaces as **non-blocking** GitHub check (Pages env can be transient, per R3 P2-1) |

### 9.2 Wall-clock budget (per R4 P1-1)

`daemon-unit.yml` and `daemon-contract.yml` are configured as **independent jobs**, not serial; `proto.yml` is a `needs:` predecessor of `daemon-contract.yml` only (skip-cascade), not of `daemon-unit.yml`.

Worst-case happy-path serial sum: ~17 min. Realistic 95th-percentile wall-clock including GitHub Actions queue (0-5 min), Playwright flake retries (1-3% × 6 retry budget can double a single e2e run), and the Cloudflare Pages preview build running in parallel (4-7 min, often the long pole on web-only PRs):

**PR-time CI budget (95th percentile, including queue + flake retry): ≤25 min wall-clock.** Tracked in chapter 09 dogfood gates `[cross-file: see chapter 09]`. Regressions past 25 min trigger a "CI cycle time" issue.

### 9.3 `--only=<case>` taxonomy (per R5 P1-1)

Workers running local e2e per `feedback_local_e2e_only` need a one-line mapping from "what file did I touch" to "what `--only` flag do I pass". M2 has 12 PRs across 5 bridge files; ambiguity here costs throughput. The taxonomy is generated from the chapter 03 §1 RPC inventory `[cross-file: see chapter 03]` and lives in `scripts/e2e-only-map.json`:

| RPC / Bridge | `npm run e2e --only=` | Layer |
|---|---|---|
| `ccsmAgents.list` | `agents-list` | L3 (harness-agent) |
| `ccsmPermissions.evaluate` | `perm-evaluate` | L3 (harness-perm) |
| `ccsmPty.spawn` | `pty-spawn` | L3 (harness-pty) |
| `ccsmPty.input` | `pty-input` | L3 (harness-pty) |
| `ccsmPty.subscribe` | `pty-subscribe` | L3 (harness-pty) + L5 (multi-client-pair) |
| `ccsmSessions.list` | `sessions-list` | L3 + L4 (web-list-sessions) |
| `ccsmSessions.snapshot` | `sessions-snapshot` | L3 + L5 (multi-client-daemon-crash) |
| `ccsmEvents.subscribe` | `events-subscribe` | L2 contract + L5 |
| ... (full list checked into `scripts/e2e-only-map.json`, validated against `gen/ts/` by a CI lint) | | |

Worker PR template includes the line "`--only` ID(s) used: <list>". Reviewer checks the listed IDs cover the touched RPCs; mismatch → reject.

### 9.4 Migration-window CI tolerance + disable mechanism (per R5 P1-3)

Per `feedback_migration_window_ci_tolerance`: during M1's bridge swap (chapter 09 `[cross-file: see chapter 09]`), parallel PRs across multiple bridges may produce CI rebase storms.

**Disable mechanism (the only allowed form of "skip"):** a workflow MAY gate its top-level `jobs.*.if:` on `${{ vars.MIGRATION_WINDOW != 'true' }}`. The `MIGRATION_WINDOW` repository variable is set/unset by manager exactly once per window. This is NOT the same as `feedback_no_skipped_e2e`'s ban on hardcoded skips (which targets test-internal `it.skip(...)` calls); a workflow gate scoped by an explicit window variable is auditable, time-bounded, and reversible.

**Allow-list of disable-eligible workflows:** `web-e2e.yml`, `multi-client-e2e.yml`, `electron-e2e.yml`. **Disable-forbidden:** `proto.yml`, `daemon-unit.yml`, `daemon-contract.yml`, `cf-smoke.yml` — these guard cross-cutting invariants that must never lapse.

**Re-enable trigger:** M2 start. The `MIGRATION_WINDOW` variable MUST be unset within 24h of M2 start. A scheduled CI lint (`scripts/check-migration-window.ts`, runs daily) checks the variable against the M1 window dates declared in chapter 09 and opens an issue if the window has overstayed.

**Make-up integration test:** at M2 start, a one-off `migration-window-makeup.yml` workflow runs the union of all disabled workflows against the post-merge `working` HEAD. Reviewer-approved before M2 PRs proceed. Any regression caught here blocks M2 until fixed.

### 9.5 Local commands

`npm run e2e:web` runs the web suite locally (matches `web-e2e.yml`); `npm run e2e:multi` runs the multi-client cases (pair + crash variant); `npm run e2e -- --only=<id>` runs a single case per the taxonomy above. Worker self-test commands.
