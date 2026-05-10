# ccsm — Design

ccsm is a web-based session manager for Claude Code. A local daemon
process hosts multiple `claude` PTY sessions; browser tabs attach over
WebSocket with 1:N fanout, and reconnection does not lose output.

> Architecture inspirations: Wave Terminal (sidecar + localhost ws + AuthKey),
> JupyterLab Desktop (URL+token bootstrap), ttyd (binary frame +
> PAUSE/RESUME backpressure).

---

## §1 Goals & Non-Goals

### Goals

- G1. A single local command `npx ccsm` starts the daemon, the terminal
  prints `http://127.0.0.1:<port>/?token=<t>`, and opening it in a browser
  just works.
- G2. Multiple `claude` sessions run concurrently; each session has its
  own PTY and its own ring buffer.
- G3. The same session can be watched by multiple browser tabs at once
  (1:N fanout); input is routed to the single underlying PTY. A single
  tab only renders one session at a time, switching sessions via the
  sidebar.
- G4. Reconnection: the client reconnects with `lastSeq`; the daemon
  back-fills missing bytes from the ring buffer so output is never lost.
- G5. The backend trusts nothing from the frontend: every ws/http request
  is verified by token + origin (only `127.0.0.1` / `localhost`).

### Non-Goals

- No desktop shell (Electron/Tauri/PWA). The frontend code is constrained
  to **not call any desktop API**, so a future shell is cheap to add.
- No remote access (cross-machine access, public exposure, user system,
  multi-tenancy). The daemon listens only on 127.0.0.1.
- No plugin system, no theme marketplace, no AI agent orchestration.
- No on-disk session persistence (daemon exit = sessions lost; acceptable
  for the MVP).

---

## §2 Critical Flows

### F1. Cold start

1. The user runs `npx ccsm`.
2. The daemon process starts, picks a free port (try 17832 first, +1 on
   conflict until success), and generates a 32-byte random token.
3. stdout prints one line: `ccsm ready: http://127.0.0.1:<port>/?token=<token>`.
4. The process runs in the foreground; Ctrl-C exits.

### F2. Browser attach

1. The user clicks the URL in the terminal; a browser opens.
2. The frontend SPA loads, reads the token from `window.location.search`,
   and stores it in `sessionStorage` (not localStorage; closing the tab
   clears it).
3. All subsequent http/ws requests carry `Authorization: Bearer <token>`
   (http) or `?token=<token>` (ws handshake parameter).

### F3. Create a new session

1. Frontend `POST /api/sessions { cwd?: string }` -> daemon returns
   `{ sid, channelId }`.
2. The daemon spawns `node-pty` running `claude` (via
   `@anthropic-ai/claude-agent-sdk` or by spawning the CLI directly,
   detailed in §6); cwd is taken from the request, falling back to the
   daemon's startup cwd.
3. PTY output is written to that session's ring buffer and pushed to all
   subscribers via wps-style pubsub.

### F4. Tab attaches to a session

1. Frontend `WebSocket('ws://127.0.0.1:<port>/ws?token=<t>&sid=<sid>&lastSeq=<n>')`.
2. Daemon validates token + origin + that sid exists, then adds the ws to
   that session's subscriber set.
3. If `lastSeq < currentSeq`, the daemon reads
   `[lastSeq+1, currentSeq]` from the ring buffer and sends those bytes
   first, then fans out in real time.
4. If `lastSeq` has already been overwritten (too old), the daemon sends
   a `{type: "reset"}` control frame; the client clears the screen and
   re-subscribes.

### F5. Multi-tab sync (across browser tabs)

1. The user copies the current URL to a second tab; the same sid is
   subscribed by both tabs and both receive the same output stream.
2. Either tab can send an INPUT frame -> the daemon routes it to that
   sid's PTY (there is only one PTY).
3. PTY echo flows back through the normal output stream, so both tabs
   see it.

Note: a single tab only renders one session's terminal (the active sid).
Switching sessions detaches the old ws + attaches the new one (or keeps
the old ws alive in the background to write into the ring; see §7 for
details).

### F6. Reconnection

1. Network jitter / laptop sleep -> ws closes.
2. The client remembers the last seq it received and re-dials the ws
   with `lastSeq=<n>`.
3. Replay logic from F4 step 3 kicks in.

---

## §3 Architecture

### Process model

- Single daemon process (Node.js).
- Three components inside the daemon:
  - **HTTP server** (`fastify` or `node:http`): static assets + REST API
    (`/api/sessions`, `DELETE /api/sessions/:sid`).
  - **WebSocket server** (`ws` library, mounted on the same http server,
    path `/ws`): binary-frame PTY stream.
  - **Session manager**: `Map<sid, Session>`, each Session holding a
    `node-pty.IPty` + ring buffer + subscribers set.

### Whether the sidecar is a separate process

No. In the MVP all logic lives in a single Node process. Wave splits its
Go sidecar out because the Electron main-process Node is unsuitable for
business logic; we have no Electron, and the daemon itself is the
business process.

### 1:N fanout

- Each Session has `subscribers: Set<WebSocket>`.
- PTY data event -> write to ring buffer -> for-each subscribers send
  OUTPUT frame.
- subscriber close -> removed from the Set; an empty Set does not kill
  the PTY (the user may have just closed a tab; the session stays).

### Ring buffer

- Each Session has a fixed-size (default 4MB) ring byte buffer.
- It tracks `(seq, byteOffset)` indices and supports range lookup by seq.
- Old data beyond the buffer size is overwritten; in that case a
  reconnecting client gets `reset`.

---

## §4 RPC Contracts

REST (JSON over HTTP):

```
POST   /api/sessions
       body: { cwd?: string }
       resp: { sid: string, createdAt: number }

GET    /api/sessions
       resp: { sessions: [{ sid, createdAt, alive: boolean }] }

DELETE /api/sessions/:sid
       resp: { ok: true }
```

All requests require `Authorization: Bearer <token>`, otherwise 401.

WebSocket:

```
GET /ws?token=<t>&sid=<sid>&lastSeq=<n>
```

Handshake validates token + origin + sid. After a successful handshake
only binary frames are used (§5).

---

## §5 WebSocket Protocol

Binary frames; one ws message = one frame:

```
+--------+--------+--------+--------+
| type   |     seq (u32 BE)         |  + payload (bytes)
| 1B     |     4B                   |
+--------+--------+--------+--------+
```

Frame types:

| type (hex) | direction | meaning | payload |
|-----------|-----------|---------|---------|
| 0x01 OUTPUT | s->c | PTY stdout/stderr | raw bytes |
| 0x02 INPUT  | c->s | user input | raw bytes |
| 0x03 RESIZE | c->s | terminal resize | `cols (u16 BE), rows (u16 BE)` |
| 0x04 PAUSE  | c->s | client congested, please pause sending OUTPUT | empty |
| 0x05 RESUME | c->s | resume sending | empty |
| 0x06 RESET  | s->c | ring buffer overwritten, client should clear the screen | empty |
| 0x07 EXIT   | s->c | PTY exited | `code (u32 BE)` |

The `seq` field:

- OUTPUT frames: incremented by the daemon, +1 per frame. The client
  records `lastSeq` for reconnection.
- INPUT/RESIZE/PAUSE/RESUME: written by the client; the daemon does not
  validate them and they are only used by the client itself for ordering
  (usually ignored).

PAUSE/RESUME is explicit backpressure; it does not rely on internal ws
buffer water marks (those are unreliable).

---

## §6 SDK Integration

`@anthropic-ai/claude-agent-sdk` is ESM-only. Daemon usage:

- The daemon entry point `index.mjs` (ESM) does
  `import { ... } from '@anthropic-ai/claude-agent-sdk'` directly.
- The actual `claude` CLI is still spawned via `node-pty`, because we
  need PTY semantics (full-screen TUI, color, resize). The SDK is more
  appropriate for non-TUI scenarios and is not used in the MVP.
- If we later want inline tool-call parsing, we can pull in the SDK to
  process structured output (out of MVP scope).

`node-pty` invocation:

```js
import { spawn } from 'node-pty';
const pty = spawn('claude', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: opts.cwd,
  env: process.env,
});
pty.onData(data => session.broadcast(data));
pty.onExit(({ exitCode }) => session.notifyExit(exitCode));
```

On Windows `node-pty` uses ConPTY; the prebuilt binary ships via
`npm install` so users do not need a build toolchain (verified: at least
node-pty 1.0+ ships prebuilds for Node 20).

---

## §7 Frontend State

Stack: React + TypeScript + xterm.js + zustand.

### Layout

Single page, single browser tab. Reuses the v0.2 desktop sidebar + main
two-column structure (with a draggable splitter):

```
+-------------------------+------------------------------------+
| [+ New Session v] [ . ] |                                    |
| ----------------------- |                                    |
| GROUPS              [+] |                                    |
|   v default             |                                    |
|       * a1b2  10:31     |   xterm.js (active session)        |
|         c3d4  10:42     |                                    |
|   > scratch             |                                    |
|                         |                                    |
| ----------------------- |                                    |
| > Archived              |                                    |
| ----------------------- |                                    |
| [ Settings    ] [ v ]   |                                    |
+-------------------------+------------------------------------+
```

Four regions:

- **Top**: `+ New Session` primary button **(MVP, real, click creates a
  session immediately)** + search icon **(placeholder, onClick is empty)**.
  The cwd dropdown (`v`) is not built in MVP; new sessions use the cwd
  the daemon was started with (a cwd picker can come later).
- **Middle**: GROUPS region. The user can create multiple groups, each
  containing multiple sessions; session rows support drag-to-reorder
  across groups, with a hover action menu on the right (rename / move /
  close). The active session is highlighted.
- **Lower middle**: collapsed Archived region, used to hold groups the
  user has archived. Collapsed by default.
- **Bottom**: Settings button + Import button **(both placeholders;
  rendered but onClick is empty / shows a "not implemented" toast)**.

The right main pane in MVP only hosts xterm.js; the v0.2 attached panes
(StatusBar / FileTree / InputBar) are not included (they come post-P2).

The desktop WindowControls (min/max/close) are not drawn — the browser
provides them.

### Store layout

```ts
type Session = {
  sid: string;
  createdAt: number;
  alive: boolean;
  ws: WebSocket | null;
  lastSeq: number;
  // each session keeps its own ring-buffer copy (byte sequence + lastSeq);
  // when navigated away, ws stays alive and keeps filling
  scrollback: Uint8Array[];
};

type Store = {
  token: string;
  sessions: Map<string, Session>;
  activeSid: string | null;
  term: Terminal;  // single global xterm.js instance

  createSession(cwd?: string): Promise<string>;
  setActive(sid: string): void;          // detach old render; replay the active session's scrollback and take over input
  closeSession(sid: string): Promise<void>;
  sendInput(data: string): void;          // routed to activeSid
  resize(cols: number, rows: number): void;
};
```

### Session-switching behavior

- Background sessions keep their ws connected and continue receiving
  OUTPUT into `scrollback` without rendering.
- `setActive(sid)`: `term.reset()` -> `term.write()` the target session's
  `scrollback` in one shot to replay -> from then on that session's
  OUTPUT goes straight into `term.write()`.
- Closing a session: REST DELETE + close ws + remove from the Map. If
  the closed session was active, automatically pick the first item in
  the list (or fall back to empty state).

### Reconnection strategy

- ws close -> wait 1s and retry, exponential backoff capped at 30s.
- After successful reconnection, replay via `lastSeq` per §F6.
- Receiving a `RESET` frame -> `term.reset()` + `lastSeq = 0`.

### Desktop API ban

A static check (eslint rule) on the frontend forbids:

- `window.electron`
- `window.__TAURI__`
- `import('@tauri-apps/api/...')`
- `import('electron')`

CI runs `eslint --max-warnings=0`; any reference is an immediate fail.
This guarantees the frontend stays drop-in usable when a shell is added
later.

---

## §8 File Layout

monorepo (pnpm workspace):

```
ccsm/
|-- package.json              # workspace root
|-- pnpm-workspace.yaml
|-- packages/
|   |-- daemon/
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   |-- src/
|   |   |   |-- index.mts     # entry, parse args, listen
|   |   |   |-- http.mts      # fastify routes
|   |   |   |-- ws.mts        # ws server + frame codec
|   |   |   |-- session.mts   # Session class + ring buffer
|   |   |   |-- manager.mts   # SessionManager
|   |   |   `-- auth.mts      # token + origin checks
|   |   `-- bin/
|   |       `-- ccsm.mjs      # #!/usr/bin/env node entry
|   |-- frontend/
|   |   |-- package.json
|   |   |-- vite.config.ts
|   |   |-- index.html
|   |   `-- src/
|   |       |-- main.tsx
|   |       |-- App.tsx
|   |       |-- store.ts
|   |       |-- components/
|   |       |   |-- TopBar.tsx
|   |       |   |-- SessionList.tsx
|   |       |   `-- TerminalView.tsx
|   |       `-- ws/
|   |           |-- client.ts # ws connect + reconnect + frame codec
|   |           `-- frame.ts  # encode/decode binary frames
|   `-- shared/
|       |-- package.json
|       `-- src/
|           |-- frame.ts      # frame constants + types (shared client/server)
|           `-- api.ts        # REST types (shared client/server)
`-- README.md
```

At startup the `daemon` serves the `frontend` `dist/` as static assets.

---

## §9 Phase Plan

### Phase 1 — Walking skeleton (1 week)

- Daemon comes up, listens on a port, prints URL+token.
- REST `POST /api/sessions` spawns `claude` and returns sid.
- A ws connection can see PTY output and send keystrokes.
- Frontend renders the §7 layout: sidebar (top New Session + Search +
  middle GROUPS + bottom Settings/Import) + main (xterm.js). Search /
  Settings / Import / cwd `v` dropdown **render as buttons but onClick
  is empty (or shows a "not implemented" toast)**, which does not affect
  layout completeness. The `+ New Session` primary button is real:
  clicking it does POST /api/sessions -> setActive.
- Single session, no GROUPS drag / Archived / multi-group support (those
  go to P2).
- **Acceptance**: clicking `+ New Session` -> the browser exchanges
  something equivalent to `claude --help` and the output matches;
  Search/Settings/Import do not crash when clicked.

### Phase 2 — Multi-session + reconnection (1 week)

- The frontend GROUPS region is wired up; `+ New Session` adds the new
  session under the default group, and clicking a list entry switches
  active.
- Background sessions keep ws alive + accumulate scrollback; setActive
  replays.
- ring buffer + lastSeq reconnection (network jitter scenario).
- Multiple browser tabs sharing the same URL viewing the same sid works
  (verifies 1:N fanout; no UI support).
- **Acceptance**: create 3 sessions and switch among them; scrollback is
  not lost. Closing and reopening the tab (with the original URL+token)
  shows aligned output.

### Phase 3 — Robustness (1 week)

- PAUSE/RESUME backpressure (the frontend xterm.js actively PAUSEs when
  it is slow to write).
- 401/403 paths for missing token / bad origin are covered by tests.
- The daemon kills all PTYs gracefully on exit (SIGHUP).
- Manual cold-start test on Windows + macOS + Linux.
- **Acceptance**: blast a huge output (`yes` or 1MB log); the UI does
  not freeze; closing and reopening the tab shows complete data.

---

## §10 Desktop Shell — Deferred

Not in MVP. But the frontend constraints (§7) keep all three follow-on
paths cheap:

- **Electron**: the main process forks the daemon (or spawns it as a
  child), and the main window does
  `loadURL('http://127.0.0.1:<port>/?token=<t>')`. Zero frontend changes.
- **Tauri**: same shape; a Rust process spawns the daemon and the
  webview loads the local URL. Zero frontend changes (as long as the §7
  lint rule has not been broken).
- **PWA**: add manifest + service worker; the user clicks "Install" to
  install to the desktop. The daemon still runs separately; the PWA is
  just a browser shell.

We pick which one when we actually need to; until then nothing taints
the daemon/frontend design.

---

## §11 Deployment Topologies

> See `docs/ROADMAP.md` for the detailed roadmap. This section locks
> just one architectural red line: **the Tauri shell and the Cloudflare
> Pages entry point are completely independent and do not depend on each
> other.**

Starting from S2, ccsm has three concurrent entry-point topologies; any
one of them being offline does not affect the others:

1. **Tauri desktop shell** — a Rust process spawns the local daemon; the
   daemon embeds the pre-built `frontend-web` static assets; the webview
   loads `http://127.0.0.1:<port>/?token=<t>`. **The Tauri shell never
   fetches Cloudflare Pages**, works offline, and the installer ships
   the frontend bundle.
2. **Browser -> local daemon** (S0/S1) — the user opens the daemon's
   own `http://127.0.0.1:<port>/` in a regular browser and gets the SPA
   that the daemon serves directly.
3. **Browser -> Cloudflare Pages -> local daemon** (S2) — the user
   opens `https://ccsm-worker.jiahuigu.workers.dev` in a regular browser; Pages
   distributes the same SPA, and the SPA fetches the loopback daemon
   (`http://127.0.0.1:<port>`) from inside the browser. Pages is just a
   static-asset CDN — it does not participate in auth and does not
   proxy traffic.

### Red lines (architectural invariants)

- The Tauri shell's webview URL **must** be `http://127.0.0.1:<port>/...`;
  it **must not** point to `https://ccsm-worker.jiahuigu.workers.dev` or any remote host.
- The Tauri shell source (`packages/frontend-tauri/`) **must not**
  contain `pages.dev` / `cc-sm` / remote-fetch logic. CI grep guards
  enforce this; see `.github/workflows/ci.yml`.
- All three topologies share the same `frontend-web` codebase, but the
  distribution channels are independent: Tauri uses embed, S0/S1 uses
  daemon static, S2 uses Pages. Updating any one channel does not
  silently switch the others.

---

## §12 Changelog

- 2026-05-07 Initial version. Web + daemon only; desktop shell deferred.
- 2026-05-07 §11 Deployment Topologies: Tauri shell guard — three topologies independent, Tauri never fetches Pages (Task #711, S2-T10).
- 2026-05-08 §13 Deployment Modes architecture diagrams — three modes ASCII + security constraints (Task #720, S2-T11).

---

## §13 Deployment Modes architecture diagrams

§11 locks the "three topologies are independent" red line; this section
draws an architecture diagram for each of the three modes, labeling the
static-asset path, the daemon location, the origin, the
cross-vs-same-origin relationship, and the security constraints. It
complements [README.md "Deployment modes"](./README.md#deployment-modes)
from a developer's perspective.

### Mode 1 — Cloudflare Pages + local daemon (S2)

```
+------------------------+        HTTPS GET (cached, 0 origin trip)
| Browser (Chrome >=120) | -----------------------------+
| origin:                |                              v
|   https://cc-sm        |                   +----------------------+
|   .pages.dev           |                   | Cloudflare CDN edge  |
+----+-------------------+                   | (static SPA bundle)  |
     |                                       +----------+-----------+
     | (SPA boots in browser)                           |
     |                                                  | (build artifact)
     | fetch + ws -> loopback (cross-origin + PNA)      v
     |                                       +----------------------+
     +-------------------------------------> | local ccsm daemon    |
                                             | 127.0.0.1:9876       |
                                             | serves /api/* + /ws  |
                                             | (no static here in   |
                                             |  this mode — SPA on  |
                                             |  CDN)                |
                                             +----------------------+

origin (browser)   : https://ccsm-worker.jiahuigu.workers.dev
origin (daemon)    : http://127.0.0.1:9876
relation           : cross-origin (HTTPS -> HTTP loopback)
static asset path  : Cloudflare CDN (`/_headers` immutable for /assets/*)
daemon location    : user's local machine, loopback only
token bootstrap    : URL `?token=` -> sessionStorage; or `GET <daemonBase>/token`
```

Security constraints:

- The daemon's `classifyOrigin()` allow-list must include
  `https://ccsm-worker.jiahuigu.workers.dev` (S2-T1). Look-alike domains / PR-preview
  subdomains are rejected by default (unless
  `CCSM_ALLOW_PAGES_PREVIEWS=1`, S2-T8).
- Chromium >=120 PNA: when an HTTPS page fetches loopback, the browser
  sends `Access-Control-Request-Private-Network: true` and the daemon
  **must** respond with `Access-Control-Allow-Private-Network: true`,
  otherwise the SPA is blocked (S2-T1).
- W3C Secure Contexts §3.1 lists `127.0.0.1` as Potentially Trustworthy,
  so HTTPS pages fetching/ws-ing loopback do not count as mixed content.
- Cloudflare Pages is just the CDN; it **does not participate in auth
  and does not proxy traffic**. The token never leaves the
  user-machine <-> browser loop.

### Mode 2 — daemon-embedded (classic mode, S0/S1)

```
+------------------------+
| Browser                |
| origin:                |
|   http://127.0.0.1     |
|   :17832               |
+----+-------------------+
     |
     | http GET / (static SPA, same-origin)
     | http /api/* + ws /ws (same-origin, no CORS / PNA)
     v
+------------------------+
| local ccsm daemon      |
| 127.0.0.1:17832        |
|  - HTTP server:        |
|    * static (frontend- |
|      web bundle embedded)|
|    * /api/sessions     |
|  - WS server: /ws      |
+------------------------+

origin (browser)   : http://127.0.0.1:17832
origin (daemon)    : http://127.0.0.1:17832
relation           : same-origin (no CORS / no PNA preflight)
static asset path  : daemon-embedded (frontend-web build artifact bundled into daemon dist)
daemon location    : user's local machine, loopback only
token bootstrap    : URL `?token=` (the one printed by daemon stdout)
```

Security constraints:

- Same-origin; no CORS / PNA needed.
- Tokens still travel via `Authorization: Bearer` (HTTP) / `?token=` (WS).
- `classifyOrigin()` allows local loopback origins other than `null`
  (file://).

### Mode 3 — Tauri desktop shell

```
+-----------------------------------------------+
| ccsm-tauri.exe (Rust process)                 |
|                                               |
|   +--------------------+   stdout handshake   |
|   | embedded webview   |   (port + token)     |
|   | origin:            | <-------+            |
|   |   http://127.0.0.1 |         |            |
|   |   :<port>/?token=  |         |            |
|   +---------+----------+         |            |
|             |                    |            |
|             | http + ws (same-origin)         |
|             v                    |            |
|   +--------------------+         |            |
|   | spawned daemon     |---------+            |
|   | child process      |                      |
|   | 127.0.0.1:<port>   |                      |
|   |  * static SPA      |                      |
|   |  * /api + /ws      |                      |
|   +--------------------+                      |
|                                               |
+-----------------------------------------------+

origin (webview)   : http://127.0.0.1:<port> (daemon-served, same as mode 2)
origin (daemon)    : http://127.0.0.1:<port>
relation           : same-origin (webview does not point to pages.dev)
static asset path  : daemon-embedded (shares the build with mode 2)
daemon location    : child spawned by the Tauri process; exits with Tauri
token bootstrap    : Rust reads daemon stdout, splices it into the initial webview URL
```

Security constraints:

- The Tauri webview URL **must** be `http://127.0.0.1:<port>/...`; it
  **must not** point to `https://ccsm-worker.jiahuigu.workers.dev` (§11 red line + CI
  grep guard, S2-T10).
- The daemon's `classifyOrigin()` is the same as mode 2: only loopback
  origins are allowed. Tauri's own `tauri://localhost` (custom-protocol
  resource URLs) never appears in the daemon's Origin header (the
  webview loads the daemon URL, not a Tauri custom protocol).
- Offline-capable: the installer ships the frontend bundle (built into
  the daemon binary at build time); no online dependency on Cloudflare
  Pages.
- The daemon child's lifecycle is bound to the Tauri main process;
  Tauri exit -> daemon SIGTERM -> PTY SIGHUP, leaving no zombie
  sessions.

### Comparison of the three modes

| dimension | mode 1 (Pages+local) | mode 2 (embedded) | mode 3 (Tauri) |
|-----------|----------------------|-------------------|----------------|
| static-asset location | Cloudflare CDN | daemon-embedded serve | daemon-embedded (ships with the app) |
| daemon location | user machine loopback | user machine loopback | child spawned by Tauri |
| browser origin | `https://ccsm-worker.jiahuigu.workers.dev` | `http://127.0.0.1:<port>` | `http://127.0.0.1:<port>` |
| daemon origin | `http://127.0.0.1:9876` | same as browser | same as browser |
| same/cross-origin | cross | same | same |
| CORS | required (Pages allow-list) | not needed | not needed |
| PNA preflight | required (Chrome >=120) | not needed | not needed |
| offline-capable | no (Pages must be reachable for SPA) | yes | yes |
| install method | run daemon + open browser | run daemon + open browser | install ccsm-tauri, double-click |
