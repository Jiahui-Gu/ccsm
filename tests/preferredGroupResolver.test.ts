import { describe, it, expect } from 'vitest';
import { resolvePreferredGroup } from '../src/stores/lib/preferredGroupResolver';
import type { Group } from '../src/types';

function g(id: string, kind: 'normal' | 'archive' = 'normal'): Group {
  return { id, name: id, collapsed: false, kind };
}

describe('resolvePreferredGroup', () => {
  it('returns null when groups is empty', () => {
    expect(resolvePreferredGroup([], null, null, null)).toBeNull();
    expect(resolvePreferredGroup([], 'g1', 'g2', 'g3')).toBeNull();
  });

  it('returns caller-provided id when usable', () => {
    const groups = [g('a'), g('b'), g('c')];
    expect(resolvePreferredGroup(groups, 'b', 'a', 'c')).toBe('b');
  });

  it('falls back to focused when caller missing', () => {
    const groups = [g('a'), g('b')];
    expect(resolvePreferredGroup(groups, null, 'b', 'a')).toBe('b');
    expect(resolvePreferredGroup(groups, undefined, 'a', 'b')).toBe('a');
  });

  it('falls back to active session group when caller + focused missing', () => {
    const groups = [g('a'), g('b')];
    expect(resolvePreferredGroup(groups, null, null, 'a')).toBe('a');
  });

  it('returns null when no candidate is usable', () => {
    const groups = [g('a'), g('b')];
    expect(resolvePreferredGroup(groups, null, null, null)).toBeNull();
  });

  it('skips ids that are not present in groups', () => {
    const groups = [g('a')];
    expect(resolvePreferredGroup(groups, 'ghost', null, null)).toBeNull();
    expect(resolvePreferredGroup(groups, 'ghost', 'a', null)).toBe('a');
  });

  it('treats archive groups as not usable', () => {
    const groups = [g('arc', 'archive'), g('norm', 'normal')];
    // caller points at archive → skip to next candidate
    expect(resolvePreferredGroup(groups, 'arc', 'norm', null)).toBe('norm');
    // every candidate is archive → null
    expect(resolvePreferredGroup(groups, 'arc', 'arc', 'arc')).toBeNull();
  });

  it('caller wins over focused when both are usable', () => {
    const groups = [g('a'), g('b')];
    expect(resolvePreferredGroup(groups, 'a', 'b', 'b')).toBe('a');
  });

  it('focused wins over active when caller missing', () => {
    const groups = [g('a'), g('b')];
    expect(resolvePreferredGroup(groups, null, 'a', 'b')).toBe('a');
  });
});
