# 16 — Risks and open questions

> Status of each item: **R** = risk to flag and mitigate; **Q** = open question for Stage 2 reviewer to adjudicate.

## R1 — Listener B unconfigured looks like a half-built feature

In v0.3 Listener B is bound but has no consumer. A new contributor seeing "the JWT interceptor rejects everything by default" may be tempted to "just turn it off for dev" — which is the [§2.3 violation](../2026-05-02-final-architecture.md#2-locked-principles).

**Mitigation:** [04 placeholder-safe defaults](./04-listener-B-jwt.md#placeholder-safe-defaults-v03) keeps the interceptor structurally installed and emits `listenerB.unconfigured` log; CI lint forbids header-bypass. Ch.01 anti-patterns explicitly call this out.

## R2 — `node-pty` Windows prebuilds drift

`node-pty` Windows builds historically need a matching Node ABI; if `@yao-pkg/pkg`'s embedded Node moves and we forget to rebuild, daemon binary on Windows segfaults at first session.

**Mitigation:** CI matrix runs `node-pty.spawn('cmd.exe', ...)` smoke test on every Windows artifact post-bundle. Block release on failure.

## R3 — `xterm-headless` snapshot encoding

Snapshot returns a textual dump from `xterm-headless`. Truncation or encoding bugs in serialization could drift between snapshot and live deltas, causing "double print" or "missing first line" UX.

**Mitigation:** IT-S1 + IT-S4 specifically diff snapshot+deltas against a parallel live capture. Chapter [09](./09-pty-host.md) names `serialize()` as the contract — Stage 2 reviewer should verify this is byte-stable.

## R4 — UDS HTTP/2 on Windows named pipes via @connectrpc/connect-node

Connect-Node over UDS works on POSIX; over Windows named pipes the `http2` module requires a custom socket adapter. **Q for reviewer:** is the Connect-Node + Windows named pipe combination known-good with HTTP/2, or do we need a fallback to HTTP/1.1 server-streaming on Windows (which Connect supports via long-poll)? If fallback, document explicitly in [ch.07](./07-connect-server.md) — keeping it as silent runtime-detection is a hidden compatibility cliff.

## R5 — `ccsm_native` build complexity

Adding a Rust/C++ native module increases the build matrix and the contributor onboarding cost. **Q for reviewer:** can the native bits be replaced by `node-gyp` + small C bindings, or by pure-JS shims with per-platform branches? The [ch.09 rationale](./09-pty-host.md#substrate) ("a small native is cheaper than three platform-specific JS shims") deserves scrutiny.

## R6 — In-process supervisor's relevance shrinks to almost nothing

[ch.11 in-process supervisor](./11-crash-and-observability.md#crash-loop--rollback-in-process-supervisor-leftover) is now just crash-loop counter + `.bak` rollback. **Q for reviewer:** is this still worth being in-process at all, or should it move to a tiny launcher binary (`ccsm-launch`) that the OS supervisor (v0.4) can replace? In v0.3 the in-process version is fine; the question is whether to anticipate the v0.4 split now. Per zero-rework rule, anticipating = OK only if no v0.3 code is "transitional"; reviewer to judge.

## R7 — Connect message size and PTY chunking

PTY emits arbitrary byte chunks; Connect default max message size is generous but not infinite. **Mitigation:** `fanout.ts` re-chunks above `MAX_DELTA_BYTES` (e.g. 256 KiB). Reviewer to confirm chunk size matches xterm-headless's expectations.

## R8 — Backpressure-induced slow-subscriber drops mid-typing

If the Electron renderer briefly stalls (GC pause, devtools open), a fan-out drop ([ch.08](./08-session-model.md#fan-out-registry-sized-for-n--3-day-1)) would drop the user's own client. **Q for reviewer:** should `MAX_QUEUE_BYTES` be substantially larger for the local Listener A subscribers (where memory cost is cheap and dropping the user is catastrophic) than for Listener B (where remote slowness is more likely)? If yes, document the per-listener tunables in ch.08 explicitly.

## R9 — Supervisor envelope on a separate UDS doubles the local-socket count

[ch.05](./05-supervisor-control-plane.md) keeps supervisor on its own UDS distinct from Listener A. **Q for reviewer:** could supervisor methods piggy-back on Listener A's Connect server as a separate `SupervisorService` while still being "control plane" semantically? Tradeoff: fewer sockets vs. mixing wire formats. Current spec keeps them separate per §2.8 literal reading; reviewer to confirm.

## R10 — Dogfood baseline drift vs v0.2

M1/M2/M4 in [ch.15](./15-testing-strategy.md#dogfood-smoke-gate-release-blocker) compare against v0.2 numbers. v0.2 had no Connect overhead; v0.3 will be slower on round-trip. **Mitigation:** the targets allow +/- a margin; if real numbers exceed margin, the answer is **not** to weaken the gate — it is to revisit ch.07 (codec, compression) or ch.09 (chunk size). Reviewer should confirm the margins are realistic.

## §16.Z Zero-rework self-check

本章是**风险与未决项清单**, 按设计本身就该在 v0.4 时**关闭/合并**部分条目 (R1 在 cloudflared 接入后失效; R6 在 OS supervisor 接入后定调; R10 在 v0.4 重设基线时调整)。这不是 v0.3 代码被修改, 是 v0.3 spec 文档被更新 — 文档演进不在零返工口径之内。R2/R3/R4/R5/R7/R8 是 v0.3 实现细节风险, 关闭后不复出现, 不会在 v0.4 因为加 web/iOS 而被重新打开。

## Cross-refs

- All preceding chapters (this is the catch-basin).
