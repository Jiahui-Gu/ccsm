# T9.3 spike — Win 11 25H2 loopback HTTP/2 cleartext (h2c)

**Status:** smoke harness landed and verified GREEN on Win 11 25H2 (build
26200). 1h soak deferred to self-hosted Windows runner per spec ch10 +
Task #16 (T0.10).

**Why this spike exists:** ch14 §1.3 phase 0.5 — before we lock the
transport-pick row in ch14 §1.A matrix, we must rule out the risk that the
Win 11 25H2 networking stack (new TCP/IP fast path + reorganized loopback
driver) breaks plaintext HTTP/2 on `127.0.0.1`. Listener B
(`127.0.0.1:PORT_TUNNEL`, h2c upstream of `cloudflared`) does not work if
that assumption fails. This probe is the Windows counterpart to the
`uds-h2c` spike (T9.4), which covers darwin/linux.

## Files

- `server.mjs` — `node:http2` cleartext server bound to `127.0.0.1`
  ephemeral port; routes `GET /ping → pong` (unary RTT) and
  `GET /stream?n=&hz=` (server-streaming NDJSON for
  `stream-truncation-detector.mjs`); writes the kernel-assigned port to a
  port-file; SIGTERM-safe.
- `client.mjs` — `node:http2` client over loopback TCP (port discovered via
  `--port-file` or passed via `--port`); 10 req/sec, configurable duration;
  per-request RTT NDJSON to stderr, summary JSON to stdout; verdict
  `PASS`/`FAIL`. Drops the `/proc/self/fd` snapshot (Windows has no
  equivalent cheap probe and `lsof`/`handle.exe` would break the
  stdlib-only Layer 1 constraint); RSS climb is the leak proxy.
- `run.sh` — orchestrates server start → client soak → teardown; pipes RTT
  NDJSON through the existing `tools/spike-harness/rtt-histogram.mjs`.
  win32-only (skip exit 2 on non-win32 — `uds-h2c` covers those).

## Smoke verification on this host (Win 11 25H2, build 26200)

```
$ ver
Microsoft Windows [Version 10.0.26200.8246]

$ SPIKE_DURATION_SEC=10 bash tools/spike-harness/probes/loopback-h2c-on-25h2/run.sh
starting server (host=127.0.0.1, ephemeral port -> /tmp/ccsm-loopback-h2c-port)
running client (duration=10s, rate=10/s)
--- summary ---
{"durationSec":10,"sent":91,"ok":91,"errors":0,
 "p50Us":1096,"p95Us":1545,"p99Us":8546,
 "rssStartBytes":50847744,"rssEndBytes":50925568,"rssDeltaBytes":77824,
 "verdict":"PASS","verdictReason":"thresholds met"}
--- histogram ---
{"count":91,"skipped":0,"minUs":804,"maxUs":8546,"meanUs":1204.5,
 "p50Us":1096,"p95Us":1545,"p99Us":8546,"bucketUs":100,"buckets":[...]}
exit=0
```

`node --check` passes for both `.mjs` files; `bash -n run.sh` passes.

## Decision criterion (encoded in client.mjs)

A run is **PASS** iff both hold over the full duration:

1. error rate ≤ **1 %** (`errors / sent`)
2. RSS climb ≤ **50 MB** (`process.memoryUsage().rss` end − start)

Any FAIL exits 3 from the client (and from `run.sh`).

## Recommendation for ch14 §1.A transport choice (win32)

The 10-second smoke on real Win 11 25H2 hardware (build 26200) shows the
loopback h2c path is healthy: zero errors, p50 ~1.1 ms, p95 ~1.5 ms, RSS
delta ~76 KB across 91 unary round-trips. **The ch14 §1.3 phase 0.5 risk
is retired** — Win 11 25H2 does not break loopback HTTP/2 cleartext, and
the transport-pick row in ch14 §1.A may proceed under the assumption that
**Listener B = `127.0.0.1:PORT_TUNNEL` over h2c** is viable on Windows, on
parity with darwin/linux (covered by `uds-h2c` smoke).

The 1h soak on a self-hosted Windows runner (T0.10) remains the gate before
we declare the row final, but this smoke is sufficient to unblock downstream
T9.x design choices that depend on that row.

## Reuse vs. greenfield

This probe deliberately mirrors the `uds-h2c` (T9.4) shape so a single set
of operator runbooks and verdict thresholds covers both transports. The
shared helpers `rtt-histogram.mjs` and `stream-truncation-detector.mjs` are
reused as-is (per ch14 §1.B forever-stable contract). No new npm deps; the
probe is `node:` stdlib only.

## Follow-ups

- T0.10 (#16): wire this `run.sh` into the self-hosted Win 11 25H2 runner
  with `SPIKE_DURATION_SEC=3600`. Capture `loopback-h2c-summary.json` +
  `loopback-h2c-histogram.json` as build artifacts.
- T9.5: parallel named-pipe spike (UDS replacement for Windows Listener A)
  is independent of this probe; this spike only covers Listener B.
