# 03 — Bridge swap (`ipcRenderer.invoke` → Connect client)

## Context block

The Electron renderer talks to the main process today via 5 preload bridge files (`electron/preload/bridges/ccsm{Core,Session,Pty,Notify,SessionTitles}.ts`) that expose `window.ccsm*` APIs. Each method is `ipcRenderer.invoke('channel', ...args)` (or `ipcRenderer.send` for fire-and-forget) plus a `contextBridge.exposeInMainWorld` registration. Main-process handlers live in `electron/ipc/*.ts` and dispatch into `electron/sessionTitles/`, `electron/notify/`, `electron/pty/`, etc. — most of which already moved to `daemon/` in v0.3, with Electron main now forwarding to the daemon over the v0.3 envelope.

v0.4 cuts out the middle layer **for everything that crosses the daemon boundary**: the preload bridge calls a Connect client directly; the Connect client speaks to the daemon (local socket in Electron, Cloudflare Tunnel in web). Window-only / clipboard-only IPCs that legitimately belong to Electron main stay on `ipcRenderer`.

## TOC

- 1. Inventory of current bridges (RPCs, fire-and-forget, streams)
- 2. What stays on `ipcRenderer` vs what moves to Connect
- 3. Renderer → daemon transport in Electron (Connect-Node-over-Unix-socket)
  - 3.1 Reconnect choreography
  - 3.2 Preload transport security boundary
  - 3.3 Structured logging on bridge-side failures
  - 3.4 Local-transport-key smoke test
- 4. Bridge surface stability rule
- 5. Per-batch swap plan (PR boundaries)
- 6. Migration semantics (no dual-transport during the swap)
- 7. Test discipline per swap PR
  - 7.1 Parity-test framework
  - 7.2 Bridge adapter contract tests (survives M2)
  - 7.3 Input coalescer unit test
  - 7.4 PTY input size cap

## 1. Inventory of current bridges

**Terms (used throughout chapters 03/04):**
- **Bridge file**: one of the 5 `electron/preload/bridges/*.ts` files (`ccsmCore`, `ccsmSession`, `ccsmPty`, `ccsmNotify`, `ccsmSessionTitles`).
- **Bridge surface**: the public `window.ccsm*` API exposed by all bridge files together. This is what `src/` (the renderer) consumes.
- **Bridge function**: one method on `window.ccsm*` (e.g. `window.ccsmPty.list()`).

**Naming convention (v0.3 IPC → v0.4 Connect):** v0.3 IPC channel `<domain>:<verbCamel>` maps to proto RPC `<Verb><Domain>` (PascalCase service method) which generates TS client method `<verb><Domain>` (camelCase). Examples: `pty:list` → `ListPty` → `listPty`; `app:getVersion` → `GetAppVersion` → `getAppVersion`; `sessionTitles:listForProject` → `ListSessionTitlesForProject` → `listSessionTitlesForProject`. The bridge function's exported name (e.g. `list()`) is unchanged from v0.3 (per §4 stability rule); only the *internal* call swaps from `ipcRenderer.invoke('pty:list')` to `connectClient.listPty({})`.

Counts as of `working` HEAD (2026-04-30):

| Bridge file | Unary RPCs | Fire-and-forget (renderer→main) | Streams (main→renderer) |
|---|---|---|---|
| `ccsmCore.ts` | 17 (`db:load`, `db:save`, `app:getVersion`, `import:scan`, `import:recentCwds`, `app:userHome`, `app:userCwds:get/push`, `cwd:pick`, `settings:defaultModel`, `paths:exist`, `updates:status/check/download/install`, `updates:getAutoCheck/setAutoCheck`, `window:minimize/toggleMaximize/close/isMaximized`, `ccsm:get-system-locale`) | 1 (`ccsm:set-language`) | 4 (`updates:status`, `update:downloaded`, `window:maximizedChanged`, `window:beforeHide`/`window:afterShow`) |
| `ccsmSession.ts` | 0 | 2 (`session:setActive`, `session:setName`) | 4 (`session:state`, `session:title`, `session:cwdRedirected`, `session:activate`) |
| `ccsmPty.ts` | 9 (`pty:list/spawn/attach/detach/input/resize/kill/get/getBufferSnapshot/checkClaudeAvailable`) | 0 | 2 (`pty:data`, `pty:exit`) |
| `ccsmNotify.ts` | 0 | 1 (`notify:userInput`) | 1 (`notify:flash`) |
| `ccsmSessionTitles.ts` | 5 (`sessionTitles:get/rename/listForProject/enqueuePending/flushPending`) | 0 | 0 |

**Totals:** 31 unary, 4 fire-and-forget, 11 streams = **46 cross-boundary calls**. (The "~22 IPC bridges" figure in the predecessor design doc was an undercount; v0.4 inventory is canonical going forward.)

**Stream-count note (per R6):** `window:beforeHide` and `window:afterShow` are counted as **one paired signal stream** (they always fire together — hide-then-show on dock-hide / dock-show). Splitting them would yield 12 streams; the inventory uses the paired-signal convention (11). The pair is delivered over a single `streamWindowVisibility` server-stream when its underlying channels remain on `ipcRenderer` (per §2 they do, so the pairing is documentary only).

## 2. What stays on `ipcRenderer` vs what moves to Connect

**Stays on `ipcRenderer` (Electron-only, not in `proto/`):**

| Channel | Why it stays |
|---|---|
| `window:minimize / toggleMaximize / close / isMaximized` | Electron `BrowserWindow` is renderer-process specific. Web client has no concept of "minimize the OS window". |
| `window:maximizedChanged / window:beforeHide / window:afterShow` | Same — OS window state events. |
| `ccsmPty.clipboard.{readText,writeText}` | Electron `clipboard` module; in web, use `navigator.clipboard` (different API surface). Bridge keeps its `clipboard.readText`/`writeText` methods; the implementation forks at build time (Electron uses `clipboard`, web uses `navigator.clipboard`). |
| `cwd:pick` (folder picker) | Electron `dialog.showOpenDialog`. Web uses `<input type="file" webkitdirectory>` or just disables the picker. Bridge method present in both clients but the Electron impl is `ipcRenderer.invoke`, the web impl is a synthetic File-API wrapper. |

**Moves to Connect (every other entry in §1's table).** The list above is exhaustive: `window:*`, the clipboard surface, and the cwd folder-picker are the only Electron-OS-bound items. Everything else is daemon-domain (sessions, PTY, settings, notify, updater, importable-session scan) and goes through the proto schema.

**Why this split:** the rule is "if the data lives in the daemon, the call goes through Connect". Window chrome and OS dialogs live in Electron main and have no daemon counterpart. The web client can implement its own equivalents (or no-op them) using browser APIs. This keeps the proto schema focused on the actual product surface.

**Updater special case:** the auto-updater (`updates:status/check/download/install`) **belongs to Electron** (it updates the Electron+daemon bundle). However, the **daemon also self-updates** (per v0.3 §3.1) via a separate `daemon-v*` poll-and-replace path. v0.4 keeps both:
- The renderer's `updates:*` IPCs continue to talk to **Electron** main's `electron-updater` (via `ipcRenderer`) for the desktop app.
- The web client cannot trigger an Electron-app update (it's running in a browser), so the entire `updates:*` surface in the bridge is **no-op'd** in the web build (returns `{ kind: 'idle' }` from `updatesStatus()`, etc.). Updater Settings rows render in **disabled state** (greyed control + tooltip "auto-update is only available in the desktop client") when `import.meta.env.VITE_TARGET === 'web'`. The DOM structure is preserved (rows still mount), so this is a per-row enabled-state fork, not a structural redesign of the Settings page. This conditional is one of the explicitly-permitted §4 `VITE_TARGET` exceptions (see §4 enumerated list).

**Why no-op rather than remove:** the bridge surface stays identical (rule §4); only the implementation forks. Renderer code calling `window.ccsm.updatesStatus()` works in both clients without conditional code. Why disabled-state rather than hidden: preserves Settings page structure across targets so screenshots/walkthroughs/test selectors don't fork; the only target-specific behavior is the row's `disabled` attribute.

## 3. Renderer → daemon transport in Electron (Connect-Node-over-Unix-socket)

Connect's standard `createConnectTransport` speaks HTTP/2 to a hostname:port. Electron renderer → local daemon needs HTTP/2 over a **Unix domain socket** (Mac/Linux) or **named pipe** (Win). Node's `http2` supports both via `Http2Session` over an existing duplex stream.

**Decision (lock):** custom Connect transport in `electron/connect/ipc-transport.ts` that:
1. Opens a `net.Socket` to `~/.ccsm/daemon.sock` (Unix) or `\\.\pipe\ccsm-daemon` (Win).
2. Wraps it in `http2.connect(url, { createConnection: () => socket })`.
3. Hands the resulting `ClientHttp2Session` to Connect's transport adapter.
4. Reuses one session across all RPCs (HTTP/2 multiplexing).

**Why a custom transport:** Connect's stock browser/Node transports assume `http://host:port`. Local-IPC is its own beast. The custom transport is ~150 LOC and isolates the IPC concerns; the rest of the renderer code is unaware whether it's talking over a socket or over Cloudflare Tunnel.

**Where it lives:** `electron/connect/ipc-transport.ts` (new). Imported by the **preload** script (which has Node access via `contextBridge`) and exposed through `window.ccsmTransport.create()` consumed by the bridges. The renderer-process bridges hold the Connect client; transport lives in preload to keep `net.Socket` access out of renderer code (CSP-friendly).

**Connection lifecycle:**
- On bridge install (`installCcsmCoreBridge`, etc.), the preload creates one Connect transport instance and passes it to all bridges. Single shared HTTP/2 session for all calls.
- Reconnect: if the underlying socket errors (`ECONNRESET`, `EPIPE`), the transport tears down the HTTP/2 session and lazily re-establishes on next call. In-flight RPCs reject with a `unavailable` Connect error; bridges surface this as `BridgeTimeoutError` (existing v0.3 §3.7.5 surface) and the renderer's `useDaemonHealthBridge` shows the `daemon.unreachable` banner.
- **Reconnect retry (burst phase):** exponential backoff capped at 5s, max 6 attempts in 30s, then surface `daemon.unreachable` per v0.3 §6.8.
- **Reconnect retry (steady-state phase, per R3 P1-1):** after burst exhaustion, fall back to a 30s steady-state retry that continues indefinitely, matching the web client cadence (chapter 04 §6). The transport tracks a `phase: 'burst' | 'steady'` field; on first success the phase resets to `burst`. The renderer's `daemon.unreachable` banner MUST include a manual "Retry now" button that triggers an out-of-cycle reconnect attempt (cross-ref chapter 04 §6 surface — same UX in both clients).
- **Injectable backoff clock (per R5 P1-3):** the transport accepts a `Clock` interface (`now()`, `setTimeout()`) at construction time. Production passes the real clock; tests pass a controllable fake clock so reconnect/backoff timing is deterministic. This makes the four boundary cases hermetically testable: (a) success on attempt N where N<6, (b) abandon to steady-state on N=6, (c) `ECONNRESET` triggers reconnect, (d) `EPIPE` triggers reconnect; plus (e) in-flight RPCs reject with `BridgeTimeoutError` not generic `unavailable`.

### 3.1 Reconnect choreography (per R3 P1-2)

The single shared HTTP/2 session multiplexes all 31 unary RPCs and all 11 streams. When the session re-establishes after a reset, every active server-stream MUST re-subscribe and may demand a fresh snapshot (per chapter 06 §6 if the renderer's last-seen seq fell outside the daemon's ring buffer). Naively re-subscribing all streams in the same tick produces a snapshot storm: at N=20 sessions × ~3 streams/session = 60 snapshot RPCs hit the daemon's snapshot semaphore (v0.3 frag-3.5.1) simultaneously and serialize, freezing the UI for seconds.

**Stagger rule:** stream re-subscribe is delayed by `jitter(50ms, 500ms)` keyed off `hash(sessionId) % 450 + 50`. Hash-keyed (not random) so re-subscribe ordering is deterministic across reconnects for the same session set — easier to reproduce bugs. Unary RPCs queued during reconnect are not staggered (they were already serialized on the renderer side).

**Wall-clock budget:** at N=20 sessions the worst-case re-subscribe completes within 500ms + (snapshot semaphore queue × per-snapshot-cost). Cross-ref chapter 06 §6 fanout buffer sizing for the per-snapshot cost.

**Idempotency precondition:** queued retries during the burst phase MUST be idempotent (chapter 02 §9 idempotency keys). Without this, a unary RPC that succeeded on the daemon but had its response dropped by the socket reset would be re-applied on retry.

### 3.2 Preload transport security boundary (per R2 P1-1)

Connect-Node-in-preload runs with full Node privileges (HTTP/2 frame parser, Connect interceptors, optional `jose` for JWT verification on web — not Electron). A parser exploit in any of these → preload code-exec → bypass of `contextIsolation`. The transport MUST be hardened as follows:

1. **Proxy-only contextBridge surface.** `window.ccsmTransport.create()` returns ONLY a thin proxy with primitive method signatures: `unary(serviceName: string, methodName: string, requestBytes: Uint8Array): Promise<Uint8Array>` and `stream(serviceName: string, methodName: string, requestBytes: Uint8Array): AsyncIterable<Uint8Array>`. No exposed properties referencing `net.Socket`, `Http2Session`, or any Node primitive.
2. **All Connect machinery stays in preload.** Transport setup, HTTP/2 session management, interceptors, retry/reconnect logic — entirely in preload code. The renderer-side bridge files import generated Connect clients but bind them to the proxy from §3.2.1, never to a real Connect transport object.
3. **Structured-clone-only payloads across the bridge.** All values crossing `contextBridge.exposeInMainWorld` are `Uint8Array` (proto-encoded request/response bytes) or plain JS objects. No closures, no class instances, no `Promise` chains that close over Node refs.
4. **Audit checkpoint at M1.** M1 deliverable includes a security review of `electron/connect/ipc-transport.ts` confirming: no Node prototype/handle leaks via `contextBridge`, the proxy surface is exhaustively enumerated, and the renderer cannot reach any `net.Socket` / `Http2Session` instance through traversal of the proxy. Reviewer: security-auditor agent. Reference: Electron's "exposeInMainWorld safe patterns" doc.

**Why this matters:** Electron's security model assumes minimal preload surface. Connect-in-preload is a substantial new attack surface; the proxy boundary is what keeps a hypothetical HTTP/2-frame-parser CVE contained to preload's sandbox rather than escalating to renderer RCE.

### 3.3 Structured logging on bridge-side failures (per R3 P2-1)

When the bridge surfaces `BridgeTimeoutError` (or any Connect error code), it MUST emit a structured `console.warn` from preload context with shape `{ bridge: string, method: string, code: ConnectErrorCode, traceId?: string, retryAttempt?: number }`. The `traceId` is read from the Connect response's `x-ccsm-trace-id` header (chapter 02 §6 trace propagation) when present. This is the minimum diagnostic data needed to correlate "user reports random freeze" with daemon-side trace logs, and is a precondition for any future remote-error-capture integration.

### 3.4 Local-transport-key smoke test (per R3 P2-2)

The `localTransportKey` request tag is what gates JWT bypass on the local-socket transport (chapter 05 §4). If a future refactor accidentally drops the tag, every Electron RPC fails `unauthenticated` and the desktop app is dead-on-arrival. The test plan (chapter 08 §3) MUST include two contract tests: (a) "local-socket request reaches handler with `localTransportKey=true`, JWT not required, succeeds" and (b) "remote-tagged request without JWT rejects with `unauthenticated`". These run on every CI build, not just M1.

## 4. Bridge surface stability rule

**Hard rule:** the public shape of `window.ccsm*` (every method name, parameter list, return type, and event subscription) **MUST NOT change** in v0.4. Renderer code (`src/`) is unmodified except for:
- Build-time conditionals on `import.meta.env.VITE_TARGET` for the explicitly-enumerated Electron-only surfaces below.
- TypeScript widening if the new return types (from generated proto) are structurally compatible but not literally `===` to the v0.3 hand-typed shapes.

**Permitted `VITE_TARGET` conditionals (exhaustive enumeration — adding to this list requires a spec amendment):**
1. **Window chrome controls** (`window:minimize/toggleMaximize/close/isMaximized` + `maximizedChanged/beforeHide/afterShow`) — the title-bar UI hides minimize/maximize/close buttons in `web` (browser provides them).
2. **Folder picker** (`cwd:pick`) — the picker button in cwd-input renders `<input type="file" webkitdirectory>` in `web`, native dialog button in `electron`. Bridge function shape is unchanged.
3. **Clipboard surface** (`ccsmPty.clipboard.{readText,writeText}`) — implementation forks at build time (Electron `clipboard` module vs `navigator.clipboard`). No renderer-visible difference.
4. **Updater Settings rows** (per §2 "Updater special case") — render in disabled state with tooltip when `VITE_TARGET === 'web'`. DOM structure preserved; only the `disabled` attribute and tooltip text fork.

Any other `import.meta.env.VITE_TARGET` reference in `src/` is a spec violation and MUST be flagged in PR review.

**Why:** the renderer is shared between Electron and web. Diverging the bridge surface forces double-maintenance. v0.4 ships +frontend, not +features (chapter 01 G/A discipline).

**Bridge-internal forks ARE allowed.** Inside `electron/preload/bridges/ccsmPty.ts`, the implementation of `list()` changes from `ipcRenderer.invoke('pty:list')` to `connectClient.listPty({}).then(r => r.sessions)`. The exported function signature is identical.

**TypeScript codegen mismatch:** if the proto-generated request/response shapes aren't literally identical to the v0.3 types, the bridge file **adapts** at the boundary (e.g. v0.3 `pty:list` returns `unknown`; v0.4 returns `ListPtyResponse` whose `.sessions` is the same array). Adaptation lives in the bridge file; renderer unaffected.

## 5. Per-batch swap plan (PR boundaries)

Order: **read-only first, then write, then streams.** Within each tier, group by domain to keep diffs in one bridge file per PR.

### Batch A — read-only RPCs (lowest risk)

| Bridge | RPCs | Proto file |
|---|---|---|
| ccsmCore | `app:getVersion`, `app:userHome`, `app:userCwds:get`, `settings:defaultModel`, `paths:exist`, `import:scan`, `import:recentCwds`, `ccsm:get-system-locale` | core.proto, settings.proto, import.proto |
| ccsmSessionTitles | `sessionTitles:get`, `sessionTitles:listForProject` | session_titles.proto |
| ccsmPty | `pty:list`, `pty:get`, `pty:checkClaudeAvailable`, `pty:getBufferSnapshot` | pty.proto |
| ccsmCore (db) | `db:load` | core.proto |

Why first: idempotent reads, no state mutation. Easy to compare v0.3 vs v0.4 outputs side-by-side in tests.

### Batch B — write RPCs (more risk)

| Bridge | RPCs | Proto file |
|---|---|---|
| ccsmCore | `db:save`, `app:userCwds:push`, `cwd:pick` (Electron-side only — see §2), `updates:check/download/install/setAutoCheck`, `ccsm:set-language` | core.proto, settings.proto, updater.proto |
| ccsmSession (signals) | `session:setActive`, `session:setName` | session.proto |
| ccsmPty | `pty:spawn`, `pty:attach`, `pty:detach`, `pty:input`, `pty:resize`, `pty:kill` | pty.proto |
| ccsmNotify | `notify:userInput` | notify.proto |
| ccsmSessionTitles | `sessionTitles:rename`, `sessionTitles:enqueuePending`, `sessionTitles:flushPending` | session_titles.proto |

Why second: state-mutating, narrower error model. v0.4 moves these one bridge-file at a time.

### Batch C — streams (highest risk)

| Bridge | Streams | Proto file |
|---|---|---|
| ccsmPty | `pty:data`, `pty:exit` | pty.proto |
| ccsmSession | `session:state`, `session:title`, `session:cwdRedirected`, `session:activate` | session.proto |
| ccsmNotify | `notify:flash` | notify.proto |
| ccsmCore | `updates:status`, `update:downloaded`, `window:maximizedChanged`, `window:beforeHide`, `window:afterShow` | (window:* stays on `ipcRenderer`); `updates:status` and `update:downloaded` move to updater.proto |

Why last: server-streaming over HTTP/2 has the most novel failure modes (heartbeat, reconnect, seq replay). Tackled after the unary surface is proven stable.

### PR sizing

- One PR per batch sub-row above (so ~4 PRs for Batch A, ~5 for Batch B, ~3 for Batch C). Total ~12 PRs across the swap.
- Each PR includes: `proto/` definitions for its RPCs, `gen/ts/` regeneration, daemon-side handler bindings, bridge file changes, e2e probe.
- PR is mergeable independently: bridge file commits both the new Connect impl and the Electron forwarding code (until M2 cuts the envelope). See §6.

## 6. Migration semantics: NO dual-transport during the swap

**Decision (lock):** during M1 (the bridge-swap milestone, chapter 09), each bridge file has **one** active transport per build. The bridge swap PR replaces the `ipcRenderer.invoke` line with the Connect call **and the corresponding daemon-side handler is wired to Connect at the same time**. There is no period where the same bridge function might invoke either transport at runtime.

**Why:** dual-transport-with-feature-flag is the trap from v0.3 (frag-3.4.1.h discipline). Selecting transport at runtime doubles the test surface and creates ghost paths that survive past their useful life.

**Per-PR mechanism:**
1. PR adds proto definitions + regenerates `gen/ts/`.
2. PR adds daemon-side Connect handler that delegates to the existing daemon module (no logic change in the module, just a new entry point).
3. PR removes the v0.3 envelope handler for those RPCs from the daemon's data-socket dispatcher allowlist.
4. PR rewrites the bridge file's `ipcRenderer.invoke` calls to Connect client calls.
5. PR removes the corresponding Electron main-process `ipcMain.handle` registrations.
6. PR updates / adds e2e probe.

After all batch PRs land, the daemon's data-socket envelope handler has zero registered methods → the entire envelope path on the data socket is deleted in M2 (housekeeping). At that point: control socket = envelope, data socket = Connect, no overlap.

**Why not all-at-once big-bang PR:** ~46 RPCs in one PR is unreviewable and a single bug grounds the whole release. Per-batch PRs keep blast radius bounded.

## 7. Test discipline per swap PR

Every bridge-swap PR MUST include:

1. **Unit test on the daemon Connect handler:** call the handler in-process with a mock context, assert response shape matches proto.
2. **Adapter parity test (deleted after M2 — but see §7.2 below):** for each swapped RPC, a temporary test asserts that Connect response and the corresponding v0.3 envelope response on the same input produce equivalent JS values. Test is gated by an env flag and removed when M2 deletes the envelope path.
3. **E2E probe on the bridge function:** in the harness-agent / harness-perm e2e suite, exercise the bridge from a real renderer (Electron) AND from the web client harness. **Naming convention (per R5 P1-2):** every bridge-swap e2e case is named `bridge-swap-<bridge>-<rpc>` (e.g. `bridge-swap-ccsmPty-list`, `bridge-swap-ccsmCore-getVersion`). The PR worker invokes `npm run e2e:bridge -- --only=bridge-swap-<bridge>-<rpc>` and pastes output in PR body. Trust-CI-mode reviewer (per `feedback_trust_ci_mode`) verifies the case ID matches the swapped RPC. See chapter 08 §9 for the full naming registry.
4. **Reverse-verify entry in PR body:** PR-body screenshot or output showing "before bridge swap, this RPC works; after, this RPC works; behavior identical".

### 7.1 Parity-test framework (per R5 P0-1)

The parity tests are the load-bearing safety net during M1's 12 PRs. To prevent each PR from inventing its own definition of "equivalent" and producing a non-uniform safety net, M1's first PR MUST land a shared parity-test framework at `daemon/__tests__/parity/`:

**Framework shape:**
- `assertParity(envelopeResp, connectResp, opts: { ignoreFields?: string[]; coerce?: Record<string, (v: any) => any> }): void` — deep-equal with field-level ignore-list and per-field coercion (e.g. coerce v0.3 `unknown`-typed `pid: number | string` to `Number(v)` before compare).
- **Input corpus:** golden fixtures at `daemon/__tests__/parity-corpus/<rpc>.json`. Each fixture file is a JSON array of `{ name, request, expectedV03Response, expectedV04Response, parityOpts }` cases. Fixtures are **recorded** (not hand-written) by running the v0.3 envelope path against a fresh seeded daemon under a `RECORD_PARITY=1` env flag — keeps fixtures honest and re-recordable when daemon-side data shapes shift.
- **Non-determinism handling:** the `coerce` map MUST handle: timestamps (zero them out), ULIDs (regex-match `[0-9A-HJKMNP-TV-Z]{26}` not literal-equal), PIDs (zero them out), free-form ports (`>1024 && <65536` predicate not literal-equal). Per-RPC `parityOpts` declares which of these apply.
- **Codegen-driven scaffold:** a generator at `scripts/gen-parity-scaffold.ts` reads the swap PR's modified proto file, enumerates RPCs, and asserts each has a parity-corpus entry — fails the PR if missing. This makes "every swapped RPC has parity coverage" mechanically enforceable.
- **Equivalence semantics for type-widening cases:** when v0.3 returns `unknown` and v0.4 returns a typed shape (per §4 adaptation), parity is asserted on the structural projection: the framework normalizes both sides through the v0.4 type's parser, then compares. Documented per-RPC in the corpus file's `parityOpts.normalizationStrategy` field.

### 7.2 Bridge adapter contract tests (survives M2 — per R3 P1-3)

Parity tests are deleted at M2 (envelope removed → nothing to compare against). To prevent the post-M2 "silent adapter regression" risk (proto field renamed → bridge maps to wrong renderer key → no test catches it), promote a subset of parity assertions to **enduring bridge adapter contract tests** at `electron/preload/bridges/__tests__/<bridge>.contract.test.ts`:

- One assertion per bridge function: feed a known proto-typed response into the bridge's adapter logic, assert the resulting `window.ccsm*`-shaped value matches the v0.3-documented type.
- These are NOT parity tests (no v0.3 envelope path involved post-M2). They are pure adapter unit tests against the v0.3 type contract.
- `buf breaking` catches wire-level incompat; these contract tests catch post-wire adapter drift. Both layers required.
- Cross-ref chapter 08 §3 for the test runner integration.

### 7.3 Input coalescer unit test (per R5 P1-1)

The `pty:input` bridge wraps individual keystrokes in a 5ms coalescing window (per chapter 06 §3). Coalescer bugs are invisible until a user pastes 50 KB and gets character-by-character delivery. M1 first PR that touches `pty:input` MUST land a coalescer unit test at `electron/preload/bridges/__tests__/ccsmPty.coalescer.test.ts`:

- Inject a fake RAF/timer clock.
- Simulate N keystrokes within window W; assert ≤K RPCs emitted (where K = ceil(N × byteSize / 64KiB) — the per-RPC cap; see §7.4).
- Simulate N keystrokes spanning multiple windows; assert each window flushes exactly once.
- Assert no keystroke is lost across the boundary.
- Assert the 256 KiB renderer-side buffer cap (chapter 06 §3) drops oldest keystrokes with a structured warn log when exceeded.

### 7.4 PTY input size cap (per R2 P2-1)

`SendPtyInputRequest.data` MUST be capped at **64 KiB** server-side (daemon rejects with `invalid_argument` Connect error code if exceeded). Renderer-side coalescer (§7.3) chunks larger pastes into ≤64 KiB RPCs. The 16 MiB HTTP/2 frame cap (chapter 02 §8) is the absolute ceiling but 64 KiB is the per-RPC product cap. Why 64 KiB: matches typical OS pipe buffer (PIPE_BUF on Linux is 64 KiB, Win named pipe default is 64 KiB), so a single RPC fits one OS write — no partial-write semantics to model. Documented in `pty.proto` validation comment + chapter 07 §1 daemon-side validation.

**Why parity tests are temporary:** they're a migration safety net, not a permanent invariant. Once the envelope handler is deleted, the enduring adapter contract tests (§7.2) take over.

**Why an e2e on web during the swap (M1) before the web build is wired up:** the web client is `vite dev` against the local daemon from M1 onwards. Hitting the Connect surface from a real browser DOM during the swap catches CORS, content-type, and HTTP/2 negotiation issues early — those bite the web build (M3) hardest.
