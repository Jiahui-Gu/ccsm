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

- v0.4-rc1 installer builds.
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

### Done definition

- v0.4-rc2 installer builds.
- Author runs the installer; all v0.3 functionality works; no envelope code on data socket (verifiable: `grep -r 'envelope' daemon/src/sockets/data-socket.ts` returns nothing).
- 1-week dogfood with no regressions.

## 4. M3 — Web client functional (local-only)

**Goal:** the web client renders and operates sessions, talking to the local daemon via the dev-mode TCP listener. No Cloudflare yet.

### Deliverables

1. `web/` package per chapter 04 §1.
2. `web/src/main.tsx` mounts shared `src/App.tsx`.
3. `web/src/bridges/*` web flavor of preload bridges, calling Connect-Web against the dev TCP listener.
4. `src/platform/getPlatform.ts` (or equivalent) — abstracts `process.platform` reads.
5. Dev TCP listener on daemon (`CCSM_DAEMON_DEV_TCP=7878`); MUST refuse to bind in production builds (compile-time gate via `process.env.NODE_ENV` check or build flag).
6. `npm run web:dev` runs Vite + the web client; talks to a locally running daemon.
7. Tests: L4 web e2e suite green (~6 cases). L5 multi-client e2e extended to include web client.
8. `web/dist/` build artifact produced by `npm run build:web`. Cloudflare Pages NOT wired yet.

### Done definition

- Author can run web client locally:
  1. `npm run daemon:dev` → daemon binds dev TCP listener.
  2. `npm run web:dev` → Vite dev server.
  3. Open `http://localhost:5174` → SPA loads, sees session list, opens session, types into terminal.
- Multi-client test (L5) passes: Electron and web on the same session see each other's input/output.
- 3-day dogfood: web client used at least 4-5 hours of real work locally with no critical regressions.

**Risk gate before M4:** if M3 dogfood reveals significant UX gaps (e.g. xterm.js rendering glitches in browser, keyboard shortcut conflicts), pause M4 and address. Don't paper over with Cloudflare polish.

## 5. M4 — Cloudflare wired, remote access live

**Goal:** the headline feature. Web client reachable from any network via Cloudflare Tunnel + Access; JWT validated by daemon.

### Deliverables

1. `cloudflared` binaries bundled in installer (Win/Mac/Linux x64+ARM64). Installer drops them in app resources path.
2. Daemon: `cloudflared` spawn/supervise logic (chapter 05 §1).
3. Daemon: JWT validation interceptor on remote ingress (chapter 05 §4).
4. Daemon: SQLite settings rows for tunnel token, CF team name, CF app AUD; encrypted at rest via OS keychain.
5. Electron Settings UI: "Remote access" pane with the 3-step setup wizard (chapter 05 §6).
6. Cloudflare Pages: GitHub integration set up; first deploy from `main` succeeds.
7. Auto-start at OS boot setting (chapter 01 G6) — opt-in toggle, default OFF, persists across reboots.
8. `daemon.unreachable` and `cloudflare.unreachable` banners surface correctly.
9. Tests: L6 Cloudflare smoke green on a CI tunnel + service-token JWT.
10. Documentation: `docs/web-remote-setup.md` user guide.

### Done definition

- v0.4.0 installer ready to ship.
- Author runs setup wizard, gets `<random>.cfargotunnel.com` hostname, opens `https://app.<author-domain>` (or `<deploy>.pages.dev`) from a phone tether (cellular network), signs in with GitHub, sees session list, opens session, types in terminal, sees Electron desktop mirror the input.
- 7-day dogfood per chapter 00 success criteria.
- Release tag `v0.4.0` cut.

## 6. Release tagging + version bumps

| Tag | Trigger | Distribution |
|---|---|---|
| `v0.4.0-rc1` | M1 done | Local installer; not pushed to update channel |
| `v0.4.0-rc2` | M2 done | Local installer; not pushed |
| `v0.4.0-rc3` | M3 done | Local installer; web NOT yet on Pages |
| `v0.4.0` | M4 done + 7-day dogfood passed | Push to update channel; Pages live |

**Why rcN tags during the milestones:** preserves "this is M2-complete" snapshot in git history. Useful if M3 hits trouble and we need to bisect or roll back.

**Daemon binary tag:** `daemon-v0.4.0-rcN` matching the Electron tag. Single installer, lockstep versions (chapter 02 §7).

## 7. Dogfood gates between milestones

Per `feedback_dogfood_protocol`: each milestone closure requires a dogfood window before the next milestone starts. Lengths:

| Gate | Duration | What's tested |
|---|---|---|
| Post-M1 | 24h | Connect path doesn't break first RPC; no daemon crash |
| Post-M2 | 7 days | Full Electron usage on Connect; multi-client (Electron+Electron) coherent; no regression vs v0.3 baseline |
| Post-M3 | 3 days | Web client operates sessions locally; matches Electron behavior |
| Post-M4 | 7 days | End-to-end remote access stable; auto-start works after OS reboot |

**Dogfood failures during a gate:** open issues; if HIGH severity (data loss, crash loop), pause next milestone until fixed. Per `feedback_correctness_over_cost`: never skip an issue to advance the schedule.

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

**Why no "downgrade to v0.3" rollback path:** v0.4 changes the SQLite schema only additively (no destructive migrations expected); v0.3 binary against v0.4 SQLite would work but lose any v0.4-only data. Acceptable; documented but not engineered as a one-click flow.
