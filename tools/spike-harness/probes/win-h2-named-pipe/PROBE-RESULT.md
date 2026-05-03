# T9.5 spike — Node 22 http2 (h2c) over Windows named pipe

**Status:** smoke harness landed, **viability confirmed on win32**; 1h soak deferred to self-hosted Windows runner per spec ch10 + Task #16 (T0.10).

**Platform authored on:** `MINGW64_NT-10.0-26200` (Windows 11), Node v24.14.1 (forward-compat with the v22 target pinned by `@types/node ^22.10.0`). On non-win32 hosts the harness short-circuits with exit 2 (`run.sh` skip + `server.mjs` / `client.mjs` guard); the parallel UDS spike (T9.4) covers darwin / linux.

## Why this spike exists

Per spec ch14 §1.5 phase 0.5: "must resolve before A4 transport pick on Windows". Open question = does Node's `http2` module actually function when its underlying duplex is a Windows named pipe (kernel object surfaced through libuv as a `net.Socket`), as opposed to a TCP socket or UDS? If yes, win32 can run the same h2c-over-Listener-A design as darwin/linux without a TLS jump or loopback-TCP fallback. If no, A4 has to fall back to option C (loopback-TCP + JWT) on Windows only.

## Files

- `server.mjs` — `net.createServer().listen('\\?\pipe\ccsm-spike')` accepts pipe clients and bridges each accepted `net.Socket` into an `http2.createServer()` instance via `http2.emit('connection', sock)`. Single `GET /ping → pong` route. Win32-guarded; SIGTERM / SIGINT / SIGBREAK clean shutdown (named pipes have no FS residue to unlink).
- `client.mjs` — `http2.connect('http://localhost', { createConnection: () => net.connect(pipePath) })`, 10 req/sec, configurable duration, p50/p95/p99 + RSS delta + per-minute handle snapshot via `process._getActiveHandles().length` (the closest Windows analogue to the linux `/proc/self/fd` probe used in T9.4). Emits a single trailing summary JSON line + per-request RTT NDJSON on stderr; `verdict: PASS|FAIL`.
- `run.sh` — orchestrates server start → client soak → teardown (TERM-then-KILL); pipes RTT NDJSON through the existing `tools/spike-harness/rtt-histogram.mjs` helper (PR #851 / commit ab9b173). Win32-only.

Layer-1 constraints (per `tools/spike-harness/README.md`): node: stdlib only — `http2`, `net`, `os`, `util`. Zero npm deps added.

## Smoke verification on this host (win32)

5-second smoke at 10 req/sec, run from `~/ccsm-worktrees/pool-14`:

```
$ SPIKE_DURATION_SEC=5 SPIKE_LOG_DIR=/tmp/winh2 \
    bash tools/spike-harness/probes/win-h2-named-pipe/run.sh
starting server (pipe=\\?\pipe\ccsm-spike)
running client (duration=5s, rate=10/s)
--- summary ---
{"durationSec":5,"sent":45,"ok":45,"errors":0,
 "p50Us":977,"p95Us":1413,"p99Us":8212,
 "rssStartBytes":46968832,"rssEndBytes":48619520,"rssDeltaBytes":1650688,
 "handleSnapshots":[{"tSec":0,"handleCount":1},{"tSec":5,"handleCount":1}],
 "verdict":"PASS","verdictReason":"thresholds met"}
exit=0
```

`node --check` passes for both `.mjs` files; `bash -n run.sh` passes.

Key numbers from the smoke:

- **45/45 ok, 0 errors** — http2 over named pipe round-trips end-to-end. The h2c HEADERS / DATA / END_STREAM frames flow through the libuv pipe surface without truncation.
- **p50 = 977 us, p95 = 1.41 ms, p99 = 8.2 ms** — same order of magnitude as the UDS spike's expected envelope; the named-pipe path is not a perf cliff.
- **RSS delta = +1.65 MB, handle delta = 0** — no leak in 5 s. (The 5 s window is too short to draw a leak conclusion; that is what the 1 h soak on a self-hosted Windows runner is for. But it does rule out an obvious per-request handle leak.)

## Decision criterion (encoded in client.mjs, parity with T9.4)

A run is **PASS** iff all three hold over the full duration:

1. error rate ≤ **1 %** (`errors / sent`)
2. RSS climb ≤ **50 MB** (`process.memoryUsage().rss` end − start)
3. active-handle count climb ≤ **5** between first and last `process._getActiveHandles()` snapshot

Any FAIL exits 3 from the client (and from `run.sh`).

`process._getActiveHandles` is undocumented but has been a stable Node-core API since v18 and is the closest cheap analogue to `/proc/self/fd` on Windows. The probe tolerates its absence (returns `null`, then the leak criterion is skipped and we lean on RSS as on macOS in T9.4).

## Recommendation for ch14 §1.5 / A4 transport pick on Windows

The smoke run answers the phase-0.5 viability question **affirmatively**: Node 22+ `http2` operates correctly over a Windows named pipe via the standard `createConnection` injection used by the UDS spike. There is no need for a TLS jump or a loopback-TCP fallback solely because of platform.

Pending the 1 h soak on real Windows CI hardware, the recommendation is to lock **option A (h2c-over-named-pipe)** as the v0.3 Listener-A transport on win32, mirroring the darwin/linux `h2c-over-UDS` choice from T9.4. Peer-cred on the Windows side is supplied by `connect-and-peercred.ps1` (`GetNamedPipeClientProcessId` — currently a stub, separate task) and pipe DACL hardening by `set-pipe-dacl.ps1` (also stub).

If the soak shows handle / RSS climb on Windows specifically, the fallback is option C (loopback-TCP + JWT) — already covered by T9.3's harness — at the cost of giving up peer-cred bypass on Listener A on Windows only.

## Follow-ups

- **T0.10 (#16)**: wire this `run.sh` into a self-hosted Windows runner with `SPIKE_DURATION_SEC=3600`. Capture `summary.json` + `histogram.json` as build artifacts. Required before the A4 lock-in can be ratified.
- **`connect-and-peercred.ps1`**: still a stub per `tools/spike-harness/README.md` inventory. Needs a real `GetNamedPipeClientProcessId` P/Invoke implementation to validate Listener-A peer-cred on win32 once this transport is locked.
- **`set-pipe-dacl.ps1`**: still a stub. Needs `SetSecurityInfo` P/Invoke for the same-user DACL gating that makes Listener A trustworthy without TLS.
