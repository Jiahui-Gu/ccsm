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

**What:** v0.3 sets default xterm-headless scrollback to 10k lines per session. With N sessions live and full scrollback, memory grows. Web client adds another subscriber to each session's fanout buffer (per-subscriber 1 MiB cap; chapter 06 §7).

**Trigger:** long-running daemon (>1 week) with 20+ sessions reports >2 GB resident memory.

**Mitigation:**
- v0.3 already enforces the per-subscriber 1 MiB cap (drop-slowest).
- v0.4 adds nothing here unless web introduces persistent extra subscribers.
- Long-term mitigation (v0.5+): scrollback eviction policy for idle sessions.
- v0.4 dogfood (post-M4 7-day) monitors memory growth as part of the gate.

## 2. Medium risks

### R6. Cloudflare Tunnel hostname leak

**What:** the auto-generated `<random>.cfargotunnel.com` hostname looks like a random string but is enumerable. If leaked (e.g. browser history, screen share), the hostname is visible. Cloudflare Access still requires JWT, so leak alone is not a breach — but it removes a layer of obscurity.

**Trigger:** user shares a screen with the URL visible.

**Mitigation:**
- Cloudflare Access enforces auth on every request. Hostname-knowledge alone grants nothing.
- Document in chapter 05 / setup wizard: "the hostname is one of two security layers; the other (Access) blocks unauthorized users."
- Optional v0.5+: rotate hostname (delete and recreate tunnel). Out of scope for v0.4.

### R7. Browser tab kept open across daemon upgrade

**What:** user has the web client open at version v0.4.0; daemon upgrades to v0.4.1 in the background. The open tab's bundle has stale proto types.

**Trigger:** user notices a feature added in v0.4.1 doesn't appear in their open tab.

**Mitigation:**
- Field-level back-compat (chapter 02 §7) — old client gracefully ignores new fields.
- `Ping` RPC returns daemon version; SPA SHOULD show a "new version available, refresh to update" banner if version differs from build-embedded version. (M4 deliverable, MAY be deferred to v0.5 if scope tight.)
- Worst case: user reloads the tab on next interaction; gets fresh bundle.

### R8. CSP / cross-origin issues in browser

**What:** Cloudflare Access's auth-redirect flow involves cross-origin cookies and redirects. Browser CSP (Content Security Policy) configured incorrectly on either Pages or Tunnel could break the auth handshake.

**Trigger:** sign-in works once but subsequent page loads fail with "blocked by CSP" or "third-party cookie blocked" console errors.

**Mitigation:**
- Use Cloudflare's documented Access SPA pattern (no custom CSP needed for the redirect flow if both origins are first-party to the user's view of `<their-domain>`).
- M3 dogfood explicitly tests Safari + Chrome + Firefox (the major browsers each handle third-party cookies differently as of 2026).
- If breakage: scope to one browser, document, advise alternate browser. Not a release blocker.

### R9. `cloudflared` binary supply chain

**What:** daemon ships `cloudflared` binary in the installer. If `cloudflared` upstream is compromised (or our pinned version has a CVE), users are exposed.

**Trigger:** Cloudflare publishes security advisory for `cloudflared`.

**Mitigation:**
- Pin `cloudflared` version in build script; version tracked in `daemon/scripts/cloudflared-version.txt` (or similar).
- Quarterly review for security advisories.
- Auto-update (separate from daemon auto-update) of `cloudflared` itself: NOT in v0.4. Defer.

### R10. SPA bundle size grows unchecked

**What:** Vite bundle bloats over time as features are added (xterm addons, larger icon set, etc.). Web client first-load latency degrades.

**Trigger:** deploy log shows bundle >1 MB gzipped; users on slow connections complain.

**Mitigation:**
- Chapter 04 §2 sets target ~600 KB gzipped first-load.
- CI lint: bundle-size check (`size-limit` package) on PRs touching `web/` or `src/`. Fail on >800 KB. Lock-in for M3 PR.
- Manual chunk splitting (chapter 04 §3) keeps cache-friendly chunks.

## 3. Low risks (acknowledged, not blocking)

### R11. `buf` binary upgrade churn

**What:** `buf` CLI gets breaking changes; CI gate breaks on a `buf` upgrade.

**Trigger:** CI failure with "unknown lint rule" or similar.

**Mitigation:** pin `buf` version in `package.json`. Routine maintenance.

### R12. Auto-start at OS boot conflicts with antivirus

**What:** AV on Win flags the auto-start registry / startup-folder entry as suspicious.

**Trigger:** user reports AV warning on first launch with auto-start enabled.

**Mitigation:**
- Default OFF (chapter 01 G6). Users opt in.
- Use standard mechanisms (Win startup folder shortcut, not registry HKCU\Run) to minimize false-positive risk.

### R13. Installer size increases with `cloudflared` bundled

**What:** `cloudflared` binary is ~20 MB per platform. Installer grows accordingly.

**Trigger:** installer download takes noticeably longer.

**Mitigation:**
- Acceptable cost. Installer was ~80 MB; will be ~100 MB. Negligible.
- Alternative: download `cloudflared` on first remote-enable. Adds setup-wizard friction; not chosen.

### R14. Multi-client typing UX is confusing

**What:** two clients on the same session: characters interleave. User might find this surprising.

**Trigger:** user reports "I typed `cd` and the screen shows `cwed`".

**Mitigation:**
- Documentation note: "if you type from two devices simultaneously, output interleaves."
- No UI lock in v0.4. If demand emerges, future feature (v0.5+).

### R15. Web client clipboard quirks

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

### A5. JWT-replay attacks not prevented (no nonce/jti store)

**Why accepted:** single-user. Attacker who has the JWT cookie has the same identity as the legitimate user. Multi-user model would change this.
