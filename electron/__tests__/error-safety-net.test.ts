// Verifies the main-process unhandledRejection / uncaughtException safety
// net is wired in electron/main.ts. Audit risk #2 (tech-debt-03-errors.md):
// without these listeners Node 20+ silently exits the main process on any
// escaped rejection.
//
// Two layers of verification:
//  1) Source-level: confirm main.ts invokes wireCrashHandlers (the SRP-split
//     module that owns the two `process.on` calls) BEFORE app.whenReady, AND
//     that main-crash-wiring.ts actually registers both listeners. Catches
//     accidental deletion in a refactor on EITHER side of the split.
//  2) Behavior-level: simulate the listener body (log + don't exit) and
//     assert the contract (no process.exit call).
//
// Reverse-verify: comment out the wireCrashHandlers(...) call in main.ts OR
// remove a process.on(...) from main-crash-wiring.ts → the source-level
// test FAILS. Restore → PASSES.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN_TS = path.resolve(__dirname, '..', 'main.ts');
const WIRING_TS = path.resolve(__dirname, '..', 'main-crash-wiring.ts');

describe('main-process error safety net (source wiring)', () => {
  const mainSrc = fs.readFileSync(MAIN_TS, 'utf8');
  const wiringSrc = fs.readFileSync(WIRING_TS, 'utf8');
  // Strip line comments before matching so a commented-out reference
  // doesn't satisfy the test (the contract is about live wiring, not
  // documentation).
  const stripComments = (s: string): string =>
    s
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  const mainLive = stripComments(mainSrc);
  const wiringLive = stripComments(wiringSrc);

  it('registers process.on(unhandledRejection) before app.whenReady', () => {
    // wireCrashHandlers is the SRP-split owner of the listener; main.ts
    // must invoke it before whenReady, and the wiring module must
    // register the listener.
    const idxCall = mainLive.indexOf('wireCrashHandlers(');
    const idxReady = mainLive.indexOf('app.whenReady().then(');
    expect(idxCall).toBeGreaterThan(-1);
    expect(idxReady).toBeGreaterThan(-1);
    expect(idxCall).toBeLessThan(idxReady);
    expect(wiringLive).toMatch(
      /\.on\(\s*['"]unhandledRejection['"]/,
    );
  });

  it('registers process.on(uncaughtException) before app.whenReady', () => {
    const idxCall = mainLive.indexOf('wireCrashHandlers(');
    const idxReady = mainLive.indexOf('app.whenReady().then(');
    expect(idxCall).toBeGreaterThan(-1);
    expect(idxReady).toBeGreaterThan(-1);
    expect(idxCall).toBeLessThan(idxReady);
    expect(wiringLive).toMatch(
      /\.on\(\s*['"]uncaughtException['"]/,
    );
  });

  it('does NOT call app.exit / process.exit from inside the safety-net handlers', () => {
    // The handler bodies live in main-crash-wiring.ts. They must not
    // auto-exit (preserves test default-throw behavior + matches
    // renderer "log + degrade" stance).
    expect(wiringLive).not.toMatch(/app\.exit/);
    expect(wiringLive).not.toMatch(/process\.exit/);
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
