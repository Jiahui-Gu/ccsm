# 11 — Crash collector and observability

> Authority: [final-architecture §1 diagram](../2026-05-02-final-architecture.md#1-the-diagram) ("crash collector" inside daemon box).

## Goals

- Capture daemon crashes (segfault, unhandled rejection, OOM) with enough context to debug post-mortem.
- Capture child-process crashes (claude CLI subprocess) with exit code, last-N-lines stderr.
- Stream structured logs from every component to disk + optional Sentry.
- Surface lifecycle events (crash, rollback, restart) on the supervisor `supervisor.event` push channel ([ch.05](./05-supervisor-control-plane.md)).

## File layout

```
${dataRoot}/
├── logs/
│   ├── daemon.log            (current; rotated)
│   ├── daemon.log.1
│   └── ...
├── crash/
│   ├── 2026-05-02T14-22-11Z-<pid>.dmp   (native dump if available)
│   ├── 2026-05-02T14-22-11Z-<pid>.json  (structured context: version, build_sha, last log lines, OS info)
│   └── ...
└── runtime/
    ├── daemon.pid
    ├── port-tunnel
    └── crashloop.json        (counter for in-process supervisor)
```

## In-daemon crash collector

A native crash handler (via `crashpad` if linked, or pure Node `process.on('uncaughtException' / 'unhandledRejection')` + signal handlers as a fallback) writes:

1. The `.json` context immediately on crash (synchronous fs write).
2. The native `.dmp` if a crashpad-style handler is in use (out-of-process).
3. A line to `daemon.log` describing the event.

On next start, the daemon scans `crash/` for any unsent dumps; if Sentry is configured, it uploads. Either way, it emits a `supervisor.event{kind:"crashed", prevExitCode, ...}` to any connected supervisor client.

## Crash-loop + rollback (in-process supervisor leftover)

The in-process supervisor ([§2.9](../2026-05-02-final-architecture.md#2-locked-principles)) keeps `crashloop.json = {attempts, first_attempt_at, last_version, last_build_sha}`. If `attempts > N` within `T` seconds with the same version, daemon refuses to start the new version's binary and instead invokes `${binary}.bak` (the previous-good binary preserved by the installer). **Why:** §2.9 explicit. This is the **only** thing the in-process supervisor still does — it does not "keep the daemon alive".

## Logging

- **Structured JSON lines** to `daemon.log`. Schema: `{ts, level, event, ...fields}`.
- **Per-request logs** from Connect interceptor ([ch.07](./07-connect-server.md)) include `{listener:"A"|"B", method, code, duration_ms}`.
- **Listener B unauthenticated** events log at `warn` (one line per request, sampled if rate exceeds threshold).
- **Sentry** optional via env (`CCSM_SENTRY_DSN`). Off by default. When on, structured errors and crash dumps are uploaded; PII scrubber strips `cwd`, `env`, JWT contents, and ring buffer bytes.

## What clients see

Electron does not poll log files. It receives:
- `supervisor.event` push for lifecycle (crashed, rolled back, restarting).
- Connect RPC errors for in-flight operation failures (mapped via `interceptors/error-map.ts`).
- `ControlService.ServerInfo` for version / uptime / readiness.

## §11.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。crash collector + 文件布局 (`logs/`, `crash/`, `runtime/`) + 结构化 JSON 日志 + 可选 Sentry + `.bak` 回滚 — v0.4 全部沿用。v0.4 OS supervisor 接入时, 它读同一个 `daemon.pid` / 写同一个 `crashloop.json`, 不强迫 in-process supervisor 改动 (问题已在 §16 R6 列为 open question 供 reviewer 调; 当前 spec 答案是不改)。**Why 不变:** final-architecture §1 diagram (crash collector 在 daemon 框内) + §2.9 (in-process supervisor 仅 crash-loop+rollback)。

## Cross-refs

- [05-supervisor-control-plane](./05-supervisor-control-plane.md) — `supervisor.event` push channel.
- [07-connect-server](./07-connect-server.md) — request log interceptor.
- [13-packaging-and-release](./13-packaging-and-release.md) — `.bak` provenance.
