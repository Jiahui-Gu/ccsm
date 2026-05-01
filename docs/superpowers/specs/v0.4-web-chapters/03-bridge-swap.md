# 03 — Bridge swap (`ipcRenderer.invoke` → Connect client)

## Context block

The Electron renderer talks to the main process today via 5 preload bridge files (`electron/preload/bridges/ccsm{Core,Session,Pty,Notify,SessionTitles}.ts`) that expose `window.ccsm*` APIs. Each method is `ipcRenderer.invoke('channel', ...args)` (or `ipcRenderer.send` for fire-and-forget) plus a `contextBridge.exposeInMainWorld` registration. Main-process handlers live in `electron/ipc/*.ts` and dispatch into `electron/sessionTitles/`, `electron/notify/`, `electron/pty/`, etc. — most of which already moved to `daemon/` in v0.3, with Electron main now forwarding to the daemon over the v0.3 envelope.

v0.4 cuts out the middle layer **for everything that crosses the daemon boundary**: the preload bridge calls a Connect client directly; the Connect client speaks to the daemon (local socket in Electron, Cloudflare Tunnel in web). Window-only / clipboard-only IPCs that legitimately belong to Electron main stay on `ipcRenderer`.

## TOC

- 1. Inventory of current bridges (RPCs, fire-and-forget, streams)
- 2. What stays on `ipcRenderer` vs what moves to Connect
- 3. Renderer → daemon transport in Electron (Connect-Node-over-Unix-socket)
- 4. Bridge surface stability rule
- 5. Per-batch swap plan (PR boundaries)
- 6. Migration semantics (no dual-transport during the swap)
- 7. Test discipline per swap PR

## 1. Inventory of current bridges

Counts as of `working` HEAD (2026-04-30):

| Bridge file | Unary RPCs | Fire-and-forget (renderer→main) | Streams (main→renderer) |
|---|---|---|---|
| `ccsmCore.ts` | 17 (`db:load`, `db:save`, `app:getVersion`, `import:scan`, `import:recentCwds`, `app:userHome`, `app:userCwds:get/push`, `cwd:pick`, `settings:defaultModel`, `paths:exist`, `updates:status/check/download/install`, `updates:getAutoCheck/setAutoCheck`, `window:minimize/toggleMaximize/close/isMaximized`, `ccsm:get-system-locale`) | 1 (`ccsm:set-language`) | 4 (`updates:status`, `update:downloaded`, `window:maximizedChanged`, `window:beforeHide`/`window:afterShow`) |
| `ccsmSession.ts` | 0 | 2 (`session:setActive`, `session:setName`) | 4 (`session:state`, `session:title`, `session:cwdRedirected`, `session:activate`) |
| `ccsmPty.ts` | 9 (`pty:list/spawn/attach/detach/input/resize/kill/get/getBufferSnapshot/checkClaudeAvailable`) | 0 | 2 (`pty:data`, `pty:exit`) |
| `ccsmNotify.ts` | 0 | 1 (`notify:userInput`) | 1 (`notify:flash`) |
| `ccsmSessionTitles.ts` | 5 (`sessionTitles:get/rename/listForProject/enqueuePending/flushPending`) | 0 | 0 |

**Totals:** 31 unary, 4 fire-and-forget, 11 streams = **46 cross-boundary calls**. (The "~22 IPC bridges" figure in the predecessor design doc was an undercount; v0.4 inventory is canonical going forward.)

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
- The web client cannot trigger an Electron-app update (it's running in a browser), so the entire `updates:*` surface in the bridge is **no-op'd** in the web build (returns `{ kind: 'idle' }` from `updatesStatus()`, etc.). UI hides updater Settings rows when `import.meta.env.VITE_TARGET === 'web'`.

**Why no-op rather than remove:** the bridge surface stays identical (rule §4); only the implementation forks. Renderer code calling `window.ccsm.updatesStatus()` works in both clients without conditional code.

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
- Reconnect retry: exponential backoff capped at 5s, max 6 attempts in 30s, then surface `daemon.unreachable` per v0.3 §6.8.

## 4. Bridge surface stability rule

**Hard rule:** the public shape of `window.ccsm*` (every method name, parameter list, return type, and event subscription) **MUST NOT change** in v0.4. Renderer code (`src/`) is unmodified except for:
- Build-time conditionals on `import.meta.env.VITE_TARGET` for the 3 Electron-only surfaces in §2.
- TypeScript widening if the new return types (from generated proto) are structurally compatible but not literally `===` to the v0.3 hand-typed shapes.

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
2. **Adapter parity test (deleted after M2):** for each swapped RPC, a temporary test asserts that Connect response and the corresponding v0.3 envelope response on the same input produce equivalent JS values. Test is gated by an env flag and removed when M2 deletes the envelope path.
3. **E2E probe on the bridge function:** in the harness-agent / harness-perm e2e suite, exercise the bridge from a real renderer (Electron) AND from the web client harness.
4. **Reverse-verify entry in PR body:** PR-body screenshot or output showing "before bridge swap, this RPC works; after, this RPC works; behavior identical".

**Why parity tests are temporary:** they're a migration safety net, not a permanent invariant. Once the envelope handler is deleted, there's nothing to compare against.

**Why an e2e on web during the swap (M1) before the web build is wired up:** the web client is `vite dev` against the local daemon from M1 onwards. Hitting the Connect surface from a real browser DOM during the swap catches CORS, content-type, and HTTP/2 negotiation issues early — those bite the web build (M3) hardest.
