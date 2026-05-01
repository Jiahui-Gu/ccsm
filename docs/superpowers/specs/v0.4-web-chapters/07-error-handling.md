# 07 — Error handling and edge cases

## Context block

v0.3 already covered the bulk of "daemon split" failure modes (daemon crash → respawn, SQLite locked → serialize writes, updater swap on Win → batch script). v0.4 adds three new failure surfaces: **(1)** Cloudflare layer failures (Tunnel down, Access misconfigured, JWT stale), **(2)** wire-protocol version skew between Electron + daemon during the bridge swap and afterward, **(3)** concurrent edits between desktop and web on the same session. This chapter covers all three plus carryover failures that change behavior under v0.4's Connect transport.

## TOC

- 1. Daemon-side failures (carryover + new)
- 2. Cloudflare layer failures
- 3. Network failures (web client specific)
- 4. JWT lifecycle (stale mid-session, rotated keys)
- 5. Wire-protocol version skew
- 6. Concurrent multi-client semantics
- 7. Web build failures (Pages deploy)
- 8. Catastrophic failures (last-resort recovery)

## 1. Daemon-side failures

### Daemon crash (carryover from v0.3, behavior unchanged)

- Electron client: detect via control-socket `/healthz` poll; supervisor respawns daemon; renderer's `useDaemonHealthBridge` shows `daemon.unreachable` banner during the gap. Behavior unchanged.
- Web client: Connect transport sees stream RST or `unavailable`; UI shows `daemon.unreachable` banner with "Retry" button; auto-retry every 5-30s exp backoff (chapter 04 §6).
- **New in v0.4:** if daemon respawns with a new `boot_nonce`, both clients on next reconnect get a fresh PTY snapshot (chapter 06 §6) rather than a seq replay. No data loss; possibly a brief screen flicker as the buffer is re-rendered.

### SQLite locked (carryover, behavior unchanged)

Daemon serializes all writes via `better-sqlite3` synchronous API. Long-running migrations block writes; v0.3 §6 migration-gate interceptor still applies on the data-socket — it MUST be re-implemented as a Connect interceptor (chapter 02 §8).

### Daemon hangs (process alive, RPCs not progressing)

- Connect deadline header (`x-ccsm-deadline-ms`, carryover from v0.3) caps every unary RPC at 30s default, 120s clamp.
- Streams have no deadline; they rely on heartbeat (chapter 06 §4) for liveness.
- If the daemon stops processing but stays alive, deadlines fire on unary RPCs and surface as `deadline_exceeded` Connect errors. Bridge wraps as `BridgeTimeoutError` (existing v0.3 §3.7.5 type). Three+ in 10s triggers a "daemon stuck" diagnostic toast (existing v0.3 surface).

### Daemon disk full (new edge case worth calling out)

- SQLite write fails with `SQLITE_FULL`. Daemon's existing storage-full handler (v0.3 frag-8) surfaces a `storage.full` banner. v0.4: same banner reaches both Electron and web (it's in the renderer; both clients render it).

## 2. Cloudflare layer failures

### `cloudflared` process crashes

- Daemon supervises (chapter 05 §1): exponential restart, capped at 60s, 10 attempts in 30 minutes, then surface `cloudflare.unreachable` banner.
- During the outage: web client sees the Pages SPA loaded (cached in browser) with `daemon.unreachable` banner (it can't reach the tunnel). Local Electron is unaffected.
- Recovery: when `cloudflared` reconnects, the tunnel hostname routes again; web client's auto-retry catches the next interval.

### Cloudflare Access misconfigured (e.g. wrong AUD claim)

- Daemon's JWT interceptor rejects with `unauthenticated`. Web client sees auth error → redirects to Access flow → Cloudflare returns the user to the SPA → SPA reloads, retries, gets the same JWT → still `unauthenticated`. Loop.
- **Mitigation:** daemon logs `pino.warn({ aud: actual, expected, traceId }, 'jwt_aud_mismatch')` once per minute (rate-limited). User checks daemon log, fixes Access app config in Cloudflare dashboard, re-runs setup wizard step 2.
- **Why not a UI surface:** the misconfiguration is a Cloudflare-account-level error the daemon can't fix. Logging is the right escalation; the alternative (silent loop) is worse.

### Cloudflare Pages deploy fails

- The web SPA bundle never reaches Pages. Users on `app.<domain>` see the **previous** deploy (Pages keeps the previous successful deploy live; failed deploys don't replace it). No user impact for existing users.
- New users hitting a fresh deployment that failed: see Cloudflare Pages's "site not found" page. Edge case (this is the very first deploy).
- **Mitigation:** GitHub Actions can mirror a `wrangler pages deploy` and surface failure on the PR. Lock-in for v0.4: no, rely on Cloudflare's GitHub integration's PR-status reporting.

### Cloudflare zone-wide outage

- Cloudflare edge unavailable → both Tunnel and Pages affected.
- Web client: navigation to `app.<domain>` fails at TCP connect. Browser shows generic network error. SPA never loads.
- Local Electron: unaffected (local socket).
- **Mitigation:** none in-app. Document as known limitation in user-facing README ("requires Cloudflare for remote access").

## 3. Network failures (web client specific)

### Initial page load fails

- Browser shows network error. SPA never loads. User retries page load.
- No app-level mitigation. Could ship a static "still working on it" SSL-error page later — out of scope for v0.4.

### SPA loads but daemon unreachable

- Connect transport's first RPC fails. `useDaemonHealthBridge` flips to `unreachable`. SPA shows skeleton + banner (chapter 04 §6).
- Auto-retry: 1s → 2s → 5s → 15s → 30s exp backoff, indefinite. Per-RPC failures don't increment counter; only the bridge-level health probe does.

### Network drop mid-session (long PTY stream open)

- Stream iterator throws. Bridge's stream consumer catches.
- Reconnect attempt with `fromSeq = lastSeenSeq + 1` per chapter 06 §6.
- If reconnect succeeds within ~30 minutes: replay or re-snapshot, continue. Seamless.
- If reconnect succeeds after >30 minutes: fanout buffer at the daemon may have rolled past `fromSeq`. Force re-snapshot. User sees current state; lost-output is in the original PTY's history (visible in scrollback as part of the snapshot — xterm-headless preserves scrollback up to the configured limit, default 10k lines).
- If session was killed during the drop: snapshot includes the exit message; UI marks session as exited.

### Browser tab backgrounded for >100s

- Tab suspends or throttles event loop.
- HTTP/2 stream may or may not be killed by Cloudflare (heartbeats from daemon keep edge happy, but the browser may ignore them if throttled).
- On tab refocus: if stream is alive, normal resume. If not, reconnect with `fromSeq`. User probably sees a brief skeleton flicker.

### Bandwidth-constrained network (slow mobile data)

- HTTP/2 flow control + drop-slowest (chapter 06 §7) applies. Daemon drops events; client gets `gap=true`; re-snapshot on next event.
- User experience: PTY output may "skip ahead" rather than scroll continuously. Acceptable for monitoring; less ideal for active typing.
- **Not in scope:** adaptive quality (e.g. ASCII-only fallback). Future work.

## 4. JWT lifecycle

### JWT expires mid-session

- 24h Access session (chapter 05 §3). User has tab open >24h.
- Next RPC the SPA makes returns `unauthenticated`.
- SPA's transport interceptor catches this code, redirects browser to `https://<tunnel-hostname>/cdn-cgi/access/login/<aud>` (Cloudflare Access endpoint).
- Cloudflare Access checks IdP session; if still valid (GitHub session lasts longer), re-issues JWT, redirects browser back to SPA.
- SPA reloads; transport reconnects; PTY stream resumes via `fromSeq`.
- **User experience:** brief redirect-spinner, then back to the same view. Should take <2s on a fresh GitHub session.

### JWT JWKS rotation

- Cloudflare rotates signing keys ~yearly. New JWTs use new key.
- Daemon's `createRemoteJWKSet` (jose lib) auto-refetches JWKS on signature-mismatch; subsequent validations succeed.
- 30s cooldown means at most one re-fetch per 30s if many requests hit the rotation moment. Negligible.

### Cloudflare Access policy change (user removed from allowlist)

- Next JWT issuance fails (Access blocks at IdP step). User sees Cloudflare's "you don't have access" page.
- For a session already authenticated: existing 24h JWT still validates at the daemon until expiry. After expiry: the redirect to `/cdn-cgi/access/login` returns the "no access" page.
- This is intended behavior — denying access to a removed user IS the feature.

### JWT replay (attacker steals JWT cookie)

- Mitigations: HTTPS-only cookie, `Secure` + `HttpOnly` + `SameSite=Lax` flags (Cloudflare default).
- Daemon doesn't track JWT-by-JWT to prevent replay (no nonce store). Single-user model: even if replayed, the only authorized user IS the attacker's-target. Multi-user (N2) would need a nonce/jti store.
- If user suspects compromise: revoke the GitHub OAuth grant in GitHub settings; rotate Access app config in Cloudflare; revoke all sessions in Cloudflare Zero Trust dashboard.

## 5. Wire-protocol version skew

### Electron v0.3.x against daemon v0.4.0

- v0.3.x Electron talks the hand-rolled envelope. v0.4 daemon's data socket talks Connect/HTTP/2.
- v0.3.x Electron sends a length-prefixed JSON envelope; v0.4 daemon's HTTP/2 listener sees garbage prefix and rejects.
- **Outcome:** Electron's bridge sees connection failure; surfaces `daemon.unreachable`.
- **Recovery:** the v0.4 installer ships matched Electron+daemon. User must run installer. Document the upgrade path: "v0.4 is a wire-protocol change; users on v0.3 must run the installer (auto-update will handle this if enabled)."

### Electron v0.4 against daemon v0.3.x

- Symmetric: v0.4 Electron sends Connect HTTP/2 PRI to v0.3 daemon's envelope listener. Envelope listener sees garbage, rejects.
- Same `daemon.unreachable` surface. Same recovery (user runs installer).
- **Why blocked rather than soft-fallback:** chapter 02 §7 — single installer for v0.4 ships matched versions. Soft fallback would require v0.4 Electron to detect the daemon version (chicken-and-egg: needs a version RPC the daemon would have to speak in both protocols) and dual-implement every bridge. Not worth the carrying cost.

### Web client v0.4 against daemon v0.5+

- Field-level back-compat: protobuf reserved tags + new fields with new tag numbers (chapter 02 §7).
- Old web tab from cached browser bundle: missing fields default to zero/empty; daemon handles gracefully. New web tab on next page load: fresh bundle from Pages, full schema.
- **Acceptable failure:** if v0.5 introduces a feature requiring new client behavior (e.g. a new event in `oneof`), the old web tab silently ignores the new event variant. The new feature is not visible until the user reloads. Tolerable.

### Backwards-incompatible proto change (would-be wire break)

- `buf breaking` CI check fails on the PR. PR cannot merge.
- If the change is genuinely needed: explicit version bump (e.g. `ccsm.v2`). v0.4 doesn't anticipate this and treats it as a follow-up release lifecycle event.

### Web client SPA + daemon out of sync (intra-day)

- User has SPA loaded at 9 AM; daemon updates to v0.4.1 at 10 AM with new RPC.
- SPA at 9 AM doesn't call the new RPC, so no impact.
- If v0.4.1 added a field to an existing message: SPA gracefully ignores. No impact.
- If v0.4.1 made a wire-breaking change: blocked by `buf breaking` from being merged in the first place.

## 6. Concurrent multi-client semantics

### Both clients type into the same session

- PTY input flows: each client sends `SendPtyInput` independently. Daemon receives in TCP-arrival order, writes to PTY input queue in arrival order, `node-pty` writes in queue order.
- **Result:** characters interleave at the byte boundary. Behavior matches "two people typing on the same shell"; not specifically a concurrency bug, but worth surfacing in docs.
- **Not mitigated:** no UI to "lock" a session to one client. Out of scope; user can simply not type from two devices.

### Client A killed while Client B has stream open

- Client A's stream closes (client-side disconnect). Daemon notices via HTTP/2 RST or stream end. Removes A from fanout.
- Client B's stream continues unchanged.
- Daemon's per-session state (PTY, buffer) is reference-counted by subscriber set; while B is attached, session lives. Last subscriber leaves → session is left running per v0.3 lifecycle (daemon owns sessions, not clients).

### Client B opens session that Client A is currently spawning

- Client A: `SpawnPty(...)` in flight, hasn't returned yet.
- Client B: `ListSessions()` won't see the new session until A's spawn completes (daemon registers session post-spawn).
- Client B: `StreamPty(<sessionId>)` for an unknown sessionId returns `not_found`; client B retries on its next list-poll.
- No corruption; just brief transient invisibility.

### Both clients rename the same session simultaneously

- Each `RenameSession(sessionId, title)` is unary and serialized at the daemon (per-sid serialization, v0.3 §sessionTitles). Last-write-wins.
- Title-change stream emits both events in serialization order. Both UIs converge to the second rename's value.
- Acceptable; no corruption.

## 7. Web build failures (Pages deploy)

### `buf generate` produces unexpected output

- CI gate `git diff --exit-code gen/` fails. PR can't merge.
- Developer regenerates locally, commits the diff.

### `vite build` fails on an `src/` change that was Electron-tested but not web-tested

- CI runs `npm run build:web` on every PR; failure blocks merge.
- Failure modes typically: imports a Node-only module (`fs`, `path`); references `process.platform` directly; uses an untranspiled feature.
- v0.4 establishes that the Electron and Web build BOTH run on every PR (chapter 08).

### Pages deploy fails on `main`

- Most likely cause: build environment difference (Node version, package install).
- Cloudflare Pages keeps the previous deploy live; users unaffected.
- Author sees deploy failure email from Cloudflare; investigates; pushes fix.

## 8. Catastrophic failures (last-resort recovery)

### Daemon SQLite corrupted

- v0.3 frag-8 covers migration / fresh-install path. v0.4 inherits.
- Recovery: user deletes `~/.ccsm/db.sqlite`, daemon recreates fresh on next start. Sessions lost (the JSONL files are still in `~/.claude/projects/` so re-import works).

### Daemon binary corrupted (auto-update botched)

- v0.3 frag-11 §11 + auto-update rollback (.bak path) covers this.
- Recovery: user re-runs the installer.

### Cloudflare account compromised

- Out of scope (this is a Cloudflare account security concern, not ccsm).
- Mitigation guidance: enable 2FA on Cloudflare account; rotate API tokens periodically.

### Web SPA shipped with a critical bug

- Cloudflare Pages: rollback to previous deploy via dashboard (one click).
- Author can also `git revert` the bad commit and push; next CI deploy supersedes the bad one in ~2 min.
