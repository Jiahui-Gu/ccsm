// Unit tests for the SessionWatcher facade (index.ts).
//
// These tests are NOT a duplicate of titleChanged.test.ts (which exercises
// the full producer + sinks via the title bridge). Here we verify the
// facade's specific responsibilities:
//   * `configureSessionWatcher` rewires the singleton's title fetcher and
//     pending-rename flusher (boot wiring contract).
//   * `closeAll` fires `unwatched` for every tracked sid.
//   * The `__createForTest` factory returns an isolated instance (no
//     module-level cross-talk between watchers).

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __createForTest,
  configureSessionWatcher,
  sessionWatcher,
  type UnwatchedEvent,
  type TitleChangedEvent,
} from '../index';

let tmpRoot: string | null = null;

function mkTmp(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-facade-test-'));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  tmpRoot = null;
  // Reset the module singleton's wired callbacks back to noops so we don't
  // pollute neighbouring suites that import `sessionWatcher`.
  configureSessionWatcher({
    fetchTitle: async () => ({ summary: null }),
    flushRename: () => undefined,
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('SessionWatcher facade', () => {
  it('closeAll fires unwatched for every tracked sid', () => {
    const w = __createForTest();
    const evts: UnwatchedEvent[] = [];
    w.on('unwatched', (e: UnwatchedEvent) => evts.push(e));
    w.startWatching('a', '/nonexistent/a.jsonl');
    w.startWatching('b', '/nonexistent/b.jsonl');
    w.startWatching('c', '/nonexistent/c.jsonl');
    w.closeAll();
    expect(new Set(evts.map((e) => e.sid))).toEqual(new Set(['a', 'b', 'c']));
    // After closeAll, a second close is a no-op (no extra events).
    const before = evts.length;
    w.closeAll();
    expect(evts.length).toBe(before);
  });

  it('__createForTest returns isolated instances (no cross-talk)', () => {
    const w1 = __createForTest();
    const w2 = __createForTest();
    const e1: UnwatchedEvent[] = [];
    const e2: UnwatchedEvent[] = [];
    w1.on('unwatched', (e: UnwatchedEvent) => e1.push(e));
    w2.on('unwatched', (e: UnwatchedEvent) => e2.push(e));
    w1.startWatching('s', '/nonexistent/s.jsonl');
    w1.stopWatching('s');
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(0);
  });

  it('getLastEmittedForTest returns null for an unknown sid', () => {
    const w = __createForTest();
    expect(w.getLastEmittedForTest('never')).toBeNull();
  });

  it('configureSessionWatcher rewires the singleton fetchTitle + flushRename', async () => {
    const dir = mkTmp();
    const jsonlPath = path.join(dir, 'sess.jsonl');

    const fetchTitle = vi.fn(async () => ({ summary: 'wired title' }));
    const flushRename = vi.fn();
    configureSessionWatcher({ fetchTitle, flushRename });

    const evts: TitleChangedEvent[] = [];
    const onTitle = (e: TitleChangedEvent): void => {
      if (e.sid === 'facade-sid') evts.push(e);
    };
    sessionWatcher.on('title-changed', onTitle);

    try {
      fs.writeFileSync(jsonlPath, '{"type":"user"}\n');
      sessionWatcher.startWatching('facade-sid', jsonlPath);
      await waitFor(() => evts.length >= 1 && flushRename.mock.calls.length >= 1);
      expect(evts[0]).toEqual({ sid: 'facade-sid', title: 'wired title' });
      expect(flushRename).toHaveBeenCalledWith('facade-sid');
    } finally {
      sessionWatcher.off('title-changed', onTitle);
      sessionWatcher.stopWatching('facade-sid');
    }
  });

  it('stopWatching for an unknown sid does not throw and emits no unwatched', () => {
    const w = __createForTest();
    const evts: UnwatchedEvent[] = [];
    w.on('unwatched', (e: UnwatchedEvent) => evts.push(e));
    expect(() => w.stopWatching('never')).not.toThrow();
    expect(evts).toHaveLength(0);
  });
});
