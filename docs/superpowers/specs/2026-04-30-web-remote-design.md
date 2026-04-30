# v0.3+ — Daemon split + Web remote-control

**Status:** locked (4-spike round, 2026-04-30)
**Author:** ccsm
**Tracks:** #922

## 1. Goal

Enable remote operation of ccsm from a web browser (any device, anywhere) while the user's local Windows box keeps running the actual sessions, CLI processes, and SQLite data. Authentication via the same GitHub account that owns the repo. Free tier of Cloudflare for ingress.

Non-goal for v0.3: iOS/Android. Deferred to v0.6+ but the wire protocol is chosen so that adding a Swift client later requires zero protocol redesign.

## 2. Context

### 2.1 Current state (v0.2.0)
ccsm today is a single Electron app: main process owns sessions / CLI subprocess / SQLite / PTY / notifications; renderer is React + xterm.js. All IPC is in-process via `electron/ipc/*` and `electron/preload/bridges/*`. ~22 cross-boundary calls, 16 unary + 6 server-streams (PTY out, notifications, etc.).

### 2.2 Why this is the next slice
User wants remote work: leave Windows box running at home, open a browser on any device (work laptop, hotel) and continue sessions exactly where they were. Today this is impossible — UI is bolted to the same process as the data.

### 2.3 Constraints
- No active deadline. Iteration mode (memory: project_direction_locked).
- Cloudflare free tier only. WebSocket idle timeout 100s → 90s heartbeat required. WebSocket connections capped per zone but well above single-user load.
- Architecturally clean over expedient (memory: prefer daemon split over Electron-bound shortcut).
- Author dogfoods every release.

## 3. Architecture (locked)

```
┌─────────────────────────────────────────────────────────┐
│ Daemon (headless, runs on user's Win box)               │
│ - Node binary (~30-50MB pkg-bundled)                    │
│ - Connect/Protobuf RPC server (@connectrpc/connect-node)│
│ - Session manager (lifted from electron/sessionTitles)  │
│ - PTY host + xterm-headless buffer + seq replay         │
│ - SQLite (better-sqlite3)                               │
│ - Claude SDK loader (loadSdk shim)                      │
│ - CLI subprocess manager                                │
│ - Auto-updater (poll GitHub releases)                   │
│ - Logs: pino → ~/.ccsm/daemon.log                       │
└─────────────────────────────────────────────────────────┘
        │                                    │
   Local: named pipe (Win) /                 │
          unix socket (Mac/Linux)            │
        │                          Cloudflare Tunnel
        ▼                                    │
┌──────────────────────┐                     ▼
│ Electron (local UI)  │            ┌──────────────────────┐
│ - main: tray + window│            │ Cloudflare Pages     │
│ - renderer: React    │            │ (web client)         │
│   + xterm.js         │            │ - React + xterm.js   │
│ - Connect client     │            │ - Connect-Web client │
└──────────────────────┘            │ - Cloudflare Access  │
                                    │   (GitHub IdP, JWT)  │
                                    └──────────────────────┘
```

### 3.1 Daemon
- **Language**: Node.js. Same language as today's Electron main process — lift-and-shift, no rewrite.
- **Packaging**: `pkg` or `@yao-pkg/pkg` produces single `.exe` / `.app` / ELF binary.
- **Lifecycle**:
  - Win: optional Win Service registration; default = user-mode background process (started by Electron on first launch, kept alive after Electron exits, exits only when user explicitly quits via tray).
  - Mac: `launchd` user agent.
  - Linux: `systemd` user unit.
- **Listeners**:
  - Local IPC: named pipe `\\.\pipe\ccsm-daemon` (Win) or `~/.ccsm/daemon.sock` (Mac/Linux). No authentication — assumes local user trust boundary.
  - Remote: TCP `127.0.0.1:7878`, exposed only via Cloudflare Tunnel. Connect server validates Cloudflare Access JWT on every request.
- **Auto-update**: poll `Jiahui-Gu/ccsm-daemon` GitHub releases (separate repo or tag prefix, TBD in implementation plan); on new version, download → verify SHA256 → kill old → swap binary → restart. No `electron-updater` (Electron-only).

### 3.2 Electron client
- Reduced to: tray icon + window manager + renderer host. All session/PTY/SQLite logic moves to daemon.
- On launch: probe daemon; if not running, spawn it; then connect via local socket.
- Renderer: same React + xterm.js as today. IPC layer in `preload/bridges/*` swapped from `ipcRenderer` to a Connect client. Bridge surface unchanged so renderer code is untouched.
- Tray-resident lifecycle (memory: option 3): closing window hides to tray; daemon keeps sessions alive; explicit Quit from tray menu stops both.

### 3.3 Web client
- Same React renderer code as Electron, packaged as a static SPA via Vite.
- Deployed to Cloudflare Pages (free tier, automatic deploys from `main`).
- Connect-Web client (browser flavor, plain HTTP/2, half-duplex) talks to daemon through the Cloudflare Tunnel.
- xterm.js works identically; PTY stream comes from daemon's xterm-headless buffer (see 3.5).

### 3.4 Protocol: Connect + Protobuf + buf
- Schema in `proto/` directory of main repo. Versioned alongside code.
- `buf generate` produces TypeScript bindings consumed by both Electron renderer and Web client. Swift bindings are emitted but unused until iOS lands.
- Wire format: Connect (HTTP/2 framing, JSON or binary). Browser-friendly (no Envoy proxy needed, unlike grpc-web).
- Authentication: Cloudflare Access JWT in `Cf-Access-Jwt-Assertion` header, validated by daemon middleware on every remote request. Local socket bypasses this.
- Streaming: server-streaming for PTY out, session updates, notifications. Client-streaming and bidi not used (PTY input is unary message-per-keystroke, fine).

### 3.5 PTY display strategy (chosen: headless buffer)
- Daemon runs `xterm-headless` per session, maintains the authoritative terminal buffer.
- Clients receive (a) full snapshot on connect (`getBuffer(sessionId, fromSeq?)`), then (b) incremental ops (`subscribePty(sessionId)` server-stream).
- Seq numbers per session for resumable streams (already implemented in main process via L4 PR-A..E commits 49353a9, 9971733, 64b5248 — lifted to daemon).
- **Why**: user explicitly wants "leave desktop running, open web from anywhere". Multi-device concurrent connections (desktop + web at the same time) need consistent view; raw-byte stream from a fixed point would diverge. +~20h vs raw bytes; pays back in correctness.

### 3.6 Cloudflare layer
- **Tunnel**: `cloudflared` runs on Win box (or daemon spawns it), creates outbound tunnel to a `*.cfargotunnel.com` hostname. No port forwarding, no public IP needed.
- **Pages**: web client deployed via `wrangler` from GitHub Actions on push to `main`.
- **Access**: zero-trust application in front of both the tunnel hostname and the Pages domain. IdP = GitHub OAuth. Policy = `email == <author's GitHub email>`. JWTs short-lived (24h default), refreshed on browser side, validated on daemon side.
- **All free tier**: Tunnel free for unlimited bandwidth, Pages free for 500 builds/month + unlimited static hosting, Access free for ≤50 users.

## 4. Components

### 4.1 New
- `daemon/` — Node binary source. Connect server, session manager, PTY host, SQLite, CLI subprocess, updater. Bulk lifted from `electron/` paths cited in 3.1.
- `proto/` — Protobuf schema. `buf.gen.yaml` config for TS + Swift output.
- `web/` — Vite SPA wrapper around the shared renderer. Cloudflare Pages deploy config.
- `infra/cloudflare/` — Tunnel config template, Access policy as code.

### 4.2 Modified
- `electron/main.ts` — strip session/PTY/CLI/SQLite logic; add daemon spawn-or-attach + Connect client wiring.
- `electron/preload/bridges/*.ts` — swap `ipcRenderer.invoke` calls for Connect client calls. Bridge interface unchanged so renderer is untouched.
- `electron/ipc/*.ts` — most files removed (logic moved to daemon). A few (window-only, tray-only) stay.
- `package.json` — split into a workspace? Decide in implementation plan.

### 4.3 Removed (eventually)
- Direct SQLite access from Electron main.
- Direct node-pty in Electron main.
- Claude SDK loader in Electron main.

## 5. Data flow examples

### 5.1 Local user opens Electron
1. Electron main spawns daemon if absent (named-pipe probe).
2. Connect client dials `\\.\pipe\ccsm-daemon`.
3. Renderer mounts; bridges call `daemon.listSessions()` → daemon returns from SQLite.
4. User opens session N; renderer subscribes to `subscribePty(N)`; daemon streams snapshot + ops; xterm.js renders.
5. User closes window; Electron hides to tray; daemon keeps sessions running.
6. User explicitly Quit from tray; Electron tells daemon to graceful-shutdown; both exit.

### 5.2 Remote user opens web
1. Browser navigates to `app.ccsm.<user-domain>` (Cloudflare Pages route).
2. Cloudflare Access intercepts; redirects to GitHub OAuth; on success, sets JWT cookie.
3. SPA loads; Connect-Web client dials `daemon.<user-domain>` (Cloudflare Tunnel hostname); JWT auto-injected.
4. Daemon middleware validates JWT against Cloudflare Access JWKS; on success, processes RPC.
5. Same `listSessions` → `subscribePty` flow as local.
6. WS-equivalent (Connect server stream) heartbeats every 90s to dodge CF 100s idle timeout.

## 6. Error handling and edge cases

- **Daemon crash**: Electron detects connect failure; offers user one-click respawn; renderer shows banner.
- **Stale JWT mid-session**: daemon returns Connect `unauthenticated`; web client redirects to Access flow; on return, replays last `getBuffer(sid, fromSeq)`.
- **Network drop on web**: Connect-Web auto-reconnects; replay via fromSeq.
- **Concurrent edits from two clients (desktop + web)**: both subscribe to same session; daemon broadcasts ops to all subscribers. Last-write-wins for explicit user actions (keystroke ordering preserved by daemon's single PTY input queue per session).
- **SQLite locked**: daemon serializes all writes via better-sqlite3's synchronous API.
- **Updater swap on Windows**: daemon writes new binary to `daemon.exe.new`; on restart, batch script swaps. Standard pattern.

## 7. Testing

- Daemon: unit tests (vitest) for session/SQLite/PTY/SDK modules. Integration tests via test Connect client. ~30 e2e probes (mostly lifted from current main-process e2es).
- Electron: thin client; e2e via Playwright as today, but talking to a real daemon spawned in-test.
- Web: e2e via Playwright on Cloudflare Pages preview deploy. Local dev via Vite.
- Protocol: `buf lint` + `buf breaking` in CI; schema changes blocked if breaking.
- Real-prod dogfood per release (memory: dogfood_protocol).

## 8. Release slicing (one milestone per version)

| Version | Scope | Estimate | Value to user |
|---|---|---|---|
| **v0.3** | Daemon split + Electron client uses local Connect IPC. No web yet. | ~125h | Architecture foundation; Electron upgrades no longer kill running sessions; dogfood daemon stability. |
| **v0.4** | Connect + Protobuf formalization, `proto/` repo, buf CI, full bridge swap. | ~30h | Wire protocol versioned and codegen'd; ready for any client. |
| **v0.5** | Web client (shared renderer build) + Cloudflare Tunnel/Pages/Access wiring. | ~30-50h | **Remote work goes live.** |
| **v0.6+** | iOS native (SwiftUI) using same Connect schema with Swift codegen. | ~66h+ (deferred) | Mobile monitoring/notifications. App Store guideline 4.2.7 + 4.8 SIWA caveats apply (per F3 spike). |

Each version independently shippable, independently dogfoodable, no half-finished states.

## 9. Open questions deferred to implementation plans

- pkg vs @yao-pkg/pkg — pick during v0.3 implementation; both viable.
- Daemon repo: same `Jiahui-Gu/ccsm` monorepo or separate `ccsm-daemon`? Recommend monorepo with workspace for tighter version coupling.
- Cloudflare Tunnel hostname strategy: `<random>.cfargotunnel.com` vs custom domain. Custom domain requires user to own a domain — make it optional in v0.5.
- Web client offline UI when daemon unreachable: skeleton vs banner. Cosmetic, decide during v0.5.
- Version-skew handling between old Electron client and newer daemon (or vice versa): protocol field-level back-compat via Protobuf reserved tags is the long-term answer; near-term v0.3 ships them in lockstep via single installer.
- Daemon auto-start at OS boot (Win startup folder shortcut, launchd `RunAtLoad`, systemd `WantedBy=default.target`): pick mechanism per OS during v0.3. Today the spec assumes Electron launch spawns daemon — that's enough for v0.3 dogfood but remote-only access (v0.5) needs boot-time autostart.
- APNs relay (per F3 spike option A: tiny Cloudflare Worker translating daemon push → APNs token) is the v0.6+ iOS dependency. Stub the Worker repo at v0.5 if convenient.

## 10. Risks (locked-in awareness)

1. **Daemon updater on Windows is finicky** — process-replacing-itself pattern needs careful testing. Allocate a dogfood week between v0.3 ship and v0.4 start.
2. **Cloudflare Access free tier limits** — ≤50 users (single-user fine), but if author shares with friends later, plan budget.
3. **Connect-Web is half-duplex** — verified ccsm needs no true bidi (F4 spike). If a future feature needs bidi (e.g., collaborative cursor sharing), revisit.
4. **xterm-headless memory per session** — buffer per session per client. Cap scrollback (default 10k lines OK), eviction policy for long-idle sessions.
5. **iOS App Store risk (deferred)** — guideline 4.2.7 (Remote Desktop) requires "your own Mac/PC companion" framing. Factor into v0.6 marketing copy.

## 11. Non-goals (explicit)

- Multi-tenant. Single user, single GitHub account.
- Mobile in v0.3-v0.5.
- Cross-OS daemon (each user runs daemon on their own machine; no SaaS).
- Tauri / Flutter migration (F1, F2 spikes rejected).
- gRPC / TypeSpec (F4 spike rejected in favor of Connect+Protobuf+buf).

## 12. References

- F1 spike — Tauri vs Electron desktop: `~/spike-reports/F1-tauri-desktop.md`
- F2 spike — Flutter all-platform: `~/spike-reports/F2-flutter-all.md`
- F3 spike — iOS native vs cross-platform: `~/spike-reports/F3-ios-stack.md`
- F4 spike — shared protocol layer: `~/spike-reports/F4-shared-protocol.md`
- Round-1 spikes A1-A4, B1-B4, C5, D6-D7: `~/spike-reports/`
- L4 PR-A..E (PTY headless + seq replay): commits `49353a9`, `9971733`, `64b5248`
- Memory: `project_direction_locked.md`, `feedback_architecture_review_first.md`, `feedback_architecture_spike_or_source.md`
