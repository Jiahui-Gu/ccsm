# 08 — Session model

> Authority: [final-architecture §2.7](../2026-05-02-final-architecture.md#2-locked-principles) ("backend-authoritative; clients are pure subscribers; snapshot + delta-from-`seq` replay; broadcast-all + last-writer-wins at the PTY layer; PTY is the serialization point; no locks; no 'primary' client; scrollback RAM-only").

## Authority and ownership

The daemon is the source of truth for every session. A client (Electron in v0.3, web/iOS in v0.4) is a **pure subscriber**: it has no local session state that the daemon doesn't know about. A client kill / reload / network blip MUST result in a re-subscribe and a re-paint identical to the daemon's view, with no client-resident data lost. **Why:** §2.7.

## Session identity

A session is identified by a server-minted `session_id` (ULID, sortable). The `session_id` is created by `SessionService.Create` and never reused. SQLite row in `sessions` table holds the durable metadata; in-memory `SessionRuntime` object holds the PTY handle and ring buffer.

## Snapshot + delta protocol

Every emitted byte from the PTY has a monotonically increasing `seq` (uint64, per-session). Subscribers attach by:

1. Calling `SessionService.Snapshot(session_id)` → returns `{seq_at: <last_seq_in_snapshot>, content: <ring buffer dump>, cols, rows}`.
2. Calling `SessionService.Subscribe(session_id, since_seq=seq_at)` → server-streams `Delta{seq, bytes}` for every new chunk.

If `since_seq` is older than the ring buffer's earliest retained seq, the server responds on the stream with a `Delta{seq:0, kind:RESET}` then closes; client MUST re-Snapshot. **Why:** ring buffer is bounded; truncation is the only honest signal; persistence (which would let history go arbitrarily far back) is deferred ([§3 scrollback persistence](../2026-05-02-final-architecture.md#3-what-this-doc-does-not-decide)).

## Multi-client writes (broadcast-all + LWW)

Three (or more) subscribers may concurrently call `PtyService.Write`. All writes are forwarded into the PTY in **arrival order at the daemon**; no per-client buffering, no fairness, no locks. The PTY itself is the serialization point. The PTY's output is **broadcast to every subscriber** (including the writer) over `SessionService.Subscribe` streams, in `seq` order.

Last-writer-wins is the natural consequence: if two clients each type a character at the same instant, the PTY sees them in arrival order and emits both; whichever character "wins" at the prompt is whichever the shell processed last. This is identical to two terminals tailing the same `tmux` pane. **Why:** §2.7 explicit.

## Fan-out registry sized for N ≥ 3 (day 1)

Each `SessionRuntime` holds a `Set<Subscriber>` with no upper-bound assertion. The fan-out path:

```
PTY data event (chunk)
  → assign next seq
  → append to ring buffer
  → for each subscriber in Set: enqueue Delta{seq, chunk}
```

The enqueue MUST be backpressure-aware: if a subscriber's stream backs up beyond `MAX_QUEUE_BYTES`, the daemon drops the slow subscriber (closes its stream with `Code.ResourceExhausted` and logs `subscriber.dropped.slow`). **Why:** one slow client must not hold up the others; this is the only correct behavior in a broadcast topology and applies identically at N=1, N=3, N=∞ — sizing for N=1 ("just one subscriber, why do I need a queue?") is the rework anti-pattern called out in [01](./01-goals-and-non-goals.md#anti-patterns-any-of-these-in-any-chapter--p0-reject).

## Scrollback (RAM only, in v0.3)

Ring buffer is the existing `xterm-headless` instance per session, with a fixed line cap (configurable, default e.g. 5000 lines). Scrollback persistence to SQLite is **deferred**; v0.3 ring buffer is unchanged. **Why deferred:** §2.7 ("scrollback: RAM-only … long-tail history persistence is a separate, later feature").

## Resize and signal

`PtyService.Resize` MUST broadcast a synthetic `Delta{kind:RESIZE, cols, rows}` to all subscribers so they re-fit local terminals. Last-writer-wins applies to resize too (the PTY's actual size after the call wins).

`PtyService.Signal` posts a Unix signal (or Windows equivalent — `Ctrl-C` injected via `node-pty.kill('SIGINT')`) to the claude CLI subprocess. No side effect on subscribers beyond what the subprocess emits.

## §8.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。session 语义 (backend-authoritative / snapshot+delta / broadcast+LWW / N>=3 fan-out / RAM ring buffer / slow-subscriber drop) 全部源自 final-architecture §2.7。v0.4 web/iOS 接入是**新增 subscriber**, 同一套 fan-out 代码服役。N>=3 day 1 = 不需要"扩容"的代码改动。Scrollback 持久化 (NG5) 进 v0.4 时是**新增** SQLite 写路径, 不修改 ring buffer 既有逻辑。**Why 不变:** §2.7 显式锁定。

## Cross-refs

- [06-proto-schema](./06-proto-schema.md) — `SessionService` / `PtyService` definitions.
- [09-pty-host](./09-pty-host.md) — implementation substrate.
- [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md) — durable session metadata.
