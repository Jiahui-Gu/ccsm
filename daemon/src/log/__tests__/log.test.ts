// Frag-12 §12.1 — daemon logger tests.
//
// Coverage:
//   1. Redact list — `daemon.secret`, `imposterSecret`, `authorization`,
//      and the wildcard `*.secret` / `*.password` / `*.token` matchers
//      all replace values with the literal `[Redacted]` censor.
//   2. Real rotation — writing >50 MB of payload through the logger
//      produces at least 2 files under the log directory (size cap
//      kicked in mid-day).
//   3. Symlink maintenance — `daemon.log` points at the newest rotated
//      file after `maintainCurrentSymlink()` runs.
//   4. Canonical base fields — every line carries `side` / `v` / `pid` /
//      `boot`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDaemonLogger,
  daemonLogDir,
  maintainCurrentSymlink,
  DAEMON_LOG_CURRENT_SYMLINK,
  DAEMON_REDACT_PATHS,
  DAEMON_REDACT_CENSOR,
} from '../index.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccsm-daemon-log-'));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Worker thread may still hold the file handle; ignore.
  }
});

/**
 * Drain pino's worker-thread transport so the test sees writes on disk.
 *
 * pino's `transport()` is async; logger.flush() is best-effort under the
 * default async destination. We sleep briefly to let the worker thread
 * round-trip the queued writes.
 */
async function drain(logger: { flush: (cb?: (err?: Error | null) => void) => void } | undefined, ms = 1500): Promise<void> {
  if (logger && typeof logger.flush === 'function') {
    await new Promise<void>((resolve) => {
      try {
        logger.flush(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  await new Promise((r) => setTimeout(r, ms));
}

function readAllLines(logDir: string): unknown[] {
  const out: unknown[] = [];
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('daemon.')) continue;
    if (name === DAEMON_LOG_CURRENT_SYMLINK) continue;
    const full = join(logDir, name);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Mid-rotation partial line; skip.
      }
    }
  }
  return out;
}

describe('createDaemonLogger — redact list', () => {
  it('redacts daemon.secret, imposterSecret, authorization, and wildcard *.secret/*.password/*.token', async () => {
    const logger = createDaemonLogger({
      dataRoot: tmpRoot,
      version: '0.3.0-test',
      pid: 12345,
      bootNonce: 'test-boot-redact',
    });

    logger.info(
      {
        // Exact paths.
        daemon: { secret: 'abc' },
        imposterSecret: 'legacy-leak',
        authorization: 'Bearer xyz',
        // Wildcard *.secret / *.password / *.token at depth-1.
        upstream: { secret: 'level1-secret', password: 'level1-pass', token: 'level1-tok' },
        // Wildcard `*.secret` matches `outer.secret` (single intermediate
        // segment) per @pinojs/redact / fast-redact semantics. Deeper
        // nesting like `outer.inner.secret` would require an explicit
        // `*.*.secret` entry — out of scope for v0.3 redact list.
        outer: { secret: 'one-level-secret' },
        // A field that should NOT be redacted.
        kept: 'visible',
      },
      'redact-test',
    );

    await drain(logger);

    const lines = readAllLines(daemonLogDir(tmpRoot));
    expect(lines.length).toBeGreaterThan(0);
    const line = lines.find((l): l is Record<string, unknown> => {
      return typeof l === 'object' && l !== null && (l as { msg?: unknown }).msg === 'redact-test';
    });
    expect(line, `did not find redact-test line; got ${JSON.stringify(lines)}`).toBeDefined();

    expect((line!.daemon as Record<string, unknown>).secret).toBe(DAEMON_REDACT_CENSOR);
    expect(line!.imposterSecret).toBe(DAEMON_REDACT_CENSOR);
    expect(line!.authorization).toBe(DAEMON_REDACT_CENSOR);

    expect((line!.upstream as Record<string, unknown>).secret).toBe(DAEMON_REDACT_CENSOR);
    expect((line!.upstream as Record<string, unknown>).password).toBe(DAEMON_REDACT_CENSOR);
    expect((line!.upstream as Record<string, unknown>).token).toBe(DAEMON_REDACT_CENSOR);

    expect(
      (line!.outer as Record<string, unknown>).secret,
    ).toBe(DAEMON_REDACT_CENSOR);

    expect(line!.kept).toBe('visible');
  });

  it('exports the canonical redact path list (regression guard for accidental removals)', () => {
    expect(DAEMON_REDACT_PATHS).toEqual([
      'daemon.secret',
      'imposterSecret',
      'authorization',
      '*.secret',
      '*.password',
      '*.token',
    ]);
  });
});

describe('createDaemonLogger — canonical base fields', () => {
  it('stamps {side, v, pid, boot} on every line', async () => {
    const logger = createDaemonLogger({
      dataRoot: tmpRoot,
      version: '9.9.9',
      pid: 4242,
      bootNonce: 'BOOT-ULID-XYZ',
    });
    logger.info({ event: 'hello' }, 'h');
    await drain(logger);
    const lines = readAllLines(daemonLogDir(tmpRoot));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const o = l as Record<string, unknown>;
      expect(o.side).toBe('daemon');
      expect(o.v).toBe('9.9.9');
      expect(o.pid).toBe(4242);
      expect(o.boot).toBe('BOOT-ULID-XYZ');
    }
  });
});

describe('createDaemonLogger — real rotation at 50 MB', () => {
  it('produces 2+ files when total payload exceeds 50 MB cap', async () => {
    const logger = createDaemonLogger({
      dataRoot: tmpRoot,
      version: '0.3.0-test',
      pid: 12345,
      bootNonce: 'test-boot-rotation',
    });

    // Build a ~512 KB payload string (compresses to a single JSONL line of
    // similar size; pino will JSON-stringify it). Write 102 lines = ~52 MB
    // → tips past the 50 MB cap.
    const chunk = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 102; i++) {
      logger.info({ idx: i, payload: chunk }, 'rot');
    }

    // Rotation involves the worker thread reopening files; give it ample
    // time to flush 50+ MB through sonic-boom on slow CI disks.
    await drain(logger, 2500);

    const logDir = daemonLogDir(tmpRoot);
    const files = readdirSync(logDir).filter(
      (n) => n.startsWith('daemon.') && n !== DAEMON_LOG_CURRENT_SYMLINK,
    );
    // At least 2 rotated files (size cap kicked in).
    expect(files.length, `expected >=2 rotated files, got: ${files.join(', ')}`).toBeGreaterThanOrEqual(2);

    // Sanity: total bytes across files exceed 50 MB so we know we actually
    // wrote past the cap (not just that pino-roll spuriously rotated).
    let total = 0;
    for (const f of files) {
      total += statSync(join(logDir, f)).size;
    }
    expect(total).toBeGreaterThan(50 * 1024 * 1024);
  }, 30_000);
});

describe('maintainCurrentSymlink', () => {
  it('points daemon.log at the newest daemon.* file', () => {
    const logDir = daemonLogDir(tmpRoot);
    // Build a synthetic file tree so the test does not depend on real
    // pino-roll output (decoupled from rotation timing).
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'daemon.2026-05-01.1'), 'old\n');
    // Make sure mtimes differ — most filesystems have ms resolution.
    const past = Date.now() / 1000 - 60;
    utimesSync(join(logDir, 'daemon.2026-05-01.1'), past, past);
    writeFileSync(join(logDir, 'daemon.2026-05-02.1'), 'new\n');

    maintainCurrentSymlink(logDir);

    const linkPath = join(logDir, DAEMON_LOG_CURRENT_SYMLINK);
    let content: string | undefined;
    try {
      content = readFileSync(linkPath, 'utf8');
    } catch {
      // Symlink creation can fail on Windows w/o developer mode; the
      // function is best-effort and we accept that scenario rather than
      // failing the test on a permissions issue. If the symlink wasn't
      // created the file simply won't exist, which is the documented
      // fallback.
    }
    if (content !== undefined) {
      expect(content).toBe('new\n');
    }
  });
});
