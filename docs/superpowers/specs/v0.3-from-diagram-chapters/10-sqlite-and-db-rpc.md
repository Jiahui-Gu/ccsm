# 10 — SQLite and `db.*` Connect RPC

> Authority: [final-architecture §1 diagram](../2026-05-02-final-architecture.md#1-the-diagram) (SQLite inside daemon box), §2.1 (backend = source of truth).

## SQLite moves into the daemon

In v0.2 the renderer / main process opened SQLite directly via better-sqlite3. **In v0.3 only `ccsm-daemon` opens SQLite.** Electron talks to SQLite **only** via `DbService` Connect RPCs over Listener A. **Why:** §1 diagram (SQLite is inside the daemon box); §2.1 (single source of truth — two writers to the same DB file is a corruption surface, even on the same machine).

## File location

`${dataRoot}/db/ccsm.sqlite` (see [02-process-topology](./02-process-topology.md#filesystem-layout-per-os)). WAL mode. `synchronous=NORMAL`. Single-writer enforced by daemon owning the only handle.

## Schema (v0.3 minimum)

```sql
-- sessions
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,        -- ULID
  cwd          TEXT NOT NULL,
  args_json    TEXT NOT NULL,
  env_json     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  status       TEXT NOT NULL,           -- running | closed | interrupted
  exit_code    INTEGER
);
CREATE INDEX sessions_status ON sessions(status);

-- app_state — k/v store for client preferences, dataRoot anchors, last-window etc.
CREATE TABLE app_state (
  key          TEXT PRIMARY KEY,
  value_json   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- session_meta — per-session client-side notes/labels (not PTY content)
CREATE TABLE session_meta (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

-- migrations
CREATE TABLE schema_migrations (
  version      INTEGER PRIMARY KEY,
  applied_at   INTEGER NOT NULL
);
```

`schema_migrations` is consulted at daemon startup; missing migrations are applied in order, gated by file lock to defend against the second-instance race ([02 L5](./02-process-topology.md#lifecycle-rules-v03)).

**Crash dumps and structured logs are NOT in SQLite.** They're files under `${dataRoot}/logs/` and `${dataRoot}/crash/` ([ch.11](./11-crash-and-observability.md)). **Why:** crash collector must work even when SQLite is the thing that crashed.

## `DbService` shape

See [06-proto-schema](./06-proto-schema.md#ccsmv1dbservice). Methods are intentionally generic:

- `AppStateGet(key) → value | NotFound`
- `AppStateSet(key, value)` — upsert
- `SessionMetaGet/Set/List`

This avoids a per-feature RPC per UI surface; the renderer stores its preferences blob under `app_state['ui.preferences.v1']` etc. **Why generic:** the alternative (one RPC per typed key) would force a daemon proto change every time the UI adds a preference; that's cross-process churn for no gain.

`schema_migrations` is **not** exposed over RPC. **Why:** schema is the daemon's contract with itself; clients have no business reading it.

## Concurrency

`better-sqlite3` is synchronous in-process; the daemon serializes DB calls on a dedicated worker (or just the main event loop with WAL — depending on Connect throughput observed at dogfood). Concurrent Connect callers see linearizable reads/writes. **Why:** clients are subscribers ([§2.7](../2026-05-02-final-architecture.md#2-locked-principles)) and expect the DB to behave like a server — not like a shared file.

## Forbidden

- Renderer importing `better-sqlite3`. **Why:** double-writer corruption + violates topology.
- Exposing raw SQL over RPC. **Why:** schema becomes a client contract; v0.4 web client cannot be trusted to write SQL.
- Storing PTY scrollback in SQLite (deferred — see [01 NG5](./01-goals-and-non-goals.md#non-goals-must-not-ship-in-v03)).

## §10.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。SQLite 在 daemon 内、单 writer、WAL、`DbService` 通用 KV 接口、schema_migrations 内部不暴露 — 全部源自 final-architecture §1 diagram + §2.1。v0.4 web/iOS 通过同一个 `DbService` RPC 读写 (透过 cloudflared -> Listener B)。Scrollback 进 SQLite (v0.4+) 是新增 table + 新增 RPC, 不修改 v0.3 现有 schema 或方法。**Why 不变:** §2.1 (single source of truth) + §1 diagram。

## Cross-refs

- [01-goals-and-non-goals](./01-goals-and-non-goals.md) — G9, NG5.
- [06-proto-schema](./06-proto-schema.md) — DbService.
- [11-crash-and-observability](./11-crash-and-observability.md) — files, not DB.
- [14-deletion-list](./14-deletion-list.md) — renderer SQLite imports to delete.
