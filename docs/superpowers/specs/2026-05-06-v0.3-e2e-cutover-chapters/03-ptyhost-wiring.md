# 03 — ptyHost wiring (host / term / buffer / daemon-port / RPCs)

This chapter owns the fixes for [01-cutover-audit](./01-cutover-audit.md)
HP-3, HP-4, HP-8, HP-9. The core narrative is "the SSE pipe + daemon-port
handshake + three real RPCs that wave-2-B intended to ship are all
half-wired; this chapter pins down the contract for each, plus the
cold-start sequence so `waitForTerminalReady` actually flips
`{host:true, term:true, buffer:true}` deterministically."

## 1. The three readiness flags (HP-4)

`scripts/probe-utils-real-cli.mjs:85-113` polls the renderer:

```js
const host  = !!document.querySelector(`[data-testid="terminal-host"][data-sid="${sid}"]`);
const term  = !!window.__ccsmTerm;
const buffer = !!(window.__ccsmTerm && window.__ccsmTerm.buffer && window.__ccsmTerm.buffer.active);
```

We define exactly what produces each flag and what gates can stop it.

### `host` — TerminalPane host element exists

- **Producer**: `src/components/TerminalPane.tsx` renders a host
  `<div data-testid="terminal-host" data-sid={sid} />` UNCONDITIONALLY
  once the active session id matches `sid`.
- **R1 baseline-cite (MUST, before any code change)**: fixer / PR
  author MUST first run `git show 35b08d15^:src/components/TerminalPane.tsx`
  to record v0.2's claude-missing branch (independent error screen vs
  inline Retry inside host). The v0.2 DOM topology is the baseline; any
  new code path MUST cite v0.2 baseline line numbers in the PR body.
  Diverging from v0.2 DOM topology requires explicit user/product
  approval recorded in the PR; absent approval, preserve v0.2 shape
  and only expose a stable `data-testid` on whichever element actually
  mounts (harness selector adapts, not UI).
- **Required gate change** (conditional on baseline above): if v0.2
  already renders the host unconditionally with an inline error child,
  there MUST NOT be a "claudeAvailable === true" conditional render
  around the host element; the pane MAY render an error-state child
  (Retry button) inside the host when claude is missing, but the host
  element with `data-testid` MUST be present. If v0.2 swaps host for
  an independent error screen, preserve that and add a stable
  `data-testid` on the error screen instead — do NOT collapse it into
  host.
- **Why**: the harness uses host presence as the "did App→TerminalPane
  wiring fire" signal; gating it on a downstream RPC (HP-9) couples
  S5 to S1 unnecessarily.

### `term` — xterm `Terminal` instance pinned

- **Producer**: `src/terminal/xtermSingleton.ts` creates the `Terminal`
  in a `useEffect([sid])` and assigns `window.__ccsmTerm = term`.
- **Required**: assignment fires once the term is open() onto the host
  DOM, BEFORE the first attach RPC. Pinning order:
  1. `new Terminal(...)`
  2. `term.open(hostEl)`
  3. `window.__ccsmTerm = term`
  4. `window.ccsmPty.attach(sid)` (RPC; may fail or take time)
- **Why**: `__ccsmTerm` is the harness's signal that the singleton has
  been instantiated for the current sid; deferring it past the attach
  RPC means `term:false` whenever HP-3 / HP-9 is slow.

### `buffer` — `term.buffer.active` non-null

- **Producer**: xterm's `term.buffer.active` becomes non-null synchronously
  after `term.open()`. This MUST be true the moment `term` is true; if
  it isn't, the xterm singleton was created without `open(host)` —
  treat as a host-mount race and fix in TerminalPane.
- **Required**: there MUST be no code path that exposes `__ccsmTerm`
  before `open()` is called.

### Acceptance (chained)

`waitForTerminalReady(sid, 60000)` resolves true within ~5s on a cold
launch when:

- daemon port is bound (HP-3 fixed)
- `pty:spawn` RPC succeeds (HP-9 fixed)
- TerminalPane mounts the host unconditionally (this section §1)
- xterm singleton pins `__ccsmTerm` after `open()` (this section §1)

### MUST UT — TerminalPane unconditional host (R5 testability lever)

`tests/components/TerminalPane.test.tsx` (**NEW** — file does NOT exist
at HEAD `5d0c5375`; verified `ls tests/components/` and `ls
tests/terminal/`. The conventional path matches `src/components/TerminalPane.tsx`,
NOT `tests/terminal/`.) MUST land in the same PR as the production fix
to §1, with React Testing Library, covering exactly these three cases:

1. **`claudeAvailable: false`** — render `<TerminalPane sid="s1" />`
   with store state `{ claudeAvailable: false }`. Assert
   `getByTestId('terminal-host')` resolves; the host element carries
   `data-sid="s1"`. The Retry button (claude-missing affordance) is a
   CHILD of the host element (`getByTestId('terminal-host').contains(retryBtn)`),
   NOT in lieu of it. Cite v0.2 baseline at `35b08d15^` per §1
   "R1 baseline-cite (MUST)" — if v0.2 swaps host for a separate error
   screen, mirror that DOM topology and assert the stable `data-testid`
   on whichever element v0.2 actually mounts.
2. **`claudeAvailable: true, exitKind: 'crashed'`** — same; the
   crashed-state Retry / restart child is INSIDE host. `getByTestId('terminal-host')`
   never throws.
3. **`claudeAvailable: true, kind: 'idle'`** — same; the xterm
   container child is INSIDE host. `getByTestId('terminal-host')` never
   throws.

**Why MUST**: the unconditional-host property is the single
most-easily-regressed property in the entire spec. Any future React
change to TerminalPane that adds an early `if (!claudeAvailable) return null`
silently re-introduces S5 (chapter 01 §"Symptom catalog"). The harness
`terminal-pane-mounted` case is a 60s+ signal on CI; the UT above is a
~100ms signal on every commit. Both are required; the harness is
acceptance, the UT is regression test.

## 2. SSE event delivery

`electron/preload/bridges/ccsmPty.ts:84-146` opens an `EventSource`
per sid. Daemon side at `daemon/api/pty.ts` listens via
`registerSubscriber` and pushes `pty:data` / `pty:exit` / `pty:ack`.

### Required guarantees

1. **G-1**: A `pty:data` event MUST be delivered to the renderer for
   any data emitted by the pty AFTER the SSE socket is established for
   that sid. (No drop on subscribe.)
2. **G-2**: A late subscriber (subscribes AFTER pty has already produced
   data) MUST be served the buffer snapshot via the `attach` RPC, NOT
   via the SSE backlog. SSE is "live tail only."
3. **G-3**: `pty:exit` MUST fire exactly once per pty lifetime,
   regardless of subscriber count.
4. **G-4**: SSE auto-reconnect (the EventSource default) MUST NOT
   replay events the renderer already received. Daemon SHOULD treat
   reconnection as "open new tail; renderer is responsible for catching
   up via attach if it cares."
5. **G-5 (reconnect dedup contract)**: every `pty:data` event MUST
   carry a monotonically-increasing `seq: number` (per-sid, never
   reused, never decreasing across reconnects). The `attach` RPC
   response MUST be `{ snapshot, snapshotLastSeq }` where
   `snapshotLastSeq` is the `seq` of the LAST `pty:data` event that
   was already incorporated into `snapshot`. On reconnect the
   renderer MUST filter incoming `pty:data` events with
   `seq <= snapshotLastSeq` (drop them — they are already in the
   painted snapshot). User input issued during the SSE reconnect
   window MUST be queued in renderer (cap **64 KiB**); on overflow
   the bridge MUST surface `daemon_unavailable` to the caller and
   drop the queued bytes — silent truncation is forbidden. Once the
   new EventSource is `open`, the queue MUST be flushed in arrival
   order via the existing `input` RPC before any new keystrokes are
   forwarded.

### Concrete v0.3 fixes

- **G-2** is the mechanism that makes `attach-replay-from-headless-buffer`
  work. The fixer MUST verify `daemon/ptyHost/dataFanout.ts` retains
  the buffer snapshot (`getBufferSnapshot` exists per `daemon/api/pty.ts`),
  and that `ccsmPty.attach` calls `getBufferSnapshot` server-side
  before opening the SSE channel — OR returns the snapshot in the
  attach response so renderer can paint then subscribe.
- **G-3** is currently lossy under the wave-2 SSE multiplexer (tear-down
  on `pty:exit` is correct at preload bridge but the daemon must
  guarantee single-emission across N subscribers — see `daemon/api/pty.ts`
  `closeSseClients`-equivalent path).

### UT requirement

`daemon/ptyHost/__tests__/dataFanout.test.ts` already exists. The
fixer MUST add (or extend) cases:

- subscribe AFTER pty wrote data → attach response carries snapshot
  (≠ live tail).
- two subscribers per sid → both receive every `pty:data`; `pty:exit`
  fires for both exactly once.
- subscriber unsubscribes mid-stream → other subscriber unaffected.
- subscriber close + reconnect (per G-5) → the new EventSource
  receives ONLY events with `seq > snapshotLastSeq`; the renderer
  MUST observe zero replay of pre-close events. UT asserts the
  filtered event set equals the post-reconnect emission set
  exactly (no replay, no drop of post-reconnect events). Queued
  input issued during the reconnect window MUST be observed by the
  pty fake exactly once after the new EventSource opens, in
  arrival order.

**Why**: these are the exact properties HP-8 sigkill-reattach depends on.

## 3. Daemon-port readiness (HP-3)

### Failure mode being fixed

`electron/preload/bridges/ccsmPty.ts:35-50` has a 5s budget polling
`ipcMain.invoke('daemon:getPort')` at 100ms intervals. Cold electron
launches under e2e routinely exceed 5s before main has spawned the
daemon, bound the port, parsed the `PORT=<n>` line.

### Required contract

The 5s budget MUST be replaced — Option C below makes the daemon port
available BEFORE the renderer runs, so the per-RPC poll becomes a
fallback (≤10 iterations, surfaces as typed error if exhausted) rather
than the primary readiness mechanism. The ready-signal + timeout +
error-handling contract for `spawnDaemon()` itself is the load-bearing
piece and is pinned below; it is intentionally listed BEFORE the Option
A/B/C choice so the decision section is self-contained.

#### `spawnDaemon()` ready signal (MUST, R5 testability)

`spawnDaemon()` resolves iff ALL of the following hold:

1. Daemon child process spawned successfully (no `ENOENT` / `EACCES` /
   spawn-syscall failure).
2. Daemon stdout emitted exactly one line matching the regex
   `^PORT=(\d+)$` (anchored, single capture). Stdout lines NOT matching
   this regex MUST be ignored (forwarded to electron stderr per ch03 §6
   logging) but MUST NOT resolve the promise.
3. The parsed port number is in the inclusive range `[1024, 65535]`
   (ephemeral / user range; daemon never binds to privileged
   `[1, 1023]`).

Resolves to `{ port: <n>, pid: <n> }`. Rejects with a typed `Error`
(`code` ∈ `'spawn_failed' | 'malformed_port' | 'stdout_eof' |
'child_exit_before_port' | 'startup_timeout'`) on any of: spawn
failure, stdout EOF before PORT line, malformed PORT line, daemon
child exit before PORT line, startup timeout (next subsection).

**Why pinned**: a future refactor that resolves `spawnDaemon` on
`child.spawn()` returning (process started but port not bound) silently
collapses Option C's invariant. Pinning the regex + range as the
contract makes the regression catchable at UT tier.

#### 10s startup timeout (MUST, R5 testability)

`spawnDaemon()` MUST reject with `code: 'startup_timeout'` if no
matching `PORT=` line arrives within **10 seconds** of `child_process.spawn()`
returning. The timer starts at spawn-call return, not at
`child.on('spawn')` (some platforms delay the `spawn` event under
load); the goal is wall-clock-bounded user-visible startup.

The 10s value is a hard upper bound for any reasonable cold spawn on
the supported platforms (Win / macOS / Linux). If a future platform
proves to need >10s, the value is a per-platform spec edit, not a
silent extension.

#### Spawn-failure error handling (MUST)

Caller (`electron/main.ts`) MUST handle `spawnDaemon()` rejection by:

1. Surfacing a **fatal native Electron error dialog** (`dialog.showErrorBox`)
   with the rejection `code` + the daemon's last stderr line (truncated
   to 500 chars).
2. Calling `app.exit(<non-zero>)` — clean exit, no `process.exit` mid-event-loop.
3. **NOT** retrying `spawnDaemon` (that retry is owned by §3 "Spawn
   failure path" below and applies to the port-collision case ONLY).
4. **NOT** proceeding into `createWindow()`. A daemon-less window
   violates the Option C contract and is worse for the user than no
   window.

Auto-restart loops are explicitly v0.4 reliability scope (see §7 +
chapter 00 §3.7).

#### MUST UT — `electron/__tests__/daemon-spawner.test.ts` (R5 testability)

`electron/__tests__/daemon-spawner.test.ts` (**NEW** — file does NOT
exist at HEAD `5d0c5375`; verified `ls electron/__tests__/`. Mock the
child process via `vi.mock('node:child_process', ...)` stubbing
`spawn`.) MUST cover exactly these four cases:

1. **PORT-line happy path** — child stdout emits `"PORT=12345\n"`;
   `spawnDaemon()` resolves to `{ port: 12345, pid }` within fake-time
   <10s.
2. **Malformed PORT line rejects** — child stdout emits `"PORT=abc\n"`
   or `"PORT=80\n"` (privileged range) or `"PORT=99999\n"` (out of
   range); `spawnDaemon()` rejects with `code: 'malformed_port'`.
3. **stdout-EOF rejects** — child stdout closes without PORT line
   (e.g. daemon binary prints nothing then exits); `spawnDaemon()`
   rejects with `code: 'child_exit_before_port'` or `'stdout_eof'`.
4. **10s timeout rejects** — child stdout never emits; advance fake
   timers to 10s + 1ms; `spawnDaemon()` rejects with `code: 'startup_timeout'`.

Each case asserts the rejection is a typed `Error` with the expected
`code`, NOT a generic string error. Use `vi.useFakeTimers()` for the
timeout case.

#### Cold-spawn budget (measured)

Option C makes "renderer cannot run before daemon is ready" the contract,
which means daemon-boot latency lands on the user-visible "click →
window" path. The choice is conditional on that latency staying within
budget.

- **Baseline**: `35b08d15` cold-launch click-to-window time, measured on
  the developer's primary box for each platform (Win / macOS / Linux).
- **Budget**: post-Option-C cold-launch p95 MUST NOT regress more than
  **500ms** vs the `35b08d15` baseline on any of the three platforms.
- **Measurement**: PR-3 MUST attach a `p50`/`p95` table (Win / macOS /
  Linux, baseline vs Option-C) to the PR body. Until that table exists
  the value below stays as a placeholder:

  | platform | baseline p95 | Option-C p95 | delta |
  |----------|--------------|--------------|-------|
  | Windows  | `<TBD by PR-3>` | `<TBD by PR-3>` | `<TBD by PR-3>` |
  | macOS    | `<TBD by PR-3>` | `<TBD by PR-3>` | `<TBD by PR-3>` |
  | Linux    | `<TBD by PR-3>` | `<TBD by PR-3>` | `<TBD by PR-3>` |

- **Trigger**: a delta >500ms on any platform forces the fallback to
  **Option B** (pre-resolved port cache via `daemon:portReady` IPC
  event) per chapter 05 §7 Risk-1 — this is automatic, NOT a manager
  judgement call. The fallback path is pre-designed below; Option B
  becomes the shipped solution and Option C is documented as
  "considered, exceeded budget."

#### Implementation choice

There are three viable shapes; pick exactly ONE and document the
choice:

##### Option A — extend the bridge poll budget to 30s

Cheapest. Change `for (let i = 0; i < 50; i += 1)` to `for (let i = 0;
i < 300; i += 1)` and update the error message. Still polls.

**Pros**: 1-line change, no protocol change, no other bridge update.
**Cons**: still busy-polls; first RPC after cold start now incurs full
boot latency on its critical path.

##### Option B — pre-resolve port in `ccsmPty` module init

The bridge subscribes to a `daemon:portReady` `ipcRenderer.on` event
during preload init. Main fires the event once `spawnDaemon().then(...)`
resolves. The bridge caches the port immediately; first RPC has zero
boot wait.

**Pros**: zero per-RPC overhead; matches "preload sets up everything
synchronously" model.
**Cons**: requires `electron/main.ts:171` to register a `BrowserWindow.webContents.send('daemon:portReady', port)` AFTER window creation.
Extra IPC channel.

##### Option C — `await spawnDaemon()` in main BEFORE creating the BrowserWindow

`electron/main.ts:171` currently fire-and-forgets. Switching to
`await spawnDaemon()` before `createWindow()` means by the time the
renderer JavaScript runs, the port is already exposed via the existing
`ipcMain.handle('daemon:getPort')` and the bridge's first poll wins
on iteration 0.

**Pros**: cleanest contract — "renderer cannot run before daemon is
ready"; no new IPC channel; one-line fix in `electron/main.ts`.
**Cons**: cold app launch is now sequenced (window appears later).
Acceptable iff the budget above holds; if not, Option B auto-wins.

#### Decision

**MUST adopt Option C** (await spawnDaemon before BrowserWindow),
**conditional** on the measured cold-spawn budget above
(≤500ms p95 regression vs `35b08d15` on Win / macOS / Linux).
**Why**: it's the only option that simultaneously makes the contract
explicit ("daemon ready iff window exists"), removes the per-RPC
critical-path penalty, and requires zero changes downstream.

The 5s `for (let i = 0; i < 50; i += 1)` poll in
`electron/preload/bridges/ccsmPty.ts:41` MUST stay (fallback path —
`getDaemonPort()` could theoretically return null on extreme bad luck
between the await and the first RPC) but MAY be shortened to 10
iterations. The error message MUST include "this should never happen
post-spawnDaemon-await" so a future regression is debuggable.

#### Spawn failure path

If `spawnDaemon()` rejects (port bind failure, daemon binary missing,
permission denied, malformed `PORT=<n>` line, 10s startup-timeout —
see chapter 03 §3 ready-signal contract owned by CF-7), main MUST:

1. **Catch** the rejection at the top-level `await` site in
   `electron/main.ts`. No unhandled-rejection.
2. **Retry exactly once** with `port=0` (ask the OS to assign any free
   loopback port) before surfacing failure. The single retry covers the
   common "developer left a previous daemon bound on a fixed port"
   collision; it does NOT cover deeper failures.
3. If the retry also rejects: show a **native Electron error dialog**
   (`dialog.showErrorBox`) with the daemon's last stderr line (truncated
   to 500 chars) and exit the app with a **non-zero exit code**.
4. **No automatic restart loop.** Auto-restart is explicitly v0.4
   reliability scope (see §7 + chapter 00 §3.7 — owned by F-00).
5. **No silent fallback** to "open the window without a daemon." The
   contract is "daemon ready iff window exists"; a daemon-less window
   is worse than no window for the user.

#### Race after await

Even with Option C's `await spawnDaemon()`, there is a window between
the await resolving and the first preload RPC firing where
`getDaemonPort()` could theoretically return null (e.g., the in-memory
port reference is cleared by a separate `before-quit` racing the
bootstrap). The fixer MUST either:

- **Prove the race cannot occur** by inspecting `electron/main.ts` and
  showing that no path between `await spawnDaemon()` resolving and
  `createWindow()` returning can clear the port, AND that `before-quit`
  is not registered until after `createWindow()` returns; OR
- **Pin the worst-case window** in the spec (e.g., "≤1 event-loop tick
  between `await spawnDaemon()` resolving and `createWindow()` returning,
  no other handler can preempt") AND keep the ≤10-iteration bridge poll
  as the explicit guard for that window.

The retained 10-iteration poll (above) is the implementation guard;
this section is the contract that makes it explicit.

### Renderer error surface

If the bridge ever does throw "daemon port unavailable", the renderer
MUST surface a user-visible error (not a silent retry-loop). Existing
zustand error slice handles this; verify the toast appears in
`window.ccsmPty.spawn` failures.

### Loopback bind invariant

**MUST**: the daemon HTTP server MUST bind `127.0.0.1` only; binding
to `0.0.0.0` / `::` / 任何非 loopback 接口 = P0 regression. Daemon
当前无 auth, loopback 是唯一 trust boundary。任何放宽必须独立 RFC +
user/product approval (例如 v0.4 web-frontend prep 等场景), 不允许
spec 默认带入。Gate enforcement: see
[ch05 §1 G9](./05-release-slicing-and-dag.md#1-top-level-v03-e2e-iron-rules-recap-gate-form);
surface implication: see
[ch02 §1](./02-store-and-preload-surface.md#1-surface-catalog-what-lives-on-window)
footer note.

## 4. sigkill-reattach (HP-8)

### v0.3 scope (R1 strict, manager decision round 1)

**v0.3 = restore the v0.2 daemon-port already-shipping attach-replay path
to green; nothing more.** Once HP-3 unblocks the daemon-port boundary, the
renderer's reattach-after-pty:exit flow MUST behave as it did at
`35b08d15^`. Buffer replay is served by daemon's **existing v0.2 snapshot
behaviour (unchanged)** — no new TTL / cap / eviction / cwd semantics are
introduced in v0.3. v0.3 is a refactor (chapter 00 §2); introducing new
product rules on this path would expand scope.

**Explicitly out of v0.3** (see §7 below for the consolidated defer list):
60s snapshot TTL pin, buffer cap (1MB/sid), ring-buffer truncation +
eviction log, cwd-mismatch → discard snapshot rule, NEW
`sigkill-reattach` harness case in Set A, and chapter 05 G10 release-gate
lock.

### Required contract (v0.2 behaviour restoration only)

After:

1. renderer attached to sid X
2. external SIGKILL hits the pty process (e.g. user clicks Force Kill,
   or `pty.kill('SIGKILL')`)
3. renderer detects via `pty:exit{ code:null, signal:'SIGKILL' }`
4. renderer issues `ccsmPty.spawn({ sid: X, cwd: <same> })`
5. renderer issues `ccsmPty.attach(X)`

The daemon MUST behave exactly as it did at `35b08d15^`:

- accept the spawn for the SAME sid (re-use is allowed, NOT an error) —
  v0.2 already shipped this.
- accept the attach and return the buffer snapshot via daemon's existing
  v0.2 `getBufferSnapshot` path; no new response shape.
- emit fresh `pty:data` events for the new pty.

### Implementation responsibilities (v0.3)

- Verify (do not modify) that `daemon/ptyHost/lifecycle.ts` retains the
  pre-kill buffer using the v0.2 mechanism. If wave-2 cutover changed the
  retention behaviour, restore the v0.2 behaviour; do NOT introduce a new
  TTL / cap / eviction policy.
- The `attach-replay-from-headless-buffer` harness case (already in
  Set A pre-cutover) is the e2e signal for this restoration. The NEW
  `sigkill-reattach` case proposed for chapter 04 §4 stays Set B
  informational in v0.3.

**Why**: this section's job in v0.3 is to make sure the v0.2 attach-replay
path is green again, not to harden it further. Hardening (TTL / cap /
eviction / new UTs / new harness case promotion) is the v0.4 reliability
workstream.

## 5. Three real RPCs (HP-9)

The iron rule: `SendInput / Resize / CheckClaudeAvailable` MUST be
real, UT-covered, Connect-roundtripped in v0.3.

### `input` (SendInput)

- **Wire**: `POST /api/pty/input` body `{ sid, data }` → `{ ok: true }`.
- **Daemon impl**: `daemon/api/pty.ts` — calls
  `inputPtySession(sid, data)` from `daemon/ptyHost/index.ts`, which
  writes to the underlying `pty.write()`.
- **MUST** (R1 baseline-cite): fixer MUST first verify v0.2 behavior
  via `git show 35b08d15^:` on the pre-cutover IPC handler for
  `pty:input`. If v0.2 already silently drops writes to an unknown sid
  (200 OK + no-op), v0.3 MUST preserve silent-drop semantics — promotion
  to a typed error (`{ ok: false, error: 'no_such_sid' }`) is a v0.4
  candidate that requires user/product approval, not a v0.3 refactor
  freebie. Only if v0.2 already returned a typed error may v0.3 keep
  the typed-error response.
- **UT**: `daemon/ptyHost/__tests__/lifecycle.test.ts` — write to
  unknown sid returns typed error; write after kill returns typed error;
  write to live sid is observed by the underlying pty fake.
- **Connect-roundtrip**: a renderer-side test (or a thin harness probe)
  asserts `await window.ccsmPty.input(sid, 'x\r')` round-trips and
  `pty:data` event fires within 1s.

### `resize` (Resize)

- **Wire**: `POST /api/pty/resize` body `{ sid, cols, rows }` → `{ ok: true }`.
- **Daemon impl**: `resizePtySession(sid, cols, rows)` → `pty.resize(...)`.
- **MUST** (R1 baseline-cite): fixer MUST first verify v0.2 behavior
  via `git show 35b08d15^:` on the pre-cutover resize handler. Default
  is to **clamp** invalid `cols`/`rows` (≤0, non-integer) to a safe
  minimum (e.g. 1) and proceed — NOT reject with 400. Promotion to
  `400 bad_request` is allowed ONLY if v0.2 already rejected the same
  inputs (cite the baseline line); otherwise preserve the v0.2
  acceptance envelope and add a UT proving the clamp behavior matches
  v0.2.
- **UT**: existing tests under `daemon/ptyHost/__tests__/` — extend if
  resize coverage missing.
- **Connect-roundtrip**: harness UI case (a Set B nice-to-have, NOT a
  Set A blocker) verifies that resizing the window leads to a `resize`
  RPC against the daemon.

### `checkClaudeAvailable`

- **Wire**: `POST /api/pty/checkClaudeAvailable` body `{ force?: boolean }`
  → `{ available: boolean, path?: string, reason?: string }`.
- **Daemon impl**: `daemon/ptyHost/claudeResolver.ts` — already exists.
  MUST return `available: true` only when the claude binary is found
  AND executable. `force: true` bypasses any caching.
- **MUST**: never throws; on resolver error returns
  `{ available: false, reason: <one-line explainer> }`.
- **UT**: `daemon/ptyHost/__tests__/claudeResolver.test.ts` already
  exists; verify it covers (a) binary present, (b) binary missing,
  (c) binary present but not executable, (d) `force` bypass.
- **Connect-roundtrip**: renderer's `useClaudeAvailableQuery` (or
  equivalent) calls this on app boot; the result drives the
  TerminalPane "Retry" UI when false. Set A harness case
  `terminal-pane-mounted` indirectly covers the true path.

### Connect-roundtrip harness cases (Set A — three dedicated cases per RPC)

The iron rule "real impl + UT + Connect-roundtrip per RPC in v0.3"
requires a DIRECT harness-tier roundtrip per RPC, not indirect coverage
("`terminal-pane-mounted` indirectly covers" is INSUFFICIENT — a
fixer regressing `checkClaudeAvailable`'s wire shape can leave the
indirect signal green). The "Connect-roundtrip" lines in each RPC
subsection above are superseded by the Set A cases below; chapter 04
§4 lists their budgets.

| Case id                                | Harness            | Set | Asserts                                                                                                              |
|----------------------------------------|--------------------|-----|----------------------------------------------------------------------------------------------------------------------|
| `pty-input-roundtrip`                  | harness-real-cli   | A   | `await window.ccsmPty.input(sid, 'echo hi\r')` resolves `{ ok: true }`; a `pty:data` event fires within 1s with payload containing `"hi"`. |
| `pty-resize-roundtrip`                 | harness-ui         | A   | `await window.ccsmPty.resize(sid, 80, 24)` resolves `{ ok: true }`; daemon-side `resizePtySession` was called with `(sid, 80, 24)` (verify via debug RPC or pty fake hook). |
| `pty-claude-available-roundtrip`       | harness-ui         | A   | `await window.ccsmPty.checkClaudeAvailable({ force: true })` resolves a `{ available: boolean, path?: string, reason?: string }` shape (assert key set, type of `available`); zero indirection. |

**Why dedicated cases**: each is ~15 lines of harness code, runs in
<5s, and pins the RPC contract directly. Indirect coverage was the
exact failure mode chapter 01 §"Symptom catalog" S1 hit during wave-2-A
(`pty:input` regressed; `terminal-pane-mounted` stayed green because
its assertion was upstream of the RPC).

### Anti-stub rule

The fixer MUST NOT ship a placeholder implementation that returns
`{ ok: true }` without doing the underlying work. Reviewers MUST grep
the daemon impl for "TODO" / "stub" / "placeholder" and reject any
match in these three RPCs.

### Error-token enum (closed set, per-RPC subset)

The `error` field of every `{ ok: false, error: <token> }` daemon RPC
response MUST be exactly one of the following CLOSED enum (lowercase,
underscored). Adding a new token is a breaking change requiring a
spec edit:

| token                | meaning                                                                  |
|----------------------|--------------------------------------------------------------------------|
| `no_such_sid`        | sid is unknown to the daemon (never spawned, or already GC'd)            |
| `pty_dead`           | sid was spawned but the underlying pty has exited                        |
| `bad_request`        | request payload failed schema / range validation                         |
| `spawn_failed`       | `pty:spawn` could not start the underlying process                       |
| `daemon_unavailable` | renderer-side bridge surfaced when daemon socket / SSE is unreachable    |
| `internal`           | uncaught exception inside the daemon (stack logged via stderr §6)        |

Per-RPC emit subset (each RPC MUST emit ONLY tokens from its column;
reviewers grep against this table):

| RPC                          | tokens this RPC may return                                           |
|------------------------------|----------------------------------------------------------------------|
| `pty:spawn`                  | `bad_request`, `spawn_failed`, `internal`                            |
| `pty:input`                  | `no_such_sid`, `pty_dead`, `bad_request`, `internal` (silent-drop semantics per R1 baseline-cite above take precedence over `no_such_sid` if v0.2 dropped silently) |
| `pty:resize`                 | `no_such_sid`, `pty_dead`, `bad_request`, `internal`                 |
| `pty:attach`                 | `no_such_sid`, `internal`                                            |
| `pty:checkClaudeAvailable`   | (never `ok:false` — failures encoded as `{ available:false, reason }`) |
| renderer bridge (any RPC)    | `daemon_unavailable` (added by the preload bridge ONLY when the daemon socket / SSE is unreachable; daemon NEVER emits this token) |

## 6. Error surface conventions

All daemon RPCs return one of two shapes:

```ts
type Ok<T>   = { ok: true } & T;
type Fail   = { ok: false, error: string };
```

`error` is a stable lowercase token (`no_such_sid`, `bad_request`,
`spawn_failed`, etc.). The renderer MAY display it raw; it is NOT a
human-readable message — that's the renderer's responsibility.

**Why**: stable tokens let UTs assert exact strings without coupling
to UI copy.

### Daemon stderr structured logs

Daemon process stderr MUST be a stream of newline-delimited records
with a fixed prefix. The format is:

```
[ccsmd] <ISO-8601-timestamp> <level> <category>: <message>
```

- `<ISO-8601-timestamp>` — UTC, millisecond precision (e.g.
  `2026-05-06T12:34:56.789Z`).
- `<level>` — one of `debug` / `info` / `warn` / `error` (lowercase).
- `<category>` — one of `boot` / `pty` / `api` / `lifecycle` /
  `internal` (lowercase, extensible only via spec edit).
- `<message>` — single line; multi-line payloads (stack traces) MUST
  be either truncated to one line OR emitted as multiple consecutive
  records with the same `<category>` and `level=error`.

**Log level**: controlled by env var `CCSMD_LOG_LEVEL`; default
`info`. Valid values: `debug` / `info` / `warn` / `error`. Records
strictly below the configured level MUST NOT be written. The daemon
MUST log its effective level once at boot
(`[ccsmd] <ts> info boot: log level=info`).

**Why**: chapter 04 §2 harness-runner captures daemon stderr to a
per-case log file and tails error-level lines on failure; chapter 05
G11 grep-asserts zero error-level lines on a green Set A run. Both
gates require this stable prefix.

## 7. Out-of-scope (deferred)

- Replacing SSE with WebSocket: not blocking; v0.4+.
- Multiplexing all sids onto a single SSE stream: not blocking; current
  per-sid model is simple and the bug isn't here.
- Daemon process supervision (auto-restart on crash): v0.4 reliability
  workstream.

### sigkill-reattach v0.4 follow-up (defer list)

Per §4 (R1 strict, manager decision round 1), v0.3 only restores the
v0.2 daemon-port attach-replay path. The following sigkill-reattach
items are explicitly **deferred to v0.4**:

| #     | Item                                                                                                  | v0.4 owner / placeholder                |
|-------|-------------------------------------------------------------------------------------------------------|------------------------------------------|
| F-1   | Pin snapshot TTL = 60s MUST (currently relies on v0.2 implicit behaviour)                              | v0.4 reliability spec PR (TBD)           |
| F-2   | Pin per-sid buffer cap (1MB) + ring-buffer truncation + structured eviction log line                   | v0.4 reliability spec PR (TBD)           |
| F-3   | cwd-mismatch on respawn → discard snapshot policy (NEW product rule, not in v0.2)                      | v0.4 reliability spec PR (TBD)           |
| F-4   | NEW `sigkill-reattach` harness case promoted from Set B informational into Set A release-blocker       | v0.4 e2e suite PR (TBD)                  |
| F-5   | 4 boundary UTs in `daemon/ptyHost/__tests__/lifecycle.test.ts` (TTL elapsed → GC; elapsed → new snapshot; reattach pre-TTL → snapshot served; detach + immediate reattach → no race) using `vi.useFakeTimers()` | v0.4 reliability spec PR (TBD)           |
| F-6   | Chapter 05 G10 release gate locking sigkill-reattach NEW case as ship criteria                         | v0.4 release-slicing spec PR (TBD)       |

**Why deferred**: each item introduces a NEW product rule or NEW release
criterion that v0.2 did not ship; v0.3 is a refactor and would inflate
scope by adopting them. R1 strict-preservation派 prevails (round 1
manager decision); the v0.4 reliability spec is the right home for these
items once v0.3 ships.
