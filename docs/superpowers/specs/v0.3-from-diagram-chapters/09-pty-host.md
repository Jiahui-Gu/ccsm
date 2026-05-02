# 09 — PTY host

> Authority: [final-architecture §1 diagram](../2026-05-02-final-architecture.md#1-the-diagram) ("PTY host (xterm-headless, snapshot+delta) · claude CLI subprocess" inside daemon box), §2.7 (PTY is the serialization point).

## PTY moves into the daemon

In v0.2 the PTY ran in Electron's main process. **In v0.3 the PTY runs inside `ccsm-daemon`.** Electron has zero `node-pty` import. **Why:** §1 diagram explicit; §2.7 ("backend-authoritative; clients are pure subscribers" — a client cannot host the PTY and remain a subscriber).

## Substrate

- **`node-pty`** for the PTY syscalls. Win prebuild MUST be vendored ([13-packaging-and-release](./13-packaging-and-release.md)) or built at install time; v0.3 vendors prebuilds for all six target tuples to keep the user install free of a C++ toolchain.
- **`xterm-headless`** for the per-session ring buffer (`@xterm/headless`).
- **`ccsm_native`** — a minimal native module (Rust or C++ via N-API) holding any non-portable bits: peer-cred socket options that aren't in Node core, fast UTF-8 chunk normalization for the fan-out, and Windows named-pipe ACL setup. **Why a native module at all:** UDS peer-cred plus named-pipe SID extraction need OS calls Node doesn't expose portably; a small native is cheaper than three platform-specific JS shims.

## File layout

```
daemon/src/pty/
├── runtime.ts          (SessionRuntime: holds pty + headless terminal + subscriber set + seq)
├── fanout.ts           (Subscriber registry + backpressure)
├── ringbuffer.ts       (xterm-headless wrapper; dump = Snapshot)
├── claude-spawn.ts     (spawns claude CLI with cwd, env, args)
└── resize.ts           (cols/rows updates + broadcast)
daemon/native/ccsm_native/
├── Cargo.toml          (or binding.gyp if C++)
├── src/lib.rs
└── prebuilds/          (six target tuples: darwin-{arm64,x64} linux-{arm64,x64} win32-{x64,arm64})
```

## Lifecycle of a session

1. `SessionService.Create({cwd, env, args})` → daemon mints `session_id`, inserts row in `sessions`, calls `claude-spawn.ts` to fork PTY, registers in `SessionRuntime`. Returns `Session`.
2. PTY emits data → `runtime.ts` appends to xterm-headless ring + assigns `seq` + fans out via `fanout.ts`.
3. Subscribers join via `Snapshot` + `Subscribe` ([ch.08](./08-session-model.md)).
4. Writers drive PTY via `PtyService.Write`.
5. On PTY exit: emit final `Delta{kind:EXIT, exit_code}`, close all subscriber streams, mark row `closed`. Ring buffer retained for late `Snapshot` calls until session is GC'd (configurable retention, default 1h).
6. On `SessionService.Close`: SIGTERM PTY, then SIGKILL after grace.

## Snapshot semantics

`xterm-headless.serialize()` (or equivalent buffer dump) gives a textual representation of the visible buffer + scrollback up to the line cap. The Snapshot RPC returns this verbatim plus `seq_at = currentSeq` (the highest `seq` whose bytes are reflected in the dump). Subscriber's first `Subscribe(since_seq=seq_at)` therefore picks up at the next byte. **Why:** §2.7 — snapshot+delta-from-seq is the contract.

## Daemon crash handling

On daemon crash, all PTY children die (they are in the daemon's process group). On respawn, sessions in SQLite marked `running` are downgraded to `interrupted`; clients see `Snapshot` succeed (last persisted state) but `Subscribe` immediately closes with `Code.FailedPrecondition`. Clients render an "interrupted, please restart" UI. **Why:** PTY-process resurrection across daemon restarts is a feature requiring scrollback persistence and detached-PTY tricks; both are deferred ([§3](../2026-05-02-final-architecture.md#3-what-this-doc-does-not-decide)).

## §9.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。PTY 在 daemon 内 (而非 Electron), node-pty + xterm-headless + ccsm_native 选型, 六 target prebuild, daemon-crash 下 PTY 死 + 标 interrupted — v0.4 全部沿用。v0.4 加 web/iOS 时 PTY 完全不知道 client 类型 (它只面对 fan-out registry)。Cross-restart PTY 复活属于"scrollback 持久化"那条 v0.4+ 新功能, 是新增模块不是修改本章。**Why 不变:** final-architecture §1 diagram (PTY host 在 daemon 框内) + §2.7 (clients are subscribers — PTY 不区分 client)。

## Cross-refs

- [08-session-model](./08-session-model.md) — semantics this chapter implements.
- [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md) — session row schema.
- [13-packaging-and-release](./13-packaging-and-release.md) — node-pty / ccsm_native prebuild bundling.
