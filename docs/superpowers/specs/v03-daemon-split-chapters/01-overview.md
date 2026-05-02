# 01 — Overview

This chapter states the v0.3 mission in one place: split the existing single-process Electron app into two locally cohabiting binaries (`ccsm-daemon` + `ccsm-electron`) that communicate via Connect-RPC over a loopback transport, while structuring every artifact (proto, principal model, listener trait, installer, monorepo layout) so that v0.4 — which adds web client, iOS client, Cloudflare Tunnel, cloudflared sidecar, and CF Access JWT validation — is a **purely additive** change. v0.3 ships exactly the local-machine subset of the diagram in `00-brief.md`, minus cloudflared and minus runtime Listener B.

### 1. Goals (v0.3)

1. **Process split**: convert the existing Electron app into two binaries; daemon owns all state (sessions, PTY, SQLite, cwd, crash log); Electron is a thin Connect client.
2. **Single transport**: every Electron → daemon call uses Connect-RPC over Listener A; **zero** `ipcMain` / `contextBridge` / `ipcRenderer` survives in `packages/electron/src` (brief §11(a)).
3. **System service**: daemon installs as a per-OS system service (Win Service / launchd LaunchDaemon / systemd system unit), starts on boot, survives Electron exit (brief §7).
4. **Frozen wire schema**: every RPC and message v0.3 ships is forever-stable; v0.4 may only add (brief §6).
5. **PTY zero-loss reconnect**: 1-hour live `claude` workload survives Electron SIGKILL + relaunch with binary-identical terminal state (brief §11(c)).
6. **Clean installer round-trip**: fresh Win 11 25H2 VM install → register → run → uninstall → no residue (brief §11(d)).
7. **Crash collector local-only**: capture daemon faults to SQLite, expose via `GetCrashLog` RPC, render in Settings UI (brief §10).

### 2. Non-goals (v0.3, deferred to v0.4)

| Non-goal | Why deferred | Where it lands |
| --- | --- | --- |
| Web client | additive package + same proto | v0.4 `packages/web` |
| iOS client | additive package + same proto | v0.4 `packages/ios` |
| Cloudflare Tunnel + cloudflared sidecar lifecycle | requires Listener B JWT path; v0.3 ships Listener B as stub slot only | v0.4 daemon: instantiate Listener B from existing trait |
| CF Access JWT validation middleware | code path not loaded in v0.3 | v0.4: add `JwtValidator` middleware to Listener B factory |
| GitHub OAuth IdP integration | identity is federated through CF Access; nothing to do locally in v0.3 | v0.4: cloudflared-side config |
| Crash log network upload | local-only crash storage in v0.3 | v0.4: additive uploader reading existing SQLite log |
| Multi-principal sessions (anything other than `local-user`) | enforced via `owner_id` filter from day one; v0.3 only emits `local-user` | v0.4: emit `cf-access:<sub>` principals |

These are non-goals **inside v0.3 only** — they MUST be reachable from v0.3 by additive change alone (see [15-zero-rework-audit](./15-zero-rework-audit.md)).

### 3. Scope reduction from the diagram

The brief diagram contains the full v0.4+ topology. v0.3 ships exactly the boxes inside the `user's local machine` frame, with these subtractions:

- ❌ `cloudflared (sidecar)` box: not spawned, not packaged, not installed.
- ❌ `Listener B: 127.0.0.1:PORT_TUNNEL` runtime: socket not bound, JWT middleware not wired, config not exposed in UI.
- ❌ Web client / iOS client / GitHub OAuth IdP / Cloudflare Edge: all upstream of cloudflared, all out of scope.
- ✅ `Listener A: loopback / UDS (peer-cred, JWT bypass)`: shipped.
- ✅ `Supervisor UDS (control plane)`: shipped — `/healthz`, `hello`, `shutdown` RPCs.
- ✅ All daemon internals: Session manager, PTY host (`xterm-headless` snapshot+delta), `claude` CLI subprocess management, SQLite, cwd state, crash collector — shipped.
- ✅ Desktop client (Electron) hitting Listener A — shipped.
- ✅ **Listener trait/interface**: shipped. Listener B reserved as a stub slot in the listener array (no socket, no middleware, but the trait + the array shape exist) (brief §1).

### 4. Zero-rework rule (governance, not a feature)

v0.3 is the foundation v0.4 builds on. The rule, restated from `00-brief.md` §"ZERO-REWORK RULE":

> When v0.4 lands web client + iOS client + Cloudflare Tunnel + cloudflared sidecar + CF Access JWT validation on Listener B, what code/proto/schema/installer changes are required? **Acceptable answers: "none" / "purely additive". Unacceptable: "rename X" / "change message Y shape" / "move file Z" / "split function into two".**

Every chapter MUST close (or contribute to [15-zero-rework-audit](./15-zero-rework-audit.md)) by stating the v0.4 delta for each design decision in that chapter. Chapter 15 is the consolidated audit; reviewers MUST gate the entire spec on it.

### 5. Audience and reading order

This spec is written for: (a) reviewers who must catch zero-rework violations before any code is written; (b) implementers who will translate chapters into the parallel task DAG (stage 6); (c) future readers of the v0.4 spec who need to understand what is already locked.

Suggested order:
1. This chapter.
2. [02-process-topology](./02-process-topology.md) — what runs where.
3. [03-listeners-and-transport](./03-listeners-and-transport.md) — how they talk.
4. [04-proto-and-rpc-surface](./04-proto-and-rpc-surface.md) — what they say.
5. [05-session-and-principal](./05-session-and-principal.md) — who owns what.
6. [06-pty-snapshot-delta](./06-pty-snapshot-delta.md) — the hard part.
7. [07-data-and-state](./07-data-and-state.md) — where bytes live.
8. [08-electron-client-migration](./08-electron-client-migration.md) — the cutover.
9. [09-crash-collector](./09-crash-collector.md), [10-build-package-installer](./10-build-package-installer.md), [11-monorepo-layout](./11-monorepo-layout.md), [12-testing-strategy](./12-testing-strategy.md), [13-release-slicing](./13-release-slicing.md), [14-risks-and-spikes](./14-risks-and-spikes.md).
10. **[15-zero-rework-audit](./15-zero-rework-audit.md) — the gate.**

### 6. Glossary (used across chapters)

- **Daemon** = `ccsm-daemon`, the single-binary backend (Node 22 sea or pkg, native deps embedded).
- **Electron** = `ccsm-electron`, the thin desktop client (renderer + minimal main; no business logic).
- **Listener** = a daemon-side socket + transport + auth-middleware bundle; v0.3 instantiates Listener A only.
- **Listener A** = loopback/UDS socket, peer-cred authentication, JWT validation bypassed.
- **Listener B** = (reserved slot) 127.0.0.1:PORT_TUNNEL, CF Access JWT validation, cloudflared-only consumer; v0.3 stub, v0.4 instantiated.
- **Principal** = the entity an RPC call is attributed to. v0.3: always `local-user`. v0.4: `local-user` or `cf-access:<sub>`.
- **Session** = a long-lived terminal session bound to a principal (`owner_id`) and backed by a PTY + claude CLI subprocess.
- **Supervisor** = control-plane UDS exposing `/healthz`, `hello`, `shutdown`; separate from data-plane Listener A.
- **MUST-SPIKE** = a design decision that depends on platform/library behavior we have not yet validated; the spec lists hypothesis + validation + fallback for each.

### 7. v0.4 delta summary (preview of chapter 15)

Stated up front so reviewers can challenge the entire spec against this list:

- **Add** `packages/web` and `packages/ios` to the workspace; both consume the same generated proto client. **Daemon code: unchanged.**
- **Add** cloudflared sidecar lifecycle to daemon (spawn / supervise / config); Listener B socket bound; JWT middleware factory wired. **Listener trait + handler code: unchanged.**
- **Add** `cf-access:<sub>` principal derivation in the JWT middleware; principal flows through the same `ctx.principal` field every handler already reads. **Handler code: unchanged.**
- **Add** crash log uploader; reads existing SQLite table; new RPC for upload-status; capture path unchanged. **Crash schema: unchanged.**
- **Add** new RPCs in proto (e.g., `WebClientRegister`, `TunnelStatus`); existing RPCs and messages: forever-stable, no field renames, no semantic changes (brief §6).

If at any point during review a chapter's v0.4 delta requires changing one of the bullets above (rename, reshape, split), that chapter MUST be re-designed inside v0.3 before merge.
