# 05 — Supervisor control plane

> Authority: [final-architecture §2.8](../2026-05-02-final-architecture.md#2-locked-principles) ("supervisor control plane … stays on the local UDS with the v0.3 hand-rolled envelope. Unchanged"), §2.9 (in-process supervisor = crash-loop counter + `.bak` rollback).

## Scope (what stays on the envelope)

The supervisor control plane is a **separate** UDS / named-pipe (NOT Listener A) speaking the existing v0.3 hand-rolled length-prefixed envelope. It carries **only** the methods listed below; all other RPCs MUST go through the Connect data plane on Listener A or B.

| Method | Direction | Purpose |
|---|---|---|
| `GET /healthz` (envelope-wrapped) | client → daemon | liveness probe; returns `{ok, pid, started_at, listener_a_ready, listener_b_ready}` |
| `daemon.hello` | client → daemon | initial handshake; client sends version + capabilities; daemon responds with version + supervisor-supported method list |
| `daemon.shutdown` | client → daemon | graceful shutdown (SIGTERM-equivalent) |
| `daemon.shutdownForce` | client → daemon | immediate shutdown (post-grace) |
| `supervisor.event` | daemon → client (push) | crash-loop / rollback events; `{kind, attempt, prevExitCode, rolledBackFromVersion?}` |

That is the full surface. **Why so small:** §2.8 calls this "the v0.3 envelope, unchanged" — but "unchanged" is a posture, not a license to import every legacy method. Anything beyond lifecycle is data plane, which means Connect.

## Address

- **POSIX:** `${runtimeDir}/ccsm/supervisor.sock`, mode `0600`. Distinct from Listener A's `sock`.
- **Windows:** `\\.\pipe\ccsm-supervisor-<sid>`. Distinct from Listener A's pipe.

Peer-cred check ([03-listener-A-peer-cred](./03-listener-A-peer-cred.md)) is enforced identically here (same code path).

## hello — HMAC removed

The v0.2 `daemon.hello` carried an HMAC over a shared secret to prevent rogue same-host processes spoofing the Electron client. **In v0.3 this HMAC is removed.** Reasons (Why):

1. **Peer-cred subsumes it.** The supervisor socket is mode-0600 and peer-cred-checked; a rogue same-UID process is already privileged enough to read the secret.
2. **Carrying it forward = rework.** v0.4's identity story is "transport-keyed trust" with no shared secret anywhere; keeping HMAC in v0.3 means v0.4 must edit/delete code in `daemon/src/supervisor/hello.ts` and clients. That violates the [zero-rework rule](./00-overview.md#ship-goal-frozen).
3. **No threat-model regression.** Same-host same-UID was never blocked by HMAC anyway (the secret was readable).

Concrete deletions are enumerated in [14-deletion-list](./14-deletion-list.md).

## What is forbidden on the supervisor plane

- Any session / PTY / DB RPC. **Why:** §2.8 — those are data plane.
- Any auth header. **Why:** transport-keyed trust.
- Bidirectional streams beyond `supervisor.event` push. **Why:** envelope is line-oriented; streaming primitive is Connect's job.

## §5.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。supervisor 控制面方法集 (healthz / hello / shutdown / shutdownForce / supervisor.event) 在 v0.4 完全相同。HMAC 一旦在 v0.3 删掉, v0.4 不会"恢复"它 — final-architecture §2.5 (no backend-issued tokens, no shared secrets) 永久禁止。v0.4 OS supervisor 接入时, 它**通过这同一个**控制面 socket 调 healthz/shutdown, 不引入新方法。**Why 不变:** §2.8 ("supervisor control plane … unchanged") 显式承诺。

## Cross-refs

- [02-process-topology](./02-process-topology.md) — L1, L2, L3.
- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md) — peer-cred mechanism reused here.
- [11-crash-and-observability](./11-crash-and-observability.md) — `supervisor.event` consumes from crash collector.
- [14-deletion-list](./14-deletion-list.md) — HMAC code removal.
