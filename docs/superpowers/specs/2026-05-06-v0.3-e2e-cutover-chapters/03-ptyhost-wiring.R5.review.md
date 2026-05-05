# Review of chapter 03: ptyHost wiring

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): §1 `host` flag has no "ready signal" — TerminalPane doesn't yet have a UT, and acceptance is e2e-only

**Where**: chapter 03, §1 `host` subsection (lines 22-33), and the chained acceptance (lines 58-67).
**Issue**: §1 says the host element MUST render unconditionally, with the Retry-state child INSIDE the host (not in lieu of it). Verified at HEAD `6e3a1bd4` — `src/components/TerminalPane.tsx:122` returns `null` in some branches, which is exactly the gating pattern the spec forbids. The fix is small and clearly scoped, but:
- `tests/components/TerminalPane.test.tsx` **does not exist** (verified `ls tests/components/`).
- Chapter 05 PR-4 acceptance (line 119) writes `tests/terminal/TerminalPane.test.tsx (extend)` — wrong path AND wrong "extend".
- Chapter 03 §1 names no UT requirement at all; the only acceptance is the harness `terminal-pane-mounted` case (named in chapter 04 §3 implicitly).

**Why this is P0**: the unconditional-host property is the most-easily-regressed property in the entire spec — any future React change to TerminalPane that adds an early `if (!claudeAvailable) return null` will silently re-introduce S5. Today there is **no** unit-test guard. The harness signal is 60s+ later and only on CI.

**Suggested fix**: add to chapter 03 §1, at the end of the `host` subsection:

> **MUST** add UT `tests/components/TerminalPane.test.tsx` (NEW file — chapter 05 PR-4 acceptance must be updated; the path `tests/terminal/TerminalPane.test.tsx` in chapter 05 §3 PR-4 is incorrect, and "extend" should be "create"). The UT MUST cover:
> - `claudeAvailable: false` → host element with `data-testid="terminal-host"` and `data-sid` is in the rendered output.
> - `claudeAvailable: true, exitKind: 'crashed'` → same; Retry button is a child of host.
> - `claudeAvailable: true, kind: 'idle'` → same; xterm container child of host.
> Render with React Testing Library; assert `getByTestId('terminal-host')` never throws.

### P0-2 (BLOCKER): §3 Option C decision lacks a "ready signal" definition for `spawnDaemon` — testability ambiguity

**Where**: chapter 03, §3 "Required contract" + Option C decision (lines 116-187).
**Issue**: Option C mandates `await spawnDaemon()` before `BrowserWindow`. Verified `electron/daemon-spawner.ts:6-32`: the daemon prints `PORT=<n>` on stdout and `readyPromise` resolves on that line. So the "ready signal" is well-defined in code (PORT line → resolve). But the spec doesn't pin this contract — a future refactor could make `spawnDaemon` resolve on `child.spawn()` returning (process started but port not bound) and Option C's invariant collapses silently.

The spec also doesn't define what happens during the await:
- Is there a hard timeout? (Today `daemon-spawner.ts` has no timeout — the readyPromise can hang forever if daemon never prints PORT.)
- Does `app.whenReady()` proceed if `spawnDaemon` rejects?
- What's the user-visible error?

The `Cons` line for Option C says "cold app launch is now sequenced" — without a timeout this becomes "cold app launch can hang forever if daemon misbehaves."

**Why this is P0**: the readiness contract is the entire point of the chapter. Leaving it to "the implementation does the right thing" is the load-bearing assumption that makes Option C testable vs untestable.

**Suggested fix**: add to §3 "Required contract" before Option C:

> **Ready signal**: `spawnDaemon()` resolves iff:
> 1. Daemon child process spawned successfully (no `ENOENT`).
> 2. Daemon stdout emitted exactly one line matching `^PORT=(\d+)$`.
> 3. The parsed port is in `[1, 65535]`.
> Resolves to that port number. Rejects on any of: spawn failure, stdout EOF before PORT line, malformed PORT line, daemon child exit before PORT line.
>
> **Timeout**: `spawnDaemon()` MUST reject after 10s if no PORT line arrives. Caller (`electron/main.ts`) MUST handle rejection by surfacing a fatal startup error dialog and exiting cleanly — NOT by retrying or proceeding to `createWindow`.
>
> **UT**: `electron/__tests__/daemon-spawner.test.ts` (extend if exists, else NEW) covers: PORT-line happy path, malformed PORT line rejects, stdout-EOF rejects, 10s timeout rejects. Mock the child process via `child_process.spawn` stubbing.

The current §3 §"Required contract" paragraph (lines 125-130) talks about "wait until first call" / "30s threshold" but those refer to the OLD bridge-poll model, not Option C; reading the chapter top-to-bottom is confusing because the contract paragraph predates the decision. Reorder so the Option C contract is self-contained.

### P1-1 (must-fix): three RPCs (§5) — UT requirement is per-RPC but Connect-roundtrip is hand-waved

**Where**: chapter 03, §5 "Three real RPCs (HP-9)", subsections per RPC (lines 240-286).
**Issue**: each RPC subsection ends with a "Connect-roundtrip" line. For `input` it's "a renderer-side test (or a thin harness probe)" — i.e., undefined: is it a Vitest test, a harness case, or a manual probe? For `resize` it's "harness UI case (Set B nice-to-have)" — i.e., NOT in Set A, NOT a release blocker, but iron rule §3.5 says all three RPCs MUST have Connect-roundtrip in v0.3. Contradiction. For `checkClaudeAvailable` the roundtrip is implicit ("`terminal-pane-mounted` indirectly covers"), which is exactly the kind of "indirect" coverage that bites later.
**Why this is P1**: iron rule §3.5 is one of the spec's six iron rules. Either the rule is "real impl + UT + Connect-roundtrip per RPC" (in which case `resize` cannot be Set B nice-to-have) or the rule allows indirect coverage (in which case the rule should say so).
**Suggested fix**: pick one of:

(a) **Strict** (recommended): each of the three RPCs gets a dedicated harness case in Set A:
- `pty-input-roundtrip`: `await ccsmPty.input(sid, 'echo hi\r')`; assert `pty:data` event fires within 1s with text containing "hi".
- `pty-resize-roundtrip`: `await ccsmPty.resize(sid, 80, 24)`; assert daemon `pty.resize` was called with (80, 24).
- `pty-claude-available-roundtrip`: `await ccsmPty.checkClaudeAvailable({force:true})`; assert returns `{available: bool}` shape.

Add to chapter 04 §4 New harness cases table.

(b) **Relaxed**: rewrite iron rule §3.5 to "real impl + UT per RPC; Connect-roundtrip MAY be indirect via an existing Set A case if that case's failure would surface the RPC regression with no greater than 1 layer of indirection."

R5 recommends (a) — the three cases together are ~50 lines of harness code, run in <5s total, and pin the contract directly.

### P1-2 (must-fix): §2 SSE guarantees G-1..G-4 lack mapping to the UT cases

**Where**: chapter 03, §2 "SSE event delivery" (lines 76-113).
**Issue**: §2 lists four guarantees (G-1..G-4) and the UT requirement section says "extend `daemon/ptyHost/__tests__/dataFanout.test.ts` with three cases." Verified that file exists at HEAD. But the three listed UT cases don't cleanly map to G-1..G-4:
- "subscribe AFTER pty wrote data → attach response carries snapshot" → covers G-2.
- "two subscribers per sid → both receive every `pty:data`; `pty:exit` fires for both exactly once" → covers G-1 + G-3.
- "subscriber unsubscribes mid-stream → other subscriber unaffected" → covers G-1 (partial).
- G-4 (auto-reconnect doesn't replay) → no UT listed.

R5 angle: G-4 is the most-likely-to-flake guarantee in production and has zero coverage.

**Why this is P1**: G-4 is the property that makes SSE reconnection safe under load; without a UT, the spec ships on hope.
**Suggested fix**: add a 4th UT case to §2 UT requirements:

> - subscriber drops connection (simulate `EventSource.close()`) and reconnects (new `EventSource`) → daemon serves only events emitted AFTER the reconnect timestamp; the renderer receives no replay of pre-disconnect events.

Re-table the UT-to-guarantee mapping explicitly so the next reviewer can verify.

### P1-3 (must-fix): §4 sigkill-reattach contract has a TTL but no UT for the TTL boundary

**Where**: chapter 03, §4 "sigkill-reattach (HP-8)", "Implementation responsibilities" (lines 218-228).
**Issue**: §4 says the buffer snapshot is retained "until either (a) the renderer issues `detach` and never reattaches before a TTL (e.g. 60s), or (b) ...". The TTL is parenthetical ("e.g. 60s") — not pinned. The mandated UT only requires "a case for this exact flow" (the happy path). No UT covers:
- TTL elapses → snapshot is GC'd (memory leak guard).
- TTL elapses → fresh attach gets fresh snapshot (no stale data leak).
- Reattach BEFORE TTL → snapshot served.
- Detach + immediate reattach → no GC race.

**Why this is P1**: a TTL without a UT is a memory leak in production. The whole point of HP-8 is correctness across SIGKILL — boundary conditions are the spec.
**Suggested fix**: pin the TTL ("60s, configurable via `CCSM_PTY_SNAPSHOT_TTL_MS`, default 60_000"), add 4 explicit UT cases to `daemon/ptyHost/__tests__/lifecycle.test.ts` matching the four bullets above. Use `vi.useFakeTimers()` for TTL boundary.

### P2-1 (nice-to-have): error tokens (§6) lack a registry

**Where**: chapter 03, §6 "Error surface conventions" (lines 294-308).
**Issue**: §6 lists three example tokens (`no_such_sid`, `bad_request`, `spawn_failed`) and says "stable lowercase token". Good. But there's no central registry — each RPC's "MUST: error-typed response" line invents its own (`no_such_sid`, `value_too_large` proposed in chapter 02 R2 P2-3, etc.). Without a registry, two RPCs may invent different tokens for the same condition, or a fixer may grep for `no_such_sid` and find one usage but miss a sibling RPC's `unknown_sid`.
**Why this is P2**: testability angle is "tests assert exact strings" — a registry makes the tests self-documenting and the contract greppable.
**Suggested fix**: add a §6 sub-table:

| Token | Used by | Meaning |
|-------|---------|---------|
| `no_such_sid` | `input`, `resize` | sid not registered with daemon |
| `bad_request` | `resize` (cols/rows ≤ 0), `data.set` (empty key) | client-side validation failure |
| `spawn_failed` | `spawn` | underlying pty spawn threw |
| `value_too_large` | (proposed) `data.set` | value > 1 MiB |
| `daemon_not_ready` | (any) | daemon HTTP server up but not yet accepting RPCs |

Add a UT in `daemon/api/__tests__/error-tokens.test.ts` (NEW) that asserts the registry list matches every `error: '<token>'` literal grep'd from `daemon/api/`.

## Cross-file findings

P0-1 (TerminalPane UT) cross-cuts chapter 05 PR-4 acceptance (path is wrong AND "extend" is wrong). One fixer should fix both chapter 03 §1 and chapter 05 PR-4 acceptance.

P0-2 (Option C ready signal + timeout) cross-cuts chapter 05 PR-3 acceptance (which currently says "harness `attach-replay-from-headless-buffer` no longer reports daemon port unavailable" — but doesn't require the timeout case to be tested). Same fixer.

P1-1 (three RPCs Connect-roundtrip) cross-cuts chapter 04 §4 (need three new harness cases) and chapter 00 §3 iron rule §3.5 (rule needs sharper wording). Single fixer.
