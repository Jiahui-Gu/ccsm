# T9.4 spike — Node 22 http2 (h2c) over UDS

**Status:** smoke harness landed; 1h soak deferred to self-hosted runner per spec ch10 + Task #16 (T0.10).

**Platform:** authored from `MINGW64_NT-10.0-26200` (Windows). On win32 the harness short-circuits with exit 2 (`run.sh` skip + `server.mjs`/`client.mjs` guard) — UDS path semantics differ on Windows; the parallel named-pipe spike (T9.5) covers that transport. Smoke + 1h soak on darwin / linux are scheduled for the self-hosted runners pinned by T0.10.

## Files

- `server.mjs` — http2 (cleartext h2c) server bound to `/tmp/ccsm-spike.sock`, single `/ping → pong` route, SIGTERM-safe socket unlink.
- `client.mjs` — http2 client over UDS (via `net.connect` factory passed to `http2.connect`), 10 req/sec, configurable duration, p50/p95/p99 + RSS delta + per-minute fd snapshot (`/proc/self/fd` on linux, `null` on darwin), `verdict: PASS|FAIL`.
- `run.sh` — orchestrates server start → client soak → teardown (kill TERM-then-KILL, unlink socket); pipes RTT NDJSON through existing `tools/spike-harness/rtt-histogram.mjs`.

## Smoke verification on this host (win32)

```
$ bash tools/spike-harness/probes/uds-h2c/run.sh
uds-h2c spike: skipped on MINGW64_NT-10.0-26200 (win32 — use named-pipe spike)
exit=2
```

`node --check` passes for both `.mjs` files; `bash -n run.sh` passes; `pnpm lint` = 0 errors (the harness directory is in eslint `ignores`, but Node syntax-check is sufficient for stdlib-only scripts per `tools/spike-harness/README.md` Layer-1 constraint).

## Decision criterion (encoded in client.mjs)

A run is **PASS** iff all three hold over the full duration:

1. error rate ≤ **1 %** (`errors / sent`)
2. RSS climb ≤ **50 MB** (`process.memoryUsage().rss` end − start)
3. fd count climb ≤ **5** between first and last `/proc/self/fd` snapshot (linux only; macOS lacks an equivalent cheap probe so the criterion is skipped there and we lean on RSS as the leak proxy)

Any FAIL exits 3 from the client (and from `run.sh`).

## Recommendation for ch03 §4 transport choice (darwin/linux)

Pending the 1h soak on real CI hardware, the harness is structured so a green run is sufficient evidence to lock **option A (h2c-over-UDS)** as the v0.3 Listener-A transport on darwin/linux, matching the spec's "peer-cred-trusted local socket" requirement (no TLS overhead, no port allocation, peer-cred via `getsockopt` already covered by `connect-and-peercred.sh`).

If the soak shows fd / RSS climb, the fallback is option C (loopback-TCP + JWT) — already covered by T9.3's harness — at the cost of giving up peer-cred bypass on Listener A.

## Follow-ups

- T0.10 (#16): wire this `run.sh` into the self-hosted darwin + linux runners with `SPIKE_DURATION_SEC=3600`. Capture `summary.json` + `histogram.json` as build artifacts.
- T9.5: parallel named-pipe spike on win32 (out of scope here; this spike's win32 skip is intentional).
