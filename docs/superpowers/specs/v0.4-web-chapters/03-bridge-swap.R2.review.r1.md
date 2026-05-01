# Review of chapter 03: Bridge swap

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): Connect transport in preload widens renderer attack surface — `net.Socket` access path needs CSP/sandboxing review
**Where**: chapter 03 §3, "Where it lives: `electron/connect/ipc-transport.ts` ... Imported by the preload script ... exposed through `window.ccsmTransport.create()` consumed by the bridges."
**Issue**: The text says "the renderer-process bridges hold the Connect client; transport lives in preload to keep `net.Socket` access out of renderer code (CSP-friendly)." But the structure described — preload exposes `window.ccsmTransport.create()` returning a transport object that the renderer-side bridges then *call methods on* — risks leaking a Node-backed object across the contextBridge boundary in a way that gives renderer code an indirect handle to socket internals. The Electron `contextBridge` only deep-clones plain values; complex objects with methods that close over `net.Socket` references can leak prototype access if not wrapped carefully.

Additionally, the Connect-Node transport in preload performs HTTP/2 framing, which means malformed responses from the daemon (or a man-in-the-middle on the local socket if chmod 0700 / ACL is bypassed somehow) reach a Node parser running in preload context with full Node privileges. A parser bug → preload code-exec → bypass of the renderer's contextIsolation.

**Why this is P1**: Electron's security model relies on `contextIsolation: true` + minimal preload surface. Connect-Node-in-preload is a substantial new attack surface (HTTP/2 frame parser, Connect interceptors, jose if it ends up there) running with Node privileges that a successful parser exploit converts directly into RCE in the user's session.
**Suggested fix**: Add a §3.X subsection specifying:
1. `window.ccsmTransport.create()` returns ONLY a thin proxy with primitive method signatures (no exposed properties referencing `net.Socket`, `Http2Session`, etc.).
2. All Connect interceptor logic + transport setup runs ENTIRELY in preload; renderer never sees Connect-internal objects.
3. The preload-exposed proxy methods accept/return only structured-cloneable values (request payloads as `Uint8Array` or plain objects; response payloads same).
4. Audit checkpoint: M1 deliverable includes a security review of `electron/connect/ipc-transport.ts` confirming no Node prototype/handle leaks via `contextBridge`.
5. Reference Electron's "exposeInMainWorld safe patterns" doc explicitly.

### P2-1 (nice-to-have): No size cap on PTY input from web client → input-flood DoS
**Where**: chapter 03 §1 (`pty:input` is a write RPC moving to Connect), chapter 06 §3 (PTY input model)
**Issue**: `SendPtyInput { string session_id, bytes data }` has no documented max size on `data`. Chapter 06 §3 mentions "bridge queues max 256 KiB" as a *client-side* cap, but a remote web client (or a malicious actor with a valid JWT, e.g. credentials phished) could send unbounded `data` bytes per RPC, filling daemon memory or PTY input queue. The 16 MiB HTTP/2 frame cap (chapter 02 §8) is the only ceiling.
**Why this is P2**: Single-user model (chapter 01 N2) means the only attacker with a valid JWT is the user themselves OR someone who phished the user's GitHub. Lower likelihood than the JWT or bridge surface issues. Worth a cap nonetheless.
**Suggested fix**: Add to `pty.proto` validation: server-side reject `SendPtyInputRequest.data.length > 64 KiB` with `invalid_argument`. Document in chapter 03 §6 or chapter 07 §1.

## Cross-file findings

The preload-Node-surface concern (P1-1) intersects with chapter 04 §1's `web/src/transport.ts` — the web flavor runs in pure browser context (no Node), so the threat profile differs. Chapter 03's preload transport is the higher-risk path.
