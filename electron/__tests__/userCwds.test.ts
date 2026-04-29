import { describe, it, expect } from 'vitest';
import { normalizeCwd, pushLRU, withHomeFallback } from '../userCwds';

describe('normalizeCwd', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeCwd('/home/user/')).toBe('/home/user');
  });
  it('strips a single trailing backslash', () => {
    expect(normalizeCwd('C:\\Users\\me\\')).toBe('C:\\Users\\me');
  });
  it('strips multiple trailing separators (mixed)', () => {
    expect(normalizeCwd('C:\\Users\\me\\\\//')).toBe('C:\\Users\\me');
  });
  it('leaves a path without trailing separators alone', () => {
    expect(normalizeCwd('/home/user')).toBe('/home/user');
  });
  it('preserves Windows drive-letter casing', () => {
    expect(normalizeCwd('C:\\Foo\\Bar')).toBe('C:\\Foo\\Bar');
  });
  it('does not expand a relative path (no resolve)', () => {
    expect(normalizeCwd('relative/path/')).toBe('relative/path');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeCwd('')).toBe('');
  });
});

describe('pushLRU', () => {
  it('inserts a new item at the head of an empty list', () => {
    expect(pushLRU([], 'a')).toEqual(['a']);
  });
  it('inserts a new item at the head of a populated list', () => {
    expect(pushLRU(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });
  it('moves an existing item to the head (LRU dedupe)', () => {
    expect(pushLRU(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });
  it('dedupes case-insensitively', () => {
    expect(pushLRU(['/Foo', '/bar'], '/FOO')).toEqual(['/FOO', '/bar']);
  });
  it('caps the list at the default max=20', () => {
    const list = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const out = pushLRU(list, 'new');
    expect(out).toHaveLength(20);
    expect(out[0]).toBe('new');
    expect(out[19]).toBe('p18'); // p19 dropped from tail
  });
  it('caps the list at a custom max', () => {
    expect(pushLRU(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a']);
  });
  it('does not mutate the input list', () => {
    const input = ['a', 'b'];
    pushLRU(input, 'c');
    expect(input).toEqual(['a', 'b']);
  });
  it('returns a copy when item is empty (no mutation)', () => {
    const input = ['a', 'b'];
    const out = pushLRU(input, '');
    expect(out).toEqual(['a', 'b']);
    expect(out).not.toBe(input);
  });
});

describe('withHomeFallback', () => {
  it('returns [home] when list is empty', () => {
    expect(withHomeFallback([], '/home/u')).toEqual(['/home/u']);
  });
  it('appends home at tail when not present', () => {
    expect(withHomeFallback(['/a', '/b'], '/home/u')).toEqual(['/a', '/b', '/home/u']);
  });
  it('does not append home when already present (case-sensitive match)', () => {
    expect(withHomeFallback(['/a', '/home/u'], '/home/u')).toEqual(['/a', '/home/u']);
  });
  it('does not append home when already present (case-insensitive match)', () => {
    expect(withHomeFallback(['/a', '/Home/U'], '/home/u')).toEqual(['/a', '/Home/U']);
  });
  it('does not bump home to head when present in the middle', () => {
    expect(withHomeFallback(['/a', '/home/u', '/b'], '/home/u')).toEqual(['/a', '/home/u', '/b']);
  });
  it('does not mutate the input list', () => {
    const input = ['/a'];
    withHomeFallback(input, '/home/u');
    expect(input).toEqual(['/a']);
  });
});
