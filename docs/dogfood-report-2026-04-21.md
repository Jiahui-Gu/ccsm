# Post-SDK-removal dogfood report — 2026-04-21

Branch: `feat/dogfood-verify` off `origin/working` @ `3828035`
(latest commit: `feat(agent): drop @anthropic-ai/claude-agent-sdk dependency (#64)`)

## Sanity gates

| Gate        | Result                                                  |
| ----------- | ------------------------------------------------------- |
| `typecheck` | PASS                                                    |
| `lint`      | PASS (0 errors; 1 pre-existing warning in CommandPalette.tsx:156 — exhaustive-deps, unrelated) |
| `test`      | PASS — 238/238 tests across 12 files, 6.24s             |

## Boot

- Node: `v22.16.0`, npm `10.9.2`
- Electron: `33.4.11` (bundled Node 20.18.3, modules ABI 130)
- Webpack dev server up on `http://localhost:4100/`
- Electron main launched, renderer mounted, no pageerrors.

### Blocker hit + fixed (env-only, no source changes)

`better-sqlite3` was installed against ABI 127 but this Electron needs ABI 130.
Main process threw `ERR_DLOPEN_FAILED` on first boot. Resolved by running
`npx @electron/rebuild -f -w better-sqlite3`. This is a local dev-env fix;
no repo files changed. A follow-up separate from T10 should add a postinstall
or document the rebuild step, but that is out of scope for this report.

## Golden paths

| # | Path                            | Result | Notes                                                                                                                                                            |
| - | ------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Plain assistant text + streaming | PASS   | `probe-e2e-streaming.mjs` OK — 3 deltas coalesce into one block; streaming caret shown then cleared on finalize. `probe-e2e-default-cwd.mjs` OK — assistant block rendered after claude.exe round-trip. |
| 2 | Tool call + tool result block   | PASS   | `probe-chatstream.mjs` OK — `pre`/`code`/`ul`/`strong`/`a` render; `Read` + `Bash` tool blocks collapsible; tool results visible inline, placeholder removed on result. |
| 3 | Error banner                    | PASS   | New probe `probe-e2e-tool-call-dogfood.mjs` exercised the real claude.exe spawn path without auth: `ErrorBlock` ("Not logged in · Please run /login") + `StatusBanner` ("WARN Authentication failed" / "INFO Done — 1 turn · 40ms") all rendered correctly in the chat stream. Unit coverage in `stream-to-blocks.test.ts` (21 tests) backs the error-path translation. |
| 4 | Interrupt                       | PASS (indirect) | Live interrupt not exercised (requires auth). Covered by unit tests: `control-rpc.test.ts` (28) + `lifecycle.test.ts` (18) verify soft control-request + SIGTERM/SIGKILL escalation. No zombie observed after any probe run. |

### Other probes run

All PASS except one pre-existing failure:

- PASS: `probe-render`, `probe-e2e-default-cwd`, `probe-e2e-streaming`, `probe-e2e-chat-copy`, `probe-e2e-empty-state-minimal`, `probe-e2e-inputbar-visible`, `probe-e2e-input-placeholder`, `probe-e2e-no-sessions-landing`, `probe-e2e-titlebar`, `probe-e2e-tray`, `probe-e2e-tutorial`, `probe-e2e-dnd`, `probe-shortcuts`, `probe-sidebar-divider`, `probe-waiting-indicator`.
- FAIL (pre-existing, NOT caused by SDK removal): `probe-e2e-sidebar-align` — aside top=32 vs main top=39, delta 7px. No recent edits to Sidebar.tsx or App.tsx in this feature branch; present on `origin/working`.
- FAIL (probe fragility, NOT a product bug): `probe-e2e-send` — `cwd chip (title="~")` not found. After test DB accumulates a `recentProjects` entry, `createSession` defaults cwd to the first recent project path rather than `~` (`src/stores/store.ts:143`). Probe's selector is tied to a fresh-DB assumption.

## claude.exe zombie audit

- Baseline before tests: 5 claude.exe PIDs (user's pre-existing daily-driver sessions: 25400, 28148, 42228, 22948, 32744).
- After each probe run: same 5 PIDs, no new ones. No zombies introduced by the new spawn pipeline.
- Electron processes cleaned up cleanly on probe `app.close()`.

## Auth state observation (not a bug, just context)

`CLAUDE_CONFIG_DIR` is pinned to `~/.agentory/claude-cli-config/` (electron/agent/sessions.ts:41). This is an isolated config dir — the user's own `~/.claude/` login does NOT apply to agentory. First-run state reached the "Not logged in" error path cleanly; to fully exercise a live assistant turn, a one-time login inside that isolated config is needed. Outside T10 scope.

## Claude Desktop parity (rendering)

Comparison against `C:/Users/jiahuigu/projects/claude-desktop-rev-eng/sections/` notes (S1, S2, S4).

| Aspect                                    | Claude Desktop                                                                                                             | Agentory (this worktree)                                                                                         | Delta                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Architecture: spawn claude.exe stream-json | SDK-embedded Transport spawns claude.exe with `--output-format stream-json --input-format stream-json` (S2 §0-1)           | Direct spawn via `electron/agent/claude-spawner.ts` + `control-rpc.ts`; same protocol, no SDK dependency          | PARITY — direct implementation, same wire format                                                        |
| Block types (assistant / user / tool)     | `SdkMessage` array + renderer picks block kind (S2 §2)                                                                     | `MessageBlock` union: user, assistant, tool, todo, waiting, question, status, error (src/types.ts, ChatStream.tsx) | PARITY — Agentory has strictly more block kinds (waiting/plan/question) for permission UX               |
| Tool call UI                              | collapsible; Monaco diff viewer for file edits (S4 §2)                                                                     | Collapsible `ToolBlock` with `ChevronRight` + animated expand; custom inline `DiffView` for Read/Edit/Write      | MINOR DELTA — Agentory uses a minimal custom diff (`src/utils/diff.ts`) instead of Monaco. Acceptable for MVP. |
| Markdown in assistant text                | react-markdown + remark-gfm; syntax highlight via Monaco / tree-sitter (S4 §2.3)                                           | react-markdown + remark-gfm, no highlighter (raw `<code class="language-ts">`)                                    | DELTA — no syntax highlight on inline code blocks. Plain monospace fallback. Cosmetic; not a regression from pre-SDK-removal state. |
| Streaming tokens                          | SDK deltas → renderer incremental                                                                                          | `streamAssistantText` coalesces deltas onto a single block id; caret via `animate-pulse`                          | PARITY                                                                                                  |
| Info density                              | CLI-ish, dense, monospace tool output                                                                                      | CLI-ish: `font-mono text-sm`, `>`/`●` glyphs as authors, minimal padding, collapsed tools, `max-w-[1100px]`      | PARITY — matches the "CLI visual + GUI interaction" principle in MEMORY.md                              |
| Pane layout                               | react-resizable-panels (S4 §1)                                                                                             | Single-pane + sidebar; no resizable panels                                                                       | KNOWN SCOPE CUT — out of MVP                                                                            |
| Persistence                               | `userData/local-agent-mode-sessions/` JSONL                                                                                | `better-sqlite3` at `userData/agentory.db`                                                                        | DIFFERENT, intentional                                                                                  |

## Verdict

**YES** — chat rendering matches Claude Desktop quality at parity where both
overlap (block structure, density, streaming, collapsible tool calls). Where
Agentory differs (no Monaco diff, no syntax highlight), those are known MVP
scope cuts, not regressions from the SDK-to-spawned-claude.exe transition.

The new spawn pipeline is functional end-to-end:

- Main process boots, spawns claude.exe with correct env, translates stream-json
  to renderer blocks, handles the auth-error path cleanly.
- Renderer renders all block kinds correctly (verified via DOM inspection in
  `probe-chatstream.mjs`).
- No process leaks; interrupt pathway is well-covered by unit tests.

## Concrete regressions

None introduced by the SDK removal.

Pre-existing issues observed (not T10 scope, but logged for the backlog):

- `probe-e2e-sidebar-align` 7px delta — `src/components/Sidebar.tsx` vs App layout; needs a visual pass.
- `probe-e2e-send.mjs:68` brittle selector — depends on `~` being the default cwd; breaks once `recentProjects` is non-empty (see `src/stores/store.ts:143`).
- Local dev bootstrap: `better-sqlite3` native binary ABI mismatch vs Electron 33 on fresh install — needs `@electron/rebuild` step in docs or a postinstall hook.

## Bug fixes committed in this task

None. Source was not modified. Only addition: `scripts/probe-e2e-tool-call-dogfood.mjs` — a new probe script used to exercise the live claude.exe tool-call path.

---

## Follow-up (same day): real end-to-end — UI send → assistant reply

The original report stopped at "Not logged in" because `CLAUDE_CONFIG_DIR`
is pinned to an isolated dir with no credentials. That was the correct
observation of behavior, but it short-circuited the actual e2e. A real
user never logs in inside the isolated config — they set
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` as env vars (mirror of how
they use the CLI). Those env vars were being dropped by the SAFE_ENV
allowlist in `claude-spawner.ts` because the allowlist predates the
self-host story.

Per MEMORY.md, self-host via custom `ANTHROPIC_BASE_URL` + custom key is
Agentory's structural moat, so env passthrough is not optional.

### Fix

`electron/agent/claude-spawner.ts` — added two prefixes to `SAFE_ENV.prefixes`:

- `ANTHROPIC_` — covers `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`, and any future
  `ANTHROPIC_*` the CLI adds.
- `CLAUDE_CODE_` — covers `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_SKIP_AUTH_LOGIN`, etc.

Also hardened `CLAUDE_CODE_ENTRYPOINT`: previously it conditionally
preserved the parent's value; now we unconditionally stamp
`agentory-desktop` so server-side telemetry correctly identifies the
client even when Agentory is dogfooded from inside a Claude Code session
(where the parent sets `CLAUDE_CODE_ENTRYPOINT=cli`). `envOverrides` can
still override it for tests.

`CLAUDE_CONFIG_DIR` remains unconditionally overwritten to the isolated
path — state isolation is preserved. Env-based credentials take
precedence, which is exactly what claude.exe expects.

Proxy vars (`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `ALL_PROXY`) were
already on the exact-match list.

### New tests

5 new tests in `electron/agent/__tests__/claude-spawner.test.ts`:

- forwards `ANTHROPIC_*` credentials + endpoint configuration from parent env
- forwards `CLAUDE_CODE_*` runtime flags (Bedrock/Vertex)
- always overwrites `CLAUDE_CONFIG_DIR` with the isolated path
- `envOverrides` still win over forwarded `ANTHROPIC_*` parent vars
- existing "injects CLAUDE_CODE_ENTRYPOINT" test updated to reflect
  unconditional stamping

Total: 242/242 tests green (was 237 before this fix).

### Real end-to-end (UI send → assistant reply)

Script: `scripts/probe-e2e-env-passthrough.mjs`.

Parent env: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` set (values
redacted). Launched Electron via Playwright with inherited env, clicked
"New Session", typed the prompt, pressed Enter, waited up to 60s for an
assistant block containing "OK".

Prompt:

```
Reply with exactly the single word OK and nothing else.
```

Result: PASS in ~3.6s round-trip. Final chat region DOM innerText:

```
>
Reply with exactly the single word OK and nothing else.
●

OK

INFO
Done
— 1 turn · 3.6s · 32k in / 1 out · $0.487
agentory-next
·
opus-4
·
auto
Send
Enter send · Shift+Enter newline
```

Interpretation:

- `>` and `●` are the user and assistant author glyphs (CLI-visual
  principle).
- `OK` is the assistant reply, verbatim, matching the requested format.
- `INFO Done — 1 turn · 3.6s · 32k in / 1 out · $0.487` is the
  `StatusBanner` emitted from the `result` stream-json frame —
  confirming the full turn round-tripped through `buildSpawnEnv` →
  claude.exe → custom endpoint → stream-json → `streamToBlocks` →
  renderer.
- No "Not logged in" banner, no error blocks.

### Updated verdict

**End-to-end passes.** The SDK-removal migration is fully functional for
the self-host workflow. A user who sets `ANTHROPIC_BASE_URL` +
`ANTHROPIC_AUTH_TOKEN` in their shell and launches Agentory gets a real
assistant turn with zero extra configuration and without their
credentials being written to the isolated `~/.agentory/claude-cli-config/`.

The earlier "Not logged in" observation was an artifact of the SAFE_ENV
allowlist, not a protocol or spawn-layer bug.

