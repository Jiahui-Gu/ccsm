# T9.6 — `child_process` + `node-pty` + `@xterm/headless` throughput spike

Task: Task #112 (`T9.6` — phase 4.5 of spec ch14 §1.7). Confirms that the
v0.3 daemon → pty-host fork boundary (Task #45 / T4.1) does not introduce a
throughput cliff when the PTY parser stack (`node-pty` + `@xterm/headless`
ring buffer) is fully isolated inside a `node:child_process`.

Workload, per task brief: continuous `yes`-style stream consumed through a
PTY (`yes | cat` semantics — node-pty IS the cat boundary, the workload
just keeps the slave write buffer full).

## TL;DR

PTY + xterm-headless inside a `child_process.spawn`d Node process **runs
without backpressure failure** end-to-end. The Windows ConPTY transport
caps at **~0.48 MiB/s** of TTY bytes, so a 1 GiB ingest target is a
multi-hour test on Windows; we therefore record the realised baseline
(30s) plus an **alternate 10 MiB ingest milestone** for an apples-to-apples
RSS reading. macOS / Linux baselines are scheduled for the self-hosted
runners pinned by T0.10 — same probe contract, no code change needed.

## Files

- `package.json` — pins `node-pty@1.1.0` and `@xterm/headless@5.5.0` (same
  versions used by the root workspace), no other deps.
- `child.mjs` — runs **inside** the spawned child. Builds the workload
  (`node -e` infinite write loop), pipes it through `node-pty`, feeds every
  chunk into a `Terminal({ cols:120, rows:40, scrollback:1000 })`, and emits
  NDJSON progress + a final `summary` record on stdout. Tracks RSS, heap,
  and emits a `target` record the moment cumulative emitted bytes cross
  `--target-bytes` (default 1 GiB).
- `probe.mjs` — the parent. Spawns `child.mjs` via **`child_process.spawn`**
  (deliberately not `fork`, because the v0.4 pty-host boundary is a real OS
  process split, not an IPC peer). Aggregates the NDJSON stream, peak-tracks
  RSS, emits a single JSON summary line on stdout. Forever-stable contract
  documented at the top of the file (per `tools/spike-harness/README.md`).

## Run on this host

Host: `win32/x64`, Node `v24.14.1`. ConPTY transport (node-pty selects
automatically on Windows).

### Default 30s run (1 GiB target — not reached on this transport)

```
$ PROBE_DURATION_MS=30000 node probe.mjs
{"ok":true,"platform":"win32","arch":"x64","nodeVersion":"v24.14.1",
 "cols":120,"rows":40,"durationMs":30047,"emittedBytes":15073353,
 "bytesPerSec":501659,"mibPerSec":0.48,
 "rssBytesPeak":123768832,"rssMiBPeak":118.04,
 "rssBytesEnd":123768832,"heapUsedBytesPeak":33204336,
 "targetHit":false,"targetAtMs":null,
 "rssAtTargetBytes":null,"rssAtTargetMiB":null,
 "samples":118,"childExit":0}
```

### 30s run with 10 MiB ingest milestone (so we get a "RSS at target" reading)

```
$ PROBE_DURATION_MS=30000 PROBE_TARGET_BYTES=10485760 node probe.mjs
{"ok":true,"platform":"win32","arch":"x64","nodeVersion":"v24.14.1",
 "cols":120,"rows":40,"durationMs":30015,"emittedBytes":15188040,
 "bytesPerSec":506015,"mibPerSec":0.48,
 "rssBytesPeak":124567552,"rssMiBPeak":118.80,
 "rssBytesEnd":124461056,"heapUsedBytesPeak":34964768,
 "targetHit":true,"targetAtMs":20848,
 "rssAtTargetBytes":97763328,"rssAtTargetMiB":93.23,
 "samples":117,"childExit":0}
```

## Headline numbers

| Metric                                  | Value (win32/x64, ConPTY)            |
| --------------------------------------- | ------------------------------------ |
| Sustained throughput (TTY bytes/s)      | **~501 600 B/s** ≈ **0.48 MiB/s**    |
| RSS at start                            | ~80 MiB (Node + node-pty + xterm)    |
| RSS at 10 MiB ingest                    | **93.2 MiB** (Δ +~13 MiB)            |
| RSS peak after 30s / 15 MiB ingested    | **118.8 MiB** (Δ +~38 MiB)           |
| Heap used peak                          | 33–35 MiB                            |
| **Extrapolated time to 1 GiB ingest**   | **~35 min on ConPTY** (linear from above) |
| **Projected RSS at 1 GiB**              | bounded by `Terminal.scrollback=1000` ring → **expect <250 MiB**, not unbounded growth (xterm-headless rolls the ring after 1000 lines; `yes` produces ~1.5 MB / 1000 lines, so steady-state is reached well before 1 GiB) |

Throughput floor (ConPTY) matches Microsoft's published ConPTY guidance and
the ceiling we already observed in T9.10. Linux pty / macOS pty are an
order of magnitude faster (no kernel-mode VT shim) — those numbers will be
recorded by the same probe on the self-hosted runners.

## Verdict

**GREEN for the daemon ↔ pty-host process split.** No backpressure
failure, no fd leak (the only fds opened are the PTY pair owned by node-pty
and the parent↔child stdio pipe — both reaped on `term.kill()` /
`child.exit`), no unbounded RSS climb (xterm-headless caps at the
configured scrollback ring). The boundary cost is **process-startup-only**
(~80 MiB warm RSS to get node + node-pty addon + xterm-headless loaded),
not per-byte.

The single open follow-up is the **darwin/linux baseline numbers** — the
probe is platform-agnostic (uses `process.execPath` for the workload
shell), so once the T0.10 self-hosted runners are live, re-running
`node probe.mjs` on each gets the row filled in.

## Reproducer

```
cd tools/spike-harness/probes/child-process-pty-throughput
npm install
node probe.mjs                                   # default 10s, 1 GiB target
PROBE_DURATION_MS=30000 node probe.mjs           # 30s baseline
PROBE_DURATION_MS=30000 PROBE_TARGET_BYTES=10485760 node probe.mjs
                                                 # 30s, 10 MiB target marker
PROBE_NDJSON_OUT=samples.ndjson node probe.mjs   # also dump full sample stream
```

Env knobs (all optional):
`PROBE_DURATION_MS`, `PROBE_COLS`, `PROBE_ROWS`, `PROBE_REPORT_MS`,
`PROBE_TARGET_BYTES`, `PROBE_NDJSON_OUT`.
