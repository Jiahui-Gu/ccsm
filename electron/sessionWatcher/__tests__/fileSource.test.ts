// Unit tests for FileSource — the per-session JSONL fs-watch PRODUCER.
//
// These tests use real fs (tmp dir) so we exercise the actual Windows /
// POSIX fs.watch behavior the producer was designed around, including:
//   * immediate first read (file doesn't exist yet)
//   * file appears later → dirWatcher → fileWatcher upgrade
//   * appends fire ticks via the debounce
//   * stop()/stopAll() tear down handles + flush pending timers
//   * tail-read for files larger than MAX_READ_BYTES (256 KB)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSource, type FileTick } from '../fileSource';

let tmpRoot: string;

function mkTmp(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-fsrc-test-'));
  return tmpRoot;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('FileSource', () => {
  beforeEach(() => {
    mkTmp();
  });

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits an immediate tick for a missing file (fileExists=false, text="")', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'project', 'sess.jsonl');
    // Note: parent dir does NOT exist — exercises the ancestor-watcher
    // path. Producer must still hand a single first tick to the consumer.
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.length >= 1);
    expect(ticks[0]).toMatchObject({ sid: 's1', text: '', fileExists: false });
    expect(typeof ticks[0].ts).toBe('number');
    src.stopAll();
  });

  it('emits a fileExists=true tick once the JSONL appears', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const projectDir = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'sess.jsonl');
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.length >= 1);
    expect(ticks[0].fileExists).toBe(false);

    fs.writeFileSync(jsonlPath, '{"type":"user"}\n');
    await waitFor(() => ticks.some((t) => t.fileExists));
    const present = ticks.find((t) => t.fileExists)!;
    expect(present.sid).toBe('s1');
    expect(present.text).toContain('"type":"user"');
    src.stopAll();
  });

  it('emits a tick on append (debounced), with the latest text', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'sess.jsonl');
    fs.writeFileSync(jsonlPath, '{"type":"user","i":1}\n');
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.some((t) => t.fileExists));
    const baseline = ticks.length;

    fs.appendFileSync(jsonlPath, '{"type":"user","i":2}\n');
    await waitFor(() => ticks.length > baseline);
    const last = ticks[ticks.length - 1];
    expect(last.text).toContain('"i":2');
    expect(last.fileExists).toBe(true);
    src.stopAll();
  });

  it('hasSid + sids reflect tracked entries', () => {
    const src = new FileSource(() => undefined);
    expect(src.hasSid('s1')).toBe(false);
    expect(src.sids()).toEqual([]);
    src.start('s1', path.join(tmpRoot, 'a.jsonl'));
    src.start('s2', path.join(tmpRoot, 'b.jsonl'));
    expect(src.hasSid('s1')).toBe(true);
    expect(new Set(src.sids())).toEqual(new Set(['s1', 's2']));
    src.stopAll();
    expect(src.sids()).toEqual([]);
  });

  it('start with empty sid or empty path is a no-op', () => {
    const src = new FileSource(() => undefined);
    src.start('', path.join(tmpRoot, 'x.jsonl'));
    src.start('s1', '');
    expect(src.sids()).toEqual([]);
    src.stopAll();
  });

  it('start with same sid + same path is idempotent (does not restart)', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'sess.jsonl');
    fs.writeFileSync(jsonlPath, '');
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.length >= 1);
    const before = ticks.length;
    src.start('s1', jsonlPath); // duplicate — synchronous early-return, no new scheduleRead
    expect(ticks.length).toBe(before);
    src.stopAll();
  });

  it('start with same sid + different path stops the old entry first', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const a = path.join(tmpRoot, 'a.jsonl');
    const b = path.join(tmpRoot, 'b.jsonl');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    src.start('s1', a);
    await waitFor(() => ticks.some((t) => t.text === 'A'));
    src.start('s1', b);
    await waitFor(() => ticks.some((t) => t.text === 'B'));
    expect(src.hasSid('s1')).toBe(true);
    src.stopAll();
  });

  it('stop returns true when an entry was tracked, false otherwise', () => {
    const src = new FileSource(() => undefined);
    src.start('s1', path.join(tmpRoot, 'x.jsonl'));
    expect(src.stop('s1')).toBe(true);
    expect(src.stop('s1')).toBe(false);
    expect(src.stop('never')).toBe(false);
  });

  it('stop flushes the pending timer (no late tick after stop)', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'sess.jsonl');
    src.start('s1', jsonlPath);
    src.stop('s1'); // synchronous; cancels the immediate setTimeout(0)
    await new Promise((r) => setTimeout(r, 100));
    expect(ticks).toHaveLength(0);
  });

  it('stopAll tears down every entry', () => {
    const src = new FileSource(() => undefined);
    src.start('s1', path.join(tmpRoot, '1.jsonl'));
    src.start('s2', path.join(tmpRoot, '2.jsonl'));
    src.stopAll();
    expect(src.sids()).toEqual([]);
  });

  it('getCwd returns the cwd passed to start, undefined otherwise', () => {
    const src = new FileSource(() => undefined);
    src.start('s1', path.join(tmpRoot, '1.jsonl'), '/some/cwd');
    src.start('s2', path.join(tmpRoot, '2.jsonl'));
    expect(src.getCwd('s1')).toBe('/some/cwd');
    expect(src.getCwd('s2')).toBeUndefined();
    expect(src.getCwd('never')).toBeUndefined();
    src.stopAll();
  });

  it('a throwing tick handler does not crash the producer (logs + carries on)', async () => {
    const ticks: FileTick[] = [];
    let throwOnce = true;
    const src = new FileSource((t) => {
      ticks.push(t);
      if (throwOnce) {
        throwOnce = false;
        throw new Error('consumer boom');
      }
    });
    const jsonlPath = path.join(tmpRoot, 'sess.jsonl');
    fs.writeFileSync(jsonlPath, 'init');
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.length >= 1);
    fs.appendFileSync(jsonlPath, '\nmore');
    await waitFor(() => ticks.length >= 2);
    src.stopAll();
  });

  it('tail-reads files larger than MAX_READ_BYTES (returns last 256 KB)', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'big.jsonl');
    // 300 KB filler ('A') then a sentinel marker at the very end.
    const filler = 'A'.repeat(300 * 1024);
    const sentinel = 'TAIL_MARKER_END';
    fs.writeFileSync(jsonlPath, filler + sentinel);
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.some((t) => t.fileExists));
    const present = ticks.find((t) => t.fileExists)!;
    // We get the tail, so we must see the sentinel and the text length must
    // be capped at MAX_READ_BYTES (256 KB).
    expect(present.text.endsWith(sentinel)).toBe(true);
    expect(present.text.length).toBeLessThanOrEqual(256 * 1024);
    src.stopAll();
  });

  it('handles empty (zero-byte) files: fileExists=true, text=""', async () => {
    const ticks: FileTick[] = [];
    const src = new FileSource((t) => ticks.push(t));
    const jsonlPath = path.join(tmpRoot, 'empty.jsonl');
    fs.writeFileSync(jsonlPath, '');
    src.start('s1', jsonlPath);
    await waitFor(() => ticks.length >= 1);
    expect(ticks[0]).toMatchObject({ fileExists: true, text: '' });
    src.stopAll();
  });
});
