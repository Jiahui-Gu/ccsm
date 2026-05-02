#!/usr/bin/env node
// pty-emitter.mjs — drive the W1-W6 PTY workload classes through node-pty.
//
// Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
// Used by ch14 §1.7 (PTY throughput + snapshot byte-equality spike).
// Workload classes are pinned by ch06 §8 — do NOT invent new classes here.
//
// Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
//
//   Usage:
//     pty-emitter.mjs --workload=<W1|W2|W3|W4|W5|W6>
//                     --fixture=<path>
//                     [--cols=<int>] [--rows=<int>]
//                     [--duration-ms=<int>]
//
//   Workload classes (verbatim from ch06 §8 / ch14 §1.7):
//     W1 ASCII-heavy code dump        (50 MB / 30s)
//     W2 heavy SGR colour churn       (20 MB / 30s)
//     W3 alt-screen TUI (htop replay) (10 MB / 60s)
//     W4 DECSTBM scroll-region churn  (10 MB / 30s)
//     W5 mixed UTF-8 / CJK + combiners (5 MB / 30s)
//     W6 resize-during-burst          (W1 + SIGWINCH every 500ms)
//
//   Behavior:
//     1. spawn `bash -c 'cat <fixture>'` on mac/linux or
//        `cmd /c type <fixture>` on Windows via node-pty.
//     2. Stream PTY output to stdout as raw bytes.
//     3. On exit, print one JSON summary line to stderr.
//
//   Output (stdout): raw PTY bytes (binary).
//   Output (stderr, last line, JSON):
//     {"workload":"W1","fixtureBytes":<int>,"emittedBytes":<int>,
//      "durationMs":<int>,"cols":<int>,"rows":<int>}
//
//   Exit 0 on clean PTY EOF; non-zero on spawn failure.
//
// TODO: full implementation when T9.7 lands. Requires `node-pty`, which is
// the ONE allowed npm dep here per ch06 §1 (no node: stdlib substitute).
// The contract above is forever-stable; the wiring inside changes only.

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    workload:      { type: 'string' },
    fixture:       { type: 'string' },
    cols:          { type: 'string', default: '120' },
    rows:          { type: 'string', default: '40'  },
    'duration-ms': { type: 'string', default: '30000' },
  },
  strict: true,
});

const VALID = new Set(['W1', 'W2', 'W3', 'W4', 'W5', 'W6']);

if (!values.workload || !VALID.has(values.workload)) {
  process.stderr.write('error: --workload must be one of W1..W6\n');
  process.exit(2);
}
if (!values.fixture) {
  process.stderr.write('error: --fixture=<path> required\n');
  process.exit(2);
}

const summary = {
  workload:     values.workload,
  fixtureBytes: 0,
  emittedBytes: 0,
  durationMs:   0,
  cols:         Number(values.cols),
  rows:         Number(values.rows),
  todo:         'T9.7',
};
process.stderr.write(JSON.stringify(summary) + '\n');
process.stderr.write('TODO: implement when T9.7 lands (requires node-pty)\n');
process.exit(0);
