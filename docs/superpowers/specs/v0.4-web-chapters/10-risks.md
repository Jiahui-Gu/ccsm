# 10 — Risks

## Context block

v0.4 introduces a published wire surface, a new client (web), and a third-party ingress (Cloudflare). Each adds a class of risk distinct from v0.3's daemon-split risks. This chapter inventories the risks, ranks them by impact × likelihood, and lists the pre-emptive mitigations baked into other chapters. Each risk has a "**Trigger:**" describing what symptom would surface it and a "**Mitigation:**" with the chapter cross-ref.

## TOC

- 1. Top risks (HIGH severity)
- 2. Medium risks
- 3. Low risks (acknowledged but not blocking)
- 4. Risks the design explicitly accepts (no mitigation)

## 1. Top risks (HIGH)

### R1. Daemon updater on Windows is finicky (carryover from v0.3 §10)

**What:** daemon self-update on Win uses a process-replacing-itself pattern (write `daemon.exe.new`, batch-script swap on restart). Race conditions between Electron-spawned daemon and a running supervisor can produce a stuck-at-old-version state.

**Trigger:** user reports "I'm on v0.4.1 but the tray menu shows v0.4.0 forever".

**Mitigation:**
- v0.3 already shipped this with a `.bak` rollback path; v0.4 inherits unchanged.
- v0.4 dogfood gate post-M2 (7-day) explicitly tests the upgrade path (force-update from v0.4.0-rc1 to rc2 on the author's box).
- If serious problems: pause auto-update default-OFF for v0.4; require user-initiated install. Tracked in chapter 09 §6.

### R2. Wire-protocol skew during the bridge swap

**What:** during M1-M2 (bridge-swap milestone), some calls go over Connect, some over envelope. A bug in either path silently corrupts state.

**Trigger:** unexplained behavior change after a bridge-swap PR; daemon log shows mixed transports for the same session.

**Mitigation:**
- Per-PR parity tests (chapter 03 §7): for each swapped RPC, temporary test asserts old vs new behavior identical. Removed at M2.
- Per-batch ordering (read-only first → write → streams) limits blast radius (chapter 03 §5).
- M2 cleanup PR (chapter 09 §3 M2.Z) deletes envelope handler from data socket — once done, ambiguity ends.

### R3. Cloudflare Access free tier policy change

**What:** Cloudflare reduces free-tier user count, removes GitHub IdP from free, or rate-limits free apps. v0.4 stops working for the user.

**Trigger:** Cloudflare blog post / dashboard notification; web client returns "upgrade required" page.

**Mitigation:**
- Chapter 05 §7 documents the free-tier dependency.
- Chapter 05 §8 calls out "verify at activation time".
- Fallback (not built into v0.4): swap IdP to a different one (Google OAuth, OIDC). The daemon's JWT validator is IdP-agnostic; only the wizard text + setup flow change.
- Worst case: pay $7/user/month. Single user, $84/year. Annoying but tractable.

### R4. Connect-Web is half-duplex; future feature might need bidi

**What:** v0.4 depends on Connect-Web's HTTP/2 capabilities. If a future feature legitimately needs client-streaming or bidi (e.g. collaborative cursor sharing in a v0.5+ shared-session feature), the web client cannot do it.

**Trigger:** product-design conversation lands on a feature that requires bidi.

**Mitigation:**
- F4 spike confirmed v0.4 needs are satisfied by half-duplex (chapter 02 §1).
- Workaround for future bidi need: split client→server data into many short unary RPCs (already the model for PTY input, chapter 06 §3). Works for most cases.
- Hard case (real-time collab): consider WebTransport (Chrome 97+, Firefox-soon) or fallback to long-polling. Out of scope for v0.4.

### R5. xterm-headless memory caps under many idle sessions

**What:** v0.3 sets default xterm-headless scrollback to 10k lines per session. With N sessions live and full scrollback, memory grows. Web client adds another subscriber to each session's fanout buffer (per-subscriber 1 MiB cap; chapter 06 §7). Multi-client amplifier: each subscriber adds 1 MiB cap × N streams × M sessions to the daemon's working set; a second web client doubles the per-session buffer footprint.

**Trigger:** RSS > 500 MB after 7 days with realistic single-user load (5+ sessions, 1-2 web clients) warrants investigation. Hard fail at RSS > 1.5 GB after 7 days under typical usage (5-10 sessions, 1 web client open) — this trips R5 as a release-blocker for v0.4 and forces the eviction policy to ship.

**Mitigation:**
- v0.3 already enforces the per-subscriber 1 MiB cap (drop-slowest). Cross-ref chapter 06 R4 P0-2 (subscriber cap is the related upstream control).
- v0.4 adds nothing here unless web introduces persistent extra subscribers.
- v0.4 instrumentation (NEW): daemon samples RSS every 5 min, emits `pino.info({ event: 'rss_sample', rssBytes, sessionCount, subscriberCount })`, and exposes the latest sample on the `/stats` endpoint. Without instrumentation the dogfood gate is operationally vacuous.
- Long-term mitigation: scrollback eviction policy for idle sessions. If R5 trips at the 1.5 GB threshold during dogfood, the eviction policy [cross-file: see chapter 05 §P1-2] becomes a v0.4 ship-gate item, not a v0.5 deferral.
- v0.4 dogfood (post-M4 7-day) monitors the RSS trend with the thresholds above.

### R5b. Daemon JS event-loop saturation under multi-client streaming (NEW)

**What:** Node.js is single-threaded for JS execution. The daemon executes on one event loop: HTTP/2 frame parsing (libuv thread is fine), Connect interceptor stack per RPC (JS), protobuf encode/decode for every PTY chunk and every keystroke (JS), xterm-headless ANSI parsing for every byte from `node-pty` (JS), pino log serialization (JS unless `pino.transport()`), JWT verify on every remote RPC (~1-2 ms per call, JS), and snapshot serialization (multi-MB CPU work, JS). Worst case: 5 sessions producing hot PTY output × 2 web clients each subscribed × a snapshot RPC mid-flight saturates the event loop. New incoming RPCs back up; the control-socket `/healthz` shares the same loop, so the supervisor sees a `/healthz` timeout, respawns the daemon, and a cascading failure ensues [cross-file: see chapter 06 R4 P0-2 and chapter 07].

This is not theoretical: v0.3 already runs ANSI parsing in-process; v0.4 adds JWT + protobuf overhead atop the same loop.

**Trigger:** event-loop lag (`perf_hooks.monitorEventLoopDelay`) p99 > 50 ms sustained over a 5-min window with 3+ active sessions, or `/healthz` timeout from supervisor coinciding with `/stats` showing >2 active streams.

**Mitigation:**
- v0.4 instruments event-loop delay using `perf_hooks.monitorEventLoopDelay` (cheap, built into Node) and exports p50/p99 on `/stats`.
- Document worst-case session count in the user-facing tray "About" / health view.
- Consider moving snapshot serialization to a `worker_thread` (defer to v0.5 unless dogfood R5b trips).
- Cross-file: this risk crosses chapter 06 (streaming) and chapter 07 (failure modes). [cross-file: see chapter 06, chapter 07].

### R6. Same-user-local-process compromise of daemon (NEW — R2 P1-1)

**What:** any process running as the daemon's user (compromised dev tool, malicious npm postinstall, exploited browser extension, drive-by binary) can connect to the local socket and exercise the full RPC surface — PTY input/output (= shell command execution), spawn commands, read settings including the Cloudflare tunnel token. v0.3 had an HMAC handshake on the local socket as a second line of defense; v0.4 drops it [cross-file: see chapter 02 §8 + chapter 02 R2 P1-1].

**Trigger:** any local-malware report on a user's machine; unexplained daemon RPC activity in pino logs that doesn't correspond to a known client (Electron app, web tab, CLI helper).

**Mitigation:**
- Per chapter 02 R2 P1-1 lock: either restore HMAC on the local socket (recommended) or document acceptance and target re-introduction in v0.5. v0.4 inherits whichever lock chapter 02 ships with.
- Local socket is bound to user-only filesystem permissions (Unix domain socket mode 0600, Windows named pipe with explicit user-SID ACL).
- Daemon logs every authenticated local-RPC's PID + executable path (where the OS allows) for forensic correlation.

### R7. GitHub OAuth session compromise → daemon RCE (NEW — R2 P1-2)

**What:** an attacker who acquires a valid GitHub session for the author's email gets a Cloudflare Access JWT (chapter 05 §3 includes-emails policy + 24 h sessions), then drives any RPC including PTY input. PTY input is shell command execution. This is the highest-impact remote-attack vector in v0.4 and was previously implicit; it must be ranked.

**Trigger:** GitHub security advisory affecting the author's account; suspicious sign-in notification from GitHub or Cloudflare; unexplained PTY activity in daemon logs not matching user-driven sessions.

**Mitigation:**
- Per chapter 05 R2 P0-2 lock: require Cloudflare Access MFA on the GitHub-IdP rule, reduce session duration from 24 h to a tighter window, daemon-side IP audit on every authenticated RPC, documented compromise-recovery flow (revoke Cloudflare session, rotate tunnel credentials, rotate GitHub OAuth token) [cross-file: see chapter 05].
- Daemon logs `{ event: 'rpc_authenticated', sourceIp, cfRayId, jwtIat, rpcName }` for every remote call so the user can audit "was this me?".
- Tray menu surfaces a "recent remote sessions" view sourced from these logs (M4 deliverable).

## 2. Medium risks

### R8. Cloudflare Tunnel hostname leak

**What:** the auto-generated `<random>.cfargotunnel.com` hostname looks like a random string but is enumerable. If leaked (e.g. browser history, screen share), the hostname is visible. Cloudflare Access still requires JWT, so leak alone is not a breach — but it removes a layer of obscurity.

**Trigger:** user shares a screen with the URL visible.

**Mitigation:**
- Cloudflare Access enforces auth on every request. Hostname-knowledge alone grants nothing.
- Document in chapter 05 / setup wizard: "the hostname is one of two security layers; the other (Access) blocks unauthorized users."
- Daemon-side detection (NEW): every rejected JWT attempt is logged at `pino.warn({ event: 'jwt_rejected', sourceIp, reason, traceId })`, providing a forensic trail so "was I being scanned / attacked?" is answerable post-incident. [cross-file: see chapter 02 §8 + chapter 05 §4 — both currently silent on rejection logging; this risk drives the requirement.]
- Optional v0.5+: rotate hostname (delete and recreate tunnel). Out of scope for v0.4.

### R9. Browser tab kept open across daemon upgrade

**What:** user has the web client open at version v0.4.0; daemon upgrades to v0.4.1 in the background. The open tab's bundle has stale proto types.

**Trigger:** user notices a feature added in v0.4.1 doesn't appear in their open tab.

**Mitigation:**
- Field-level back-compat (chapter 02 §7) — old client gracefully ignores new fields.
- `Ping` RPC returns daemon version; SPA MUST show a "new version available, refresh to update" banner if the version differs from the build-embedded version. Promoted from MAY-deferred to MUST for M4: this banner is the only mechanism by which the user can detect a stale build, and deferring it makes upgrade-window stale-tab behavior silently undetectable. Scope is small (Ping RPC + 5-line UI banner).
- Worst case: user reloads the tab on next interaction; gets fresh bundle.

### R10. CSP / cross-origin issues in browser

**What:** Cloudflare Access's auth-redirect flow involves cross-origin cookies and redirects. Browser CSP (Content Security Policy) configured incorrectly on either Pages or Tunnel could break the auth handshake.

**Trigger:** sign-in works once but subsequent page loads fail with "blocked by CSP" or "third-party cookie blocked" console errors.

**Mitigation:**
- Use Cloudflare's documented Access SPA pattern (no custom CSP needed for the redirect flow if both origins are first-party to the user's view of `<their-domain>`).
- M3 dogfood explicitly tests Safari + Chrome + Firefox (the major browsers each handle third-party cookies differently as of 2026).
- If breakage: scope to one browser, document, advise alternate browser. Not a release blocker.

### R11. `cloudflared` binary supply chain

**What:** daemon ships `cloudflared` binary in the installer. If `cloudflared` upstream is compromised (or our pinned version has a CVE), users are exposed.

**Trigger:** Cloudflare publishes security advisory for `cloudflared`.

**Mitigation:**
- Pin `cloudflared` version in build script; version tracked in `daemon/scripts/cloudflared-version.txt` (or similar). Supply-chain pin uses SHA + signature verification per chapter 05 locked supply-chain story [cross-file: see chapter 05].
- Quarterly review for security advisories.
- Auto-update (separate from daemon auto-update) of `cloudflared` itself: NOT in v0.4. Defer.

### R12. SPA bundle size grows unchecked

**What:** Vite bundle bloats over time as features are added (xterm addons, larger icon set, etc.). Web client first-load latency degrades.

**Trigger:** deploy log shows bundle exceeds the locked threshold; users on slow connections complain.

**Mitigation:**
- Chapter 04 §2 sets target ~600 KB gzipped first-load.
- CI lint: bundle-size check (`size-limit` package) on PRs touching `web/` or `src/`. The fail threshold is **not** pre-set at 800 KB; instead it is locked at M1 spike to `actual_first_build + 15%` so the gate cannot trip on day one and trigger a ritual relaxation [cross-file: see chapter 04 R4 P1-1]. A gate destined to be relaxed is worse than no gate.
- Manual chunk splitting (chapter 04 §3) keeps cache-friendly chunks.

## 3. Low risks (acknowledged, not blocking)

### R13. `buf` binary upgrade churn

**What:** `buf` CLI gets breaking changes; CI gate breaks on a `buf` upgrade.

**Trigger:** CI failure with "unknown lint rule" or similar.

**Mitigation:** pin `buf` version in `package.json`. Routine maintenance.

### R14. Auto-start at OS boot conflicts with antivirus

**What:** AV on Win flags the auto-start registry / startup-folder entry as suspicious.

**Trigger:** user reports AV warning on first launch with auto-start enabled.

**Mitigation:**
- Default OFF (chapter 01 G6). Users opt in.
- Use standard mechanisms (Win startup folder shortcut, not registry HKCU\Run) to minimize false-positive risk.

### R15. Installer size increases with `cloudflared` bundled

**What:** `cloudflared` binary is ~30-40 MB per platform on Win/Mac/Linux. Per-platform installer grows accordingly.

**Trigger:** installer download takes noticeably longer.

**Mitigation:**
- Acceptable cost. Per-platform installer was ~80 MB; will be ~110-120 MB. Negligible.
- Alternative: download `cloudflared` on first remote-enable. Adds setup-wizard friction; not chosen.

### R16. Multi-client typing UX is confusing

**What:** two clients on the same session: characters interleave. User might find this surprising.

**Trigger:** user reports "I typed `cd` and the screen shows `cwed`".

**Mitigation:**
- Documentation note: "if you type from two devices simultaneously, output interleaves."
- No UI lock in v0.4. If demand emerges, future feature (v0.5+).

### R17. Web client clipboard quirks

**What:** `navigator.clipboard.writeText` requires user gesture in some browsers; differs from Electron's unrestricted access.

**Trigger:** user clicks "copy" in web; nothing happens; no error visible.

**Mitigation:**
- Wrap copy/paste in try/catch; surface a toast on failure ("clipboard blocked by browser, please use Ctrl+C").
- Defer to browser-standard behavior; don't fight it.

## 4. Risks the design explicitly accepts

### A1. Cloudflare zone-wide outage = web client unreachable

**Why accepted:** Cloudflare is the chosen ingress. Outages are rare. Local Electron is unaffected — that's the fallback.

### A2. Single-user only; no multi-tenant in v0.4

**Why accepted:** chapter 01 N2. Designing for multi-tenant inflates v0.4 scope by weeks for zero immediate user benefit (single user, single GitHub email).

### A3. Web client has no offline mode

**Why accepted:** chapter 04 §6 + N8. Stale data is worse than no data for this product.

### A4. Daemon must be reachable from Cloudflare = daemon must be running and online

**Why accepted:** the user's machine is the source of truth. If it's offline, there's nothing to display. Auto-start at boot (G6) reduces "I forgot to start it" cases. Cloud-resident daemon (N4) is a different product.

### A5. JWT replay-mid-validity not prevented (no nonce/jti store), but the compromise is auditable

**Why accepted:** single-user model — an attacker who has the JWT cookie has the same identity as the legitimate user from the daemon's authorization standpoint. The earlier framing ("no defense") masked an undetectable compromise; this version is honest about the consequence and the recovery path. The daemon logs every authenticated RPC's source IP + Cf-Ray + jwt-iat [cross-file: see chapter 07 R2 P1-2 + chapter 05 §4], so the user can audit "was this me?" after the fact. Cloudflare's session-revoke endpoint provides instant invalidation if compromise is suspected. The acceptance is therefore "no in-band prevention, but full post-hoc audit trail and fast revocation," not "no defense."
