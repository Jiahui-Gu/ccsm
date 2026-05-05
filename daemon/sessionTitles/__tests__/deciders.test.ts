// Unit tests for the pure decider functions extracted from sessionTitles
// per #677 SRP cleanup. These functions are pure: no I/O, no mocks needed.
import { describe, it, expect } from 'vitest';

import { classifyError, decideRetry, decideRequeue } from '../deciders';

describe('classifyError', () => {
  it('returns no_jsonl when err.code === ENOENT', () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('boom'), {
      code: 'ENOENT',
    });
    expect(classifyError(err)).toEqual({ reason: 'no_jsonl' });
  });

  it('returns no_jsonl for plain object with code ENOENT', () => {
    expect(classifyError({ code: 'ENOENT' })).toEqual({ reason: 'no_jsonl' });
  });

  it('returns sdk_threw with message for a generic Error', () => {
    expect(classifyError(new Error('kaboom'))).toEqual({
      reason: 'sdk_threw',
      message: 'kaboom',
    });
  });

  it('returns sdk_threw with the string when err is a string', () => {
    expect(classifyError('plain text failure')).toEqual({
      reason: 'sdk_threw',
      message: 'plain text failure',
    });
  });

  it('returns sdk_threw with no message for non-Error object', () => {
    expect(classifyError({ random: 'shape' })).toEqual({ reason: 'sdk_threw' });
  });

  it('returns sdk_threw with no message for undefined', () => {
    expect(classifyError(undefined)).toEqual({ reason: 'sdk_threw' });
  });

  it('returns sdk_threw with no message for null', () => {
    expect(classifyError(null)).toEqual({ reason: 'sdk_threw' });
  });

  it('does not classify code other than ENOENT as no_jsonl', () => {
    const err = Object.assign(new Error('access'), { code: 'EACCES' });
    expect(classifyError(err)).toEqual({
      reason: 'sdk_threw',
      message: 'access',
    });
  });
});

describe('decideRetry', () => {
  const mismatchErr = new Error(
    'Session abc not found in project directory for /Users/x'
  );

  it('returns true when dir is set and message indicates project mismatch', () => {
    expect(decideRetry(mismatchErr, '/Users/x')).toBe(true);
  });

  it('returns false when dir is undefined (nothing to retry away from)', () => {
    expect(decideRetry(mismatchErr, undefined)).toBe(false);
  });

  it('returns false when dir is set but message does not match', () => {
    expect(decideRetry(new Error('something else'), '/Users/x')).toBe(false);
  });

  it('returns false when err is ENOENT (no_jsonl, not a mismatch)', () => {
    const err = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    expect(decideRetry(err, '/Users/x')).toBe(false);
  });

  it('treats a string error message as the message field', () => {
    expect(decideRetry('not found in project directory', '/Users/x')).toBe(
      true
    );
  });

  it('returns false when err is a string that does not match', () => {
    expect(decideRetry('some unrelated text', '/Users/x')).toBe(false);
  });

  it('returns false for non-Error object with no message', () => {
    expect(decideRetry({}, '/Users/x')).toBe(false);
  });
});

describe('decideRequeue', () => {
  it('returns true when result is { ok: false, reason: "no_jsonl" }', () => {
    expect(decideRequeue({ ok: false, reason: 'no_jsonl' })).toBe(true);
  });

  it('returns false when result is { ok: true }', () => {
    expect(decideRequeue({ ok: true })).toBe(false);
  });

  it('returns false when result is { ok: false, reason: "sdk_threw" }', () => {
    expect(decideRequeue({ ok: false, reason: 'sdk_threw' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(decideRequeue(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(decideRequeue(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(decideRequeue('no_jsonl')).toBe(false);
  });

  it('returns false for malformed result missing ok', () => {
    expect(decideRequeue({ reason: 'no_jsonl' })).toBe(false);
  });
});
