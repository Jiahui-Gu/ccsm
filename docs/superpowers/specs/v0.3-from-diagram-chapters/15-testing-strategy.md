# 15 — Testing strategy

> Authority: [01 G10](./01-goals-and-non-goals.md#goals-must-ship-in-v03) (dogfood smoke gate, 4 metrics).

## Tiers

### Unit tests (UT)

Per-module, fast, in-process. Cover:
- `daemon/src/connect/peer-cred.ts` — happy path + rejection ([ch.03 T-A1..A3](./03-listener-A-peer-cred.md#test-matrix-referenced-from-15-testing-strategy)).
- `daemon/src/connect/jwt.ts` — full T-B1..B10 matrix ([ch.04](./04-listener-B-jwt.md#ut-matrix-referenced-from-15-testing-strategy)).
- `daemon/src/pty/fanout.ts` — N=3 broadcast, slow-subscriber drop, seq monotonicity.
- `daemon/src/pty/ringbuffer.ts` — snapshot reproducibility, line cap eviction.
- `daemon/src/db/migrations.ts` — apply/idempotent.
- Connect codec round-trips for every method in `proto/`.

### Integration tests (IT)

In-process or per-binary, real sockets / pipes / SQLite, mocked PTY where the OS doesn't allow.

- IT-L1: bind both listeners, verify `port-tunnel` file written, ServerInfo reflects ready state.
- IT-L2: kill listener A's underlying socket file; daemon health-degrades but Listener B still serves.
- IT-S1: Create → Snapshot → Subscribe round-trip with one client.
- IT-S2: same, with three concurrent subscribers (covers fan-out N=3 from day 1).
- IT-S3: slow subscriber with throttled stream — verify dropped at `MAX_QUEUE_BYTES`, others unaffected.
- IT-S4: ring-buffer truncation surfaces as `Delta{kind:RESET}`.
- IT-D1: DbService AppStateSet/Get round-trip; concurrent set from two clients linearizable.
- IT-E1..E3: Electron lifecycle decoupling ([ch.12](./12-electron-thin-client.md#lifecycle-decoupling-verified-by-it)).
- IT-X1: Listener A connection from a same-UID process succeeds; cross-UID fails (Linux).
- IT-X2: Listener B request without JWT → Unauthenticated; with valid JWT → handler invoked.

### End-to-end (e2e)

Full Electron + daemon on each OS. Smoke-level only:

- E2E-1: app launch → first PTY byte visible in renderer.
- E2E-2: type / receive echo loop.
- E2E-3: open second window pointing at same daemon → both render same session.

### Dogfood smoke gate (release blocker)

Four metrics, captured on each tag candidate, comparing to v0.2 baseline:

| Metric | Target |
|---|---|
| M1 cold start (Electron launch → first PTY byte) | <= v0.2 + 20% |
| M2 PTY echo round-trip latency (p50, p99) | within v0.2 +/- 10% |
| M3 daemon survives Electron renderer kill + main kill, re-attach restores session | binary pass/fail |
| M4 SQLite write throughput with 3 concurrent Connect clients | >= v0.2 single-client throughput |

Baseline numbers are captured in a `tools/dogfood-baseline.json` file at v0.2.x tag time and used as the reference for the gate. If v0.3 misses any metric, tagging blocked until the responsible chapter's design is revisited.

## Harness

- UT: `vitest` (already in repo, presumably).
- IT: `vitest` + spawned daemon binary in test-fixtures dir; per-test `dataRoot` under `os.tmpdir()`.
- e2e: `playwright` driving Electron via `_electron.launch`.
- Dogfood: a `tools/dogfood-bench.ts` script that boots daemon + Electron, runs each metric, writes JSON results comparable across runs.

## CI placement

- UT + most IT: every PR.
- e2e: every PR on macOS + Linux (Windows e2e is heavier; nightly + tag).
- Dogfood gate: tag builds only; manual approval to override (admin override is **not** allowed by branch protection per [project_branch_protection_working](../../) — admin override is locked).

## §15.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。所有 v0.3 测试 (UT/IT/e2e/dogfood) 在 v0.4 时**只会增加**新测试 (web client e2e、cloudflared sidecar IT、JWT 实参 UT 替换 placeholder), 不会修改现有 v0.3 测试断言, 因为 v0.3 的语义 (peer-cred trust on A, JWT validate on B, fan-out N>=3, snapshot+delta, lifecycle decoupling) 在 v0.4 同样为真 (引 final-architecture §2.3, §2.7, §2.9)。

## Cross-refs

- [01-goals-and-non-goals](./01-goals-and-non-goals.md) — G10.
- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md), [04-listener-B-jwt](./04-listener-B-jwt.md) — UT matrices sourced here.
- [12-electron-thin-client](./12-electron-thin-client.md) — IT-E1..E3.
- [13-packaging-and-release](./13-packaging-and-release.md) — CI matrix.
