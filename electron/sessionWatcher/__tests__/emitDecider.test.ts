// UT for the pure decider functions extracted from sessionWatcher.
//
// These were previously inline conditions in index.ts; now they are
// SRP-pure deciders so they can be unit-tested without spinning up the
// fs.watch producer.

import { describe, it, expect } from 'vitest';
import {
  decideStateEmit,
  decideTitleEmit,
  decideFlushPending,
} from '../emitDecider';

describe('decideStateEmit', () => {
  it('returns true on first emission (prev=null)', () => {
    expect(decideStateEmit(null, 'idle')).toBe(true);
    expect(decideStateEmit(null, 'running')).toBe(true);
    expect(decideStateEmit(null, 'requires_action')).toBe(true);
  });

  it('returns true on transition (prev !== next)', () => {
    expect(decideStateEmit('running', 'idle')).toBe(true);
    expect(decideStateEmit('idle', 'running')).toBe(true);
    expect(decideStateEmit('running', 'requires_action')).toBe(true);
  });

  it('returns false when state is unchanged (1-line dedupe)', () => {
    expect(decideStateEmit('idle', 'idle')).toBe(false);
    expect(decideStateEmit('running', 'running')).toBe(false);
    expect(decideStateEmit('requires_action', 'requires_action')).toBe(false);
  });
});

describe('decideTitleEmit', () => {
  it('returns true when next is a new non-empty string', () => {
    expect(decideTitleEmit(null, 'first title')).toBe(true);
    expect(decideTitleEmit('old', 'new')).toBe(true);
  });

  it('returns false when next is null', () => {
    expect(decideTitleEmit(null, null)).toBe(false);
    expect(decideTitleEmit('something', null)).toBe(false);
  });

  it('returns false when next is the empty string', () => {
    expect(decideTitleEmit(null, '')).toBe(false);
    expect(decideTitleEmit('something', '')).toBe(false);
  });

  it('returns false when next equals prev (dedupe)', () => {
    expect(decideTitleEmit('same', 'same')).toBe(false);
  });
});

describe('decideFlushPending', () => {
  it('returns true exactly on the first-tick edge (file appears)', () => {
    expect(decideFlushPending(false, true)).toBe(true);
  });

  it('returns false when the file does not yet exist', () => {
    expect(decideFlushPending(false, false)).toBe(false);
  });

  it('returns false on subsequent ticks (already seen)', () => {
    expect(decideFlushPending(true, true)).toBe(false);
    expect(decideFlushPending(true, false)).toBe(false);
  });
});
