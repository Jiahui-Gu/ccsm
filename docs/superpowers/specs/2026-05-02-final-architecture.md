# ccsm — Final architecture (frozen baseline)

> **Status: FROZEN — 2026-05-02.** Approved by user; supersedes all prior architecture proposals (incl. PR #787 proposal, `2026-05-01-v0.4-web-design.md` as architecture authority, `2026-04-30-web-remote-design.md`).
>
> **Supersedes (deleted from tree, see git history for archival reads):**
> - `docs/superpowers/specs/2026-04-30-web-remote-design.md`
> - `docs/superpowers/specs/2026-05-01-v0.4-web-design.md`
>
> **Constitution doc.** Locked principles + the topology figure, nothing more. Detail-level design (JWT knobs, sidecar update flow, presence, heartbeat tuning, scrollback persistence, etc.) belongs in subordinate v0.4 specs that hang off this baseline.

---

## §1 The diagram

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

---

## §2 Locked principles

1. **Backend = single binary, runs on the user's local machine ONLY.** No remote deploy target. No SaaS. No multi-tenant. The user's machine is the source of truth for sessions, PTY, claude CLI, SQLite, cwd, crash logs.

2. **Three first-class clients: desktop, web, iOS.** None is "primary". All three consume the same `proto/` schema and the same Connect-RPC surface. Adding a fourth client = generating a fourth client; no backend change.

3. **Backend exposes TWO loopback listeners.**
   - **Listener A** = peer-cred-trusted local socket (UDS / named pipe). JWT bypass. Same-UID processes only.
   - **Listener B** = `127.0.0.1:PORT_TUNNEL`. Cloudflare Access JWT validated unconditionally. Sole intended consumer is the local `cloudflared` sidecar.
   - Listeners are physically separate. The JWT bypass is keyed on the listener (transport identity), never on a request header.

4. **Client → listener mapping is fixed.**
   - **Desktop on the same machine** → Listener A.
   - **Web + iOS** (and desktop on a different machine) → Cloudflare Edge → `cloudflared` sidecar (local) → Listener B.
   - There is no third path.

5. **Auth = GitHub OAuth, identity provided by Cloudflare Access.** Backend never issues its own tokens. Backend never stores a user database. Backend's auth job on Listener B is "verify the `Cf-Access-Jwt-Assertion` and trust it". Backend's auth job on Listener A is "trust the peer-cred".

6. **`cloudflared` is a local sidecar, lifecycled by the daemon.** User-toggled (off by default). When on, daemon spawns `cloudflared`, points it at Listener B, advertises the public URL. When off, daemon kills the sidecar; web + iOS lose reachability; desktop on Listener A is unaffected.

7. **Session model: backend-authoritative; clients are pure subscribers.**
   - **Catch-up:** snapshot (bounded `xterm-headless` ring buffer) + delta-from-`seq` replay.
   - **Multi-client writes:** broadcast-all + last-writer-wins at the PTY layer. The PTY is the serialization point. No locks. No "primary" client.
   - **Scrollback:** RAM-only (existing v0.3 ring buffer). Long-tail history persistence is a separate, later feature.

8. **Wire surface split between supervisor control plane and data plane.**
   - **Supervisor control plane** (`/healthz`, `daemon.hello`, `daemon.shutdown*`, lifecycle): stays on the local UDS with the v0.3 hand-rolled envelope. Unchanged.
   - **Data plane** (every session / PTY / SQLite-backed RPC): moves to Connect-RPC over HTTP/2 on Listener A and Listener B. Generated from `proto/`. `buf breaking` gates every PR that touches the schema.

9. **Daemon owns its lifecycle.** The daemon is not a child of any client. Closing the desktop client does not stop the daemon. The daemon process model on each OS (launchd / Windows Service / systemd-user) is what respawns it; the in-process supervisor degrades to a crash-loop counter + `.bak` rollback, not "the thing that keeps the daemon alive". `cloudflared` is the daemon's child and dies when the daemon dies.

10. **Single user, single identity.** "Multi-tenant" is out of scope. The user's GitHub identity is the only identity the system knows. Every authenticated request — Listener A peer-cred or Listener B JWT — resolves to the same one user.

---

## §3 What this doc does NOT decide

This baseline locks the topology and the principles, not the parameters. The following all defer to subordinate v0.4 specs that take this doc as authority: exact JWT validation knobs (algorithms, AUD, clock tolerance, JWKS pre-warm + cooldown, bind-gate); `cloudflared` install / supply-chain / update flow; multi-machine semantics if the user later runs the backend on more than one host; presence indicators / "another client is typing" UX; OS-level supervisor for headless mode (launchd / Windows Service / systemd-user) and the daemon-detach-from-Electron lifecycle; heartbeat tuning and idle eviction; PTY scrollback persistence to SQLite; per-listener port discovery contract; CI lint that pins Listener B to `127.0.0.1`. None of these are open questions about the architecture; they are sub-spec decisions inside it.

---

## §4 Subordinate specs (placeholders)

- **v0.4 transport spec** — `proto/` layout, Connect-RPC server mount on Listener A and B, PTY server-stream contract, `buf` CI, browser stream-support matrix. TBD.
- **v0.4 ops / cloudflared spec** — sidecar lifecycle, OS-level supervisor for headless mode, port discovery contract, JWKS bind-gate, multi-machine collision handling. TBD.
- **v0.4 security / auth spec** — JWT validation knobs, peer-cred implementation per platform, bypass-tag-by-transport rule, threat model (residual same-UID risk). TBD.
- **v0.4 client UX spec** — desktop tech choice (Tauri vs Electron-port), web SPA shape, iOS distribution, multi-client write UX (presence vs lock vs naked LWW). TBD.
- **v0.3 reconciliation** — see Task #88 output for how the v0.3 supervisor / PTY / packaging fragments map onto this baseline (supervisor stays as v0.3 envelope; PTY snapshot+delta + fan-out registry generalize from N=1 to N≥3; envelope hardening retires from data plane).
