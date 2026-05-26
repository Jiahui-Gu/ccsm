# Real-CLI e2e Triage + Fake API Echo — Design

**Date:** 2026-05-26
**Status:** Draft — pending user review
**Branch (when implementing):** `test/real-cli-unskip-ci-2026-05`

---

## 1. Problem

`scripts/harness-real-cli.mjs` has 27 cases against the real `claude` binary. Today:

- The full harness is **skipped in CI** (`E2E_SKIP=harness-real-cli` in `.github/workflows/e2e.yml`).
- A curated subset `harness-real-cli-ci.mjs` runs **9 of 27** against a stub fake API. The other 18 stay dogfood-only.
- The skipped 18 all fail for one of three "wrong-boundary" reasons: they assert on **LLM-generated reply content** (`ALPHA`/`PONG`/`SECRET_TOKEN`), wait for **real claude idle timing** (180s), or test **claude's own UI** (welcome panel rendering).

The wrong-boundary diagnosis is the root cause. Several cases were written to validate *claude's* behavior (does the LLM remember OMEGA across restarts?) instead of *ccsm's* boundary (does ccsm replay the session terminal buffer on reopen?). Faking the LLM to satisfy those bad assertions perpetuates the wrong test.

## 2. Goal

After this change:

1. The remaining real-CLI e2e cases **all run unskipped in CI**.
2. The fake Anthropic API is a **stateless echo streamer** — no conversation memory, no keyword routing, no `messages[]` inspection.
3. Each kept case asserts only on **ccsm's boundary**: process argv, IPC, xterm buffer bytes, JSONL file presence, state transitions, child-process lifecycle. Never on LLM reply *content*.
4. `harness-real-cli-ci.mjs` (the CI-only subset file) is **deleted** — the main harness is itself the CI harness now. One fewer drift source.

## 3. ccsm ↔ claude boundary

This is the load-bearing definition for the whole effort.

| In scope for ccsm tests | Out of scope (claude's responsibility) |
|---|---|
| `claude` subprocess argv (cwd, `--resume <sid>`) | What argv claude internally passes to libcurl |
| pty stdin/stdout byte flow | What characters claude renders inside the TUI |
| IPC traffic between renderer ↔ main ↔ pty host | Whether claude's prompt template is correct |
| xterm buffer state (any non-empty reply ⇒ ok) | The semantic content of the reply |
| JSONL file presence + structural validity | Whether the LLM actually "remembers" prior turns |
| state transitions `running → idle` triggered by main-process events | The wall-clock time claude takes to emit an idle signal |
| sidebar/store reflecting the above | claude's welcome/trust panel layout |

**Rule of thumb:** if the assertion would fail when the user replaces the LLM with GPT-5 or a smaller cheaper Anthropic model, it is **testing the wrong thing**.

## 4. Case triage — 27 → 9

### A. Keep as e2e (9) — main scenarios that genuinely cross the ccsm/claude boundary

| Case | Asserts (rewritten to test ccsm boundary, not LLM) |
|---|---|
| `new-session-chat` | After typing prompt + Enter: (a) pty stdin received the bytes, (b) xterm buffer grew by ≥1 printable-ASCII char beyond what was already there, (c) store state went `running → idle` |
| `switch-session-keeps-chat` | After switching to session B and back to A: xterm buffer of A still contains the prior user-input row (no reset). active-session pid unchanged. |
| `cwd-projects-claude` | `claude` child process argv `cwd` = `projectDir` (read via main-process `process.platform`-appropriate API). Does NOT assert claude can read a marker file. |
| `reopen-resume` | After ccsm quit+relaunch with same user-data-dir: (a) sidebar shows the prior session, (b) opening it shows xterm buffer replay containing the prior user-input row, (c) claude argv includes `--resume <sid>`. Does NOT assert claude remembers a token. |
| `attach-replay-from-headless-buffer` | After session backgrounded then re-focused: xterm buffer matches the headless buffer snapshot byte-for-byte. (Already correct shape.) |
| `session-rename-writes-jsonl` | After rename: JSONL sidecar file at expected path exists and contains the new title field. Does NOT assert LLM replies "ack". |
| `session-state-becomes-idle` | Inject a synthetic `state=idle` event into main process via test seam → store reflects idle within 1s. Does NOT wait for real claude idle. |
| `notify-fires-on-idle` | Inject synthetic `idle` event → `__ccsmNotifyLog` grows by 1 within 1s. Does NOT wait 180s. (See §6 for the mechanism.) |
| `pty-subtree-killed-on-quit` | After app quit: claude child PID no longer exists in OS process table. (Already correct shape.) |

### B. Demote to UT / integration (7) — never needed real CLI in the first place

| Case | Where it goes |
|---|---|
| `cwd-picker-top-default` | `tests/sidebar/cwd-picker-defaults.test.tsx` (RTL + mock store) |
| `cwd-picker-top-chevron` | same file |
| `cwd-picker-no-shortcut` | `tests/shortcut-overlay.test.tsx` (jsdom keyboard event) |
| `cwd-picker-browse` | Move to `harness-ui` (still real Electron for IPC, but no claude binary needed) |
| `sidebar-group-no-newsession-cluster` | `tests/sidebar/group-row.test.tsx` (jsdom DOM assertion) |
| `agent-icon-active-session-no-halo` | `tests/sidebar/agent-icon.test.tsx` (jsdom className assertion) |
| `notify-name-cleared-on-session-delete` | `electron/__tests__/notify-name-map.test.ts` (main-process Map unit test) |

### C. Fold into a Keep case (5) — duplicate coverage at finer granularity

| Case | Folded into |
|---|---|
| `session-title-syncs-from-jsonl` | `session-rename-writes-jsonl` — extend with reverse-direction assertion |
| `notify-shows-session-name` | `notify-fires-on-idle` — add `payload.name` check after notify fires |
| `notify-pipeline-foreground` | `notify-fires-on-idle` — add fg/bg branch assertion |
| `notify-pipeline-background` | same |
| `caseBadgeFiresAndClearsOnFocus` | `notify-fires-on-idle` — add `__ccsmBadgeDebug.getTotal()` check on the existing notify event |

### D. Drop (6) — corner / dead code / out of boundary

| Case | Why dropped |
|---|---|
| `caseSpacesInCwdSpawnsCorrectly` | Shell-escaping is a write-once invariant. Re-add only on regression. |
| `import-resume` | Import is one-shot migration; tested too narrowly here. |
| `import-lands-in-focused-group` | Same; leave a lightweight unit test asserting `importedSession.groupId === focusedGroupId`. |
| `new-session-focus-cli` | High risk of "looks right, measures wrong dim" failure mode (the PR #1362 anti-pattern). Drop until a real regression. |
| `pty-pid-stable-across-switch` | Implementation detail, not user-observable. Indirectly covered by `attach-replay-from-headless-buffer`. |
| `alt-screen-fits-visible-viewport` | Tests claude's own welcome panel — boundary violation. |

## 5. Fake API — stateless echo streamer

`scripts/fixtures/fake-anthropic-api.mjs` is rewritten to:

- `POST /v1/messages`: stream a single fixed SSE response — `message_start`, one `content_block_delta` with body `"ok"`, `content_block_stop`, `message_delta` (`stop_reason: end_turn`), `message_stop`. No keyword inspection. No `messages[]` reading.
- `GET /v1/models`: minimal models list (unchanged, claude SDK probes it on cold start).
- All other paths: 200 + `{}`, log to stderr (unchanged).

What is **removed** from current fake-api:
- The `if (lastUserMsg.includes('ALPHA')) reply = 'ALPHA'` style keyword routing.
- All conversation-state tracking (there was none, but the design intent had been to add it — explicitly cancelled).

The fake server is now ≤50 lines of meaningful logic and is justifiable as "any byte stream proves the IPC path is wired", which is the only thing ccsm needs from claude responses in its tests.

## 6. notify idle event — synthetic injection, not wall-clock wait

`notify-fires-on-idle` (the only Keep case that was waiting 180s) is rewritten:

- Existing test seam `globalThis.__ccsmNotifyLog` stays.
- Add a parallel **test-only main-process seam** `globalThis.__ccsmEmitSyntheticIdle(sid)` that synthesizes the same `(sessionId, transition: 'idle')` event main would receive from the SDK adapter when claude truly goes idle.
- Guard the seam on the existing `CCSM_NOTIFY_TEST_HOOK` env (already set by harness launches), so production never exposes it.
- Test calls the seam, polls `__ccsmNotifyLog` for ≤2s. No 180s wait.

This is **not** mocking claude — it's mocking the *input event* claude's adapter would feed to ccsm. ccsm's own notify pipeline (event → notifier → OS API) remains under test.

## 7. CI wiring changes

In `.github/workflows/e2e.yml`:
- Remove `harness-real-cli` from `E2E_SKIP` on all three OS matrix entries.
- Drop the `Install claude CLI globally` step? **No, keep it** — the Keep cases still need a real `claude` binary to spawn (we're testing the spawn boundary, not faking the binary).
- The `Pre-approve fake API key` step stays.
- `harness-real-cli-ci.mjs` file is deleted; `run-all-e2e.mjs` discovery picks up `harness-real-cli.mjs` directly.

## 8. Implementation order

1. **Rewrite assertions on Keep-9 cases** to match §4-A's "ccsm boundary" column. No file deletion yet; PR is testable in isolation.
2. **Strip fake-anthropic-api** to echo streamer (§5).
3. **Add `__ccsmEmitSyntheticIdle` seam** (§6) — main process, behind `CCSM_NOTIFY_TEST_HOOK` env guard. Rewrite `notify-fires-on-idle` against it.
4. **Demote group B** — create 7 new unit/integration tests, delete the originals from `harness-real-cli.mjs`.
5. **Fold group C** — extend the Keep host cases with the merged assertions, delete the originals.
6. **Drop group D** — delete from `harness-real-cli.mjs` and from `harness-real-cli-ci.mjs`'s subset list.
7. **Delete `harness-real-cli-ci.mjs`**; update `e2e.yml` (remove `harness-real-cli` from `E2E_SKIP`).
8. **Verify locally**: full `npm run probe:e2e` on Windows. Push, watch CI on all three OSes.

Steps 1–3 can be one PR (the load-bearing change). Steps 4–8 can be a follow-up PR or bundled — depends on diff size.

## 9. Non-goals

- Visual pixel regression. (Separate effort.)
- Storybook / Chromatic. (Separate effort.)
- Nightly real-API workflow. (Considered, deferred — the rewritten Keep-9 do not need a real LLM at all, so nightly's marginal value is small.)
- Adding new e2e cases. Only triaging existing ones.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Echo-streamer fake API breaks a claude SDK assumption we don't know about (e.g. it requires non-empty `content` array shape we don't currently emit) | Run full harness locally before PR; fix shape on observed failures, not speculation. |
| Rewriting `cwd-projects-claude` assertion to "argv cwd" needs reading the OS process table cross-platform | Use `process.spawnargs` introspection via the pty host's existing handle; we already store the spawn args. No new cross-platform code. |
| `__ccsmEmitSyntheticIdle` seam diverges from the real SDK adapter's event shape over time | Co-locate the seam with the adapter that emits the real event; share the construction function. |
| Tests pass in CI but real-claude behavior regresses silently | Keep `harness-real-cli.mjs` runnable locally against the real Anthropic API (dogfood path) — `ANTHROPIC_API_KEY=$REAL_KEY node scripts/harness-real-cli.mjs`. Document in DEBT.md as ongoing manual-cadence verification. |
