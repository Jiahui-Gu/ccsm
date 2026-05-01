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

Daemon serializes all writes via `better-sqlite3` synchronous API. Long-running migrations block writes; v0.3 §6 migration-gate interceptor still applies on the data socket — it MUST be re-implemented as a Connect interceptor (chapter 02 §8).

### Daemon hangs (process alive, RPCs not progressing)

- Connect deadline header (`x-ccsm-deadline-ms`, carryover from v0.3) caps every unary RPC at 30s default, 120s clamp.
- Streams have no deadline; they rely on heartbeat (chapter 06 §4) for liveness.
- If the daemon stops processing but stays alive, deadlines fire on unary RPCs and surface as `deadline_exceeded` Connect errors. Bridge wraps as `BridgeTimeoutError` (existing v0.3 §3.7.5 type). Three+ in 10s triggers a "daemon stuck" diagnostic toast (existing v0.3 surface).

### Daemon disk full (new edge case worth calling out)

- SQLite write fails with `SQLITE_FULL`. Daemon's existing storage-full handler (v0.3 frag-8) surfaces a `storage.full` banner. v0.4: same banner reaches both Electron and web (it's in the renderer; both clients render it).
- **In-flight RPC mapping (new in v0.4):** `SQLITE_FULL` MUST map to Connect `resource_exhausted` (not `internal`). The transactional write is rolled back so partial-row corruption is impossible.
- **Bridge short-circuit:** once the daemon sets the `storage.full` flag, a Connect interceptor (chapter 02 §8 — add "storage-full short-circuit interceptor for write RPCs") rejects all subsequent **write** RPCs locally with `resource_exhausted` until the flag clears, so clients don't burn additional disk attempts. Read RPCs (PTY snapshot, list sessions, title stream) continue normally.
- **Client behavior:** Bridge maps `resource_exhausted` to a non-retrying local error (different from `unavailable`, which auto-retries). UI surfaces the `storage.full` banner; user is expected to free disk before retry.
- **Logger fallback under ENOSPC:** when the daemon detects ENOSPC on log writes, the pino transport switches to an in-memory ring buffer (last 1000 lines, replayed to disk once `storage.full` clears). Prevents the event loop from stalling on blocked writes and preserves the audit trail across the incident.
- **Side-channel signal:** `storage.full` MUST be exposed in the control-socket `/healthz` response (e.g. `{"ok":false,"reason":"storage.full"}`) so the supervisor and the Electron health bridge can detect it without depending on disk-backed RPC paths.
- **Testability:** chapter 08 §3 adds a contract test that injects a disk-full simulation hook (e.g. `daemon.__test_setStorageFull(true)`) and asserts (a) write RPCs return `resource_exhausted`, (b) read RPCs succeed, (c) `storage.full` event appears on the cross-client `streamSessionStateChanges` so the **web** client renders the banner (chapter 08 §5 case `web-disk-full-banner`).

## 2. Cloudflare layer failures

### `cloudflared` process crashes

- Daemon supervises (chapter 05 §1): exponential restart, capped at 60s, 10 attempts in 30 minutes, then surface `cloudflare.unreachable` banner.
- During the outage: web client sees the Pages SPA loaded (cached in browser) with `daemon.unreachable` banner (it can't reach the tunnel). Local Electron is unaffected.
- Recovery: when `cloudflared` reconnects, the tunnel hostname routes again; web client's auto-retry catches the next interval.

### Cloudflare Access misconfigured (e.g. wrong AUD claim)

- Daemon's JWT interceptor rejects with `unauthenticated`. Web client sees auth error → redirects to Access flow → Cloudflare returns the user to the SPA → SPA reloads, retries, gets the same JWT → still `unauthenticated`. Loop.
- **Client-side break-out (new in v0.4):** the SPA's transport interceptor MUST track redirect attempts in `sessionStorage` (counter + first-attempt timestamp). On the **3rd redirect within 30s**, the SPA aborts the redirect, clears the counter, and renders a `auth.looped` banner: "Authentication looped — check daemon log or Cloudflare Access policy" with a link to the diagnostics page (`/diagnostics`, surfaces the last 5 daemon JWT errors and a copy-able trace ID). Same break-out logic applies to JWT-expiry redirects (§4) since the failure shape is identical from the SPA's POV.
- **In-app surface (new in v0.4):** when JWT failures classified as `aud_mismatch` exceed **5 per minute** at the daemon, daemon emits a `cloudflare.misconfigured` banner via `streamSessionStateChanges` (chapter 06 §8). Electron Settings UI renders "Cloudflare Access misconfigured: AUD mismatch — re-run setup wizard step 2" with the actual vs expected AUD shown. Banner clears once 5 minutes pass without a new mismatch.
- **Log classification (new in v0.4):** daemon JWT-failure log line includes a `failure_class` field with one of `{ no_jwt, aud_mismatch, expired, invalid_sig, unknown }`. Each class has different semantics: `no_jwt` = Tunnel not behind Access (operator misconfig); `aud_mismatch` = Access app config drift; `expired` = normal session expiry (no banner); `invalid_sig` = JWKS rotation in flight or attack. The user-visible banner is rate-limited (per above); the **log line is NOT rate-limited** so defenders retain visibility into probe rates.
- **Why a UI surface is appropriate now:** v0.3 logged-only because there was no remote ingress to misconfigure; v0.4 introduces the Cloudflare layer, so misconfig is now a first-class failure mode that warrants surfacing.
- **Operator recovery:** user re-runs setup wizard step 2 (chapter 05 §3) with the correct AUD claim. Banner clears after 5 minutes of no further mismatches.

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
- **Snapshot bandwidth budget:** snapshot payload is gzip-compressed and capped per chapter 06 R4 P0-1 (compression + size cap with truncation marker). Over slow links the snapshot is still bounded; client renders a "scrollback truncated" marker if the cap fired.
- **Future hybrid (deferred to v0.5):** when `fromSeq` is within ~1 MB of the buffer-edge, ship a partial replay + delta-snapshot rather than a full snapshot. Documented as the path; not implemented in v0.4 to keep M4 scope tight. Why deferred: full re-snapshot is correct and simple; hybrid is a perf optimization for the slow-link reconnect case.

### Browser tab backgrounded for >100s

- Tab suspends or throttles event loop (Chrome aggressively throttles background tabs to ~1 Hz timer cap as of 2024+).
- HTTP/2 stream may or may not be killed by Cloudflare (heartbeats from daemon keep edge happy, but the browser may ignore them if throttled). Client-side liveness check fires after 120s of no event per chapter 06 §4.
- **Proactive pause (new in v0.4):** the web bridge MUST listen to the Page Visibility API. On `visibilitychange` → `hidden`, the bridge **closes** the active PTY stream cleanly (CANCEL frame, recording `lastSeenSeq`). On `visibilitychange` → `visible`, the bridge re-attaches with `fromSeq = lastSeenSeq + 1`. **Why:** prevents the daemon from accumulating bytes for a slow consumer (drop-slowest fires repeatedly otherwise → repeated multi-MB snapshot fetches on every tab refocus, the dominant laptop-user behavior).
- On refocus: replay if `fromSeq` is in-buffer; snapshot as last resort (subject to the bandwidth budget above).
- See chapter 06 §7 for the matching daemon-side fanout / drop-slowest description.

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
- **Failure path (new in v0.4):** if Access re-issues a JWT the daemon STILL rejects (e.g. team-name changed in dashboard, daemon's stored team-name is stale, AUD drift), the redirect loops. The SPA's redirect-counter (see §2 break-out) catches this: 3 redirects within 30s → abort, render `auth.looped` banner with diagnostics link. Same break-out covers misconfig (§2) and stale-team-name (§4) symmetrically.
- **Testability (new in v0.4):** chapter 08 §5 case `web-jwt-expiry` runs hermetically as follows. (a) Test harness mints a JWT signed by a test JWKS with `exp` 5s in future (no real CF Access). (b) Daemon is started with the test JWKS URL. (c) The SPA's transport interceptor exposes an `onAuthRedirect: (url: string) => void` injection hook so the test fixture can stub the navigation rather than actually redirecting the browser. (d) Test asserts the callback fires with the documented `https://<tunnel-hostname>/cdn-cgi/access/login/<aud>` URL pattern within 1s of `unauthenticated`. (e) A second variant asserts the redirect-counter break-out: stub the callback to immediately re-issue the same expired JWT, assert `auth.looped` banner appears after the 3rd attempt.

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
- **Audit trail (new in v0.4):** every authenticated RPC log line MUST include `Cf-Connecting-Ip` (origin IP from Cloudflare edge), `Cf-Ray` (request ID), `jwt_email`, `jwt_iat`, `jwt_jti` (if present), and `traceId`. The Cf-* headers are forwarded by Cloudflare through the tunnel and are only present on remote ingress (local Electron requests omit them, distinguishable). This gives the user an audit trail to confirm "was that me from my home IP, or someone else?" without requiring the daemon to maintain a nonce store. Cross-refs chapter 05 §4 (logging policy update) and chapter 10 A5.
- **First-seen-IP banner (new in v0.4):** daemon tracks the set of `(jwt_email, src_ip)` pairs seen in the last 30 days (small SQLite table, MAX 1000 rows, evicted LRU). On a new pair, daemon emits a `auth.new_device` UI banner: "New sign-in: 203.0.113.5 (City, Country) — was this you?" with a "Yes" / "No, revoke" pair. "No, revoke" deep-links to the Cloudflare Zero Trust session-revocation flow. Geo lookup is best-effort using `Cf-IPCountry` header from Cloudflare; no MaxMind dependency.
- **Recovery (updated in v0.4) — order matters:**
  1. **First**, revoke active Access sessions in Cloudflare Zero Trust dashboard (Sessions → Revoke). This is **instant** and kills any in-flight stolen JWT, even before its 24h expiry.
  2. Rotate Cloudflare Access app config (regenerates AUD; existing tokens become `aud_mismatch` immediately).
  3. Revoke the GitHub OAuth grant (GitHub Settings → Applications); prevents Access from re-issuing on the attacker's IdP session.
  4. (Optional) regenerate Tunnel credentials if there's any suspicion the tunnel token leaked.
- **Why instant revoke is the lead step:** the previous spec listed GitHub OAuth revocation first, which only takes effect after the existing 24h JWT expires. CF session revocation is the only step that immediately invalidates an in-flight stolen cookie.

## 5. Wire-protocol version skew

### Electron v0.3.x against daemon v0.4.0

- v0.3.x Electron talks the hand-rolled envelope. v0.4 daemon's data socket talks Connect/HTTP/2.
- v0.3.x Electron sends a length-prefixed JSON envelope; v0.4 daemon's HTTP/2 listener sees garbage prefix and rejects.
- **Outcome:** Electron's bridge sees connection failure; surfaces `daemon.unreachable`.
- **Recovery:** the v0.4 installer ships matched Electron+daemon. User must run installer. Document the upgrade path: "v0.4 is a wire-protocol change; users on v0.3 must run the installer (auto-update will handle this if enabled)."
- **Testability (new in v0.4) — wire-skew compat smoke:** chapter 08 §3 adds a once-per-release CI test (`wire-skew-compat`) that boots a v0.3.x Electron probe against a v0.4 daemon container and asserts (a) the renderer surfaces `daemon.unreachable` within 10s, (b) the v0.4 daemon's HTTP/2 listener does NOT crash or leak file descriptors when fed envelope-style bytes (defensive: any HTTP/2 connection-preface parser bug would otherwise take down all v0.4 users), (c) clean rejection in daemon log with `failure_class=protocol_mismatch`. Symmetric reverse test (v0.4 Electron → v0.3 daemon) confirms the envelope listener also rejects cleanly.

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
- **v0.4 re-validation (new):** v0.4 changes the install payload (bundles `cloudflared` ~20 MB plus larger build artifacts), so the v0.3 `.bak` rollback mechanism is NOT automatically inherited. M2 close (chapter 09 §7 post-M2 7-day dogfood gate) MUST include an explicit two-direction test:
  1. Force update v0.4-rc1 → v0.4-rc2; assert daemon starts on rc2 and `cloudflared` is the rc2-bundled version.
  2. Force ROLLBACK rc2 → rc1 via the `.bak` mechanism; assert daemon starts on rc1 and `cloudflared` is the rc1-bundled version.
  Both must pass; if either fails, M2 doesn't close.
- **"Rollback also failed" recovery (new in v0.4):** if both `.exe` and `.bak` are corrupted (catastrophic auto-update + power loss mid-swap), the user must run the installer manually from `C:\Users\Public\Desktop\CCSM-Setup.exe` (the location the build worker copies fresh installers to, per memory rule). User-facing docs (README + in-app "About" page) MUST cite this manual recovery path. As a fallback, the installer is also published on GitHub Releases with the corresponding tag.

### Cloudflare account compromised

- Out of scope (this is a Cloudflare account security concern, not ccsm).
- Mitigation guidance: enable 2FA on Cloudflare account; rotate API tokens periodically.

### Web SPA shipped with a critical bug

- Cloudflare Pages: rollback to previous deploy via dashboard (one click).
- Author can also `git revert` the bad commit and push; next CI deploy supersedes the bad one in ~2 min.
