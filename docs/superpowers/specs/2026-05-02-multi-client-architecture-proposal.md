# Multi-client architecture proposal

**Status:** proposal (pre-spec)
**Date:** 2026-05-02
**Author:** ccsm
**Supersedes (intent):** `2026-05-01-v0.4-web-design.md` (single-user, Electron-primary, web-as-secondary). This proposal reframes the same ingress story around a backend-authoritative, three-client topology.
**Hard inputs (locked by user, not negotiable in this doc):**

1. Backend is a standalone process and the **single source of truth** for sessions (PTY, claude CLI subprocess, SQLite, crash logging, cwd state).
2. Three first-class clients: **desktop** (Tauri or native; not necessarily Electron), **web browser**, **iOS app**. None is "primary".
3. Multiple clients may attach to the **same live session simultaneously**.
4. Backend may run on **localhost OR remote** (VPS / home NAS); clients reach it from anywhere on the internet.
5. Auth = **GitHub OAuth**. Same identity across all clients. No custom username/password.
6. Non-desktop traffic (web + iOS) **MUST traverse Cloudflare** (Tunnel or Workers). Desktop MAY bypass when on localhost / LAN.
7. PTY output is a **stream**, not request/response.

This doc picks one design per axis, names what currently-shipping code stays, names what gets thrown out, and lists the open questions the user has to answer before this becomes a spec.

---

## A. Transport selection

**Recommendation: Connect-RPC over HTTP/2 (with HTTP/1.1 fallback for browser long-poll), Protobuf v3 wire format, server-streams for PTY output.**

This is exactly what `2026-05-01-v0.4-web-design.md` §2 already locked for the data plane. It survives every constraint above with no rewrite:

- **Browser:** `@connectrpc/connect-web` runs in any modern browser without an Envoy proxy; speaks plain HTTPS that Cloudflare Tunnel passes through unchanged. Server-stream RPC (the one shape PTY needs) works half-duplex over fetch streaming, which is what every browser actually ships.
- **iOS:** `connect-swift` (Buf, Apache-2.0) generates a native Swift client from the same `proto/` schema. Uses URLSession; no custom TLS code. Same `proto/` source = same RPC surface as web and desktop, no parallel maintenance.
- **Desktop (Tauri / native / Electron):** `connect-go` / `connect-node` / `connect-kotlin` all exist. Tauri Rust side gets Connect-Go-class code via `prost` + a thin Rust Connect runtime, or it speaks the same `connect-web` HTTP shape since Tauri renderers are real WebViews.
- **Streaming semantics:** Connect server-streams are first-class. PTY output (the only true stream we have today) maps 1:1 to a single `subscribePty` server-stream RPC. Client→server keystrokes are unary RPCs (one per batch); we do not need bidi.
- **Cloudflare Tunnel compatibility:** Tunnel proxies plain HTTPS / HTTP/2. Connect's `application/proto` and `application/json` content-types pass through verbatim — confirmed by the v0.4 spike (v0.4 §5).
- **Auth header model:** Cloudflare Access injects `Cf-Access-Jwt-Assertion` on every request; Connect interceptors read headers natively per RPC. No protocol gymnastics.
- **Debuggability:** the JSON content-type variant (`application/json`) makes every Connect RPC `curl`-able from a terminal with no codegen. The hand-rolled v0.3 envelope is not.

**Rejected alternatives** (one-line each):

- **Plain HTTP/2 + WebSocket (no schema):** punts the v0.3 problem (no codegen, no breaking-change gate, no shared schema across 3 clients) into v0.5 again. Rejected.
- **gRPC-Web:** requires a translating proxy (Envoy or equivalent); Cloudflare Tunnel is not one. Rejected.
- **Plain gRPC:** browsers can't speak it without a proxy. Rejected for the same reason.
- **tRPC:** TypeScript-only — kills iOS and any future native client. Rejected.
- **GraphQL subscriptions:** wrong shape for raw byte streams (PTY output is bytes, not a typed event stream); WebSocket transport adds a second protocol surface. Rejected.
- **Custom JSON-WebSocket envelope (current v0.3 + a WebSocket lift):** works but reinvents wire-versioning, breaking-change gating, and per-language codegen by hand for every new client. We would re-derive `buf breaking` ourselves. Rejected.

---

## B. Auth model

**Recommendation: Cloudflare Access (GitHub OAuth IdP) for all *remote* ingress. Same per-app `AUD` JWT validated by the backend on every remote request. Desktop on localhost bypasses the JWT check via a peer-cred / loopback-trust tag (same shape as v0.3 §3.1.1 + v0.4 §5 `localTransportKey`). No backend-issued tokens.**

This is the cheapest design that satisfies constraints 5 + 6:

- **All three clients sign in to the same GitHub account through Cloudflare Access**, which is the `email == <user-github-email>` policy already specified in v0.4 §5. Identity is identical across clients because the IdP is identical. Backend never stores a user database.
- **Per-client OAuth flow** — each client uses the platform-native browser hand-off, not its own embedded login UI:
  - **Desktop (Tauri / Electron):** `ASWebAuthenticationSession`-equivalent. On macOS / Windows / Linux this is "open the OS default browser, intercept the redirect via a registered `ccsm://` scheme handler or a localhost loopback `http://127.0.0.1:<random>/callback`". **PKCE** authorization-code flow (NOT device flow). Device flow is for headless clients and gives a worse UX (paste-the-code-into-a-browser) for an app that owns a window.
  - **Web:** standard OAuth 2.0 redirect. Cloudflare Access does the entire flow before the SPA bytes are even served — the SPA only ever sees an authenticated request.
  - **iOS:** `ASWebAuthenticationSession` (Apple's native API, gives the app a Safari-shared cookie jar so the user is single-sign-on'd if they've authenticated to GitHub on Safari recently).
- **Where tokens live:**
  - Desktop: OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux).
  - iOS: iOS Keychain.
  - Web: `Cf-Access-Jwt-Assertion` cookie set by Cloudflare Access; SPA never touches the JWT directly.
- **Backend validation:** verify the **Cloudflare Access JWT** (RS256, per-app AUD, team issuer) on every remote request, exactly per v0.4 §8.1. No JWT exchange, no backend-issued JWT, no refresh-token plumbing on our side — Cloudflare Access owns the entire token lifecycle (refresh, revoke, expiry). The backend's job is "verify and trust".
- **Localhost desktop bypass:** the local socket / loopback HTTP listener tags the connection with `localTransportKey: true` (per v0.4 §5 wording); the JWT-validation interceptor is a no-op on locally-tagged requests. This is the same bypass trick the v0.4 doc already wrote and the test plan already covers (v0.4 §8.1).
- **Session model on the backend:** the backend treats every authenticated request as "the one user". Multi-tenant is explicitly out of scope (constraint 5 = "same identity across all clients", not "support N users"). Re-introducing a real user table is a v0.6+ conversation.

**Rejected alternatives** (one-line each):

- **Build our own OAuth + session JWT issuer:** explicitly forbidden by constraint 5. Rejected.
- **Verify GitHub access tokens directly via GitHub's `/user` API:** N+1 GitHub API call per RPC, rate-limited, slow. Cloudflare Access already did this and gave us a JWT — using it is free. Rejected.
- **Issue our own short-lived JWT after verifying the CF Access JWT once:** adds a second token lifecycle (refresh, revoke) we'd have to maintain; gives no security or perf win that justifies the surface. Rejected.
- **Device flow on desktop:** clunky UX (browser tab + paste 8-char code) for a windowed app. PKCE is strictly nicer. Rejected.

---

## C. Session model

**Recommendation: backend-authoritative session list; clients are pure subscribers. New client mid-session catches up via (snapshot + delta-from-seq) — already what v0.3 PTY hardening shipped. Writes from N clients are broadcast-all + last-writer-wins at the PTY layer (no locks, no "primary client").**

The v0.3 PTY-hardening fragment (`frag-3.5.1`) and envelope-hardening fragment (`frag-3.4.1` §3.4.1.b) already specified the catch-up shape; this proposal just confirms it generalizes from "1 client at a time" to "N clients at a time".

- **Snapshot + delta** (already shipped in v0.3): `subscribePty` opens with `fromSeq` / `fromBootNonce` headers. Daemon ships the bounded snapshot (`xterm-headless` rendered buffer, capped at the existing scrollback), then live deltas with monotonic `seq`. Reconnect within the replay budget (256 KiB per v0.3 §3.4.1.b) replays only the gap; reconnect outside the budget gets a fresh snapshot with `gap: true`.
- **Bounded scrollback:** the existing `xterm-headless` ring buffer is the bound. We do NOT keep "full session history" in RAM for replay. Persistence to SQLite for long-tail history is a separate v0.6+ feature, not in scope here.
- **Write arbitration — broadcast all, last-writer-wins at the PTY:** every client's keystroke RPC (`ptyWrite`) writes to the PTY in arrival order at the daemon. The PTY itself is the serialization point — there is no "active client" lock. If two clients type at once, the bytes interleave at byte-granularity exactly the way two `cat` processes writing to the same tty would. This is correct because:
  1. PTYs are inherently byte-streams; trying to add line-level locking is the wrong layer.
  2. The two-typist case is rare in practice (you're collaborating with yourself across devices, not contending).
  3. Every client sees its own + the other's keystrokes echoed back through the same `subscribePty` stream, so divergence is impossible — the server's PTY is the single source of truth.
- **Per-client cursor / scroll position:** that lives **client-side**, not on the backend. The backend ships the buffer; the client decides what window of it to render.
- **Subscriber registry:** the v0.3 fan-out registry (`frag-3.5.1` §3.5.1.5) already supports N subscribers per session with the drop-slowest watermark at 1 MiB. The "single subscriber" assumption was a temporary perf carve-out, not a fundamental limit; we lift it for v0.4.

**Rejected alternatives** (one-line each):

- **Active-client lock with explicit handoff:** UX nightmare ("device A: do you want to give control to device B?"); breaks the "leave it running and pick up anywhere" use case. Rejected.
- **CRDT / OT for keystrokes:** PTY is not a text editor; the OS kernel resolves byte ordering for us. Rejected.
- **Full session replay from disk:** the existing scrollback bound is enough for "I closed my laptop and came back". Long-tail history is a separate feature. Rejected.

---

## D. Deployment topology

**Recommendation: single backend binary listening on two endpoints — (1) localhost loopback HTTP/2 (peer-cred / loopback-trust tagged, JWT bypass), (2) `cloudflared` tunnel sidecar pointing at the same loopback port. NO separate edge gateway in our stack; Cloudflare IS the edge. Desktop on the same machine hits endpoint (1); desktop on another machine + web + iOS all hit endpoint (2).**

- **Single backend binary:** the daemon already exists (`daemon/src/index.ts`). The only addition is replacing the v0.3 control-plane / data-plane split-socket model with a Connect HTTP/2 listener (control-plane stays on its own listener for supervisor isolation per v0.3 §3.4.1.h — that's not changing). Same binary, two listeners, no microservice split.
- **`cloudflared` as a sidecar process** spawned and lifecycled by the backend (this matches v0.4 §5's "Tunnel spawned by daemon when remote access is enabled"). User flips a single setting → backend spawns `cloudflared`, registers the tunnel, advertises the public URL via the tray UI. No CF Workers in front of the tunnel; Workers add a second deploy target (with its own routing config drift) for zero benefit when Tunnel already terminates TLS for us.
- **Cloudflare Access in front of the tunnel** — zero-trust application configured to require GitHub OAuth, per-app AUD. This is the auth boundary. The backend does not implement OAuth itself.
- **Desktop bypass path:** desktop running on the same machine as the backend hits `http://127.0.0.1:<port>` directly. Same Connect protocol, same RPC surface, same proto-generated client code — only the URL and the `localTransportKey` middleware tag differ. Desktop on a *different* machine (e.g. Tauri client on the laptop, backend on the home NAS) goes through Cloudflare exactly like web and iOS — there is no third path. This matches constraint 6 ("Desktop MAY bypass when on localhost"; on remote it just doesn't bypass).
- **Discovery for desktop:** desktop client first tries `http://127.0.0.1:<known-port>` with a 200ms timeout; on failure, falls back to the user-configured remote URL. This makes "moved my laptop off the home network" automatic.

**Rejected alternatives** (one-line each):

- **Separate edge-gateway service we operate:** doubles deploy surface, gives us a routing-config target that can drift from the backend. Cloudflare Tunnel + Access already does this for free. Rejected.
- **Cloudflare Workers in front of Tunnel:** adds a third deploy target (`wrangler.toml`, separate codepath) for zero benefit on the streaming RPC path. Workers shine when you want edge compute; we want pass-through. Rejected.
- **Backend listens directly on a public port (no Cloudflare):** loses the auth layer (we said no custom auth), exposes the user's home IP, requires user to deal with NAT / firewall / TLS cert renewal. Rejected — explicitly violates constraint 6.
- **Per-client backend instance (one daemon per client):** breaks constraint 1 (single source of truth). Rejected.

---

## E. Delta vs current v0.3

This proposal is intentionally a **transport + ingress** change. The session model, PTY hardening, crash observability, and SQLite layer are correct as v0.3 shipped them. The throw-away surface is the transport bytes.

**Survives unchanged:**

- PTY hardening (`frag-3.5.1`): xterm-headless buffer, snapshot + delta, fan-out registry with drop-slowest watermark, server-side dead-stream detector. ~all of `daemon/src/pty/` (when it lands; not yet on `working` per `daemon/src/index.ts:96` "wires are still landing"). **Becomes the streaming spine of every client.**
- Crash observability (`daemon/src/crash/`, `daemon/src/sentry/`): Phase 1-4 all survive — they are about the daemon process, not the wire. ~600 LOC, no churn.
- SQLite schema + migration (`frag-8`): backend-local, no client-visible change. **No churn.**
- Daemon supervisor process model: spawn-or-attach, lockfile, crash-loop detection, `pino-roll` rotation, `daemon.shutdownForUpgrade` marker, dual-socket isolation at the OS level. **No churn** — these are about owning the backend process, not about how clients reach it. (The split between supervisor-control-plane and data-plane sockets becomes "supervisor still on local UDS, data-plane on Connect HTTP/2"; same architectural shape.)
- Cwd state, session lifecycle FSM, claude CLI subprocess management, env subset propagation. All backend-internal.

**Thrown out:**

- **Length-prefixed JSON envelope** (`daemon/src/envelope/envelope.ts`, ~200 LOC): replaced by Connect's HTTP/2 framing. Connect inherits the 16 MiB cap natively (`readMaxBytes`).
- **Hello-HMAC handshake** (`daemon/src/envelope/hello-interceptor.ts` + `hmac.ts` + `chunk-reassembly.ts` + `boot-nonce-precedence.ts` + `protocol-version.ts` + `trace-id-map.ts`): replaced by Cloudflare Access JWT (remote) + peer-cred / loopback-tag (local). The HMAC was a same-machine secret-possession check; with peer-cred + DACL the secret is redundant on the local socket, and on the remote socket Cloudflare Access is doing strictly more than the HMAC ever did. ~420 LOC + helpers ~250 LOC = **~670 LOC removed from the data plane**. (`hello-interceptor` survives on the supervisor control plane unchanged — control plane is local-only and keeps the v0.3 envelope per v0.4 §2.6 reasoning.)
- **Manual chunking / binary-trailer carve-out** (`frag-3.4.1` §3.4.1.b/c, ~30 LOC in `connectAdapter.ts` + symmetric reader): replaced by Connect's native HTTP/2 frame management + `bytes` field type for PTY payloads. Wire-level chunking semantics preserved; we delete our hand-rolled version.
- **`unix socket / named pipe` as the data-plane transport:** stays for the supervisor / control plane; the data plane moves to loopback HTTP/2 + remote HTTP/2-via-Tunnel. The OS-level peer-cred check generalizes to "is the socket bound to 127.0.0.1?" for the loopback HTTP path, a one-line check.
- **Migration-gate interceptor as a v0.3-envelope-specific concern:** survives semantically (the rule "data-plane RPCs are 503 during migration, control-plane is not" still applies) but the implementation moves to a Connect interceptor.
- **Deadline interceptor:** survives semantically; ~30 LOC reimplemented as a Connect interceptor.
- **Trace-id map / chunk-reassembly state machines:** Connect handles this natively via HTTP/2 stream id + Connect's per-call header carriage. Throw out.

**Rough LOC throw-away (data plane only):** ~900-1100 LOC of envelope + hello + adapter + chunk-reassembly + handler-wrapping. Roughly tracks the v0.4 §2 estimate of "the entire `daemon/src/envelope/` directory disappears from the data-plane fast path" — proposal extends that decision to also delete the v0.4 doc's Electron-vs-web differential, since *all three* clients now speak the same Connect surface.

**`electron/daemonClient/` (`controlClient.ts`, `rpcClient.ts`, `envelope.ts`, `streamHandleTable.ts`):** envelope.ts + streamHandleTable.ts → throw out (~400 LOC). controlClient.ts stays (talks to the supervisor plane which keeps the v0.3 envelope). rpcClient.ts gets ported to the proto-generated Connect client (~150 LOC of mechanics → ~50 LOC because Connect-Node provides the call mechanics).

---

## F. Migration path

**Recommendation: ship in a single coherent slice as v0.4 (renamed to v1.0 if the user prefers a major-bump signal). Subset shipping is technically possible but yields a worse outcome per axis — see below.**

Why one slice:

- **Connect data plane + Cloudflare Access JWT + multi-client coherence are the same change from the backend's POV.** All three flow through the same RPC surface — splitting them means writing two transport adapters (envelope + Connect) and maintaining both, which is exactly the trap v0.4's anti-goal A1 was warning against.
- **iOS slips one slice OK** because it's purely a new client against an unchanged backend. Recommendation: backend + desktop port + web client lands in one slice (call it v0.4); iOS native app follows in v0.4.1 / v0.5 with **zero backend churn** because the proto schema is already final.

**If the user insists on subset:**

- **Smallest viable subset = "v0.4 desktop-only over Connect, GitHub OAuth deferred":** desktop on Connect + localhost loopback only, no Cloudflare, no web, no iOS. **Rejected as a recommendation** because (a) the per-client OAuth flow is the riskiest piece of the design and deferring it just defers the risk; (b) "desktop-only over Connect" is identical to v0.4 §3 bridge-swap which the user already has a draft of; this proposal would add zero value.
- **Recommended subset (if you must):** v0.4 = backend Connect data plane + desktop port + web client + Cloudflare Access. v0.4.1 = iOS native client. This puts the high-risk auth flow in v0.4 (caught by 2 dogfood clients), and adds iOS only after the wire is proven on web.

**Hard sequencing constraints inside the slice:**

1. `proto/` schema first (must be complete before any client can codegen).
2. Backend Connect server next (`@connectrpc/connect-node` mounted on loopback HTTP/2; v0.3 envelope removed from data plane; supervisor envelope untouched).
3. Desktop client port (proto-generated Connect-Node client replaces `electron/daemonClient/rpcClient.ts`).
4. **Cloudflare Tunnel + Access wiring** (cloudflared sidecar; backend JWT interceptor; localhost bypass tag).
5. Web client (Vite SPA against the same Connect surface).
6. iOS client (Connect-Swift; same proto).

Steps 1-3 are mandatory together (you can't ship the backend without a client to test it). Steps 4-6 can each land in their own PR once 1-3 are green. Step 6 may slip to a follow-up release without holding 1-5.

---

## G. Open questions for user

These are the specific bits this proposal could not decide. Each is a fork in the architecture; the user has to pick before this becomes a real spec.

1. **What's the desktop tech?** Tauri (Rust) vs Electron (TypeScript) vs SwiftUI-on-mac+WPF-on-win (native per OS). Each has different `proto/` codegen story, different OAuth-flow primitives, and very different reuse with the existing `electron/` tree. **Tauri is the highest-leverage answer if you're willing to write Rust**; Electron is the lowest-risk because the existing renderer code ships unchanged.

2. **Backend deploy target on remote:** Linux daemon binary on a VPS / NAS, or a containerized deployment, or a Mac mini at home running it natively? This decides the supervisor layer (systemd unit vs launchd plist vs Docker `restart: always` vs Windows Service). The v0.3 supervisor model assumes "Electron parent owns the daemon" — that breaks when the daemon runs without an Electron alongside it.

3. **iOS app distribution:** App Store (requires Apple Developer account, review, no sideload), TestFlight (90-day timer, public beta cap of 10k), or self-signed sideload only (works on personal device, fragile)? This decides whether iOS work is on the v0.4 critical path or a long-tail follow-up.

4. **Multi-client write semantics — really last-writer-wins?** Per §C above the recommendation is "PTY is the serialization point, byte interleave is fine". But the user might want a softer answer — e.g. "show me when another client is typing" (presence indicator), or "lock the PTY to one client at a time but make handoff one-tap". Either is implementable; both add UI surface this proposal didn't budget.

5. **Do we keep Electron alongside the new desktop client during transition,** or hard-cut? If hard-cut, the current `electron/` tree is ~14 weeks of v0.3 work that goes away in one release. If keep-alongside, we maintain two desktop clients for 2-3 releases. This is a question about user appetite for risk + how much of the existing renderer code is reusable in the new desktop choice.

6. **Cloudflare account ownership:** is this a single CF account the user owns (matches v0.4 design's single-tenant assumption), or do we anticipate friends-of-friends self-deploying their own backend + their own Cloudflare account? The latter requires us to ship a setup wizard ("paste your Cloudflare API token here") which is non-trivial UX. The former assumes the user is the only deployer ever.

7. **PTY scrollback persistence:** v0.3 keeps scrollback in RAM only (xterm-headless ring buffer). With multiple clients over high-latency links, a client that disconnects for an hour can't replay an hour of output — it only gets a fresh snapshot (current screen) on reconnect. Is that acceptable, or do we need to spill scrollback to SQLite for long-replay? This decides whether SQLite gains a `pty_scrollback` table with retention policy in v0.4 or stays as today.

---

## Pushback / contradictions found

None of the seven hard constraints are internally contradictory. The proposal above satisfies all seven without compromise. The only soft tension is constraint 2 ("no primary client") vs the practical reality that the **existing** codebase has Electron deeply wired in (`electron/` tree + 46 IPC bridges + renderer assumptions). Cleanly satisfying constraint 2 requires either (a) treating the existing Electron client as one of the three first-class clients (port it forward, keep it), or (b) hard-cutting it. Question G5 surfaces this for the user.

There's also a soft tension between constraint 4 (backend may run remote) and v0.3's `daemonSupervisor` model (Electron-main owns the daemon process lifecycle). If the daemon runs on a VPS without an Electron alongside it, the supervisor code path needs a "headless mode" — systemd / launchd / Docker takes the supervisor's job. The v0.3 design doc explicitly punted this in v0.4 §1 N5 ("Headless daemon with no Electron — Why deferred"). Question G2 surfaces this for the user.
