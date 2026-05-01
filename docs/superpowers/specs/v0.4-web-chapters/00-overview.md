# 00 — Overview

**Spec:** ccsm v0.4 — Web client + Connect/Protobuf protocol formalization
**Status:** draft (spec-pipeline stage 1)
**Author:** ccsm
**Base:** v0.3 daemon split (already merged on `working`)
**Predecessor design doc:** `docs/superpowers/specs/2026-04-30-web-remote-design.md`

## Context block

ccsm v0.3 split the Electron app into two processes — a headless Node `daemon/` (sessions, PTY, SQLite, CLI subprocess, Claude SDK) and a thin Electron client (tray + window + renderer). The two communicate over a same-machine same-user **named pipe (Win)** / **Unix socket (Mac/Linux)** using a **hand-rolled length-prefixed JSON envelope** with HMAC handshake, deadline / migration-gate interceptors, and per-frame chunking. Renderer still calls preload bridges (`window.ccsm*`) which today wrap `ipcRenderer.invoke` against Electron main; main forwards into the local daemon.

v0.4 finishes the long arc the v0.3 design doc sketched: **(a)** replace the hand-rolled envelope with **Connect + Protobuf** generated from a versioned `proto/` schema, **(b)** swap every preload bridge from `ipcRenderer.invoke` to a Connect client (bridge surface unchanged so the renderer is untouched), and **(c)** ship a **Web client** — a Vite SPA reusing the same React renderer code, deployed on **Cloudflare Pages**, talking to the user's local daemon via **Cloudflare Tunnel** with **Cloudflare Access (GitHub OAuth IdP)** in front and JWT validation middleware on the daemon.

Per user clarification 2026-05-01, v0.4 = "do the web client". The §8 release-slicing of the predecessor doc split this across v0.4 (protobuf only) + v0.5 (web + Cloudflare). v0.4 now bundles both. v0.5 becomes the next slice (mobile, multi-user sharing, etc. — out of scope here).

## What v0.4 ships

1. **`proto/` schema directory** — Protobuf v3 service + message definitions covering every existing IPC bridge call. `buf` toolchain (`buf lint`, `buf breaking`, `buf generate`) wired into CI. TypeScript bindings emitted into `gen/ts/` and consumed by both Electron renderer and the new Web client.
2. **Connect protocol on the daemon** — `@connectrpc/connect-node` server replacing the hand-rolled envelope on the data socket. The control socket (supervisor `/healthz`, `daemon.hello`, `daemon.shutdown*`, `/stats`) stays on the v0.3 hand-rolled envelope on a separate transport (per chapter 02 §6 — moving the supervisor surface to Connect is a v0.5 housekeeping item). Local socket peer-cred verification, ACL, and 16 MiB frame cap all preserved (Connect HTTP/2 framing inherits the cap natively).
3. **Bridge swap, all ~46 calls** — every `ipcRenderer.invoke('foo', ...)` in `electron/preload/bridges/*.ts` is replaced with a Connect client call; bridge function signatures unchanged so renderer code is untouched. Per chapter 03 §1 inventory: 31 unary + 4 fire-and-forget + 11 streams = 46 cross-boundary calls. Done in 4 PR-sized batches grouped by domain (read-only, then write, then streams).
4. **Web client (`web/` package)** — Vite SPA wrapping the same `src/` renderer code as Electron. Static build deployed to Cloudflare Pages on push to `main`. In dev, runs on `vite dev` against a locally running daemon (with Tunnel optional).
5. **Cloudflare layer** — `cloudflared` Tunnel (spawned by daemon when remote access is enabled), Cloudflare Access zero-trust application with GitHub OAuth IdP, JWT validation middleware on daemon's remote ingress.
6. **Auto-start at OS boot** — opt-in setting (default OFF), so remote-only access works when the desktop is closed. Surfaced in tray menu and Settings.

## Who it's for

Single-user remote access. The author's primary use case: Windows box at home running the daemon with sessions in flight; open `app.<your-domain>` from a work laptop or phone browser; pick up exactly where you left off. Multi-user / multi-tenant is explicitly out of scope (see chapter 01).

## Success criteria

A v0.4 release succeeds when **all** of the following hold for 7 consecutive days of dogfood:

1. **Electron path unchanged for end users** — no visible regression vs v0.3 in latency, throughput, reliability, or UI behavior. Local-only users notice nothing.
2. **Web client end-to-end** — author opens `https://app.<your-domain>` from a non-author network (work, phone-tether), authenticates via GitHub OAuth, lists sessions, opens a session, sees live PTY output, types into the session, and sees the result mirrored on the desktop client. No daemon restart required.
3. **Multi-client coherence** — Electron and Web simultaneously attached to the same session both see the same PTY buffer (snapshot + live ops). Inputs from either side are honored in arrival order; neither side diverges.
4. **Reconnect** — Web client survives a 30-minute network drop and resumes via `fromSeq` replay when within the fanout-buffer window OR via fresh snapshot when the drop exceeds the buffer (no data loss; user sees current PTY state on resume). Electron does the same when the daemon restarts. Per chapter 06 §6, the 256 KiB replay budget covers ~minutes of typical chat output but not 30 min of busy compile logs; the snapshot fallback covers the long tail. Chapter 08 §5 includes both short-drop (seq replay) and long-drop (snapshot fallback) tests.
5. **Protocol gate** — `buf breaking` against the previous tagged release (`v0.4.0-rc1` etc.) passes on every PR touching `proto/`. Schema changes that would break wire compat are blocked at CI.
6. **Auto-start works** — opt-in setting flipped ON, machine rebooted, daemon comes up before Electron is launched, web client is reachable within 30s of OS login.

## Why this matters

v0.3 paid the architecture cost (process split, daemon lifecycle, PTY headless buffer + seq replay, supervisor surface, SQLite migration). Without v0.4, that cost is invisible to the user — Electron talks to a local daemon over a private pipe, exactly as before. v0.4 cashes in the investment: the protocol becomes a real published wire surface (`buf` codegen, breaking-change gate), and the same daemon now serves a browser anywhere on the internet. Every future client (mobile, CLI, IDE plugin, alt UI) is downstream of v0.4's `proto/` + Connect server work.

## Out of scope (one-line each, expanded in chapter 01)

- Mobile (iOS/Android native) — deferred to v0.5+.
- Multi-user / multi-tenant daemon — single user only.
- Feature redesigns of the renderer (sidebar, terminal display, agent list, notify, etc.) — v0.4 is +frontend, not +features.
- Daemon-on-cloud (SaaS) — daemon stays on user's machine; Cloudflare is ingress only.
- Headless daemon with no Electron present — Electron remains the primary install path; web is additive.

## Document map

- **00 Overview** (this file)
- **01 Goals + non-goals**
- **02 Protocol** (Connect, Protobuf, `proto/` layout, `buf` CI)
- **03 Bridge swap** (`ipcRenderer.invoke` → Connect client, per-bridge plan)
- **04 Web client** (Vite SPA, shared-renderer packaging, Cloudflare Pages)
- **05 Cloudflare layer** (Tunnel, Access GitHub OAuth, JWT middleware)
- **06 Streaming + multi-client** (Connect server-stream, heartbeats, seq replay)
- **07 Error handling + edge cases**
- **08 Testing** (proto contract tests, Electron+web e2e, `buf` CI)
- **09 Release slicing** (M1–M4 inside v0.4)
- **10 Risks**
- **11 References**
