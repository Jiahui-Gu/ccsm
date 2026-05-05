// Unit tests for `fileSink` (sources.ts) — Task #435 coverage push.
//
// Why this file exists:
//   - The crash/ subsystem is heavily covered (event-bus, pruner-decider,
//     pruner, raw-appender, capture sources, rate-limit, integration RPC,
//     pty-host) — ~118 spec passing on origin/working.
//   - `installCaptureSources`, `truncateUtf8`, `newCrashId`, `CAPTURE_SOURCES`,
//     `DAEMON_SELF`, `SqliteRateLimiter` all have direct or indirect specs.
//   - The one un-tested public export was `fileSink(path)` — a tiny binding
//     helper around `appendCrashRaw` that the orchestrator wires into
//     `installCaptureSources({ sink: fileSink(path) })`. Without a direct
//     spec, a regression that swaps the closure or drops the entry would
//     only surface at integration time.
//
// Scope: 3 specs covering hot path + error branch.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileSink } from './sources.js';
import type { CrashRawEntry } from './raw-appender.js';

function makeEntry(id: string): CrashRawEntry {
  return {
    id,
    ts_ms: 1_700_000_000_000,
    source: 'uncaughtException',
    summary: `summary for ${id}`,
    detail: 'stack trace here',
    labels: { errorName: 'TestError' },
    owner_id: 'daemon-self',
  };
}

describe('fileSink', () => {
  it('returns a sink that appends one NDJSON line per call to the bound path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccsm-file-sink-'));
    const path = join(dir, 'crash-raw.ndjson');
    try {
      const sink = fileSink(path);
      sink(makeEntry('id-1'));
      sink(makeEntry('id-2'));
      sink(makeEntry('id-3'));

      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      // Each line must be valid JSON carrying the entry's id.
      const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id);
      expect(ids).toEqual(['id-1', 'id-2', 'id-3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds the path at factory time so two sinks write to independent files', () => {
    // Guard against a refactor that accidentally globalises the path closure.
    const dirA = mkdtempSync(join(tmpdir(), 'ccsm-file-sink-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'ccsm-file-sink-b-'));
    const pathA = join(dirA, 'crash-raw.ndjson');
    const pathB = join(dirB, 'crash-raw.ndjson');
    try {
      const sinkA = fileSink(pathA);
      const sinkB = fileSink(pathB);

      sinkA(makeEntry('a-only'));
      sinkB(makeEntry('b-only'));
      sinkA(makeEntry('a-second'));

      const linesA = readFileSync(pathA, 'utf8').split('\n').filter((l) => l.length > 0);
      const linesB = readFileSync(pathB, 'utf8').split('\n').filter((l) => l.length > 0);

      const idsA = linesA.map((l) => (JSON.parse(l) as { id: string }).id);
      const idsB = linesB.map((l) => (JSON.parse(l) as { id: string }).id);
      expect(idsA).toEqual(['a-only', 'a-second']);
      expect(idsB).toEqual(['b-only']);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('propagates the underlying openSync error when the parent directory does not exist', () => {
    // The FATAL caller relies on errors surfacing rather than being swallowed
    // (see raw-appender.ts header comment — "better to surface 'we tried and
    // failed' than silently lose the event"). Verify fileSink does NOT trap
    // the error inside its closure.
    const sink = fileSink('/nonexistent-dir-for-task-435/does/not/exist/crash.ndjson');
    expect(() => sink(makeEntry('will-fail'))).toThrow(/ENOENT|no such file/i);
  });
});
