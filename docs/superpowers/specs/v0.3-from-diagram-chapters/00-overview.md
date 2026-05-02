# 00 — Overview

> **Status:** v0.3 design spec (Stage 1 author draft, 2026-05-02). Authoritative input: [`../2026-05-02-final-architecture.md`](../2026-05-02-final-architecture.md). Any conflict with prior `v0.3-design.md` / `v0.3-fragments/*` resolves in favor of final-architecture.

## What v0.3 is

v0.3 is the **first concrete slice** of the topology frozen in `2026-05-02-final-architecture.md`. It ships exactly one client (desktop / Electron) and exactly one daemon binary on the user's machine. It does NOT ship cloudflared, web client, iOS client, or an OS-level service installer.

Despite shipping only one client, **every backend interface required by the final architecture is already present in v0.3**. v0.3 is a *real subset* of final architecture, not a prototype that will be reshaped.

## The zero-rework guarantee

> Every line of code that ships in v0.3 MUST remain unchanged when v0.4 adds web + iOS + cloudflared. v0.4 work is **additive**: generate more client stubs, install a sidecar binary, install an OS service unit. v0.4 does not delete, replace, or refactor v0.3 daemon code.

This guarantee is the single load-bearing constraint of this spec. It governs every "MUST" in chapters 01-16. Any v0.3 design choice that forces v0.4 to delete or refactor v0.3 code is a P0 spec defect.

**Why:** see [`../2026-05-02-final-architecture.md`](../2026-05-02-final-architecture.md) §2 principles 1-10 + the "frozen baseline" status header.

## True-subset construction (the recipe)

The v0.3 ship is constructed by **deleting clients and sidecars** from the final-architecture diagram, then verifying the daemon side is unchanged:

| Final-architecture component        | v0.3 disposition                                    |
| ----------------------------------- | --------------------------------------------------- |
| GitHub OAuth IdP                    | not used (no remote auth path active)               |
| Cloudflare Access / Tunnel edge     | not used                                            |
| `cloudflared` sidecar (local)       | NOT spawned. Listener B has no consumer             |
| Listener B (`127.0.0.1:PORT_TUNNEL`) | **bound, JWT interceptor live, UT exhaustive**      |
| Listener A (peer-cred UDS / pipe)   | bound, peer-cred enforced                           |
| ccsm-daemon (single binary)         | shipped, full Connect-RPC surface                   |
| Supervisor control plane (envelope) | shipped, hello-HMAC removed                         |
| Session manager / PTY host / SQLite | shipped inside daemon                               |
| Desktop client (Electron)           | shipped as pure thin client over Listener A         |
| Web client                          | NOT shipped (proto schema exists)                   |
| iOS client                          | NOT shipped (proto schema exists)                   |

The only items above that "do nothing useful" in v0.3 are Listener B and the JWT interceptor — and they MUST still be live and tested, because the cost of leaving them out is exactly what v0.4 returns to fix.

## What this chapter set covers

| Chapter | Scope                                                                           |
| ------- | ------------------------------------------------------------------------------- |
| 01      | Goals, non-goals, anti-patterns                                                 |
| 02      | Process topology, daemon OS lifecycle, cloudflared placeholder                  |
| 03      | Listener A — UDS / named pipe + peer-cred (3 OS)                                |
| 04      | Listener B — TCP loopback bind + CF-Access JWT interceptor + UT matrix          |
| 05      | Supervisor control plane (envelope retained, hello-HMAC stripped)               |
| 06      | `proto/` schema (5 services, server-streaming, buf CI)                          |
| 07      | Connect-Node server scaffold; mounting both listeners                           |
| 08      | Backend-authoritative session model (snapshot+delta, broadcast, LWW)            |
| 09      | PTY host inside daemon (`ccsm_native`, node-pty Win prebuild)                   |
| 10      | SQLite inside daemon; `db.*` Connect service                                    |
| 11      | Crash collector inside daemon; Sentry symbol upload; log rotation               |
| 12      | Electron thin client (Connect over Listener A; renderer/main kill survives)     |
| 13      | Packaging + signing + release (single binary, 3 OS × 2 arch, installer size)    |
| 14      | Deletion list (envelope data plane ~1100 LOC, hello-HMAC, trace-id-map, etc.)   |
| 15      | Testing strategy (UT/IT/e2e/dogfood)                                            |
| 16      | Risks + open questions for downstream specs                                     |
| 17      | Zero-rework acceptance checklist (ship gate)                                    |

## How to read

- **Reviewer:** read 00 → 01 → 14, then dive into the area you're reviewing. The deletion list (14) is the fastest way to see what's *gone* relative to v0.2/v0.3-old.
- **Implementer of one area:** find the chapter for your area; read its "Cross-refs" tail to discover the chapters that frame your contract.
- **Manager planning Stage 6 DAG:** every chapter is parallelizable except where "blockedBy" appears in its Cross-refs section.

## Cross-refs

- [01 — Goals and non-goals](./01-goals-and-non-goals.md)
- [14 — Deletion list](./14-deletion-list.md)
- [17 — Zero-rework acceptance checklist (ship gate)](./17-zero-rework-acceptance-checklist.md)
- [`../2026-05-02-final-architecture.md`](../2026-05-02-final-architecture.md) (authoritative baseline)
