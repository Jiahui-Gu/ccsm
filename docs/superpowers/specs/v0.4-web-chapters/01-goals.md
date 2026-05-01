# 01 — Goals and non-goals

## Context block

v0.4 is fundamentally a **+frontend** change: it adds a second client (web browser) to the v0.3 daemon, and it formalizes the wire protocol so any future client speaks the same schema. It is **not** a feature redesign. The user's Q1 message reaffirmed this: v0.4 also adds a frontend, and like the daemon split it should avoid changing product features. Every goal below either (a) makes the new client possible, (b) closes a gap that the new client exposes, or (c) is a hard prerequisite for shipping safely. Anything that doesn't fit one of those three buckets is rejected and listed under non-goals with a "**Why deferred:**" note.

## TOC

- 1. Primary goals (must ship for v0.4 to be called shipped)
- 2. Secondary goals (ship if the implementation falls out cleanly)
- 3. Non-goals (deferred / out of scope)
- 4. Anti-goals (we explicitly will NOT do these)
- 5. Conformance language

## 1. Primary goals

**Invariant for §1:** every primary goal is either (a) the new client itself, (b) the protocol formalization required by the new client, or (c) a hard prerequisite for the new client to function. Goals that don't fit are demoted to non-goals.

**G1. Connect+Protobuf wire protocol on the daemon.** Replace the hand-rolled length-prefixed JSON envelope (v0.3 §3.4.1) on the **data socket** with `@connectrpc/connect-node` over HTTP/2. Schema lives in `proto/` and is the single source of truth for both the Electron renderer (via Connect-Node-over-IPC adapter, see chapter 03 §3) and the web client (via `@connectrpc/connect-web`).

**Why:** v0.3 explicitly punted real Connect to v0.4 ("the hand-written length-prefixed JSON envelope used in v0.3 (Plan Task 5; replaced by real Connect-RPC over HTTP/2 in v0.4)" — frag-3.4.1). Without it, codegen, breaking-change detection, and any non-TS client are all blocked.

**G2. `buf` toolchain in CI.** `buf lint` (style + breaking-policy enforcement) and `buf breaking` (vs latest tagged release) MUST pass on every PR touching `proto/`. `buf generate` MUST run as part of the build and produce TypeScript code committed to `gen/ts/` (vendored, not in `.gitignore`).

**Why:** without `buf breaking`, every protobuf edit is a potential silent wire break against any deployed older client (the user's browser tab from yesterday, an Electron client that hasn't auto-updated yet). The gate catches this at PR time.

**Why vendored codegen:** consumers (renderer, web SPA) build with stock Vite/tsc and shouldn't need a `buf` toolchain at install time. Vendoring keeps bootstrap simple; CI verifies the vendored output matches `buf generate`.

**G3. Full bridge swap.** All ~46 cross-boundary IPC calls in `electron/preload/bridges/*.ts` (5 bridge files: `ccsmCore`, `ccsmSession`, `ccsmPty`, `ccsmNotify`, `ccsmSessionTitles`) plus the `electron/ipc/*` main-process handlers route through Connect — per chapter 03 §1 inventory: 31 unary + 4 fire-and-forget + 11 streams. After v0.4, no `ipcRenderer.invoke` call survives in `electron/preload/bridges/`. Window-only / clipboard-only IPCs (e.g. `window:minimize`, `clipboard.readText`) MAY stay on `ipcRenderer` because they don't cross the daemon boundary — see chapter 03 §2.

**Why:** partial swap leaves two parallel transports indefinitely (envelope + Connect), which is exactly the maintenance burden v0.4 exists to retire. A complete swap also means the Web client (which has no `ipcRenderer`) sees the same bridge surface.

**G4. Web client reachable via Cloudflare Tunnel.** Author opens a browser from any network, hits `https://app.<your-domain>`, authenticates via GitHub OAuth (Cloudflare Access), and reaches the live daemon. Sessions, PTY, settings — all functional.

**Why:** this is the user-visible value. Without it, v0.4 is invisible plumbing.

**G5. Multi-client coherence.** Electron and Web attached to the same session see the same PTY view (already enabled by v0.3's headless buffer + seq replay; v0.4 just exercises it for real). Inputs from either side are honored in PTY-input-queue arrival order.

**Why:** the headline use case is "leave Electron running at home, also use web from laptop". If the two clients diverge, the feature is broken.

**G6. Auto-start at OS boot (opt-in).** A Settings toggle + tray menu item enables daemon auto-start at login (Win startup folder shortcut / launchd `RunAtLoad` / systemd `WantedBy=default.target`). Default OFF in v0.4.

**Why:** remote access depends on the daemon being up. This goal exists ONLY as a hard prerequisite for G4 (web client reachable when desktop is closed); it is not a generally-useful product feature. Until the user explicitly enables auto-start, the remote URL works only while Electron is running. This goal closes that gap and nothing more.

**Why surfaced in tray menu (not just Settings):** Settings pane visibility requires opening the desktop app, which defeats the purpose for users who keep the app minimized. The tray menu item is the minimal additional surface to make the toggle discoverable without scope-creeping the auto-start UX. The single tray entry mirrors the Settings toggle and does not introduce new states (scheduling, conditional auto-start, etc.).

**Why default OFF:** least-surprise on first install; flipping the user's boot state without consent is hostile. Promote default to ON in a later release once the dogfood week is clean.

## 2. Secondary goals

**S1. Custom-domain support for the Tunnel hostname.** Default is the auto-generated `<random>.cfargotunnel.com`. If the user owns a domain configured in Cloudflare DNS, surface a Settings field to use `daemon.<your-domain>` instead. Pure config, no protocol change.

**Why secondary:** the random hostname works end-to-end; custom domain is polish.

**S2. Web client offline UX.** When the daemon is unreachable, show a skeleton + retry banner (chapter 04 §6). No service worker / PWA caching of session content in v0.4.

**Why secondary:** the retry banner is a small visible behavior; PWA caching is a separate large work item with its own coherence problems (stale data shown to user on reconnect). Defer the cache.

**S3. Daemon emits structured logs for the new Connect surface.** Pino lines tagged `transport=connect`, `method=<rpc>`, `peer=<local|tunnel>`, `traceId=<ulid>`. Reuses the v0.3 traceId convention.

**Why secondary:** observability is essential, but inherits the v0.3 logging infrastructure unchanged. Listed here as a reminder to wire the new surface into the existing logger, not as a new system.

## 3. Non-goals (deferred / out of scope)

**N1. Mobile (iOS / Android native).**
**Why deferred:** Swift / Kotlin codegen is emitted by `buf generate` (see chapter 02 §3), so the protocol is mobile-ready from v0.4. The actual SwiftUI / Compose client work is its own multi-week effort and is the primary content of v0.5+.

**N2. Multi-user / multi-tenant daemon.**
**Why deferred:** v0.4 is single-user. The Cloudflare Access policy is `email == <author's GitHub email>`; daemon RPC handlers do not carry an authenticated user identity. Multi-tenant requires per-user data isolation in SQLite (per-user PTYs, per-user settings), per-user ACL on every RPC, and a separate billing/quota layer. Out of scope. Target: v0.7+ if author chooses to share with friends.

**N3. Feature redesigns of the renderer.**
**Why deferred:** v0.4 is +frontend additive. The renderer (`src/`) ships unchanged except for any small adjustments forced by the bridge swap or the web build packaging (e.g. `process.platform` no longer available in browser). Sidebar layout, terminal display, agent list, notify behavior — none change. **If the implementation finds itself proposing UI changes, that's a scope leak and the change is rejected unless re-justified as a v0.4 prerequisite.**

**N4. Daemon-on-cloud (SaaS).**
**Why deferred:** the daemon stays on the user's machine. Cloudflare is **ingress only** (Tunnel + Access). Moving the daemon to the cloud means moving SQLite + the PTYs + the Claude SDK + the user's filesystem access — a fundamentally different product. Not happening.

**N5. Headless daemon with no Electron.**
**Why deferred:** Electron remains the primary install path. The daemon ships inside the Electron installer; there is no standalone "daemon only" install in v0.4. A headless install is a 1-2-day follow-up but adds OS service installer surface (Win Service, launchd plist, systemd unit) that's not justified until at least one user wants it.

**N6. Replacing the v0.3 control socket / supervisor RPC surface with Connect.**
**Why deferred:** the control socket (`/healthz`, `daemon.hello`, `daemon.shutdown*`, `/stats`) is **kept** as a separate transport with its own narrow allowlist, per v0.3 §3.4.1.h. v0.4 swaps the **data socket** to Connect. The control socket can also move to Connect later but is currently fine and changing it adds risk to the supervisor / restart paths that the user already relies on. Target: v0.5 housekeeping.

**N7. Sigstore / signed daemon binaries (so we can flip auto-update default ON).**
**Why deferred:** v0.3 already shipped daemon auto-update as opt-in. v0.4 keeps the same default. Signing infrastructure (sigstore, GitHub OIDC keyless) is a tangential concern. Target: parallel track.

**N8. Web push notifications.**
**Why deferred:** the web client receives notifications **only while the tab is open** (regular browser Notification API). Web push (server-pushes-while-tab-closed) requires VAPID keys, a Service Worker, and a push subscription stored on the daemon. Enough complexity that it gets its own slice. Target: v0.5+.

**N9. Performance optimization passes on the new wire.**
**Why deferred:** v0.4 must not regress vs v0.3. It MAY also not be faster. If we discover the Connect-Web client over Tunnel adds noticeable latency, we measure, log, and fix in a follow-up unless it crosses the "user notices stutter" threshold (see chapter 10 risks).

## 4. Anti-goals

**A1. We will NOT keep the hand-rolled envelope alongside Connect.**
**Why:** dual transports forever is the trap. M1–M4 (chapter 09) sequence the swap; once a bridge is on Connect it stays on Connect.

**A2. We will NOT introduce a new authentication identity for local Electron.**
**Why:** local socket peer-cred + ACL is the v0.3 trust boundary and remains in v0.4. Adding a JWT requirement to the local path would be theatre and would break headless dev (`vite dev` against the local daemon has no JWT).

**A3. We will NOT couple Electron and daemon versions tighter than they already are.**
**Why:** v0.3 ships them in lockstep via one installer (frag-11 §11). v0.4 keeps that. Separating release cadences is N6's parallel track.

**A4. We will NOT redesign the renderer for "responsive web" (mobile breakpoints, touch).**
**Why:** the web client is the same React renderer, sized for laptop browsers. Mobile is N1. If a phone browser opens it, it works (because the layout is fluid enough), but designing-for-touch is a separate large effort.

**A5. We will NOT iterate on auto-start UX in v0.4 beyond the single Settings toggle + matching tray menu item.**
**Why:** G6 is a remote-access prerequisite, not a feature axis. Scheduling, conditional auto-start, polish passes, etc. are all out of scope for v0.4.

## 5. Conformance language

This spec uses RFC 2119 keywords. **MUST** = blocking requirement; **MUST NOT** = forbidden; **SHOULD** = strongly recommended, deviations need explicit justification in the implementation PR; **SHOULD NOT** = strongly discouraged, same; **MAY** = optional, choose freely. Each architectural decision in subsequent chapters is followed by `**Why:**` justifying it. Each non-goal carries `**Why deferred:**` plus a target version where applicable.
