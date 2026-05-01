# 09 — Release slicing (M1–M4 inside v0.4)

## Context block

v0.4 covers protocol formalization + bridge swap + web client + Cloudflare layer. Shipping it as one big-bang release would mean weeks of "in progress" with nothing dogfoodable; per `feedback_dogfood_protocol`, every milestone must be independently dogfoodable. This chapter slices v0.4 into four milestones, each ~1-2 weeks of implementation, each producing a usable artifact.

## TOC

- 1. Milestone overview
- 2. M1 — `proto/` locked + first bridge swapped end-to-end
- 3. M2 — All bridges swapped, envelope deleted from data socket
- 4. M3 — Web client functional (local-only, via dev TCP listener)
- 5. M4 — Cloudflare wired, remote access live
- 6. Release tagging + version bumps
- 7. Dogfood gates between milestones
- 8. Rollback strategy

## 1. Milestone overview

| Milestone | What ships | Dogfood signal | Estimate |
|---|---|---|---|
| **M1** | `proto/` schema, `buf` CI, ONE bridge swapped end-to-end (read-only RPC), Connect server on daemon's data socket alongside envelope | "I can call `app:getVersion` over Connect from the renderer; envelope still serves the rest." | ~25h |
| **M2** | All ~46 bridge calls swapped to Connect; envelope handler deleted from data socket; control socket (supervisor) untouched | "Electron runs entirely on Connect for the data socket. No regression vs. v0.3." | ~30h |
| **M3** | `web/` package built and runs on `vite dev` against local daemon (TCP listener); SPA mounts the renderer; basic flows work | "I can `vite dev` the web client locally and operate sessions." | ~25h |
| **M4** | Cloudflare Tunnel + Access wired; web client deployed to Pages; JWT middleware on daemon; setup wizard | "I open `https://app.<domain>` from any network and use ccsm." | ~30h |

**Total: ~110 hours.** ~3-4× the predecessor doc's "~30h v0.4 + ~30-50h v0.5" estimate (predecessor undercounted bridge-swap and CF wiring scope).

> **Bridge count canonical: ~46.** This is the canonical inventory from chapter 03. If chapters 00/01/02 cite a smaller number (e.g. "~22"), those are stale and must be brought *up* to ~46 — do NOT bring chapter 09 *down*. [cross-file: see chapters 00, 01, 02 for the ~22 → ~46 corrections]

> **Sub-batch naming convention.** Sub-batches use letter suffixes (`M2.A`, `M2.B`, `M2.C`); the trailing cleanup PR uses `.Z` to signal "final cleanup, run after all sibling sub-batches land." Only M2 has sub-batches in v0.4; M1/M3/M4 ship as single-milestone bundles.

## 2. M1 — `proto/` locked + first bridge swapped end-to-end

**Goal:** end-to-end Connect request travels from renderer → preload → daemon and back, with proto + buf CI enforcing schema. Pick the smallest read-only RPC for the swap (`app:getVersion`) so blast radius is minimal if anything is broken.

### Deliverables

1. `proto/` directory with `buf.yaml`, `buf.gen.yaml`, `buf.lock`, and the umbrella `service Ccsm` definition with one method (`Ping` returning `{daemonVersion, protoVersion}`) plus the `core.proto` Version RPC.
2. `gen/ts/` populated by `buf generate`.
3. `@ccsm/proto-gen` wrapper package (chapter 02 §5).
4. `buf` CI workflow live (`proto.yml`).
5. Daemon: `@connectrpc/connect-node` Http2Server bound on the data socket alongside the existing envelope handler. Connect routes registered for `Ping` + `GetVersion`. JWT interceptor scaffolded but local-bypass enabled (no remote ingress yet).
6. `electron/connect/ipc-transport.ts` — Connect transport over named pipe / Unix socket.
7. Bridge `ccsmCore.getVersion()` calls Connect (instead of `ipcRenderer.invoke`).
8. Daemon-side ipc handler for `app:getVersion` removed.
9. Tests: L1 (`buf` gates), L2 (handler unit + contract for `GetVersion`, `Ping`), L3 (Electron e2e: launch app, assert version string visible) all green.

### Done definition

- v0.4.0-rc1 installer builds.
- Author runs the installer; everything works as v0.3 except `getVersion()` is now over Connect (verifiable in daemon log: `pino.info({transport: 'connect', method: 'GetVersion'})`).
- 24h dogfood with no regressions.

## 3. M2 — All bridges swapped

**Goal:** complete the bridge swap. Every cross-daemon RPC goes over Connect; envelope handler on the data socket is deleted. Control socket (supervisor) unchanged.

### Sub-batches (PR boundaries from chapter 03 §5)

- **M2.A:** Batch A read-only RPCs (4 sub-PRs).
- **M2.B:** Batch B write RPCs (5 sub-PRs).
- **M2.C:** Batch C streams (3 sub-PRs).
- **M2.Z:** Cleanup PR — delete envelope handler from data socket; delete `electron/ipc/*` files for daemon-domain handlers; delete temporary parity tests; refactor.

### Deliverables

1. ~12 bridge-swap PRs landed.
2. `electron/preload/bridges/*.ts` files contain zero `ipcRenderer.invoke` calls for daemon-domain RPCs (window/clipboard/picker exempt per chapter 03 §2).
3. Daemon's data-socket envelope handler deleted; data socket serves Connect only.
4. Streaming heartbeat on every server-stream RPC (chapter 06 §4).
5. Multi-client coherence test (L5) passes between two Electron instances on the same daemon (web is M3).
6. Tests: full L1+L2+L3+L5 suite green.

### M2.Z preconditions (parity-test deletion gate)

M2.Z is the irreversible point: once parity tests are deleted, regressions can no longer be A/B-compared against the envelope handler. M2.Z PR MUST NOT merge until ALL of the following hold:

1. All 12 batch PRs (M2.A.1–4, M2.B.1–5, M2.C.1–3) are merged to `working`.
2. Each batch PR's parity test ran green at merge time AND is still green on `working` HEAD.
3. A final cross-bridge integration test (all ~46 RPCs exercised in one e2e session) passes on `working` HEAD.
4. The post-M2 7-day dogfood window has CLOSED (i.e. parity tests survive the dogfood window — they are the safety net during it). M2.Z runs only after dogfood close, never during. [cross-file: see chapter 03 §6/§7 for the parity-test framework spec.]

### Done definition

- v0.4.0-rc2 installer builds.
- Author runs the installer; all v0.3 functionality works; no envelope code on data socket (verifiable: `grep -r 'envelope' daemon/src/sockets/data-socket.ts` returns nothing).
- 1-week dogfood with no regressions.
- **Force-update probe:** force-update from `v0.4.0-rc1` to `v0.4.0-rc2` succeeds on a test machine; force-rollback from rc2 to rc1 succeeds (manual installer step OK). [cross-file: see chapter 07 P1-3 for the auto-update force-test framework.]

## 4. M3 — Web client functional (local-only)

**Goal:** the web client renders and operates sessions, talking to the local daemon via the dev-mode TCP listener. No Cloudflare yet.

### Deliverables

1. `web/` package per chapter 04 §1.
2. `web/src/main.tsx` mounts shared `src/App.tsx`.
3. `web/src/bridges/*` web flavor of preload bridges, calling Connect-Web against the dev TCP listener.
4. `src/platform/getPlatform.ts` (or equivalent) — abstracts `process.platform` reads.
5. **Dev TCP listener on daemon — locked production gate.** Spec is concrete; the worker has no choice of mechanism:
   1. Dev TCP listener code lives in `daemon/src/dev/dev-tcp-listener.ts`.
   2. The entire `daemon/src/dev/**` tree is excluded from production builds via `tsconfig.production.json` `exclude: ["src/dev/**"]`.
   3. Daemon entry imports the dev listener via `await import(...)` gated on `process.env.CCSM_BUILD !== 'production'`. If `process.env.CCSM_BUILD === 'production'` AND a `daemon/src/dev/**` module is somehow loaded (transitively), the entry calls `assert.fail('dev module loaded in production')` and the daemon exits non-zero.
   4. Activation env var is `CCSM_DAEMON_DEV_TCP=<port>`. In production builds the variable has no effect because the module is not present.
   5. Listener requires a per-launch shared secret negotiated at daemon start (printed to dev console, consumed by the web dev bridge); see chapter 04 R2 P0-1 for the secret protocol.
   6. **Banned mechanisms:** `process.env.NODE_ENV === 'development'` checks alone are insufficient (NODE_ENV is externally settable on a packaged binary and would be a trivial bypass) and MUST NOT be the gate.
   7. L4 e2e test verifies: prod-build daemon binary refuses to bind even with `CCSM_DAEMON_DEV_TCP=7878` AND `NODE_ENV=development` set; dev-build daemon binary binds only when the per-launch secret is provided. [cross-file: see chapter 04 R2 P0-1 for the parallel lock.]
6. `npm run web:dev` runs Vite + the web client; talks to a locally running daemon.
7. Tests: L4 web e2e suite green (~6 cases). L5 multi-client e2e extended to include web client.
8. `web/dist/` build artifact produced by `npm run build:web`. Cloudflare Pages NOT wired yet.
9. **Web client error reporting wired.** New RPC `ReportClientError` exposed by the daemon; web client catches uncaught exceptions + unhandled promise rejections and posts them. Daemon writes them to `~/.ccsm/web-client-errors.log` (rotated). Hidden-settings "copy diagnostics" button packs the last N entries for paste into a bug report. Without this, the M3 dogfood gate has no telemetry to evaluate. [cross-file: see chapter 04 P1-1 for the error-reporting RPC contract.]

### Done definition

- Author can run web client locally:
  1. `npm run daemon:dev` → daemon binds dev TCP listener.
  2. `npm run web:dev` → Vite dev server.
  3. Open `http://localhost:5174` → SPA loads, sees session list, opens session, types into terminal.
- Multi-client test (L5) passes: Electron and web on the same session see each other's input/output.
- **Dogfood: 3 days OR 12 cumulative hours of active web-client use, whichever is later.** Must include:
  - ≥1 backgrounded-tab session lasting >2h (catches throttled-tab reconnect bugs and leaked subscribers per chapter 06 §5).
  - ≥1 multi-client session (Electron + web on the same session) lasting ≥1h.
  - ≥1 reconnect after intentional network drop (toggle Wi-Fi off/on; web client must recover without reload).
- 4-5 hours of typical interactive use is too thin a sample; the wider gate is what triggers the M3 risk gate fairly.

**Risk gate before M4:** if M3 dogfood reveals significant UX gaps (e.g. xterm.js rendering glitches in browser, keyboard shortcut conflicts), pause M4 and address. Don't paper over with Cloudflare polish.

**Feature-scope discovery during M3 dogfood:** if dogfood reveals desirable new features (better keyboard mappings for browsers, web-specific gestures, mobile-friendly chrome, etc.), file them as v0.5+ candidates. v0.4 does NOT extend feature scope based on M3 findings; it only fixes regressions and addresses gaps that block the +frontend deliverable.

## 5. M4 — Cloudflare wired, remote access live

**Goal:** the headline feature. Web client reachable from any network via Cloudflare Tunnel + Access; JWT validated by daemon.

### Deliverables

1. `cloudflared` binaries bundled in installer (Win/Mac/Linux x64+ARM64). Installer drops them in app resources path.
2. Daemon: `cloudflared` spawn/supervise logic (chapter 05 §1).
3. Daemon: JWT validation interceptor on remote ingress (chapter 05 §4).
4. **SQLite settings rows for tunnel token, CF team name, CF app AUD; encrypted at rest via OS keychain — locked scheme.** The encryption-at-rest scheme is fully defined in chapter 05 §1.X; M4 implements that lock without re-deciding. Summary of the lock: secrets live in the OS keychain only (Win Credential Manager, macOS Keychain, libsecret on Linux); SQLite stores ONLY a keyring pointer (account/service identifier), never the secret bytes; Linux fallback (no libsecret) is documented and surfaces a setup-wizard warning rather than silently downgrading; setup wizard handles missing-keychain and rotation flows per chapter 05. [cross-file: see chapter 05 R2 P0-1 for the binding lock.]
5. Electron Settings UI: "Remote access" pane with the 3-step setup wizard (chapter 05 §6).
6. Cloudflare Pages: GitHub integration set up; first deploy from `main` succeeds.
7. **Auto-start at OS boot — bounded scope.** A SINGLE toggle in Settings → Remote access pane. Default OFF. Persists across reboots via the standard mechanism per chapter 01 G6 + R12 (Win startup folder shortcut, launchd `RunAtLoad`, systemd user unit). Explicitly NOT in scope for v0.4: tray menu item, first-run nudge, system-tray indicator for boot-state, OS notification on boot. No additional UX in v0.4. [cross-file: see chapter 01 R1 P1-1 for the matched scope-narrowing language.]
8. `daemon.unreachable` and `cloudflare.unreachable` banners surface correctly.
9. Tests: L6 Cloudflare smoke green on a CI tunnel + service-token JWT.
10. Documentation: `docs/web-remote-setup.md` user guide.

### Done definition

- v0.4.0 installer ready to ship.
- Author runs setup wizard, gets `<random>.cfargotunnel.com` hostname, opens `https://app.<author-domain>` (or `<deploy>.pages.dev`) from a phone tether (cellular network), signs in with GitHub, sees session list, opens session, types in terminal, sees Electron desktop mirror the input.
- 7-day dogfood per chapter 00 success criteria.
- **Manual auto-start verification.** On a real Win box: flip the auto-start toggle ON, reboot, log in, observe daemon comes up before Electron launch, web client reachable within 30s of OS login. Result recorded in release notes for the `v0.4.0` tag. This is a manual test (reboots are not cheaply automatable in CI); chapter 08 §9 manual-checklist tracks it as a per-release gate. [cross-file: see chapter 00 success criterion #6 + chapter 08 §9.]
- Release tag `v0.4.0` cut.

## 6. Release tagging + version bumps

| Tag | Trigger | Distribution |
|---|---|---|
| `v0.4.0-rc1` | M1 done | Local installer; not pushed to update channel |
| `v0.4.0-rc2` | M2 done | Local installer; not pushed |
| `v0.4.0-rc3` | M3 done | Local installer; web NOT yet on Pages |
| `v0.4.0` | M4 done + 7-day dogfood passed | Push to update channel; Pages live |

Tag prose is canonical `v0.4.0-rcN` (full semver); avoid the shorter `v0.4-rcN` form anywhere in the spec.

**Why rcN tags during the milestones:** preserves "this is M2-complete" snapshot in git history. Useful if M3 hits trouble and we need to bisect or roll back.

**Daemon binary tag:** `daemon-v0.4.0-rcN` matching the Electron tag. Single installer, lockstep versions (chapter 02 §7).

### Auto-update default for v0.4

The v0.4.0 release ships with auto-update default-ON UNLESS the explicit reliability gate trips during M2 dogfood. The gate is binary, not judgment:

> **Gate:** if ≥1 stuck-upgrade reproduction occurs during the M2 7-day dogfood window, auto-update for v0.4.0 ships default-OFF and requires user-initiated install. If 0 reproductions occur, auto-update ships default-ON.
>
> The author is the only dogfood user; ANY occurrence (n=1) trips the gate. No quorum, no severity ladder. Recorded in `docs/release-notes/v0.4.0.md` with a one-line citation of the dogfood log.

Without this binary criterion, "serious problems" is a release-time judgment call and reliability bugs leak through. [cross-file: see chapter 10 R1 for the auto-update channel mechanics.]

## 7. Dogfood gates between milestones

Per `feedback_dogfood_protocol`: each milestone closure requires a dogfood window before the next milestone starts. Lengths:

| Gate | Duration | What's tested |
|---|---|---|
| Post-M1 | 24h | Connect path doesn't break first RPC; no daemon crash |
| Post-M2 | 7 days | Full Electron usage on Connect; multi-client (Electron+Electron) coherent; no regression vs v0.3 baseline; auto-update gate (§6) evaluated |
| Post-M3 | 3 days OR 12 cumulative hours active use, whichever later | Web client operates sessions locally; matches Electron behavior; backgrounded-tab + reconnect probes per §4 done definition |
| Post-M4 | 7 days | End-to-end remote access stable; auto-start works after OS reboot |

**Dogfood failures during a gate:** open issues; if HIGH severity (data loss, crash loop), pause next milestone until fixed. Per `feedback_correctness_over_cost`: never skip an issue to advance the schedule.

**Dogfood-gate stuck signal.** If a dogfood gate exceeds 2× its planned duration without closing (e.g. post-M2 still open at day 14, post-M3 still open at 24 cumulative hours of attempted use), escalate to the user. Either ship a hot-fix mid-gate to unstick the probe or pause the release and re-evaluate the milestone scope. Without this signal, a stale-mid-flight milestone (e.g. M3 done, M4 lingering for weeks while context evaporates) is invisible to the manager.

**R1 sanity check (no scope creep) at every gate.** Before closing a milestone, the manager scans the milestone's PRs for any user-visible new surface that was NOT in the milestone's deliverables list — new bridge method, new UI component, new Settings row, new tray entry, new keyboard shortcut, new notification, new modal. Each MUST be traceable to a spec-listed deliverable; otherwise it is scope creep and gets reverted or deferred to v0.5+.

**Pre-M4 security gate.** Between the post-M3 dogfood close and M4 start, dispatch a security-focused reviewer to audit:

- (a) JWT interceptor implementation against chapter 05 §4 lock,
- (b) keychain integration against chapter 05 §1.X,
- (c) dev TCP listener prod-gate against §4 deliverable 5 of this chapter,
- (d) `cloudflared` spawn-arg + binary supply-chain checks.

Any HIGH-severity finding blocks M4 release until resolved. Process suggestion, not rigid; can be skipped only with explicit user sign-off recorded in the M4 plan.

## 8. Rollback strategy

**Within a milestone (post-PR-merge regression):**
- Revert the offending PR. Re-run CI. Move on.
- v0.3 → v0.4 transitions never roll back partial: all-or-nothing per milestone.

**Cross-milestone (e.g. M3 dogfood reveals M2-merged bug):**
- Fix forward in current branch; cherry-pick fix to a `release/v0.4.0-rcN-fix` branch if needed for an interim release.
- Generally avoid: M2 dogfood was supposed to catch this. If it didn't, extend M2 dogfood.

**Post-v0.4.0 release:**
- Catastrophic regression: `v0.4.1` hot-fix release within 24h.
- Cloudflare Pages: rollback to previous deploy via dashboard (one click, ~30s).
- Auto-update: pinned channel until hotfix verified.
- **Hotfix path probe (optional, recommended in M4 dogfood):** during the M4 7-day window, exercise the hotfix flow once — bump patch version on a throwaway tag, push to a test update channel, verify auto-update on a test machine picks it up. Confirms the hotfix path still works on v0.4 binaries before it is needed under pressure.

**Schema-additive enforcement (no destructive migrations).** v0.4's "no downgrade-to-v0.3 rollback" assumption rests on SQLite migrations being purely additive. To prevent this from silently breaking, CI runs a **schema-additive lint** that parses every migration file in `daemon/src/db/migrations/` between the v0.3 baseline and the current HEAD and fails the build if any migration:

- drops a table or column,
- alters a column type,
- adds a `NOT NULL` column without a default,
- renames a column or table.

A future PR that needs a destructive migration must first land an explicit "v0.5 schema break — downgrade no longer supported" announcement and version bump. Without this gate, a future PR could quietly break the implicit promise and a v0.4.x → v0.3 fallback could lose user data. [cross-file: see chapter 08 testing for the CI workflow specification.]

**Why no "downgrade to v0.3" rollback path:** v0.4 changes the SQLite schema only additively (enforced by the lint above); v0.3 binary against v0.4 SQLite would work but lose any v0.4-only data. Acceptable; documented but not engineered as a one-click flow.
