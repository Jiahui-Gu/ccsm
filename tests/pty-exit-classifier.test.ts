import { describe, expect, it } from 'vitest';
import { classifyPtyExit } from '../src/lib/ptyExitClassifier';

describe('classifyPtyExit', () => {
  it('clean: code=0, signal=null (graceful exit)', () => {
    expect(classifyPtyExit({ code: 0, signal: null })).toBe('clean');
  });

  it('crashed: code=0, signal=SIGTERM (signal present overrides zero code)', () => {
    // Per extracted logic: ANY signal makes it a crash, even with code=0.
    // Note: the task spec table claimed this should be 'clean', but the
    // real code in store.ts:723 and TerminalPane.tsx:451 both check
    // `signal == null && code === 0` — i.e. signal must be absent.
    expect(classifyPtyExit({ code: 0, signal: 'SIGTERM' })).toBe('crashed');
  });

  it('crashed: code=1, signal=null (non-zero exit)', () => {
    expect(classifyPtyExit({ code: 1, signal: null })).toBe('crashed');
  });

  it('crashed: code=137, signal=SIGKILL (OOM-killed)', () => {
    expect(classifyPtyExit({ code: 137, signal: 'SIGKILL' })).toBe('crashed');
  });

  it('crashed: code=null, signal=null (lost-without-trace)', () => {
    expect(classifyPtyExit({ code: null, signal: null })).toBe('crashed');
  });

  it('crashed: code=null, signal=SIGTERM (signalled, no code)', () => {
    // signal != null → crashed regardless of code.
    expect(classifyPtyExit({ code: null, signal: 'SIGTERM' })).toBe('crashed');
  });

  it('crashed: code=null, signal=SIGKILL', () => {
    expect(classifyPtyExit({ code: null, signal: 'SIGKILL' })).toBe('crashed');
  });

  it('crashed: code=2, signal=SIGINT (Ctrl-C interrupt)', () => {
    expect(classifyPtyExit({ code: 2, signal: 'SIGINT' })).toBe('crashed');
  });

  it('crashed: code=0, signal=15 (numeric signal accepted)', () => {
    expect(classifyPtyExit({ code: 0, signal: 15 })).toBe('crashed');
  });

  it('treats undefined-coerced null inputs uniformly', () => {
    // Both call sites normalize `?? null` before invoking; this guards
    // the contract: only literal null / number / string reach us.
    expect(classifyPtyExit({ code: null, signal: null })).toBe('crashed');
  });
});
