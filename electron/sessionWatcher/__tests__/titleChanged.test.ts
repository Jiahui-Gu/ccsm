// Unit tests for the SessionWatcher's `title-changed` event path.
//
// Strategy:
//   * Mock the SDK so we control what `getSessionInfo` returns per call.
//   * Drive synthetic JSONL writes via a tmp dir + `__createForTest()` so
//     we get a fresh watcher instance per test (no shared module state).
//   * Assert the event fires once per change, not on no-op identical-title
//     ticks, and that the dedupe is via the entry's `lastEmittedTitle`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the SDK module that `electron/sessionTitles/index.ts` imports.
// `getSessionInfo` is the only call exercised by the title path. We control
// the returned `summary` per call via the `summaryReturns` array, popping
// the next value on each invocation.
const summaryReturns: Array<{ summary: string | null; lastModified?: number }> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn(async () => {
    if (summaryReturns.length === 0) return null;
    return summaryReturns.shift() ?? null;
  }),
  // Unused by these tests, stubbed so the import resolves.
  renameSession: vi.fn(),
  listSessions: vi.fn(),
}));

import { __createForTest, type TitleChangedEvent } from '../index';
import {
  __resetForTests as __resetTitleBridge,
  enqueuePendingRename,
} from '../../sessionTitles';
import { renameSession as renameSessionMock } from '@anthropic-ai/claude-agent-sdk';

let tmpRoot: string;

function freshTmp(): { jsonlPath: string } {
  // Synthetic project-style layout under a unique tmp dir per test so the
  // watcher's existence checks resolve correctly.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-title-test-'));
  const projectDir = path.join(tmpRoot, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, 'sess.jsonl');
  return { jsonlPath };
}

function appendFrame(jsonlPath: string, text: string): void {
  fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', text }) + '\n');
}

async function waitForCondition(
  pred: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('SessionWatcher title-changed', () => {
  beforeEach(() => {
    summaryReturns.length = 0;
    // Bridge has its own 2s TTL cache + per-sid op chain; reset between
    // tests so cached `null` summaries from one test don't shadow the next.
    __resetTitleBridge();
    (renameSessionMock as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits title-changed once when SDK reports a new summary', async () => {
    const { jsonlPath } = freshTmp();
    const watcher = __createForTest();
    const events: TitleChangedEvent[] = [];
    watcher.on('title-changed', (e: TitleChangedEvent) => events.push(e));

    summaryReturns.push({ summary: 'first derived title' });

    fs.writeFileSync(jsonlPath, '');
    watcher.startWatching('sid-A', jsonlPath);
    appendFrame(jsonlPath, 'hello');

    await waitForCondition(() => events.length >= 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sid: 'sid-A', title: 'first derived title' });

    watcher.closeAll();
  });

  it('dedupes identical titles via lastEmittedTitle', async () => {
    const { jsonlPath } = freshTmp();
    const watcher = __createForTest();
    const events: TitleChangedEvent[] = [];
    watcher.on('title-changed', (e: TitleChangedEvent) => events.push(e));

    // Reset the bridge's TTL cache between SDK calls so we actually
    // re-invoke `getSessionInfo` per tick (the cache has a 2s TTL — long
    // enough to mask the second tick if we don't reset).
    summaryReturns.push({ summary: 'same title' });

    fs.writeFileSync(jsonlPath, '');
    watcher.startWatching('sid-B', jsonlPath);
    appendFrame(jsonlPath, 'first');
    await waitForCondition(() => events.length >= 1);

    // Second tick with the same SDK-reported summary — must NOT fire.
    __resetTitleBridge();
    summaryReturns.push({ summary: 'same title' });
    appendFrame(jsonlPath, 'second');

    // Allow plenty of time for any spurious second emit; if dedupe works
    // we should still be at exactly one event.
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('same title');

    watcher.closeAll();
  });

  it('emits again when the SDK reports a different summary', async () => {
    const { jsonlPath } = freshTmp();
    const watcher = __createForTest();
    const events: TitleChangedEvent[] = [];
    watcher.on('title-changed', (e: TitleChangedEvent) => events.push(e));

    summaryReturns.push({ summary: 'title v1' });
    fs.writeFileSync(jsonlPath, '');
    watcher.startWatching('sid-C', jsonlPath);
    appendFrame(jsonlPath, 'first');
    await waitForCondition(() => events.length >= 1);

    __resetTitleBridge();
    summaryReturns.push({ summary: 'title v2' });
    appendFrame(jsonlPath, 'second');
    await waitForCondition(() => events.length >= 2);

    expect(events.map((e) => e.title)).toEqual(['title v1', 'title v2']);

    watcher.closeAll();
  });

  it('skips emit when SDK returns null or empty summary', async () => {
    const { jsonlPath } = freshTmp();
    const watcher = __createForTest();
    const events: TitleChangedEvent[] = [];
    watcher.on('title-changed', (e: TitleChangedEvent) => events.push(e));

    // Two ticks, both with no usable title.
    summaryReturns.push({ summary: null });
    summaryReturns.push({ summary: '' });

    fs.writeFileSync(jsonlPath, '');
    watcher.startWatching('sid-D', jsonlPath);
    appendFrame(jsonlPath, 'first');
    __resetTitleBridge();
    appendFrame(jsonlPath, 'second');

    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(0);

    watcher.closeAll();
  });

  it('flushes pending rename exactly once on first JSONL appearance', async () => {
    const { jsonlPath } = freshTmp();
    const projectDir = path.dirname(jsonlPath);
    const renameMock = renameSessionMock as unknown as ReturnType<typeof vi.fn>;

    // PR2 path: a user-set title was queued before the JSONL existed
    // (renameSession would have thrown ENOENT).
    enqueuePendingRename('sid-E', 'pending-title', projectDir);

    const watcher = __createForTest();
    watcher.startWatching('sid-E', jsonlPath, projectDir);

    // Initial tick fires immediate=true; file does NOT exist yet, so the
    // flush guard (`fileExists && !entry.jsonlSeen`) must NOT fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(renameMock).not.toHaveBeenCalled();

    // Create the JSONL — dirWatcher should pick this up and schedule a
    // read. After DEBOUNCE_MS the read sees the file, sets jsonlSeen, and
    // calls flushPendingRename which in turn calls SDK renameSession.
    fs.writeFileSync(jsonlPath, '');
    appendFrame(jsonlPath, 'first');

    await waitForCondition(() => renameMock.mock.calls.length >= 1);
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith('sid-E', 'pending-title', { dir: projectDir });

    // Subsequent appends must NOT re-flush — `jsonlSeen` is now true.
    appendFrame(jsonlPath, 'second');
    appendFrame(jsonlPath, 'third');
    await new Promise((r) => setTimeout(r, 300));
    expect(renameMock).toHaveBeenCalledTimes(1);

    watcher.closeAll();
  });
});
