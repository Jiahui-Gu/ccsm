// Regression test for F6 / audit #876 cluster 1.14: the quit-time disposer
// chain in electron/main.ts must isolate failures between disposers.
//
// Background: the `disposeNotifyPipeline` callback wired into
// registerLifecycleHandlers from main.ts runs three steps in order on
// `before-quit`:
//   1) mobileRemoteServer?.close()
//   2) mobileRemoteServer = null
//   3) notifyPipelineDispose?.()
//
// Pre-fix, these ran as plain sequential statements — a throw from (1)
// (e.g. closing an already-closed http server, or a node fs error in the
// server's close path) silently skipped (2) and (3). Skipping (3) leaks
// focus/blur + sessionWatcher 'unwatched' subscriptions past quit, which
// was the explicit invariant restored by audit #876 cluster 1.14.
//
// Two layers of verification (mirrors error-safety-net.test.ts):
//   1) Source-level: the literal main.ts callback body must wrap each
//      disposer in its own try/catch. Catches accidental deletion / refactor.
//   2) Behavior-level: replicate the (fixed) callback shape and assert that
//      a throw from the first disposer does NOT prevent the third from
//      running, AND that each failure is logged via console.warn with the
//      '[main]' tag.
//
// Mutation check: removing the try/catch around step (1) in main.ts makes
// the source-level test fail. Documented in PR.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN_TS = path.resolve(__dirname, '..', 'main.ts');

function readLiveSource(): string {
  const source = fs.readFileSync(MAIN_TS, 'utf8');
  // Strip line comments so a commented reference doesn't satisfy the test.
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/** Extract the body of the `disposeNotifyPipeline: () => { ... }` block. */
function extractDisposeBlock(live: string): string {
  const startMarker = 'disposeNotifyPipeline: () => {';
  const startIdx = live.indexOf(startMarker);
  expect(startIdx).toBeGreaterThan(-1);
  // Walk braces to find the matching closing brace of the arrow-function body.
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // position at the opening '{'
  for (; i < live.length; i++) {
    const ch = live[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return live.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error('unterminated disposeNotifyPipeline block in main.ts');
}

describe('disposeNotifyPipeline cleanup chain (source wiring)', () => {
  const live = readLiveSource();
  const block = extractDisposeBlock(live);

  it('wraps mobileRemoteServer.close() in its own try/catch', () => {
    // The .close() call must appear inside a try { } block, not as a bare
    // statement. We assert presence + that a try precedes it before the
    // next disposer.
    const closeIdx = block.indexOf('mobileRemoteServer?.close()');
    expect(closeIdx).toBeGreaterThan(-1);
    // The nearest preceding `try {` should come before the close call and
    // after the start of the block.
    const tryBefore = block.lastIndexOf('try {', closeIdx);
    expect(tryBefore).toBeGreaterThan(-1);
    // No bare close() outside a try: there must be a catch after this call
    // before the next disposer reference.
    const nextDisposerIdx = block.indexOf('notifyPipelineDispose', closeIdx);
    const catchBetween = block.indexOf('catch', closeIdx);
    expect(catchBetween).toBeGreaterThan(closeIdx);
    expect(catchBetween).toBeLessThan(nextDisposerIdx);
  });

  it('wraps notifyPipelineDispose?.() in its own try/catch', () => {
    const dispIdx = block.indexOf('notifyPipelineDispose?.()');
    expect(dispIdx).toBeGreaterThan(-1);
    // Find the try { that opens immediately before this call (no other
    // disposer reference between them).
    const tryBefore = block.lastIndexOf('try {', dispIdx);
    expect(tryBefore).toBeGreaterThan(-1);
    // Make sure that try { is dedicated to this disposer — no
    // mobileRemoteServer reference sits between the try and the dispose call.
    const between = block.slice(tryBefore, dispIdx);
    expect(between).not.toMatch(/mobileRemoteServer\?\.close\(\)/);
    // A catch must follow the dispose call.
    const catchAfter = block.indexOf('catch', dispIdx);
    expect(catchAfter).toBeGreaterThan(dispIdx);
  });

  it('preserves disposer order: close → null → dispose', () => {
    const closeIdx = block.indexOf('mobileRemoteServer?.close()');
    const nullIdx = block.indexOf('mobileRemoteServer = null');
    const dispIdx = block.indexOf('notifyPipelineDispose?.()');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(nullIdx).toBeGreaterThan(closeIdx);
    expect(dispIdx).toBeGreaterThan(nullIdx);
  });

  it('logs each disposer failure via console.warn with the [main] tag', () => {
    // Pre-fix the block has zero `console.warn` calls. The fix adds one per
    // disposer; assert at least one references the '[main] disposer' tag so
    // operator-visible logs survive a refactor.
    expect(block).toMatch(/console\.warn\(\s*'\[main\] disposer/);
  });
});

describe('disposeNotifyPipeline cleanup chain (behavior contract)', () => {
  // Mirror the production callback shape: three independent disposers,
  // each in its own try/catch with a console.warn on failure. The test
  // injects a throwing first disposer and verifies the later ones still run.
  function buildCallback(
    closeServer: () => void,
    clearHandle: () => void,
    pipelineDispose: () => void,
  ): () => void {
    return () => {
      try {
        closeServer();
      } catch (err) {
        console.warn('[main] disposer mobileRemoteServer.close threw', err);
      }
      try {
        clearHandle();
      } catch (err) {
        console.warn('[main] disposer clear mobileRemoteServer threw', err);
      }
      try {
        pipelineDispose();
      } catch (err) {
        console.warn('[main] disposer notifyPipelineDispose threw', err);
      }
    };
  }

  it('runs every disposer when none throw', () => {
    const closeServer = vi.fn();
    const clearHandle = vi.fn();
    const pipelineDispose = vi.fn();
    buildCallback(closeServer, clearHandle, pipelineDispose)();
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(clearHandle).toHaveBeenCalledTimes(1);
    expect(pipelineDispose).toHaveBeenCalledTimes(1);
  });

  it('still runs later disposers when the first one throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closeServer = vi.fn(() => {
      throw new Error('close blew up');
    });
    const clearHandle = vi.fn();
    const pipelineDispose = vi.fn();

    expect(() =>
      buildCallback(closeServer, clearHandle, pipelineDispose)(),
    ).not.toThrow();

    expect(closeServer).toHaveBeenCalledTimes(1);
    // The critical invariant: pipeline dispose MUST still run.
    expect(pipelineDispose).toHaveBeenCalledTimes(1);
    expect(clearHandle).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[main] disposer mobileRemoteServer.close threw'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('still runs notifyPipelineDispose when the middle step throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closeServer = vi.fn();
    const clearHandle = vi.fn(() => {
      throw new Error('clear blew up');
    });
    const pipelineDispose = vi.fn();

    buildCallback(closeServer, clearHandle, pipelineDispose)();

    expect(pipelineDispose).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not rethrow when only the last disposer throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closeServer = vi.fn();
    const clearHandle = vi.fn();
    const pipelineDispose = vi.fn(() => {
      throw new Error('pipeline blew up');
    });
    expect(() =>
      buildCallback(closeServer, clearHandle, pipelineDispose)(),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[main] disposer notifyPipelineDispose threw'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
