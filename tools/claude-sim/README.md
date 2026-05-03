# claude-sim

Stand-in binary that pretends to be the `claude` CLI for CCSM's 1h pty
soak test (Task #209 / #92, ship-gate (c)).

It is **not** a mock of Claude's behaviour. It is a deterministic traffic
generator whose patterns are chosen to exercise every interesting edge
of the CCSM pty pipeline: chunked output, multi-KiB floods, ANSI escape
passthrough, idle gaps, and fast bursts.

## Build

```bash
cd tools/claude-sim
go build -o claude-sim ./...
```

Or use the helper used by the soak harness:

```bash
tools/claude-sim/build.sh           # writes ./claude-sim
tools/claude-sim/build.sh /tmp/out  # custom output path
```

Compiles on darwin / linux / windows; no third-party dependencies.

## Use from pty-soak-1h

The soak test (#209 / #92) spawns this binary in place of the real
`claude` CLI and pipes synthetic prompts to it for one hour. Wire-up
lives in those tasks; this PR only ships the binary
([LIBRARY-ONLY]).

Typical invocation:

```bash
go build -o claude-sim ./...
CLAUDE_SIM_BURST_INTERVAL_MS=50 \
CLAUDE_SIM_QUIET_MS=5000 \
CLAUDE_SIM_FLOOD_BYTES=32768 \
CLAUDE_SIM_FAST_BURST_COUNT=64 \
  ./claude-sim
```

It prints `claude-sim ready` on startup. After each line read on stdin
it emits one of five patterns, rotating deterministically:

| step % 5 | pattern        | what it stresses                          |
|----------|----------------|-------------------------------------------|
| 0        | small chunked  | common case, line buffering               |
| 1        | KiB-scale flood| ring buffer, backpressure, snapshot debounce |
| 2        | ANSI escape    | passthrough (color, bold, cursor moves)   |
| 3        | quiet idle     | snapshot scheduler idle path              |
| 4        | fast burst     | write coalescing, throughput              |

Stdin handling:

- One line in -> one pattern out.
- `quit\n` -> prints `bye` and exits 0.
- EOF -> exits 0.

Any non-zero exit is treated as a soak regression.

## Env vars

| Name                          | Default | Purpose                                         |
|-------------------------------|---------|-------------------------------------------------|
| `CLAUDE_SIM_BURST_INTERVAL_MS`| 50      | Sleep between writes inside a chunked burst.    |
| `CLAUDE_SIM_QUIET_MS`         | 5000    | Length of the idle-gap pattern.                 |
| `CLAUDE_SIM_FLOOD_BYTES`      | 32768   | Size of the flood pattern (rounded up to 1KiB). |
| `CLAUDE_SIM_FAST_BURST_COUNT` | 64      | Lines written in a fast burst.                  |

Invalid / negative values fall back to the default so the soak harness
cannot accidentally produce zero-output runs.
