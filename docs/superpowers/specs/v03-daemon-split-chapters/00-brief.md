# v0.3 Daemon Split — Author Brief (input only, NOT a chapter)

> Source of truth for the diagram: `docs/superpowers/specs/2026-05-02-final-architecture.md` §1 ONLY.
> Do NOT consult any other section of that file or any other doc — user explicit ("可能有毒").

## Scope of v0.3

Strip from the diagram, then design what's left:
- ❌ Web client (browser, @connectrpc/connect-web)
- ❌ iOS client (connect-swift)
- ❌ Cloudflare Edge (Cloudflare Access + Cloudflare Tunnel)
- ❌ cloudflared sidecar
- ❌ GitHub OAuth IdP
- ❌ Listener B (127.0.0.1:PORT_TUNNEL with CF Access JWT validation) — runtime
- ✅ Everything inside the "user's local machine" box, EXCEPT cloudflared and Listener B runtime
- ✅ Listener trait/interface abstraction (B is a stub slot, not implemented runtime)

In other words v0.3 = pure backend/frontend split of the existing Electron app into **two locally cohabiting binaries** that talk Connect-RPC over Listener A, structured so that v0.4 adding web/iOS is a **purely additive** change.

## Locked decisions (user 2026-05-03)

1. **Listener architecture**: daemon defines a `Listener` trait/interface; v0.3 instantiates only Listener A (loopback / UDS, peer-cred auth, JWT bypass); Listener B is reserved as a stub array slot — no socket bound, no JWT middleware code shipped, but the trait + the array shape exist.
2. **Listener A protocol**: HTTP/2 (same stack as B will be). Spike required to validate Win 11 25H2 h2c-on-loopback (or pick alternative HTTP/2 transport: ALPN over local-only TLS w/ self-signed, or named pipe + h2). The spec MUST mark this as a `must-spike` item with concrete alternatives, not a `tbd`.
3. **Electron client migration**: BIG-BANG. v0.3 ship gate requires 100% IPC removal — every existing `contextBridge` API + every `ipcMain` handler is replaced by a Connect call against Listener A using the same proto-generated client used by v0.4 web/iOS. Zero IPC residue.
4. **PTY**: `xterm-headless` host emits both **snapshot AND delta** in v0.3 (per diagram). Schema for delta is locked in v0.3 proto.
5. **Session model**: every Session is bound to a `principal` (`owner_id`) from day one. v0.3 has exactly one principal value: `local-user` (derived from peer-cred on Listener A). `owner_id` is enforced in RPC handlers (list/get/create/delete filter by owner). v0.4 adds `cf-access:<sub>` principals additively — daemon code unchanged.
6. **Proto scope**: v0.3 freezes ONLY the RPCs v0.3 actually uses. v0.4 may ADD new RPCs, but **MUST NOT reshape any existing v0.3 message** (no field removals, no semantic changes, only `optional` field additions / new enum variants). The spec MUST list every v0.3 message and explicitly mark which are forever-stable vs which are v0.3-internal.
7. **Daemon lifecycle**: SYSTEM SERVICE.
   - Windows: Win Service (registered via `node-windows` or equivalent; runs as LocalService account, NOT SYSTEM unless absolutely required).
   - macOS: launchd `LaunchDaemon` plist (system-wide, survives logout) — pick LaunchDaemon vs LaunchAgent based on whether v0.4 web/iOS needs daemon while user logged out (yes → LaunchDaemon). Spec must justify the choice.
   - Linux: systemd unit, system-level (not `--user`).
   - Daemon survives Electron exit. Starts on boot. No login required.
8. **Repo**: monorepo. `packages/{daemon, electron, proto}`. v0.4 adds `packages/{web, ios}` as additive. Tooling must support: shared proto codegen, independent build/test per package, cross-package CI orchestration. Pick ONE tool (npm workspaces / pnpm workspaces / Turborepo / Nx) and justify.
9. **Daemon runtime**: Node 22 + sea (Single Executable Applications, Node 22 GA) or `pkg`. Single binary per OS. Native deps: `node-pty`, `xterm-headless`, `better-sqlite3`, `@connectrpc/connect-node` (or equivalent). Spec must call out: native module bundling into sea (workaround / patch / extract-and-load), cross-OS build matrix, code signing.
10. **Crash collector**: local-only in v0.3.
    - Capture: daemon `uncaughtException` / `unhandledRejection`, child-process exit (claude CLI subprocess), PTY EOF, SQLite open errors.
    - Storage: SQLite log table (rotated, capped size).
    - Read path: a Connect RPC `GetCrashLog` exposed on Listener A; Electron Settings UI displays the log.
    - NO network upload in v0.3. v0.4 adds upload as additive (must reuse same capture path).
11. **Ship gate (v0.3 dogfood done = ALL of)**:
    - (a) `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src` returns 0 hits (or only in dead-code paths flagged for removal).
    - (b) Daemon survives `taskkill /F /IM electron.exe` (Windows) / equivalent SIGKILL (mac/linux). Reattach a fresh Electron — sessions list intact, terminals reconnect to same PTY snapshots, no data loss.
    - (c) PTY zero-loss: 1-hour live dogfood session running real `claude` CLI workload; on reconnect via fresh Electron, terminal state matches binary-identically (snapshot + replayed deltas == truth).
    - (d) Installer clean: fresh Win 11 25H2 VM → run installer → service registered, started, listening on Listener A → Electron launches and connects → uninstall via Windows Settings → service unregistered, no leftover files in ProgramData / Registry / Scheduled Tasks.

## ZERO-REWORK RULE (must be a top review angle)

For every design decision, the spec must explicitly answer:

> When v0.4 lands web client + iOS client + Cloudflare Tunnel + cloudflared sidecar + CF Access JWT validation on Listener B, **what code/proto/schema/installer changes are required?**

Acceptable answers: "none" / "purely additive" (new RPC, new principal type, new package, new feature flag enabled).
**Unacceptable**: "rename X" / "change message Y shape" / "move file Z" / "split function into two" — these mean the v0.3 design picked the wrong shape and MUST be reworked **inside v0.3**.

## Diagram (verbatim from final-architecture §1)

```
                   ┌──────────────────────────┐
                   │  GitHub OAuth IdP        │
                   └────────────┬─────────────┘
                                │ identity (federated by CF Access)
                                ▼
                   ┌──────────────────────────┐
                   │  Cloudflare Edge         │
                   │   - Cloudflare Access    │
                   │     (per-app AUD,        │
                   │      Cf-Access-Jwt-      │
                   │      Assertion injected) │
                   │   - Cloudflare Tunnel    │
                   └────────────┬─────────────┘
                                │ HTTPS / HTTP/2
                                │ (Cf-Access-Jwt-Assertion header)
                                ▼
   ╔════════════════════════════ user's local machine ════════════════════════════╗
   ║                                                                              ║
   ║   ┌───────────────────────────┐                                              ║
   ║   │  cloudflared (sidecar)    │     spawned + lifecycled                     ║
   ║   │  - tunnel client          │◀──── by ccsm-daemon (user-toggled)           ║
   ║   │  - HTTP/2 only            │                                              ║
   ║   └───────────────┬───────────┘                                              ║
   ║                   │  127.0.0.1:PORT_TUNNEL  (Connect-RPC, JWT required)      ║
   ║                   ▼                                                          ║
   ║   ┌──────────────────────────────────────────────────────────────────────┐   ║
   ║   │  ccsm-daemon  (single binary, backend-authoritative)                 │   ║
   ║   │                                                                      │   ║
   ║   │   ┌─────────── data plane ───────────┐  ┌── control plane ──┐        │   ║
   ║   │   │  Listener A: loopback / UDS      │  │  Supervisor UDS   │        │   ║
   ║   │   │    (peer-cred, JWT bypass)       │  │  (v0.3 envelope)  │        │   ║
   ║   │   │  Listener B: 127.0.0.1:PORT_TUN  │  │  /healthz, hello, │        │   ║
   ║   │   │    (CF Access JWT validated;     │  │  shutdown*        │        │   ║
   ║   │   │     cloudflared-only consumer)   │  └───────────────────┘        │   ║
   ║   │   └────────────────┬─────────────────┘                                │   ║
   ║   │                    │                                                  │   ║
   ║   │       Connect-RPC over HTTP/2 (proto-generated surface)               │   ║
   ║   │                                                                      │   ║
   ║   │   Session manager · PTY host (xterm-headless, snapshot+delta) ·      │   ║
   ║   │   claude CLI subprocess · SQLite · cwd state · crash collector       │   ║
   ║   └──────────────────────────┬───────────────────────────────────────────┘   ║
   ║                              │                                               ║
   ║                              │ Listener A                                    ║
   ║                              ▼                                               ║
   ║   ┌──────────────────────────────────────┐                                   ║
   ║   │  Desktop client (same machine)       │                                   ║
   ║   │  - Connect client (proto-generated)  │                                   ║
   ║   │  - hits Listener A directly          │                                   ║
   ║   └──────────────────────────────────────┘                                   ║
   ║                                                                              ║
   ╚══════════════════════════════════════════════════════════════════════════════╝

                   ▲                                              ▲
                   │ (back through CF Edge)                       │
                   │                                              │
   ┌───────────────┴───────────────┐         ┌────────────────────┴──────────────┐
   │  Web client (browser, any net)│         │  iOS client (any network)         │
   │  - @connectrpc/connect-web    │         │  - connect-swift over URLSession  │
   │  - same proto-generated code  │         │  - same proto-generated code      │
   └───────────────────────────────┘         └───────────────────────────────────┘
```
