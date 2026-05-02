# 00 — Overview

> Status: DRAFT (Stage 1 author output, awaiting reviewer).
> Authority: [`2026-05-02-final-architecture.md`](../2026-05-02-final-architecture.md) — read it first; this chapter set is a strict refinement of that diagram, not a re-derivation.

## Ship goal (frozen)

v0.3 ships a **single ccsm-daemon binary** that exposes the **exact wire surface** the final architecture diagram demands, on the **exact two listeners** it demands, with **session semantics** identical to the multi-client v0.4 case — but with the cloudflared sidecar / web client / iOS client / OS-level supervisor / scrollback persistence intentionally not built. v0.3 is the topology, minus three optional consumers and one optional supervisor.

**Zero-rework guarantee.** Every line of code that ships in v0.3 must still be present, untouched, in v0.4 when web + iOS + cloudflared land. v0.4 = v0.3 + new files; v0.4 ≠ v0.3 + edits. If a chapter contains a TODO, a placeholder, a "v0.4 will rip this out", or a transitional shim, it has failed the ship goal and must be redesigned.

## True-subset claim

v0.3 ⊂ final-architecture means, concretely:

| Element of final-architecture §1 diagram | v0.3 ships | v0.3 defers |
|---|---|---|
| ccsm-daemon (single binary, backend-authoritative) | YES | — |
| Listener A (loopback / UDS, peer-cred trusted, JWT bypass) | YES, bound day 1 | — |
| Listener B (`127.0.0.1:PORT_TUNNEL`, JWT validated) | YES, bound day 1 | — |
| Connect-RPC over HTTP/2 data plane | YES, **only data plane** | — |
| Supervisor control plane (UDS, v0.3 envelope) | YES, hello-HMAC stripped | — |
| Session manager · PTY host · snapshot+delta · broadcast+LWW · N≥3 fan-out | YES | — |
| SQLite, cwd state, crash collector | YES (in-daemon) | — |
| Desktop client (Connect over Listener A) | YES | — |
| `cloudflared` sidecar | NO (Listener B has no consumer in v0.3) | v0.4 |
| Web client / iOS client | NO | v0.4 |
| Cloudflare Edge / Access JWT issuance | NO (validator code is on Listener B from day 1) | v0.4 |
| OS-level supervisor (launchd / Win Service / systemd-user) | NO | v0.4 |
| Scrollback persistence (long-tail history) | NO (RAM ring buffer only) | v0.4+ |
| Multi-machine semantics | NO | v0.4+ |

The deferred rows do not require v0.3 code to be deleted or rewritten. They require v0.3 code to be **bypassed** (Listener B with no sidecar consumer, OS supervisor not installed) or **extended** (more clients, more proto methods on the same Connect server).

## Diagram (verbatim from final-architecture §1)

See [final-architecture.md §1](../2026-05-02-final-architecture.md#1-the-diagram). Not duplicated here — the diagram is the source, this chapter set is the derivation.

## Reading order

1. [01-goals-and-non-goals](./01-goals-and-non-goals.md) — what v0.3 must do, must not do, and the anti-patterns that fail the ship goal.
2. [02-process-topology](./02-process-topology.md) — daemon process tree and lifecycle posture.
3. [03-listener-A-peer-cred](./03-listener-A-peer-cred.md), [04-listener-B-jwt](./04-listener-B-jwt.md) — the two listeners.
4. [05-supervisor-control-plane](./05-supervisor-control-plane.md) — what survives of the v0.3 envelope.
5. [06-proto-schema](./06-proto-schema.md), [07-connect-server](./07-connect-server.md) — the data plane wire.
6. [08-session-model](./08-session-model.md), [09-pty-host](./09-pty-host.md) — backend-authoritative session semantics.
7. [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md), [11-crash-and-observability](./11-crash-and-observability.md) — durable state and ops.
8. [12-electron-thin-client](./12-electron-thin-client.md) — the only v0.3 client.
9. [13-packaging-and-release](./13-packaging-and-release.md) — single binary, signing, three OS × two arch.
10. [14-deletion-list](./14-deletion-list.md) — files that MUST disappear; the bar for "v0.3 ships clean".
11. [15-testing-strategy](./15-testing-strategy.md) — UT/IT/e2e/dogfood smoke gate.
12. [16-risks-and-open-questions](./16-risks-and-open-questions.md) — what Stage 2 reviewer must adjudicate.

## §0.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。本章是导读 + 真子集口径声明。"v0.3 ⊂ final-architecture" 是一次性论断 — v0.4 落地不会让 v0.3 退出 final-architecture 的子集 (引 final-architecture §1 diagram)。表中 "v0.3 deferred" 的行在 v0.4 变成 "shipped", 但 v0.3 已写代码不动。

## Cross-refs

- [final-architecture §1](../2026-05-02-final-architecture.md#1-the-diagram) — the diagram that owns this spec.
- [final-architecture §2](../2026-05-02-final-architecture.md#2-locked-principles) — every "Why:" in subsequent chapters cites a numbered principle here.
- [final-architecture §3](../2026-05-02-final-architecture.md#3-what-this-doc-does-not-decide) — every "Why deferred:" cites this list.
