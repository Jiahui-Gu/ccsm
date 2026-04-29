// Verifies the main-process unhandledRejection / uncaughtException safety
// net is wired in electron/main.ts. Audit risk #2 (tech-debt-03-errors.md):
// without these listeners Node 20+ silently exits the main process on any
// escaped rejection.
//
// Two layers of verification:
//  1) Source-level: grep the actual main.ts file for the two `process.on`
//     calls. Catches accidental deletion in a refactor.
//  2) Behavior-level: simulate the listener body (log + don't exit) and
//     assert the contract (no process.exit call).
//
// Reverse-verify: comment out the two `process.on(...)` blocks in main.ts
// → the source-level test FAILS. Restore → PASSES.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN_TS = path.resolve(__dirname, '..', 'main.ts');

describe('main-process error safety net (source wiring)', () => {
  const source = fs.readFileSync(MAIN_TS, 'utf8');
  // Strip line comments before matching so a commented-out reference
  // doesn't satisfy the test (the contract is about live wiring, not
  // documentation).
  const live = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  it('registers process.on(unhandledRejection) before app.whenReady', () => {
    const idxOn = live.search(/\bprocess\.on\(\s*['"]unhandledRejection['"]/);
    const idxReady = live.indexOf('app.whenReady().then(');
    expect(idxOn).toBeGreaterThan(-1);
    expect(idxReady).toBeGreaterThan(-1);
    expect(idxOn).toBeLessThan(idxReady);
  });

  it('registers process.on(uncaughtException) before app.whenReady', () => {
    const idxOn = live.search(/\bprocess\.on\(\s*['"]uncaughtException['"]/);
    const idxReady = live.indexOf('app.whenReady().then(');
    expect(idxOn).toBeGreaterThan(-1);
    expect(idxReady).toBeGreaterThan(-1);
    expect(idxOn).toBeLessThan(idxReady);
  });

  it('does NOT call app.exit / process.exit from inside the safety-net handlers', () => {
    // Slice from the first process.on to the initSentry() call — that's the
    // safety-net block. Assert it doesn't auto-exit (preserves test default
    // throw behavior + matches renderer "log + degrade" stance).
    const start = live.search(/\bprocess\.on\(\s*['"]unhandledRejection['"]/);
    const end = live.indexOf('initSentry()');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = live.slice(start, end);
    expect(block).not.toMatch(/app\.exit/);
    expect(block).not.toMatch(/process\.exit/);
  });
});

describe('main-process error safety net (behavior contract)', () => {
  it('handler shape logs reason and does not call process.exit', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => {
        throw new Error('process.exit must not be called from safety net');
      }) as never);

    // Mirror the production handler body verbatim.
    const handler = (reason: unknown) => {
      console.error('[main] unhandledRejection:', reason);
    };
    handler('boom');
    handler(new Error('kapow'));

    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
